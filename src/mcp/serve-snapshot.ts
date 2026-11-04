import { randomUUID } from 'node:crypto';
import type { BlueprintOutdatedFile } from '../core/activity';
import { loadProjectFromFs } from '../core/load';
import { BLUEPRINT_SCHEMA_VERSION, fileSchemaVersions } from '../core/schema-version';
import type { BlueprintProjectBundle, ValidationResult } from '../core/types';
import { validateProject } from '../core/validate';

export interface ServeProjectSnapshot {
  revision: string;
  bundle?: BlueprintProjectBundle;
  error?: string;
  outdatedFiles: BlueprintOutdatedFile[];
}

export interface ServeProjectSnapshotOptions {
  debounceMs: number;
  onChanged: (change: { revision: string; changedPaths: string[] }) => void;
  onFailed: (failure: { message: string; outdatedFiles: BlueprintOutdatedFile[] }) => void;
  load?: (projectRoot: string) => Promise<BlueprintProjectBundle>;
  validate?: (bundle: BlueprintProjectBundle) => ValidationResult;
}

export class ServeProjectSnapshots {
  readonly #projectRoot: string;
  readonly #options: ServeProjectSnapshotOptions;
  readonly #changedPaths = new Set<string>();
  #current: ServeProjectSnapshot = { revision: randomUUID(), outdatedFiles: [] };
  #fingerprint: string | undefined;
  #announcedError: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #reloading: Promise<void> | undefined;
  #reloadRequested = false;
  #started = false;
  #closed = false;
  #waiters: Array<() => void> = [];

  constructor(projectRoot: string, options: ServeProjectSnapshotOptions) {
    this.#projectRoot = projectRoot;
    this.#options = options;
  }

  get current(): ServeProjectSnapshot {
    return this.#current;
  }

  get busy(): boolean {
    return !this.#started || this.#timer !== undefined || this.#reloading !== undefined;
  }

  async start(): Promise<ServeProjectSnapshot> {
    const initial = await this.#read();
    this.#current = { revision: this.#current.revision, ...initial };
    if (initial.error === undefined) this.#fingerprint = JSON.stringify(initial.bundle);
    this.#started = true;
    this.#releaseWhenIdle();
    return this.#current;
  }

  settled(): Promise<ServeProjectSnapshot> {
    if (this.#closed || !this.busy) return Promise.resolve(this.#current);
    return new Promise(resolve => this.#waiters.push(() => resolve(this.#current)));
  }

  schedule(changedPath: string): void {
    if (this.#closed) return;
    this.#changedPaths.add(changedPath);
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#reloadRequested = true;
      this.#reloading ??= this.#reloadUntilCurrent();
    }, this.#options.debounceMs);
    this.#timer.unref();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#release();
  }

  async #reloadUntilCurrent(): Promise<void> {
    try {
      while (this.#reloadRequested && !this.#closed) {
        this.#reloadRequested = false;
        await this.#reload();
      }
    } finally {
      this.#reloading = undefined;
      this.#releaseWhenIdle();
    }
  }

  async #reload(): Promise<void> {
    const covered = [...this.#changedPaths];
    const next = await this.#read();
    if (this.#closed) return;
    if (next.error !== undefined) {
      this.#current = { ...next, revision: this.#current.revision, bundle: this.#current.bundle };
      if (next.error !== this.#announcedError) {
        this.#announcedError = next.error;
        this.#options.onFailed({ message: next.error, outdatedFiles: next.outdatedFiles });
      }
      return;
    }
    const fingerprint = JSON.stringify(next.bundle);
    const changed = fingerprint !== this.#fingerprint || this.#announcedError !== undefined;
    const changedPaths = [...this.#changedPaths].sort();
    for (const changedPath of covered) this.#changedPaths.delete(changedPath);
    this.#fingerprint = fingerprint;
    this.#announcedError = undefined;
    this.#current = { revision: changed ? randomUUID() : this.#current.revision, ...next };
    if (changed) this.#options.onChanged({ revision: this.#current.revision, changedPaths });
  }

  async #read(): Promise<Omit<ServeProjectSnapshot, 'revision'>> {
    let outdatedFiles: BlueprintOutdatedFile[] = [];
    try {
      const bundle = await (this.#options.load ?? loadProjectFromFs)(this.#projectRoot);
      outdatedFiles = fileSchemaVersions(bundle)
        .filter(([, version]) => version !== BLUEPRINT_SCHEMA_VERSION)
        .map(([file, version]) => ({ file, version: String(version) }));
      const validation = (this.#options.validate ?? validateProject)(bundle);
      if (!validation.ok) {
        throw new Error(`Blueprint project failed baseline validation:\n${validation.errors.join('\n')}`);
      }
      return { bundle, outdatedFiles: [] };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), outdatedFiles };
    }
  }

  #releaseWhenIdle(): void {
    if (!this.busy) this.#release();
  }

  #release(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}

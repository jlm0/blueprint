import { randomUUID } from 'node:crypto';
import type { BlueprintOutdatedFile } from '../core/activity';
import type { BlueprintProjectBundle } from '../core/types';
import { loadValidatedProject, type ProjectReader, type ValidatedProject } from './project-validation';

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
  read?: ProjectReader;
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

  async start(validated?: ValidatedProject): Promise<ServeProjectSnapshot> {
    const { fingerprint, ...initial } = validated ?? await this.#read();
    this.#current = { revision: this.#current.revision, ...initial };
    if (initial.error === undefined) this.#fingerprint = fingerprint;
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
    const { fingerprint, ...next } = await this.#read();
    if (this.#closed) return;
    if (next.error !== undefined) {
      this.#current = { ...next, revision: this.#current.revision, bundle: this.#current.bundle };
      if (next.error !== this.#announcedError) {
        this.#announcedError = next.error;
        this.#options.onFailed({ message: next.error, outdatedFiles: next.outdatedFiles });
      }
      return;
    }
    const changed = fingerprint !== this.#fingerprint || this.#announcedError !== undefined;
    const changedPaths = [...this.#changedPaths].sort();
    for (const changedPath of covered) this.#changedPaths.delete(changedPath);
    this.#fingerprint = fingerprint;
    this.#announcedError = undefined;
    this.#current = { revision: changed ? randomUUID() : this.#current.revision, ...next };
    if (changed) this.#options.onChanged({ revision: this.#current.revision, changedPaths });
  }

  #read(): Promise<ValidatedProject> {
    return (this.#options.read ?? loadValidatedProject)(this.#projectRoot);
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

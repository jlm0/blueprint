import { randomUUID } from 'node:crypto';
import type { BlueprintOutdatedFile, BlueprintProjectSnapshotDelta } from '../core/activity';
import { diffProjectBundles } from '../core/bundle-delta';
import type { BlueprintProjectBundle, LinkedProjectBundle, PrototypeAssetContent } from '../core/types';
import { loadValidatedProject, type ProjectReader, type ValidatedProject, type ValidProject } from './project-validation';

export interface ServeProjectSnapshot {
  revision: string;
  bundle?: BlueprintProjectBundle;
  linkedBundle?: LinkedProjectBundle;
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
  #assets = new Map<string, PrototypeAssetContent>();
  #previous: { revision: string; linkedBundle: LinkedProjectBundle; nextRevision: string } | undefined;
  #delta: BlueprintProjectSnapshotDelta | undefined;
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

  asset(sha256: string): PrototypeAssetContent | undefined {
    return this.#assets.get(sha256);
  }

  deltaFrom(base: string, snapshot: ServeProjectSnapshot): BlueprintProjectSnapshotDelta | undefined {
    const previous = this.#previous;
    if (!previous || previous.revision !== base || previous.nextRevision !== snapshot.revision || !snapshot.linkedBundle) return undefined;
    if (this.#delta?.base !== base || this.#delta.revision !== snapshot.revision) {
      this.#delta = { version: 1, revision: snapshot.revision, base, delta: diffProjectBundles(previous.linkedBundle, snapshot.linkedBundle) };
    }
    return this.#delta;
  }

  get busy(): boolean {
    return !this.#started || this.#timer !== undefined || this.#reloading !== undefined;
  }

  async start(validated?: ValidatedProject): Promise<ServeProjectSnapshot> {
    const initial = validated ?? await this.#read();
    if (initial.error === undefined) {
      this.#publish(this.#current.revision, initial);
      this.#fingerprint = initial.fingerprint;
    } else {
      this.#current = { revision: this.#current.revision, error: initial.error, outdatedFiles: initial.outdatedFiles };
    }
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
      const { bundle, linkedBundle, revision } = this.#current;
      this.#current = { revision, bundle, linkedBundle, error: next.error, outdatedFiles: next.outdatedFiles };
      if (next.error !== this.#announcedError) {
        this.#announcedError = next.error;
        this.#options.onFailed({ message: next.error, outdatedFiles: next.outdatedFiles });
      }
      return;
    }
    const changed = next.fingerprint !== this.#fingerprint || this.#announcedError !== undefined;
    const changedPaths = [...this.#changedPaths].sort();
    for (const changedPath of covered) this.#changedPaths.delete(changedPath);
    this.#fingerprint = next.fingerprint;
    this.#announcedError = undefined;
    this.#publish(changed ? randomUUID() : this.#current.revision, next);
    if (changed) this.#options.onChanged({ revision: this.#current.revision, changedPaths });
  }

  #publish(revision: string, { bundle, assetHashes, outdatedFiles }: ValidProject): void {
    const { revision: previousRevision, linkedBundle: previousBundle } = this.#current;
    if (previousBundle && previousRevision !== revision) {
      this.#previous = { revision: previousRevision, linkedBundle: previousBundle, nextRevision: revision };
    }
    this.#assets = new Map(Object.entries(bundle.prototypeAssetContents).map(([assetRef, asset]) => [assetHashes[assetRef], asset]));
    this.#current = { revision, bundle, linkedBundle: linkProjectAssets(bundle, assetHashes), outdatedFiles };
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

export function linkProjectAssets(bundle: BlueprintProjectBundle, assetHashes: Readonly<Record<string, string>>): LinkedProjectBundle {
  return {
    ...bundle,
    prototypeAssetContents: Object.fromEntries(Object.entries(bundle.prototypeAssetContents).map(([assetRef, asset]) => [
      assetRef,
      { mediaType: asset.mediaType, sha256: assetHashes[assetRef] }
    ]))
  };
}

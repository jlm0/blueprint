import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const BLUEPRINT_INPUT_LIMITS = {
  fixedJsonBytes: 1 * 1024 * 1024,
  prototypeSourceBytes: 2 * 1024 * 1024,
  prototypeAssetBytes: 16 * 1024 * 1024,
  projectBytes: 32 * 1024 * 1024
} as const;

export type BlueprintInputKind = 'fixed JSON' | 'prototype source' | 'prototype asset';

export interface BlueprintInputLimits {
  fixedJsonBytes: number;
  prototypeSourceBytes: number;
  prototypeAssetBytes: number;
  projectBytes: number;
}

interface ReadContainedFileOptions {
  kind: BlueprintInputKind;
  optional?: boolean;
}

/**
 * Reads one Blueprint sidecar through a canonical root with a shared byte budget.
 * Calls are serialized so concurrent loader requests cannot race the aggregate limit.
 */
export class ContainedBlueprintReader {
  readonly canonicalRoot: string;
  readonly limits: BlueprintInputLimits;
  private loadedBytes = 0;
  private queue: Promise<void> = Promise.resolve();

  private constructor(canonicalRoot: string, limits: BlueprintInputLimits) {
    this.canonicalRoot = canonicalRoot;
    this.limits = limits;
  }

  static async create(
    sourceRoot: string,
    limits: BlueprintInputLimits = BLUEPRINT_INPUT_LIMITS
  ): Promise<ContainedBlueprintReader> {
    const canonicalRoot = await realpath(path.resolve(sourceRoot));
    const rootStats = await stat(canonicalRoot);
    if (!rootStats.isDirectory()) {
      throw new Error(`Blueprint source root "${normalizeRef(sourceRoot)}" must resolve to a directory.`);
    }
    return new ContainedBlueprintReader(canonicalRoot, limits);
  }

  readText(fileRef: string, options: ReadContainedFileOptions): Promise<string | undefined> {
    return this.enqueue(async () => {
      const bytes = await this.readBytesNow(fileRef, options);
      return bytes?.toString('utf8');
    });
  }

  readBytes(fileRef: string, options: ReadContainedFileOptions): Promise<Buffer | undefined> {
    return this.enqueue(() => this.readBytesNow(fileRef, options));
  }

  /** Lists a bounded flat record directory while preserving the same root containment as file reads. */
  async listFileRefs(directoryRef: string, options: { optional?: boolean; suffix?: string } = {}): Promise<string[]> {
    const normalizedRef = normalizeRef(directoryRef).replace(/\/$/, '');
    const lexicalTarget = path.resolve(this.canonicalRoot, directoryRef);
    assertContained(this.canonicalRoot, lexicalTarget, 'fixed JSON', normalizedRef);

    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(lexicalTarget);
    } catch (error) {
      if (options.optional && isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    assertContained(this.canonicalRoot, canonicalTarget, 'fixed JSON', normalizedRef);
    if (!(await stat(canonicalTarget)).isDirectory()) {
      throw new Error(`fixed JSON record directory "${normalizedRef}" must resolve to a directory.`);
    }

    const entries = await readdir(canonicalTarget, { withFileTypes: true });
    if (entries.length > 1024) {
      throw new Error(`fixed JSON record directory "${normalizedRef}" exceeds the 1024-record limit.`);
    }
    return entries
      .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && (!options.suffix || entry.name.endsWith(options.suffix)))
      .map(entry => `${normalizedRef}/${entry.name}`)
      .sort();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readBytesNow(fileRef: string, options: ReadContainedFileOptions): Promise<Buffer | undefined> {
    const normalizedRef = normalizeRef(fileRef);
    const lexicalTarget = path.resolve(this.canonicalRoot, fileRef);
    assertContained(this.canonicalRoot, lexicalTarget, options.kind, normalizedRef);

    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(lexicalTarget);
    } catch (error) {
      if (options.optional && isNodeError(error) && error.code === 'ENOENT') {
        return undefined;
      }
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new Error(`${options.kind} "${normalizedRef}" does not exist.`);
      }
      throw error;
    }
    assertContained(this.canonicalRoot, canonicalTarget, options.kind, normalizedRef);

    const targetStats = await stat(canonicalTarget);
    if (!targetStats.isFile()) {
      throw new Error(`${options.kind} "${normalizedRef}" must resolve to a regular file.`);
    }
    const handle = await open(canonicalTarget, 'r');
    try {
      const fileStats = await handle.stat();
      if (!fileStats.isFile()) {
        throw new Error(`${options.kind} "${normalizedRef}" must resolve to a regular file.`);
      }

      const perFileLimit = limitFor(options.kind, this.limits);
      if (fileStats.size > perFileLimit) {
        throw new Error(`${options.kind} "${normalizedRef}" exceeds the ${perFileLimit}-byte per-file limit.`);
      }
      if (this.loadedBytes + fileStats.size > this.limits.projectBytes) {
        throw aggregateLimitError(this.limits.projectBytes, options.kind, normalizedRef);
      }

      const chunks: Buffer[] = [];
      let fileBytes = 0;
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        const remainingFileBytes = perFileLimit - fileBytes;
        const remainingProjectBytes = this.limits.projectBytes - this.loadedBytes - fileBytes;
        const bytesToRead = Math.min(chunk.length, remainingFileBytes + 1, remainingProjectBytes + 1);
        const { bytesRead } = await handle.read(chunk, 0, bytesToRead, null);
        if (bytesRead === 0) {
          break;
        }
        fileBytes += bytesRead;
        if (fileBytes > perFileLimit) {
          throw new Error(`${options.kind} "${normalizedRef}" exceeds the ${perFileLimit}-byte per-file limit.`);
        }
        if (this.loadedBytes + fileBytes > this.limits.projectBytes) {
          throw aggregateLimitError(this.limits.projectBytes, options.kind, normalizedRef);
        }
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      }

      this.loadedBytes += fileBytes;
      return Buffer.concat(chunks, fileBytes);
    } finally {
      await handle.close();
    }
  }
}

function assertContained(root: string, target: string, kind: BlueprintInputKind, fileRef: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${kind} "${fileRef}" resolves outside the canonical Blueprint source root.`);
  }
}

function limitFor(kind: BlueprintInputKind, limits: BlueprintInputLimits): number {
  if (kind === 'fixed JSON') {
    return limits.fixedJsonBytes;
  }
  if (kind === 'prototype source') {
    return limits.prototypeSourceBytes;
  }
  return limits.prototypeAssetBytes;
}

function aggregateLimitError(limit: number, kind: BlueprintInputKind, fileRef: string): Error {
  return new Error(`The total loaded Blueprint input exceeds the ${limit}-byte aggregate limit while reading ${kind} "${fileRef}".`);
}

function normalizeRef(fileRef: string): string {
  return fileRef.replace(/\\/g, '/');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

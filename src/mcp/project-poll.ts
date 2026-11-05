import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const UNWATCHED_DIRECTORIES = new Set(['.git', '.blueprint-artifacts', 'node_modules']);

interface FileStamp {
  size: bigint;
  mtimeNs: bigint;
  ino: bigint;
}

export function isWatchedProjectPath(relativePath: string): boolean {
  return relativePath.length > 0 && !relativePath.split('/').some(part => UNWATCHED_DIRECTORIES.has(part));
}

/** FSEvents can lose an event under file churn and set no drop flag, so serve also compares the stat of each file. */
export class ProjectFilePoll {
  readonly #projectRoot: string;
  #stamps: Map<string, FileStamp> | undefined;
  #lastPass: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
  }

  /** The first pass takes the baseline and returns no path. */
  pass(): Promise<string[]> {
    const next = this.#lastPass.then(() => this.#compare());
    this.#lastPass = next;
    return next;
  }

  every(intervalMs: number, onChange: (changedPath: string) => void): void {
    const tick = async (): Promise<void> => {
      const changedPaths = await this.pass();
      if (this.#closed) return;
      for (const changedPath of changedPaths) onChange(changedPath);
      this.#timer = setTimeout(tick, intervalMs).unref();
    };
    this.#timer = setTimeout(tick, intervalMs).unref();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
  }

  async #compare(): Promise<string[]> {
    const next = await statProjectFiles(this.#projectRoot);
    const previous = this.#stamps;
    this.#stamps = next;
    if (!previous) return [];
    const changedPaths = [...next].filter(([fileRef, stamp]) => !sameStamp(previous.get(fileRef), stamp)).map(([fileRef]) => fileRef);
    for (const fileRef of previous.keys()) {
      if (!next.has(fileRef)) changedPaths.push(fileRef);
    }
    return changedPaths.sort();
  }
}

async function statProjectFiles(projectRoot: string): Promise<Map<string, FileStamp>> {
  const stamps = new Map<string, FileStamp>();
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(projectRoot, directory), { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async entry => {
      if (UNWATCHED_DIRECTORIES.has(entry.name)) return;
      const fileRef = directory === '' ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(fileRef);
        return;
      }
      const stats = await stat(path.join(projectRoot, fileRef), { bigint: true }).catch(() => undefined);
      if (stats && !stats.isDirectory()) stamps.set(fileRef, { size: stats.size, mtimeNs: stats.mtimeNs, ino: stats.ino });
    }));
  };
  await visit('');
  return stamps;
}

function sameStamp(previous: FileStamp | undefined, next: FileStamp): boolean {
  return previous !== undefined && previous.size === next.size && previous.mtimeNs === next.mtimeNs && previous.ino === next.ino;
}

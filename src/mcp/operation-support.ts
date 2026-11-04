import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = findPackageRoot();

function findPackageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json')) && existsSync(path.join(current, 'starter'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
}

export function normalize(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Blueprint tool call was cancelled.');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

export function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return operation;
  }
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export async function runInOrder<T>(
  queue: Map<string, Promise<void>>,
  key: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  const previous = queue.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const finished = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(() => finished);
  queue.set(key, tail);
  try {
    await withAbort(previous, signal);
    return await run();
  } finally {
    release();
    // An aborted call leaves earlier calls running, so the key stays until the whole tail ends.
    void tail.then(() => {
      if (queue.get(key) === tail) queue.delete(key);
    });
  }
}

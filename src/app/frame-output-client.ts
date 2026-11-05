import type { CanvasProjectBundle } from '../core/types';
import type { FrameOutputTarget } from './frame-output';
import type { FrameOutputAnswer, FrameOutputRequest } from './frame-output-service';

type Pending = (answer: FrameOutputAnswer | undefined) => void;

/** The live queue waits for each answer, so a worker that stays silent must not stop every later edit. */
export const WORKER_ANSWER_TIMEOUT_MS = 30_000;

let worker: Worker | undefined;
let workerFailed = false;
let nextSnapshot = 1;
let nextRequest = 1;
const snapshotIds = new Map<CanvasProjectBundle, number>();
const pending = new Map<number, Pending>();

function failWorker(): void {
  workerFailed = true;
  worker?.terminate();
  worker = undefined;
  snapshotIds.clear();
  for (const settle of pending.values()) settle(undefined);
  pending.clear();
}

/** The compile of a large frame takes longer than one frame of input, so this work stays off the canvas main thread. */
function frameOutputWorker(): Worker | undefined {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL('./frame-output-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    workerFailed = true;
    return undefined;
  }
  worker.onmessage = (event: MessageEvent<FrameOutputAnswer>) => {
    const settle = pending.get(event.data.request);
    pending.delete(event.data.request);
    settle?.(event.data);
  };
  worker.onerror = failWorker;
  worker.onmessageerror = failWorker;
  return worker;
}

function snapshotId(target: Worker, bundle: CanvasProjectBundle): number {
  const known = snapshotIds.get(bundle);
  if (known !== undefined) return known;
  const snapshot = nextSnapshot;
  nextSnapshot += 1;
  target.postMessage({ kind: 'snapshot', snapshot, bundle } satisfies FrameOutputRequest);
  snapshotIds.set(bundle, snapshot);
  return snapshot;
}

function ask(target: Worker, request: (id: number) => FrameOutputRequest): Promise<FrameOutputAnswer | undefined> {
  const id = nextRequest;
  nextRequest += 1;
  return new Promise(resolve => {
    const timer = setTimeout(failWorker, WORKER_ANSWER_TIMEOUT_MS);
    pending.set(id, answer => {
      clearTimeout(timer);
      resolve(answer);
    });
    target.postMessage(request(id));
  });
}

export interface ChangedFrameOutputs {
  changed: ReadonlySet<string>;
  /** The element diff cannot read what changed in these frames, so only the hash can answer for them. */
  unconfirmable: ReadonlySet<string>;
}

/** A stale frame is worse than an extra rebuild, so a caller must count each frame in its scope as changed when the answer is undefined. */
export async function changedFrameOutputs(
  before: CanvasProjectBundle,
  after: CanvasProjectBundle,
  targets: FrameOutputTarget[]
): Promise<ChangedFrameOutputs | undefined> {
  const target = frameOutputWorker();
  if (!target) return undefined;
  try {
    const beforeId = snapshotId(target, before);
    const afterId = snapshotId(target, after);
    const answer = await ask(target, request => ({ kind: 'compare', request, before: beforeId, after: afterId, targets }));
    return answer?.kind === 'compare' ? { changed: new Set(answer.changed), unconfirmable: new Set(answer.unconfirmable) } : undefined;
  } catch {
    failWorker();
    return undefined;
  }
}

export async function compileFrameDocument(bundle: CanvasProjectBundle, frame: FrameOutputTarget): Promise<string | undefined> {
  const target = frameOutputWorker();
  if (!target) return undefined;
  try {
    const snapshot = snapshotId(target, bundle);
    const answer = await ask(target, request => ({ kind: 'document', request, snapshot, target: frame, assetOrigin: location.origin }));
    return answer?.kind === 'document' ? answer.html : undefined;
  } catch {
    failWorker();
    return undefined;
  }
}

/** The worker holds a copy of each snapshot, and the old document text of a dismissed change must not stay in memory. */
export function keepFrameOutputSnapshots(bundles: ReadonlySet<CanvasProjectBundle>): void {
  for (const [bundle, snapshot] of snapshotIds) {
    if (bundles.has(bundle)) continue;
    snapshotIds.delete(bundle);
    worker?.postMessage({ kind: 'release', snapshot } satisfies FrameOutputRequest);
  }
}

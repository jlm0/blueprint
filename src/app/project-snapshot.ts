import type { BlueprintProjectSnapshot, BlueprintProjectSnapshotDelta } from '../core/activity';
import { applyProjectBundleDelta } from '../core/bundle-delta';
import type { CanvasProjectBundle } from '../core/types';

export interface LiveProjectSnapshot {
  revision: string;
  bundle: CanvasProjectBundle;
}

export async function fetchLiveProjectSnapshot(
  snapshotUrl: URL,
  revision: string,
  current: LiveProjectSnapshot | undefined
): Promise<LiveProjectSnapshot> {
  const answer = await requestProjectSnapshot(snapshotUrl, revision, current?.revision);
  if ('bundle' in answer) return { revision: answer.revision, bundle: answer.bundle };
  if (current && answer.base === current.revision) {
    return { revision: answer.revision, bundle: applyProjectBundleDelta(current.bundle, answer.delta) };
  }
  const full = await requestProjectSnapshot(snapshotUrl, revision, undefined);
  if ('bundle' in full) return { revision: full.revision, bundle: full.bundle };
  throw new Error('Blueprint returned an invalid live project snapshot.');
}

async function requestProjectSnapshot(
  snapshotUrl: URL,
  revision: string,
  base: string | undefined
): Promise<BlueprintProjectSnapshot | BlueprintProjectSnapshotDelta> {
  const requestUrl = new URL(snapshotUrl);
  requestUrl.searchParams.set('revision', revision);
  if (base !== undefined) requestUrl.searchParams.set('base', base);
  const response = await fetch(requestUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Blueprint could not load revision ${revision}.`);
  const answer = await response.json() as Partial<BlueprintProjectSnapshot & BlueprintProjectSnapshotDelta>;
  if (answer.version !== 1 || typeof answer.revision !== 'string' || (!answer.bundle && !answer.delta)) {
    throw new Error('Blueprint returned an invalid live project snapshot.');
  }
  return answer as BlueprintProjectSnapshot | BlueprintProjectSnapshotDelta;
}

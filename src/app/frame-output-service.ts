import type { CanvasProjectBundle, ScreenDefinition } from '../core/types';
import { compilePrototypeDocument } from '../prototype/compiler';
import { type FrameOutputTarget, type FrameShape, createFrameOutputHasher, frameOutputOutsideRules, frameTargetIn } from './frame-output';
import { changedBundlePaths, frameNeedsRebuild, onlyTokenValuesChanged, rebuildScope } from './frame-rebuild';
import { screenTokenReads } from './frame-token-reads';
import { declaredFrameUses } from './frame-uses';

export type FrameOutputRequest =
  | { kind: 'snapshot'; snapshot: number; bundle: CanvasProjectBundle }
  | { kind: 'release'; snapshot: number }
  | { kind: 'compare'; request: number; before: number; after: number; targets: FrameOutputTarget[] }
  | { kind: 'document'; request: number; snapshot: number; target: FrameOutputTarget; assetOrigin: string };

export type FrameOutputAnswer =
  | { kind: 'compare'; request: number; changed: string[]; unconfirmable: string[] }
  | { kind: 'document'; request: number; html: string }
  | { kind: 'failed'; request: number; message: string };

interface FrameOutputSnapshot {
  bundle: CanvasProjectBundle;
  hashes: Map<string, string>;
  shapes: Map<string, FrameShape>;
}

export function framesInChangeScope<T extends { screenId: string }>(
  before: CanvasProjectBundle,
  after: CanvasProjectBundle,
  targets: readonly T[],
  readsTokens = true
): T[] {
  const scope = rebuildScope(changedBundlePaths(before, after), before, after);
  if (!scope) return [...targets];
  const screens = new Map<string, ScreenDefinition>(after.screens.screens.map(screen => [screen.id, screen]));
  return targets.filter(target => {
    const screen = screens.get(target.screenId);
    if (!screen) return true;
    return frameNeedsRebuild(scope, target.screenId, declaredFrameUses(after, screen).usedBoundaryIds, readsTokens ? screenTokenReads(after, screen) : undefined);
  });
}

export function createFrameOutputService(createHasher = createFrameOutputHasher): (request: FrameOutputRequest) => FrameOutputAnswer | undefined {
  const snapshots = new Map<number, FrameOutputSnapshot>();
  const snapshotById = (id: number): FrameOutputSnapshot => {
    const snapshot = snapshots.get(id);
    if (!snapshot) throw new Error(`The frame output service does not hold snapshot ${id}.`);
    return snapshot;
  };
  /** The compile session behind a hasher holds hundreds of MB on a large project, so it lives only for one compare. */
  const hasherOf = (snapshot: FrameOutputSnapshot): ((target: FrameOutputTarget) => string) => {
    let hasher: ReturnType<typeof createHasher> | undefined;
    return target => {
      let hash = snapshot.hashes.get(target.key);
      if (hash === undefined) {
        hasher ??= createHasher(snapshot.bundle, snapshot.shapes);
        hash = hasher(target);
        snapshot.hashes.set(target.key, hash);
      }
      return hash;
    };
  };
  return request => {
    if (request.kind === 'snapshot') {
      snapshots.set(request.snapshot, { bundle: request.bundle, hashes: new Map(), shapes: new Map() });
      return undefined;
    }
    if (request.kind === 'release') {
      snapshots.delete(request.snapshot);
      return undefined;
    }
    try {
      if (request.kind === 'document') {
        const { screenId, state, preset } = request.target;
        return {
          kind: 'document',
          request: request.request,
          html: compilePrototypeDocument({
            bundle: snapshotById(request.snapshot).bundle,
            target: { kind: 'screen', id: screenId },
            state,
            framePreset: preset,
            assetOrigin: request.assetOrigin
          }).html
        };
      }
      const before = snapshotById(request.before);
      const after = snapshotById(request.after);
      if (after.shapes !== before.shapes && onlyTokenValuesChanged(before.bundle, after.bundle)) after.shapes = before.shapes;
      const hashOfBefore = hasherOf(before);
      const hashAfter = hasherOf(after);
      const hashBefore = (target: FrameOutputTarget): string => hashOfBefore(frameTargetIn(before.bundle, target));
      const resized = (target: FrameOutputTarget): boolean => {
        const { width, height } = frameTargetIn(before.bundle, target).preset;
        return width !== target.preset.width || height !== target.preset.height;
      };
      const changed = framesInChangeScope(before.bundle, after.bundle, request.targets)
        .filter(target => resized(target) || hashBefore(target) !== hashAfter(target));
      const unconfirmable = changed.filter(target => resized(target) || frameOutputOutsideRules(hashBefore(target)) !== frameOutputOutsideRules(hashAfter(target)));
      return { kind: 'compare', request: request.request, changed: changed.map(target => target.key), unconfirmable: unconfirmable.map(target => target.key) };
    } catch (error) {
      return { kind: 'failed', request: request.request, message: error instanceof Error ? error.message : String(error) };
    }
  };
}

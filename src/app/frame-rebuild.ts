import { boundaryId } from '../core/address';
import type { CanvasProjectBundle } from '../core/types';
import { type ScreenTokenReads, changedTokenRefs } from './frame-token-reads';

export interface RebuildScope {
  all: boolean;
  screenIds: Set<string>;
  boundaryIds: Set<string>;
  tokenRefs: Set<string>;
}

export function frameNeedsRebuild(
  scope: RebuildScope,
  screenId: string,
  usedBoundaryIds: ReadonlySet<string> | undefined,
  tokenReads?: ScreenTokenReads
): boolean {
  if (scope.all || scope.screenIds.has(screenId) || !usedBoundaryIds) return true;
  if (scope.tokenRefs.size > 0 && (!tokenReads || tokenReads.unknown || [...scope.tokenRefs].some(ref => tokenReads.variables.has(ref)))) return true;
  return [...scope.boundaryIds].some(id => usedBoundaryIds.has(id));
}

export function rebuildScope(
  changedPaths: readonly string[],
  previous: CanvasProjectBundle | undefined,
  next: CanvasProjectBundle
): RebuildScope | undefined {
  const scope: RebuildScope = { all: false, screenIds: new Set(), boundaryIds: new Set(), tokenRefs: new Set() };
  const projectId = next.manifest.project.id;
  for (const changedPath of changedPaths) {
    if (
      changedPath === 'manifest.json' || changedPath === 'screens.json' ||
      changedPath.startsWith('explorations/') || changedPath.startsWith('history/')
    ) return undefined;
    if (changedPath === 'inspo.json' || changedPath.startsWith('inspo/')) continue;
    if (changedPath === 'tokens.json' && previous) {
      for (const ref of changedTokenRefs(previous, next)) scope.tokenRefs.add(ref);
      continue;
    }
    if (changedPath === 'tokens.json' || changedPath === 'brand.json' || changedPath.startsWith('brand/')) {
      scope.all = true;
      continue;
    }
    if (changedPath === 'primitives.json' || changedPath === 'components.json') {
      const kind = changedPath === 'primitives.json' ? 'primitive' : 'component';
      if (!previous) {
        scope.all = true;
        continue;
      }
      const before = definitionsById(previous, kind);
      const after = definitionsById(next, kind);
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(id) !== after.get(id)) scope.boundaryIds.add(boundaryId(projectId, kind, id));
      }
      continue;
    }
    const owners = reusables(next).filter(({ reusable }) => reusable.prototype.source === changedPath || reusable.prototype.styles.includes(changedPath));
    for (const { kind, reusable } of owners) scope.boundaryIds.add(boundaryId(projectId, kind, reusable.id));
    const screens = next.screens.screens.filter(screen => screen.prototype && [
      screen.prototype.source,
      ...screen.prototype.styles,
      ...screen.prototype.assetRefs
    ].includes(changedPath));
    for (const screen of screens) scope.screenIds.add(screen.id);
    if (owners.length > 0 || screens.length > 0) continue;
    if (changedPath.startsWith('prototype/primitives/') || changedPath.startsWith('prototype/components/')) {
      scope.all = true;
      continue;
    }
    return undefined;
  }
  return scope;
}

/** A comparison with the change baseline can span more than one change event, so the paths of one event are not enough. */
export function changedBundlePaths(previous: CanvasProjectBundle, next: CanvasProjectBundle): string[] {
  const files: Array<[string, (bundle: CanvasProjectBundle) => unknown]> = [
    ['manifest.json', bundle => bundle.manifest],
    ['tokens.json', bundle => bundle.tokens],
    ['primitives.json', bundle => bundle.primitives],
    ['components.json', bundle => bundle.components],
    ['screens.json', bundle => bundle.screens],
    ['brand.json', bundle => bundle.brand]
  ];
  const paths = files.filter(([, read]) => JSON.stringify(read(previous)) !== JSON.stringify(read(next))).map(([changedPath]) => changedPath);
  for (const changedPath of new Set([...Object.keys(previous.prototypeSourceContents), ...Object.keys(next.prototypeSourceContents)])) {
    if (previous.prototypeSourceContents[changedPath] !== next.prototypeSourceContents[changedPath]) paths.push(changedPath);
  }
  for (const changedPath of new Set([...Object.keys(previous.prototypeAssetContents), ...Object.keys(next.prototypeAssetContents)])) {
    if (JSON.stringify(previous.prototypeAssetContents[changedPath]) !== JSON.stringify(next.prototypeAssetContents[changedPath])) paths.push(changedPath);
  }
  return paths;
}

function reusables(bundle: CanvasProjectBundle) {
  return [
    ...bundle.primitives.primitives.map(reusable => ({ kind: 'primitive' as const, reusable })),
    ...bundle.components.components.map(reusable => ({ kind: 'component' as const, reusable }))
  ];
}

function definitionsById(bundle: CanvasProjectBundle, kind: 'primitive' | 'component'): Map<string, string> {
  return new Map(reusables(bundle).filter(entry => entry.kind === kind).map(({ reusable }) => [reusable.id, JSON.stringify(reusable)]));
}

import { boundaryId } from '../core/address';
import type { CanvasProjectBundle } from '../core/types';

export interface RebuildScope {
  all: boolean;
  screenIds: Set<string>;
  boundaryIds: Set<string>;
}

export function frameNeedsRebuild(scope: RebuildScope, screenId: string, usedBoundaryIds: ReadonlySet<string> | undefined): boolean {
  if (scope.all || scope.screenIds.has(screenId) || !usedBoundaryIds) return true;
  return [...scope.boundaryIds].some(id => usedBoundaryIds.has(id));
}

export function rebuildScope(
  changedPaths: readonly string[],
  previous: CanvasProjectBundle | undefined,
  next: CanvasProjectBundle
): RebuildScope | undefined {
  const scope: RebuildScope = { all: false, screenIds: new Set(), boundaryIds: new Set() };
  const projectId = next.manifest.project.id;
  for (const changedPath of changedPaths) {
    if (
      changedPath === 'manifest.json' || changedPath === 'screens.json' ||
      changedPath.startsWith('explorations/') || changedPath.startsWith('history/')
    ) return undefined;
    if (changedPath === 'inspo.json' || changedPath.startsWith('inspo/')) continue;
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

function reusables(bundle: CanvasProjectBundle) {
  return [
    ...bundle.primitives.primitives.map(reusable => ({ kind: 'primitive' as const, reusable })),
    ...bundle.components.components.map(reusable => ({ kind: 'component' as const, reusable }))
  ];
}

function definitionsById(bundle: CanvasProjectBundle, kind: 'primitive' | 'component'): Map<string, string> {
  return new Map(reusables(bundle).filter(entry => entry.kind === kind).map(({ reusable }) => [reusable.id, JSON.stringify(reusable)]));
}

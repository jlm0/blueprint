import { activityFocusForBoundary, type BlueprintAgentActivityFocus } from './activity';
import type { BlueprintProjectBundle, BoundaryKind } from './types';

/** Boundaries whose declaration or owned prototype files differ between two snapshots; removed boundaries are omitted. */
export function changedBoundaries(previous: BlueprintProjectBundle, next: BlueprintProjectBundle): BlueprintAgentActivityFocus[] {
  const changed: BlueprintAgentActivityFocus[] = [];
  const compare = <T extends { id: string }>(kind: BoundaryKind, before: T[], after: T[], files: (item: T) => string[]): void => {
    const priorById = new Map(before.map(item => [item.id, item]));
    for (const item of after) {
      const prior = priorById.get(item.id);
      if (!prior || boundaryFingerprint(previous, prior, files(prior)) !== boundaryFingerprint(next, item, files(item))) {
        changed.push(activityFocusForBoundary(next, kind, item.id));
      }
    }
  };
  compare('token-group', previous.tokens.tokenGroups, next.tokens.tokenGroups, () => []);
  compare('primitive', previous.primitives.primitives, next.primitives.primitives, primitive => (
    [primitive.prototype.source, ...primitive.prototype.styles]
  ));
  compare('component', previous.components.components, next.components.components, component => (
    [component.prototype.source, ...component.prototype.styles]
  ));
  compare('screen', previous.screens.screens, next.screens.screens, screen => (
    [screen.prototype.source, ...screen.prototype.styles, ...screen.prototype.assetRefs]
  ));
  return changed;
}

function boundaryFingerprint(bundle: BlueprintProjectBundle, declaration: unknown, files: string[]): string {
  return JSON.stringify([declaration, files.map(file => bundle.prototypeSourceContents[file] ?? null)]);
}

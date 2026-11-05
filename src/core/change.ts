import { activityFocusForBoundary, BRAND_FOCUS_ID, FRAME_PRESETS_FOCUS_ID, INSPO_FOCUS_ID, type BlueprintAgentActivityFocus } from './activity';
import type { BlueprintProjectBundle, BoundaryKind, PrototypeAsset } from './types';

/** Boundaries whose declaration or owned prototype files differ between two snapshots. A removed boundary is omitted, except a token group, because a frame can read a token through a `var()` fallback. */
export function changedBoundaries(previous: BlueprintProjectBundle<PrototypeAsset>, next: BlueprintProjectBundle<PrototypeAsset>): BlueprintAgentActivityFocus[] {
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
  for (const group of previous.tokens.tokenGroups) {
    if (!next.tokens.tokenGroups.some(candidate => candidate.id === group.id)) changed.push(activityFocusForBoundary(next, 'token-group', group.id));
  }
  if (JSON.stringify(previous.manifest.framePresets) !== JSON.stringify(next.manifest.framePresets)) {
    changed.push(activityFocusForBoundary(next, 'project', FRAME_PRESETS_FOCUS_ID));
  }
  if (next.brand && brandFingerprint(previous) !== brandFingerprint(next)) {
    changed.push(activityFocusForBoundary(next, 'project', BRAND_FOCUS_ID));
  }
  if (next.inspo && JSON.stringify(previous.inspo ?? null) !== JSON.stringify(next.inspo)) {
    changed.push(activityFocusForBoundary(next, 'project', INSPO_FOCUS_ID));
  }
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

function brandFingerprint(bundle: BlueprintProjectBundle<PrototypeAsset>): string {
  const marks = bundle.brand?.marks ?? [];
  return JSON.stringify([bundle.brand ?? null, marks.map(mark => bundle.prototypeSourceContents[mark.source] ?? null)]);
}

function assetFingerprint(asset: PrototypeAsset | undefined): string | null {
  if (!asset) return null;
  return 'sha256' in asset ? asset.sha256 : asset.base64;
}

function boundaryFingerprint(bundle: BlueprintProjectBundle<PrototypeAsset>, declaration: unknown, files: string[]): string {
  return JSON.stringify([declaration, files.map(file => bundle.prototypeSourceContents[file] ?? assetFingerprint(bundle.prototypeAssetContents[file]))]);
}

import { boundaryId } from './address';
import type { BlueprintProjectBundle, BoundaryKind } from './types';

export type BlueprintAgentActivityPhase = 'started' | 'completed' | 'failed';

export interface BlueprintAgentActivityFocus {
  boundaryId: string;
  kind: BoundaryKind;
  localId: string;
  board: 'primitives' | 'screens' | null;
  screenId?: string;
}

export interface BlueprintAgentActivityEvent {
  version: 1;
  sessionId: string;
  turnId?: string;
  toolUseId: string;
  toolName: string;
  phase: BlueprintAgentActivityPhase;
  label: string;
  emittedAt: string;
  focus: BlueprintAgentActivityFocus;
  focuses: BlueprintAgentActivityFocus[];
  revision?: string;
  projectValid?: boolean;
}

export interface BlueprintProjectChangedEvent {
  version: 1;
  revision: string;
  changedAt: string;
  changedPaths: string[];
}

export interface BlueprintProjectErrorEvent {
  version: 1;
  message: string;
  changedAt: string;
}

export interface BlueprintProjectSnapshot {
  version: 1;
  revision: string;
  bundle: BlueprintProjectBundle;
}

interface SourceReferenceOwner {
  kind: BoundaryKind;
  id: string;
}

export function activityFocusForBoundary(
  bundle: BlueprintProjectBundle,
  kind: BoundaryKind,
  localId: string
): BlueprintAgentActivityFocus {
  const screenId = kind === 'section' ? localId.split('/')[0] : kind === 'screen' ? localId : undefined;
  return {
    boundaryId: boundaryId(bundle.manifest.project.id, kind, localId),
    kind,
    localId,
    board: boardForBoundary(kind),
    ...(screenId ? { screenId } : {})
  };
}

/**
 * Every boundary whose governed source path appears in free-form tool input.
 * Longer paths are consumed first so a path is never also credited to a shorter one it contains.
 */
export function activityFocusesForSourceText(bundle: BlueprintProjectBundle, text: string): BlueprintAgentActivityFocus[] {
  let remaining = text.replaceAll('\\', '/');
  const owners: SourceReferenceOwner[] = [];
  const references = [...sourceReferenceOwners(bundle)].sort(([left], [right]) => right.length - left.length);
  for (const [ref, refOwners] of references) {
    if (!remaining.includes(ref)) continue;
    remaining = remaining.replaceAll(ref, '\u0000');
    owners.push(...refOwners);
  }
  return uniqueFocuses(bundle, owners);
}

export function activityFocusesForChangedPaths(
  bundle: BlueprintProjectBundle,
  changedPaths: string[]
): BlueprintAgentActivityFocus[] {
  const references = sourceReferenceOwners(bundle);
  return uniqueFocuses(bundle, changedPaths.flatMap(changedPath => references.get(changedPath.replaceAll('\\', '/')) ?? []));
}

export function boundaryDisplayName(bundle: BlueprintProjectBundle, kind: BoundaryKind, localId: string): string {
  if (kind === 'project') return bundle.manifest.project.name;
  if (kind === 'board') return localId === 'screens' ? 'Screens' : 'Primitives';
  if (kind === 'token-group') {
    return bundle.tokens.tokenGroups.find(candidate => candidate.id === localId)?.name ?? localId;
  }
  if (kind === 'primitive') {
    return bundle.primitives.primitives.find(candidate => candidate.id === localId)?.name ?? localId;
  }
  if (kind === 'component') {
    return bundle.components.components.find(candidate => candidate.id === localId)?.name ?? localId;
  }
  if (kind === 'screen') {
    return bundle.screens.screens.find(candidate => candidate.id === localId)?.name ?? localId;
  }
  if (kind === 'section') {
    const [screenId, sectionId] = localId.split('/');
    return bundle.screens.screens
      .find(candidate => candidate.id === screenId)
      ?.sections.find(candidate => candidate.id === sectionId)?.name ?? localId;
  }
  if (kind === 'state-set') {
    const [primitiveId, stateSetId] = localId.split('/');
    return bundle.primitives.primitives
      .find(candidate => candidate.id === primitiveId)
      ?.stateSets.find(candidate => candidate.id === stateSetId)?.name ?? localId;
  }
  return localId;
}

function sourceReferenceOwners(bundle: BlueprintProjectBundle): Map<string, SourceReferenceOwner[]> {
  const references = new Map<string, SourceReferenceOwner[]>();
  const add = (refs: string[], kind: BoundaryKind, id: string): void => {
    for (const ref of refs) {
      const normalized = ref.replaceAll('\\', '/');
      references.set(normalized, [...references.get(normalized) ?? [], { kind, id }]);
    }
  };
  for (const primitive of bundle.primitives.primitives) {
    if (primitive.prototype) add([primitive.prototype.source, ...primitive.prototype.styles], 'primitive', primitive.id);
  }
  for (const component of bundle.components.components) {
    if (component.prototype) add([component.prototype.source, ...component.prototype.styles], 'component', component.id);
  }
  for (const screen of bundle.screens.screens) {
    if (screen.prototype) {
      add([screen.prototype.source, ...screen.prototype.styles, ...screen.prototype.assetRefs], 'screen', screen.id);
    }
  }
  for (const exploration of bundle.explorations.explorations) {
    for (const prototype of [exploration.target.baseline.prototype, ...exploration.candidates.map(candidate => candidate.prototype)]) {
      add([prototype.source, ...prototype.styles, ...prototype.assetRefs], 'screen', exploration.target.screenId);
    }
  }
  for (const entry of bundle.history.entries) {
    if (entry.screen.prototype) {
      add([entry.screen.prototype.source, ...entry.screen.prototype.styles, ...entry.screen.prototype.assetRefs], 'screen', entry.screenId);
    }
  }
  return references;
}

function uniqueFocuses(bundle: BlueprintProjectBundle, owners: SourceReferenceOwner[]): BlueprintAgentActivityFocus[] {
  const focuses = new Map<string, BlueprintAgentActivityFocus>();
  for (const owner of owners) {
    const focus = activityFocusForBoundary(bundle, owner.kind, owner.id);
    if (!focuses.has(focus.boundaryId)) focuses.set(focus.boundaryId, focus);
  }
  return [...focuses.values()];
}

function boardForBoundary(kind: BoundaryKind): 'primitives' | 'screens' | null {
  if (kind === 'screen' || kind === 'section') return 'screens';
  if (kind === 'board' || kind === 'project') return null;
  return 'primitives';
}

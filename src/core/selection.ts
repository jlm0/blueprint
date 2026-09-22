import type { BlueprintProjectBundle, BoundaryKind } from './types';

export interface BlueprintSelectedBoundary {
  boundaryId: string;
  kind: BoundaryKind;
  localId: string;
  label: string;
}

export type BlueprintSelectionFrameRole = 'current' | 'version' | 'baseline' | 'candidate';

export interface BlueprintCanvasSelection extends BlueprintSelectedBoundary {
  context: BlueprintSelectedBoundary[];
  screenId?: string;
  state?: string;
  framePresetId?: string;
  explorationId?: string;
  explorationRole?: BlueprintSelectionFrameRole;
  candidateId?: string;
  historyVersion?: number;
}

const selectableKinds = new Set<BoundaryKind>(['token-group', 'primitive', 'state-set', 'component', 'screen', 'section']);
const frameRoles = new Set<string>(['current', 'version', 'baseline', 'candidate']);
const maximumContextDepth = 16;
const maximumFieldLength = 512;

export function isSelectableBoundaryKind(kind: string): kind is BoundaryKind {
  return selectableKinds.has(kind as BoundaryKind);
}

export function selectionReference(selection: BlueprintCanvasSelection): string {
  const boundaries = [selection, ...selection.context].map(boundary => `${boundary.kind}:${boundary.localId}`);
  if (selection.explorationId && selection.candidateId) {
    boundaries.push(`exploration:${selection.explorationId} candidate:${selection.candidateId}`);
  } else if (selection.explorationId && selection.explorationRole === 'baseline') {
    boundaries.push(`exploration:${selection.explorationId} baseline`);
  } else if (selection.historyVersion !== undefined) {
    boundaries.push(`history version:${selection.historyVersion}`);
  }
  return boundaries.join(' in ');
}

export function selectionSourceFiles(bundle: BlueprintProjectBundle, selection: BlueprintCanvasSelection): string[] {
  const framePrototype = selectedFramePrototype(bundle, selection);
  for (const boundary of [selection, ...selection.context]) {
    const files = framePrototype && (boundary.kind === 'screen' || boundary.kind === 'section')
      ? [framePrototype.source, ...framePrototype.styles]
      : boundarySourceFiles(bundle, boundary.kind, boundary.localId);
    if (files.length > 0) return files;
  }
  return [];
}

export function parseCanvasSelection(value: unknown): BlueprintCanvasSelection | undefined {
  if (!isRecord(value)) return undefined;
  const target = parseSelectedBoundary(value);
  if (!target || !Array.isArray(value.context) || value.context.length > maximumContextDepth) return undefined;
  const context = value.context.map(parseSelectedBoundary);
  if (context.some(boundary => boundary === undefined)) return undefined;
  const optional: Partial<BlueprintCanvasSelection> = {};
  for (const key of ['screenId', 'state', 'framePresetId', 'explorationId', 'candidateId'] as const) {
    if (value[key] === undefined) continue;
    if (!isField(value[key])) return undefined;
    optional[key] = value[key];
  }
  if (value.explorationRole !== undefined) {
    if (typeof value.explorationRole !== 'string' || !frameRoles.has(value.explorationRole)) return undefined;
    optional.explorationRole = value.explorationRole as BlueprintSelectionFrameRole;
  }
  if (value.historyVersion !== undefined) {
    if (typeof value.historyVersion !== 'number' || !Number.isSafeInteger(value.historyVersion) || value.historyVersion < 1) return undefined;
    optional.historyVersion = value.historyVersion;
  }
  return { ...target, context: context as BlueprintSelectedBoundary[], ...optional };
}

function selectedFramePrototype(
  bundle: BlueprintProjectBundle,
  selection: BlueprintCanvasSelection
): { source: string; styles: string[] } | undefined {
  const exploration = selection.explorationId
    ? bundle.explorations.explorations.find(candidate => candidate.id === selection.explorationId)
    : undefined;
  if (exploration && selection.candidateId) {
    return exploration.candidates.find(candidate => candidate.id === selection.candidateId)?.prototype;
  }
  if (exploration && selection.explorationRole === 'baseline') return exploration.target.baseline.prototype;
  if (selection.historyVersion !== undefined) {
    return bundle.history.entries.find(entry => (
      entry.screenId === selection.screenId && entry.version === selection.historyVersion
    ))?.screen.prototype;
  }
  return undefined;
}

function boundarySourceFiles(bundle: BlueprintProjectBundle, kind: BoundaryKind, localId: string): string[] {
  const [ownerId] = localId.split('/');
  const prototype = kind === 'primitive' || kind === 'state-set'
    ? bundle.primitives.primitives.find(primitive => primitive.id === ownerId)?.prototype
    : kind === 'component'
      ? bundle.components.components.find(component => component.id === ownerId)?.prototype
      : kind === 'screen' || kind === 'section'
        ? bundle.screens.screens.find(screen => screen.id === ownerId)?.prototype
        : undefined;
  return prototype ? [prototype.source, ...prototype.styles] : [];
}

function parseSelectedBoundary(value: unknown): BlueprintSelectedBoundary | undefined {
  if (!isRecord(value)) return undefined;
  const { boundaryId, kind, localId, label } = value;
  if (!isField(boundaryId) || !isField(localId) || !isField(label)) return undefined;
  if (typeof kind !== 'string' || !isSelectableBoundaryKind(kind)) return undefined;
  if (!boundaryId.endsWith(`/${kind}/${localId}`)) return undefined;
  return { boundaryId, kind, localId, label };
}

function isField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumFieldLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

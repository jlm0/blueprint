import type { BlueprintProjectBundle, BoundaryKind } from './types';

export interface BlueprintSelectedBoundary {
  boundaryId: string;
  kind: BoundaryKind;
  localId: string;
  label: string;
}

export interface BlueprintCanvasSelection extends BlueprintSelectedBoundary {
  context: BlueprintSelectedBoundary[];
  screenId?: string;
  state?: string;
  framePresetId?: string;
}

const selectableKinds = new Set<BoundaryKind>(['token-group', 'primitive', 'state-set', 'component', 'screen', 'section']);
const maximumContextDepth = 16;
const maximumFieldLength = 512;

export function isSelectableBoundaryKind(kind: string): kind is BoundaryKind {
  return selectableKinds.has(kind as BoundaryKind);
}

export function selectionReference(selection: BlueprintCanvasSelection): string {
  return [selection, ...selection.context].map(boundary => `${boundary.kind}:${boundary.localId}`).join(' in ');
}

export function selectionSourceFiles(bundle: BlueprintProjectBundle, selection: BlueprintCanvasSelection): string[] {
  for (const boundary of [selection, ...selection.context]) {
    const files = boundarySourceFiles(bundle, boundary.kind, boundary.localId);
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
  const optional: Partial<Record<'screenId' | 'state' | 'framePresetId', string>> = {};
  for (const key of ['screenId', 'state', 'framePresetId'] as const) {
    if (value[key] === undefined) continue;
    if (!isField(value[key])) return undefined;
    optional[key] = value[key];
  }
  return { ...target, context: context as BlueprintSelectedBoundary[], ...optional };
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

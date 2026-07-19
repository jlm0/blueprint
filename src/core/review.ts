import { boundaryId } from './address';
import { listBoundaryReferences } from './query';
import type { BlueprintProjectBundle, BoardKind, BoundaryKind, BoundaryReference, ScreenSection } from './types';

export interface SectionProjectionSummary {
  boundaryId: string;
  kind: 'section';
  projectId: string;
  screenId: string;
  localId: string;
  name: string;
  description: string;
  prototypeOnly: boolean;
  dependencyCount: number;
  dependencySummary: string[];
}

export interface VisibleBoundaryRecord {
  id: string;
  kind: BoundaryKind;
  board: BoardKind;
  label: string;
  screenId?: string;
  renderedSnippet?: string;
  computedStyles?: Record<string, string>;
}

export interface VisibleBoundarySyncResult {
  ok: boolean;
  errors: string[];
  records: VisibleBoundaryRecord[];
}

export interface ReviewManifestOptions {
  generatedAt?: string;
  board: BoardKind;
  screenId?: string;
  screenshotPath?: string;
  /** Explicit status when no captured screenshot exists. Defaults to capture-ready. */
  captureStatus?: 'capture-ready' | 'unresolved';
  /** Required explanation when captureStatus is unresolved. */
  captureReason?: string;
  /** Exact governed source, state, and viewport selected for a prototype review. */
  prototypeReview?: PrototypeReviewManifestContext;
  packetCommandBase?: string;
}

export interface PrototypeReviewManifestContext {
  source: string;
  state: string;
  framePresetId: string;
  conditionId: string;
}

export interface ReviewCaptureRecord {
  status: 'captured' | 'capture-ready' | 'unresolved';
  path?: string;
  reason?: string;
}

export interface BoundaryReviewManifestEntry {
  boundaryId: string;
  kind: BoundaryKind;
  localId: string;
  label: string;
  board: BoardKind;
  screenId?: string;
  capture: ReviewCaptureRecord;
  /** Backward-compatible alias for capture. */
  screenshot: ReviewCaptureRecord;
  packet: {
    status: 'available' | 'unavailable';
    command?: string;
  };
}

export interface ReviewManifest {
  schemaVersion: '1.0.0';
  projectId: string;
  sourceRoot: string;
  generatedAt: string;
  board: BoardKind;
  screenId?: string;
  prototypeReview?: PrototypeReviewManifestContext;
  capture: ReviewCaptureRecord;
  /** Backward-compatible alias for capture. */
  screenshot: ReviewCaptureRecord;
  boundaries: BoundaryReviewManifestEntry[];
}

export interface CanvasStyleEvidenceOptions {
  generatedAt?: string;
  screenshotPath?: string;
}

export interface CanvasStyleEvidenceEntry {
  boundaryId: string;
  kind: BoundaryKind;
  label: string;
  status: 'captured' | 'unresolved';
  evidenceType: 'canvas-dom';
  renderedSnippet?: string;
  computedStyles?: Record<string, string>;
  screenshotPath?: string;
}

export interface CanvasStyleEvidenceArtifact {
  schemaVersion: '1.0.0';
  projectId: string;
  generatedAt: string;
  boundaries: CanvasStyleEvidenceEntry[];
}

export function summarizeScreenSections(bundle: BlueprintProjectBundle, screenId: string): SectionProjectionSummary[] {
  const screen = bundle.screens.screens.find(candidate => candidate.id === screenId);
  if (!screen) {
    throw new Error(`Unknown screen "${screenId}".`);
  }

  const projectId = bundle.manifest.project.id;
  return screen.sections.map(section => sectionSummary(projectId, screen.id, section));
}

export function validateVisibleBoundaryRecords(
  bundle: BlueprintProjectBundle,
  records: VisibleBoundaryRecord[]
): VisibleBoundarySyncResult {
  const references = new Map<string, BoundaryReference>();
  for (const ref of listBoundaryReferences(bundle)) {
    references.set(ref.id, ref);
  }

  const errors: string[] = [];
  for (const record of records) {
    const ref = references.get(record.id);
    if (!ref) {
      errors.push(`Visible boundary "${record.id}" does not exist in structured data.`);
      continue;
    }
    if (ref.kind !== record.kind) {
      errors.push(`Visible boundary "${record.id}" declares kind "${record.kind}" but structured data has "${ref.kind}".`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    records
  };
}

export function createReviewManifest(
  bundle: BlueprintProjectBundle,
  records: VisibleBoundaryRecord[],
  options: ReviewManifestOptions
): ReviewManifest {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const references = new Map(listBoundaryReferences(bundle).map(ref => [ref.id, ref]));
  const capture = createCaptureRecord(options);

  return {
    schemaVersion: '1.0.0',
    projectId: bundle.manifest.project.id,
    sourceRoot: bundle.sourceRoot,
    generatedAt,
    board: options.board,
    screenId: options.screenId,
    prototypeReview: options.prototypeReview,
    capture,
    screenshot: capture,
    boundaries: records.map(record => {
      const ref = references.get(record.id);
      const localId = ref?.localId ?? localIdFromBoundary(record.id);
      return {
        boundaryId: record.id,
        kind: record.kind,
        localId,
        label: record.label,
        board: record.board,
        screenId: record.screenId,
        capture,
        screenshot: capture,
        packet: createPacketLink(bundle, record.kind, localId, options.packetCommandBase)
      };
    })
  };
}

export function createCanvasStyleEvidence(
  bundle: BlueprintProjectBundle,
  records: VisibleBoundaryRecord[],
  options: CanvasStyleEvidenceOptions = {}
): CanvasStyleEvidenceArtifact {
  return {
    schemaVersion: '1.0.0',
    projectId: bundle.manifest.project.id,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    boundaries: records.map(record => ({
      boundaryId: record.id,
      kind: record.kind,
      label: record.label,
      status: record.renderedSnippet || record.computedStyles ? 'captured' : 'unresolved',
      evidenceType: 'canvas-dom',
      renderedSnippet: record.renderedSnippet,
      computedStyles: record.computedStyles,
      screenshotPath: options.screenshotPath
    }))
  };
}

function sectionSummary(projectId: string, screenId: string, section: ScreenSection): SectionProjectionSummary {
  const localId = `${screenId}/${section.id}`;
  return {
    boundaryId: boundaryId(projectId, 'section', localId),
    kind: 'section',
    projectId,
    screenId,
    localId,
    name: section.name,
    description: section.description,
    prototypeOnly: section.prototypeOnly,
    dependencyCount: section.uses.length,
    dependencySummary: section.uses.map(dependency => `${dependency.kind}:${dependency.id}`)
  };
}

function createCaptureRecord(options: ReviewManifestOptions): ReviewCaptureRecord {
  if (options.screenshotPath) {
    return {
      status: 'captured',
      path: options.screenshotPath
    };
  }

  if (options.captureStatus === 'unresolved') {
    if (!options.captureReason?.trim()) {
      throw new Error('Review manifests with unresolved capture status require a capture reason.');
    }
    return {
      status: 'unresolved',
      reason: options.captureReason
    };
  }

  return {
    status: 'capture-ready'
  };
}

function createPacketLink(
  bundle: BlueprintProjectBundle,
  kind: BoundaryKind,
  localId: string,
  packetCommandBase: string | undefined
): BoundaryReviewManifestEntry['packet'] {
  if (!packetCommandBase) {
    return {
      status: 'unavailable'
    };
  }

  return {
    status: 'available',
    command: `${packetCommandBase} --project ${bundle.sourceRoot} --boundary ${kind}:${localId} --mode deep`
  };
}

function localIdFromBoundary(id: string): string {
  return id.split('/').slice(2).join('/');
}

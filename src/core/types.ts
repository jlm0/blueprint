export type { BoundaryKind, ReadinessItem, ReadinessReport, ReadinessSeverity, ReadinessSource, ReadinessTier, TokenUsage } from './schemas/handoff';
export type { BrandFile, BrandFont, BrandFontSource, BrandMark, BrandMarkRole, BrandMarkVariant, BrandTrait, BrandUsage, BrandVoice } from './schemas/brand';
export type { DeclaredGroup, ImplementationTarget, LocalValueException, ReusableKind, StyleEvidence, StyleEvidenceStatus } from './schemas/common';
export type { ComponentDefinition, ComponentFile } from './schemas/components';
export type { InspoAspect, InspoDirection, InspoEntry, InspoFile } from './schemas/inspo';
export type { BlueprintManifest, BoardDefinition, BoardKind, FramePreset, ProjectManifest, PrototypeHostPolicy } from './schemas/manifest';
export type { PrimitiveDefinition, PrimitiveFile } from './schemas/primitives';
export type {
  ExplorationBaseline,
  ExplorationCandidate,
  ExplorationDefinition,
  ExplorationFile,
  ExplorationLifecycle,
  ExplorationPrototypeSource,
  ExplorationRecordFile,
  ExplorationTarget,
  ScreenHistoryEntry,
  ScreenHistoryFile,
  ScreenHistoryRecordFile,
  ScreenHistoryReplacement
} from './schemas/records';
export type {
  Platform,
  ReusableAxis,
  ReusableAxisValue,
  ReusableDefinition,
  ReusableDependency,
  ReusablePrototypeSource,
  ReusableSlot,
  ReusableUnsupportedCombination
} from './schemas/reusable';
export type {
  BoundaryDependency,
  CompositionBinding,
  ProductionRelationship,
  ProductionRelationshipKind,
  PrototypeSource,
  PrototypeUseDeclaration,
  ReviewCondition,
  SavedScreen,
  ScreenDefinition,
  ScreenFile,
  ScreenPrototypeSource,
  ScreenSection
} from './schemas/screens';
export type { DesignToken, TokenFile, TokenGroup } from './schemas/tokens';

import type { BoundaryKind, TokenUsage } from './schemas/handoff';
import type { BrandFile } from './schemas/brand';
import type { StyleEvidence } from './schemas/common';
import type { ComponentFile } from './schemas/components';
import type { InspoFile } from './schemas/inspo';
import type { BlueprintManifest } from './schemas/manifest';
import type { PrimitiveFile } from './schemas/primitives';
import type { ExplorationFile, ScreenHistoryFile } from './schemas/records';
import type { ScreenFile } from './schemas/screens';
import type { DesignToken, TokenFile } from './schemas/tokens';

export type ReusableAxisName = 'variant' | 'size' | 'state';

export interface BlueprintProjectBundle<TAsset extends PrototypeAsset = PrototypeAssetContent> {
  manifest: BlueprintManifest;
  tokens: TokenFile;
  primitives: PrimitiveFile;
  components: ComponentFile;
  screens: ScreenFile;
  brand?: BrandFile;
  inspo?: InspoFile;
  /** Saved alternatives assembled from separate exploration records. */
  explorations: ExplorationFile;
  /** Prior canonical versions assembled from separate history records. */
  history: ScreenHistoryFile;
  /** The version of each saved record not on the current schema, keyed by record path; absent when every record is current. */
  recordSchemaVersions?: Record<string, string>;
  sourceRoot: string;
  sourceFiles: {
    manifest: string;
    tokens: string;
    primitives: string;
    components: string;
    screens: string;
    brand?: string;
    inspo?: string;
    explorationRecords: string[];
    historyRecords: string[];
    /** Normalized absolute provenance paths for every governed prototype input. */
    prototypeSources: string[];
    /** Governed exploration inputs kept separate from canonical boundary sources. */
    explorationSources: string[];
    /** Governed historical prototype inputs kept separate from canonical sources. */
    historySources: string[];
  };
  /** Serializable source text keyed by sidecar-relative path, including brand mark SVGs, for browser compilation. */
  prototypeSourceContents: Record<string, string>;
  /** Serializable controlled asset data keyed by sidecar-relative path for browser URL rewriting. */
  prototypeAssetContents: Record<string, TAsset>;
}

/** Binary-safe controlled asset payload injected into the browser compiler. */
export interface PrototypeAssetContent {
  /** Browser media type used when constructing a data or blob URL. */
  mediaType: string;
  /** Base64-encoded bytes; binary assets are never decoded as UTF-8 source text. */
  base64: string;
}

export interface PrototypeAssetLink {
  mediaType: string;
  sha256: string;
}

export type PrototypeAsset = PrototypeAssetContent | PrototypeAssetLink;

export type LinkedProjectBundle = BlueprintProjectBundle<PrototypeAssetLink>;

export type CanvasProjectBundle = BlueprintProjectBundle<PrototypeAsset>;

export interface BoundarySelector {
  kind: BoundaryKind;
  id: string;
}

export interface BoundaryReference {
  id: string;
  kind: BoundaryKind;
  projectId: string;
  localId: string;
  name: string;
}

export interface BoundaryPacket<TData = unknown> {
  id: string;
  kind: BoundaryKind;
  projectId: string;
  sourceFiles: string[];
  data: TData;
  styleRefs: string[];
  styleEvidence: StyleEvidence[];
  dependencies: {
    uses: BoundaryReference[];
    usedBy: BoundaryReference[];
  };
  notes: string[];
  prototypeOnly: boolean;
  implementationHints: string[];
  /** Canonical render source for renderable reusable boundaries. */
  rendering?: PrototypeRenderDecision;
}

/** Render source for a boundary, consumed by canvas and handoff clients. */
export interface PrototypeRenderDecision {
  mode: 'canonical-app-owned';
  source: string;
}

export type ExtractionMode = 'focused' | 'deep';

export interface ExtractionOptions {
  mode?: ExtractionMode;
}

export interface ResolvedToken {
  id: string;
  groupId: string;
  tokenId: string;
  name: string;
  type: DesignToken['type'];
  value: string;
  description: string;
  styleRef: string;
}

export interface TraversalCycle {
  from: string;
  to: string;
  path: string[];
  reason: string;
}

export interface DeepHandoffPacket<TData = unknown> extends BoundaryPacket<TData> {
  extraction: {
    mode: 'deep';
    selected: BoundaryReference;
    includedBoundaryIds: string[];
    cycles: TraversalCycle[];
    unsupportedReferences: string[];
  };
  boundaries: BoundaryPacket[];
  resolvedTokens: ResolvedToken[];
  tokenUsage: TokenUsage[];
  /** Project brand guideline every implemented boundary follows, when brand.json exists. */
  brand?: BrandFile;
}

export type ExtractionPacket = BoundaryPacket | DeepHandoffPacket;

export type ValidationMode = 'baseline' | 'strict';

export interface ValidationOptions {
  mode?: ValidationMode;
  fileExists?: (filePath: string) => boolean;
  /** Called once for each rule pass over a candidate file. */
  onCandidateFileLint?: (file: string) => void;
}

export interface ValidationResult {
  ok: boolean;
  /** Each contract error, then each style error. */
  errors: string[];
  /** The errors of the file contracts. They stop `serve` and each tool that changes the project, but an `explore` archive stops only on an error that it adds. */
  contractErrors: string[];
  /** The errors of the style rules. They refuse validate, `explore` create, `promote`, and `restore`, but the canvas shows them as finding marks. */
  styleErrors: string[];
}

export interface QueryResult {
  query: string;
  projectId: string;
  results: unknown[];
}

/** One deterministic source-graph error found before mounting or capture. */
export interface PrototypeSourceGraphIssue {
  /** Canonical boundary and state that could not compile. */
  boundaryId: string;
  /** Declared state or review-condition state inspected. */
  state: string;
  /** Actionable compiler diagnostic. */
  message: string;
}

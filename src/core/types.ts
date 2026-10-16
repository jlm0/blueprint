export type BoundaryKind = 'project' | 'board' | 'token-group' | 'primitive' | 'component' | 'screen' | 'section';

export type BoardKind = 'primitives' | 'screens';

export interface BlueprintManifest {
  schemaVersion: string;
  handoffContractVersion?: string;
  project: ProjectManifest;
  defaultBoardId: string;
  boards: BoardDefinition[];
  framePresets: FramePreset[];
  /** Governs the isolated browser-native prototype host. */
  prototypeHost: PrototypeHostPolicy;
}

/** Restricts browser-native prototype resources to deterministic sidecar-owned inputs. */
export interface PrototypeHostPolicy {
  /** Relative directories that may contain prototype assets. */
  assetRoots: string[];
  /** Network policy for the first static prototype runtime. */
  network: 'deny';
  /** Script policy for the first deterministic prototype runtime. */
  scripts: 'none';
}

export interface ProjectManifest {
  id: string;
  name: string;
  description: string;
  owner: string;
  sourceRoot: string;
}

export interface BoardDefinition {
  id: string;
  kind: BoardKind;
  name: string;
  description: string;
}

export interface FramePreset {
  id: string;
  name: string;
  type: 'mobile' | 'desktop';
  width: number;
  height: number;
  safeArea: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

export interface TokenFile {
  schemaVersion: string;
  projectId: string;
  tokenGroups: TokenGroup[];
}

export interface TokenGroup {
  id: string;
  name: string;
  description: string;
  styleRefs: string[];
  notes: string[];
  tokens: DesignToken[];
}

export interface DesignToken {
  id: string;
  name: string;
  type: 'color' | 'space' | 'size' | 'radius' | 'typography' | 'shadow' | 'motion';
  value: string;
  description: string;
  styleRef: string;
}

export interface PrimitiveFile {
  schemaVersion: string;
  projectId: string;
  primitives: PrimitiveDefinition[];
}

/** Where a reusable runs: a website or web app, a native phone app, or a native desktop app. */
export type Platform = 'web' | 'mobile' | 'desktop';

export type ReusableKind = 'primitive' | 'component';

export type ReusableAxisName = 'variant' | 'size' | 'state';

/** One named value on a reusable axis. */
export interface ReusableAxisValue {
  id: string;
  name: string;
  description: string;
}

/** Variants, sizes, or states: every value a reusable offers on that axis and the one an omitted attribute takes. */
export interface ReusableAxis {
  default: string;
  values: ReusableAxisValue[];
}

/** A variant or size that does not offer one of the reusable's states. */
export interface ReusableUnsupportedCombination {
  axis: 'variant' | 'size';
  value: string;
  state: string;
  reason: string;
}

/** A place a placement fills to customize the reusable, and what it accepts there. */
export interface ReusableSlot {
  id: string;
  name: string;
  description: string;
  /** `text`, `graphic`, `brand-mark`, `primitive:<id>`, or `component:<id>`. */
  accepts: string[];
}

/** A primitive or component the reusable's source renders. */
export interface ReusableDependency {
  kind: ReusableKind;
  id: string;
  reason: string;
}

/** Governed HTML/CSS source of a primitive or component. */
export interface ReusablePrototypeSource {
  /** Sidecar-relative HTML source path. */
  source: string;
  /** Sidecar-relative CSS source paths loaded with the HTML source. */
  styles: string[];
  /** Explicit exceptions for otherwise token-governed reusable style values. */
  localValueExceptions: LocalValueException[];
}

/** The one shape every primitive and component shares. */
export interface ReusableDefinition {
  id: string;
  name: string;
  description: string;
  /** A primitive's Blueprint group, or a component's declared entry in components.groups. */
  group: string;
  platforms: Platform[];
  uses: ReusableDependency[];
  variants: ReusableAxis;
  sizes: ReusableAxis;
  states: ReusableAxis;
  unsupported: ReusableUnsupportedCombination[];
  slots: ReusableSlot[];
  prototype: ReusablePrototypeSource;
  tokenGroupIds: string[];
  /** Token reference to reusable visual role mapping. */
  tokenRoles: Record<string, string>;
  /** The role and how assistive technology announces it. */
  accessibility: string;
  notes: string[];
  implementationHints: string[];
  implementationTargets: ImplementationTarget[];
  styleRefs: string[];
  styleEvidence: StyleEvidence[];
  prototypeOnly: boolean;
}

export type PrimitiveDefinition = ReusableDefinition;

export type ComponentDefinition = ReusableDefinition;

/** Declares one intentional reusable-style literal that is not token-governed. */
export interface LocalValueException {
  /** CSS property or design role receiving the literal. */
  property: string;
  /** Literal value retained by the app-owned source. */
  value: string;
  /** Product-specific reason the value is not reusable token state. */
  reason: string;
}

/** Shared source fields for screens. */
export interface PrototypeSource {
  /** Sidecar-relative HTML source path. */
  source: string;
  /** Sidecar-relative CSS source paths loaded with the HTML source. */
  styles: string[];
  /** Deterministic host-selected state IDs supported by the source. */
  states: string[];
  /** Optional mechanically observed reusable-boundary references for declaration cross-checking. */
  renderedUses?: PrototypeUseDeclaration[];
  /** Explicit exceptions for otherwise token-governed reusable style values. */
  localValueExceptions?: LocalValueException[];
}

/** Identifies a canonical reusable boundary instantiated by a prototype source. */
export interface PrototypeUseDeclaration {
  /** Reusable boundary category. */
  kind: ReusableKind;
  /** App-owned local boundary ID. */
  id: string;
}

export interface ScreenFile {
  schemaVersion: string;
  projectId: string;
  /** Declared screens-board pages, such as Web, Mobile, or Landing; each page is its own canvas. */
  pages: DeclaredGroup[];
  screens: ScreenDefinition[];
}

/** A named grouping that must be declared before screens or components can reference it. */
export interface DeclaredGroup {
  id: string;
  name: string;
  description?: string;
}

/** In-memory collection of non-canonical screen alternatives. */
export interface ExplorationFile {
  schemaVersion: string;
  projectId: string;
  explorations: ExplorationDefinition[];
}

/** One independently stored exploration record at explorations/<id>.json. */
export interface ExplorationRecordFile {
  schemaVersion: string;
  projectId: string;
  exploration: ExplorationDefinition;
}

export type ExplorationLifecycle = 'active' | 'archived' | 'promoted';

/** One saved comparison attached to an exact canonical screen and review condition. */
export interface ExplorationDefinition {
  id: string;
  title: string;
  intent: string;
  lifecycle: ExplorationLifecycle;
  target: ExplorationTarget;
  candidates: ExplorationCandidate[];
  /** Present only after an explicitly selected candidate has been promoted. */
  selectedCandidateId?: string;
  /** Canonical screen version created by promotion. */
  promotedScreenId?: string;
}

export interface ExplorationTarget {
  screenId: string;
  state: string;
  framePresetId: string;
  /** SHA-256 of the exact canonical screen record and its governed source bytes. */
  baseDigest: string;
  /** Immutable metadata plus governed render-source snapshot from creation time. */
  baseline: ExplorationBaseline;
}

export interface ExplorationBaseline {
  screen: ScreenDefinition;
  prototype: ExplorationPrototypeSource;
}

export interface ExplorationCandidate {
  id: string;
  label: string;
  prototype: ExplorationPrototypeSource;
}

/** Screen-local governed source for one non-canonical candidate. */
export interface ExplorationPrototypeSource {
  source: string;
  styles: string[];
  assetRefs: string[];
}

/** In-memory collection assembled from independently stored history records. */
export interface ScreenHistoryFile {
  schemaVersion: string;
  projectId: string;
  entries: ScreenHistoryEntry[];
}

/** One independently stored prior canonical version at history/<screen>-v<n>.json. */
export interface ScreenHistoryRecordFile {
  schemaVersion: string;
  projectId: string;
  entry: ScreenHistoryEntry;
}

/** Immutable prior canonical screen plus the exact review context that produced it. */
export interface ScreenHistoryEntry {
  screenId: string;
  version: number;
  state: string;
  framePresetId: string;
  screen: ScreenDefinition;
  replacedBy: ScreenHistoryReplacement;
}

export type ScreenHistoryReplacement =
  | {
      type: 'exploration-candidate';
      explorationId: string;
      candidateId: string;
    }
  | {
      type: 'history-restore';
      version: number;
    };

/** Optional brand guideline that tokens, primitives, components, and screens express. */
export interface BrandFile {
  schemaVersion: string;
  projectId: string;
  name: string;
  /** One line that positions the product. */
  tagline?: string;
  personality?: BrandTrait[];
  voice?: BrandVoice;
  marks: BrandMark[];
  usage?: BrandUsage;
}

export interface BrandTrait {
  name: string;
  description: string;
}

export interface BrandVoice {
  summary: string;
  /** Example copy written in the voice. */
  do: string[];
  /** Example copy the voice rules out. */
  dont: string[];
}

export interface BrandUsage {
  do: string[];
  dont: string[];
}

export type BrandMarkRole = 'mark' | 'wordmark' | 'lockup' | 'app-icon';

export interface BrandMark {
  id: string;
  name: string;
  role: BrandMarkRole;
  description: string;
  /** Sidecar-relative SVG drawn with currentColor and, for a second color, var(--brand-accent). */
  source: string;
  /** Approved color treatments; the first is the primary treatment. */
  variants: BrandMarkVariant[];
  /** Empty space kept on every side, as a ratio of the mark's height or width. */
  clearSpace: { ratio: number; basis: 'height' | 'width'; note?: string };
  /** Smallest on-screen size, in CSS pixels along one axis. */
  minimumSize: { px: number; axis: 'height' | 'width'; note?: string };
}

export interface BrandMarkVariant {
  id: string;
  name: string;
  /** Color token refs such as color.background. */
  background: string;
  foreground: string;
  accent?: string;
}

/** Optional fifth structured sidecar file containing reusable composite boundaries. */
export interface ComponentFile {
  schemaVersion: string;
  projectId: string;
  /** Declared component groups; every component belongs to one. */
  groups: DeclaredGroup[];
  components: ComponentDefinition[];
}

export interface ScreenDefinition {
  id: string;
  name: string;
  /** One-based revision shown only when the same route and frame name have multiple versions. */
  version?: number;
  description: string;
  framePresetId: string;
  /** Id of the declared page in screens.pages; the screen renders on that page's canvas. */
  page: string;
  styleRefs: string[];
  styleEvidence?: StyleEvidence[];
  notes: string[];
  prototypeOnly: boolean;
  implementationHints: string[];
  productionRelationship?: ProductionRelationship;
  implementationTargets?: ImplementationTarget[];
  /** Browser-native source and deterministic review conditions. */
  prototype: ScreenPrototypeSource;
  sections: ScreenSection[];
}

/** One named state and viewport combination available for deterministic review. */
export interface ReviewCondition {
  id: string;
  framePresetId: string;
  state: string;
}

/** Browser-native source contract for a screen. */
export interface ScreenPrototypeSource extends PrototypeSource {
  /** Controlled sidecar-relative images, fonts, or other local assets. */
  assetRefs: string[];
  /** Named state and frame combinations exposed to serve, capture, and review. */
  reviewConditions: ReviewCondition[];
}

export interface ScreenSection {
  id: string;
  name: string;
  description: string;
  styleRefs: string[];
  styleEvidence?: StyleEvidence[];
  uses: BoundaryDependency[];
  prototypeOnly: boolean;
  notes: string[];
  implementationHints: string[];
  implementationTargets?: ImplementationTarget[];
}

export interface BoundaryDependency {
  kind: 'token-group' | 'primitive' | 'component' | 'screen' | 'section';
  id: string;
  reason: string;
  binding?: CompositionBinding;
}

export type ProductionRelationshipKind =
  | 'new-route'
  | 'existing-route'
  | 'state-of-existing-screen'
  | 'variant-of-existing-screen'
  | 'section-replacement'
  | 'embedded-flow';

export interface ProductionRelationship {
  kind: ProductionRelationshipKind;
  routePath?: string;
  targetScreenId?: string;
  replacedSectionId?: string;
  notes?: string[];
}

export interface CompositionBinding {
  slot?: string;
  state?: string;
  variant?: string;
  size?: string;
  prop?: string;
  copy?: string;
  data?: string;
  layout?: string;
  accessibility?: string;
}

export interface ImplementationTarget {
  platform: string;
  framework: string;
  candidatePath: string;
  symbolName: string;
  operationIntent: string;
  propMapping: Record<string, string>;
  stateMapping: Record<string, string>;
  tokenAdapter: string;
  testPaths: string[];
  storyPaths: string[];
  unresolvedDecisions: string[];
}

export type StyleEvidenceStatus = 'source' | 'linked-artifact-pending' | 'unresolved';

export interface StyleEvidence {
  styleRef: string;
  status: StyleEvidenceStatus;
  sourceAnchor?: string;
  artifactRef?: string;
  renderedSnippet?: string;
  notes?: string[];
}

export interface BlueprintProjectBundle {
  manifest: BlueprintManifest;
  tokens: TokenFile;
  primitives: PrimitiveFile;
  components: ComponentFile;
  screens: ScreenFile;
  brand?: BrandFile;
  /** Saved alternatives assembled from separate exploration records. */
  explorations: ExplorationFile;
  /** Prior canonical versions assembled from separate history records. */
  history: ScreenHistoryFile;
  sourceRoot: string;
  sourceFiles: {
    manifest: string;
    tokens: string;
    primitives: string;
    components: string;
    screens: string;
    brand?: string;
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
  prototypeAssetContents: Record<string, PrototypeAssetContent>;
}

/** Binary-safe controlled asset payload injected into the browser compiler. */
export interface PrototypeAssetContent {
  /** Browser media type used when constructing a data or blob URL. */
  mediaType: string;
  /** Base64-encoded bytes; binary assets are never decoded as UTF-8 source text. */
  base64: string;
}

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

export interface TokenUsage {
  tokenId: string;
  role: string;
  boundaryId: string;
  boundaryKind: BoundaryKind;
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
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export type ReadinessTier = 'ready' | 'pending' | 'unresolved' | 'blocked';

export type ReadinessSeverity = 'ready' | 'pending' | 'unresolved' | 'blocker';

export type ReadinessSource = 'resolved' | 'declared' | 'declared-missing-artifact' | 'synthesized-missing';

export interface ReadinessItem {
  path: string;
  severity: ReadinessSeverity;
  source: ReadinessSource;
  message: string;
  artifactRef?: string;
  artifactExists?: boolean;
}

export interface ReadinessReport {
  projectId: string;
  /** Sidecar-relative governed source paths; source text is intentionally omitted. */
  prototypeSources: string[];
  tier: ReadinessTier;
  items: ReadinessItem[];
  blockers: ReadinessItem[];
}

export interface QueryResult {
  query: string;
  projectId: string;
  results: unknown[];
}

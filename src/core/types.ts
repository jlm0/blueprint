export type BoundaryKind = 'project' | 'board' | 'token-group' | 'primitive' | 'state-set' | 'component' | 'screen' | 'section';

export type BoardKind = 'primitives' | 'screens';

export interface BlueprintManifest {
  schemaVersion: string;
  handoffContractVersion?: string;
  project: ProjectManifest;
  defaultBoardId: string;
  boards: BoardDefinition[];
  framePresets: FramePreset[];
  /** Governs the isolated browser-native prototype host when high-fidelity sources are present. */
  prototypeHost?: PrototypeHostPolicy;
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
  type: 'color' | 'space' | 'radius' | 'typography' | 'shadow' | 'motion';
  value: string;
  description: string;
  styleRef: string;
}

export interface PrimitiveFile {
  schemaVersion: string;
  projectId: string;
  primitives: PrimitiveDefinition[];
}

export interface PrimitiveDefinition {
  id: string;
  name: string;
  description: string;
  tokenGroupIds: string[];
  uses?: BoundaryDependency[];
  styleRefs: string[];
  styleEvidence?: StyleEvidence[];
  notes: string[];
  prototypeOnly: boolean;
  implementationHints: string[];
  implementationTargets?: ImplementationTarget[];
  /** Canonical app-owned render source. Omission selects the explicit legacy fallback. */
  prototype?: PrimitivePrototypeSource;
  stateSets: PrimitiveStateSet[];
}

/** Declares one intentional reusable-style literal that is not token-governed. */
export interface LocalValueException {
  /** CSS property or design role receiving the literal. */
  property: string;
  /** Literal value retained by the app-owned source. */
  value: string;
  /** Product-specific reason the value is not reusable token state. */
  reason: string;
}

/** Shared source fields for canonical primitives, components, and screens. */
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
  kind: 'primitive' | 'component';
  /** App-owned local boundary ID. */
  id: string;
}

/** Canonical source contract used for a primitive on every board and screen. */
export interface PrimitivePrototypeSource extends PrototypeSource {
  /** Named content slots accepted by the primitive. */
  slots: string[];
  /** Supported variant IDs. */
  variants: string[];
  /** Human-readable accessibility semantics the source must preserve. */
  accessibilityIntent: string;
  /** Token reference to reusable visual role mapping. */
  tokenRoles: Record<string, string>;
}

export interface PrimitiveStateSet {
  id: string;
  name: string;
  description: string;
  styleRefs: string[];
  styleEvidence?: StyleEvidence[];
  states: PrimitiveState[];
}

export interface PrimitiveState {
  id: string;
  name: string;
  tokens: string[];
  tokenRoles?: Record<string, string>;
  prototypeOnly: boolean;
  notes: string[];
  implementationHints: string[];
}

export interface ScreenFile {
  schemaVersion: string;
  projectId: string;
  screens: ScreenDefinition[];
}

/** Optional fifth structured sidecar file containing reusable composite boundaries. */
export interface ComponentFile {
  schemaVersion: string;
  projectId: string;
  components: ComponentDefinition[];
}

/** Reusable app-owned composition built from canonical primitives or other components. */
export interface ComponentDefinition {
  id: string;
  name: string;
  description: string;
  uses: BoundaryDependency[];
  tokenGroupIds: string[];
  /** Canonical app-owned composite source. */
  prototype: ComponentPrototypeSource;
  styleRefs?: string[];
  styleEvidence?: StyleEvidence[];
  notes?: string[];
  prototypeOnly?: boolean;
  implementationHints?: string[];
  implementationTargets?: ImplementationTarget[];
}

/** Canonical source contract for a reusable composite component. */
export interface ComponentPrototypeSource extends PrototypeSource {
  /** Named content slots accepted by the component. */
  slots: string[];
}

export interface ScreenDefinition {
  id: string;
  name: string;
  description: string;
  framePresetId: string;
  /** Optional sub-flow grouping for the screens board; screens sharing a flow lay out on the same canvas row. */
  flow?: string;
  styleRefs: string[];
  styleEvidence?: StyleEvidence[];
  notes: string[];
  prototypeOnly: boolean;
  implementationHints: string[];
  productionRelationship?: ProductionRelationship;
  implementationTargets?: ImplementationTarget[];
  /** Browser-native high-fidelity source and deterministic review conditions. */
  prototype?: ScreenPrototypeSource;
  sections: ScreenSection[];
}

/** One named state and viewport combination available for deterministic review. */
export interface ReviewCondition {
  id: string;
  framePresetId: string;
  state: string;
}

/** Browser-native source contract for a high-fidelity screen. */
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
  kind: 'token-group' | 'primitive' | 'state-set' | 'component' | 'screen' | 'section';
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
  /** Reusable components; empty for legacy four-file sidecars. */
  components: ComponentFile;
  screens: ScreenFile;
  sourceRoot: string;
  sourceFiles: {
    manifest: string;
    tokens: string;
    primitives: string;
    components?: string;
    screens: string;
    /** Normalized absolute provenance paths for every governed prototype input. */
    prototypeSources: string[];
  };
  /** Serializable source text keyed by sidecar-relative prototype path for browser compilation. */
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
  /** Canonical or legacy render selection for renderable reusable boundaries. */
  rendering?: PrototypeRenderDecision;
}

/** Render selection for a boundary with an app-owned canonical source. */
export interface CanonicalPrototypeRenderDecision {
  mode: 'canonical-app-owned';
  source: string;
  fallbackUsed: false;
}

/** Honest compatibility selection for a boundary without a canonical source. */
export interface LegacyFallbackRenderDecision {
  mode: 'legacy-fallback';
  fallbackUsed: true;
  reason: 'no-canonical-prototype-source';
}

/** Discriminated public render decision consumed by canvas and handoff clients. */
export type PrototypeRenderDecision = CanonicalPrototypeRenderDecision | LegacyFallbackRenderDecision;

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
  /** Honest visual-source capability classification. */
  fidelityTier: 'baseline-compatible' | 'high-fidelity';
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

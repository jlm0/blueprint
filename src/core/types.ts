export type BoundaryKind = 'project' | 'board' | 'token-group' | 'primitive' | 'state-set' | 'screen' | 'section';

export type BoardKind = 'primitives' | 'screens';

export interface BlueprintManifest {
  schemaVersion: string;
  handoffContractVersion?: string;
  project: ProjectManifest;
  defaultBoardId: string;
  boards: BoardDefinition[];
  framePresets: FramePreset[];
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
  type: 'mobile' | 'tablet' | 'desktop' | 'custom';
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
  stateSets: PrimitiveStateSet[];
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

export interface ScreenDefinition {
  id: string;
  name: string;
  description: string;
  framePresetId: string;
  styleRefs: string[];
  styleEvidence?: StyleEvidence[];
  notes: string[];
  prototypeOnly: boolean;
  implementationHints: string[];
  productionRelationship?: ProductionRelationship;
  implementationTargets?: ImplementationTarget[];
  sections: ScreenSection[];
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
  kind: 'token-group' | 'primitive' | 'state-set' | 'screen' | 'section';
  id: string;
  reason: string;
  binding?: CompositionBinding;
}

export type ProductionRelationshipKind =
  | 'new-route'
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
  screens: ScreenFile;
  sourceRoot: string;
  sourceFiles: {
    manifest: string;
    tokens: string;
    primitives: string;
    screens: string;
  };
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
  tier: ReadinessTier;
  items: ReadinessItem[];
  blockers: ReadinessItem[];
}

export interface QueryResult {
  query: string;
  projectId: string;
  results: unknown[];
}

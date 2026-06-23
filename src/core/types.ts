export type BoundaryKind = 'project' | 'board' | 'token-group' | 'primitive' | 'state-set' | 'screen' | 'section';

export type BoardKind = 'primitives' | 'screens';

export interface BlueprintManifest {
  schemaVersion: string;
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
  styleRefs: string[];
  notes: string[];
  prototypeOnly: boolean;
  implementationHints: string[];
  stateSets: PrimitiveStateSet[];
}

export interface PrimitiveStateSet {
  id: string;
  name: string;
  description: string;
  styleRefs: string[];
  states: PrimitiveState[];
}

export interface PrimitiveState {
  id: string;
  name: string;
  tokens: string[];
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
  notes: string[];
  prototypeOnly: boolean;
  implementationHints: string[];
  sections: ScreenSection[];
}

export interface ScreenSection {
  id: string;
  name: string;
  description: string;
  styleRefs: string[];
  uses: BoundaryDependency[];
  prototypeOnly: boolean;
  notes: string[];
  implementationHints: string[];
}

export interface BoundaryDependency {
  kind: 'token-group' | 'primitive' | 'state-set' | 'screen' | 'section';
  id: string;
  reason: string;
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
  dependencies: {
    uses: BoundaryReference[];
    usedBy: BoundaryReference[];
  };
  notes: string[];
  prototypeOnly: boolean;
  implementationHints: string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface QueryResult {
  query: string;
  projectId: string;
  results: unknown[];
}

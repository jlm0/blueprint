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

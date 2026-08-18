export type {
  BlueprintManifest,
  BlueprintProjectBundle,
  BoundaryKind,
  BoundaryPacket,
  BoundaryReference,
  BoundarySelector,
  CanonicalPrototypeRenderDecision,
  ComponentDefinition,
  ComponentFile,
  ComponentPrototypeSource,
  DeepHandoffPacket,
  ExplorationBaseline,
  ExplorationCandidate,
  ExplorationDefinition,
  ExplorationFile,
  ExplorationRecordFile,
  ExplorationLifecycle,
  ExplorationPrototypeSource,
  ExplorationTarget,
  ExtractionOptions,
  ExtractionPacket,
  LegacyFallbackRenderDecision,
  LocalValueException,
  PrimitiveDefinition,
  PrimitivePrototypeSource,
  PrototypeAssetContent,
  PrototypeHostPolicy,
  PrototypeRenderDecision,
  PrototypeSource,
  PrototypeUseDeclaration,
  ReadinessItem,
  ReadinessReport,
  ReadinessSeverity,
  ReadinessSource,
  ReadinessTier,
  ResolvedToken,
  ReviewCondition,
  ScreenDefinition,
  ScreenHistoryEntry,
  ScreenHistoryFile,
  ScreenHistoryRecordFile,
  ScreenHistoryReplacement,
  ScreenPrototypeSource,
  TokenUsage,
  TokenGroup,
  ValidationOptions,
  ValidationResult
} from './core/types';
export type {
  BoundaryReviewManifestEntry,
  CanvasStyleEvidenceArtifact,
  CanvasStyleEvidenceEntry,
  PrototypeReviewManifestContext,
  ReviewCaptureRecord,
  ReviewManifest,
  ReviewManifestOptions,
  SectionProjectionSummary,
  VisibleBoundaryRecord,
  VisibleBoundarySyncResult
} from './core/review';
export type {
  BlueprintAgentActivityEvent,
  BlueprintAgentActivityFocus,
  BlueprintAgentActivityPhase,
  BlueprintProjectChangedEvent,
  BlueprintProjectErrorEvent,
  BlueprintProjectSnapshot
} from './core/activity';

export { boundaryId, parseBoundarySelector } from './core/address';
export { createProjectBundle } from './core/bundle';
export {
  archiveExploration,
  computeCanonicalScreenDigest,
  computeExplorationBaselineDigest,
  computeExplorationCandidateDigest,
  computeHistoryVersionDigest,
  createExplorationMetadata,
  inspectExploration,
  inspectScreenHistory,
  listExplorations,
  listScreenHistory,
  promoteExploration,
  restoreScreenHistory
} from './core/exploration';
export type {
  CreateExplorationInput,
  ExplorationInspection,
  ExplorationMutationResult,
  ExplorationSummary,
  PromoteExplorationInput,
  PromotionResult,
  RestoreHistoryInput,
  RestoreHistoryResult,
  ScreenHistoryInspection,
  ScreenHistorySummary,
  TextSourceWrite
} from './core/exploration';
export { loadProjectFromFs } from './core/load';
export {
  explorationRecordFile,
  explorationRecordRef,
  historyRecordFile,
  historyRecordRef
} from './core/storage-records';
export { createReadinessReport, validateProject } from './core/validate';
export {
  createExtractionPacket,
  listBoundaryReferences,
  queryPrototypeOnly,
  querySections,
  queryUsedBy,
  queryUses,
  showBoundary
} from './core/query';
export {
  createCanvasStyleEvidence,
  createReviewManifest,
  summarizeScreenSections,
  validateVisibleBoundaryRecords
} from './core/review';
export {
  BLUEPRINT_MCP_SERVER_NAME,
  BLUEPRINT_MCP_SERVER_VERSION,
  BLUEPRINT_MCP_TOOL_NAMES,
  createBlueprintMcpServer
} from './mcp/create-server';
export type {
  CaptureInput,
  CaptureOutput,
  ExtractInput,
  ExtractOutput,
  ExploreInput,
  ExploreOutput,
  IndexInput,
  IndexOutput,
  InitInput,
  InitOutput,
  PromoteInput,
  PromoteOutput,
  QueryInput,
  QueryOutput,
  RestoreInput,
  RestoreOutput,
  ServeInput,
  ServeOutput,
  ValidateInput,
  ValidateOutput
} from './mcp/schemas';

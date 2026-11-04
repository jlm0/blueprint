import * as z from 'zod/v4';
import { positiveIntegerSchema, safeIdSchema, schemaVersionSchema, limitedText, stringListSchema } from './common';
import { named } from './registry';
import { savedScreenSchema } from './screens';

const HUMAN_LABEL_LIMIT = 160;

export const explorationLifecycleSchema = z.enum(['active', 'archived', 'promoted']);

/** Screen-local governed source for one non-canonical candidate. */
export const explorationPrototypeSourceSchema = named('explorationPrototype', z.object({
  source: z.string(),
  styles: stringListSchema,
  assetRefs: stringListSchema
}));

export const explorationCandidateSchema = named('explorationCandidate', z.object({
  id: safeIdSchema,
  label: limitedText(HUMAN_LABEL_LIMIT),
  prototype: explorationPrototypeSourceSchema
}));

export const explorationBaselineSchema = named('explorationBaseline', z.object({
  screen: savedScreenSchema,
  prototype: explorationPrototypeSourceSchema
}));

export const explorationTargetSchema = named('explorationTarget', z.object({
  screenId: z.string(),
  state: z.string(),
  framePresetId: z.string(),
  /** SHA-256 of the exact canonical screen record and its governed source bytes. */
  baseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Immutable metadata plus governed render-source snapshot from creation time. */
  baseline: explorationBaselineSchema
}));

export const explorationSchema = named('exploration', z.object({
  id: safeIdSchema,
  title: limitedText(HUMAN_LABEL_LIMIT),
  intent: limitedText(HUMAN_LABEL_LIMIT),
  lifecycle: explorationLifecycleSchema,
  target: explorationTargetSchema,
  candidates: z.array(explorationCandidateSchema).min(2).max(5),
  /** Present only after an explicitly selected candidate has been promoted. */
  selectedCandidateId: safeIdSchema.optional(),
  /** Canonical screen version created by promotion. */
  promotedScreenId: z.string().optional()
}));

export const explorationFileSchema = named('explorationFile', z.object({
  schemaVersion: z.string(),
  projectId: z.string(),
  explorations: z.array(explorationSchema)
}));

export const explorationRecordFileSchema = named('explorationRecordFile', z.object({
  schemaVersion: schemaVersionSchema,
  projectId: z.string(),
  exploration: explorationSchema
}));

export const screenHistoryReplacementSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exploration-candidate'),
    explorationId: z.string(),
    candidateId: z.string()
  }),
  z.object({
    type: z.literal('history-restore'),
    version: positiveIntegerSchema
  })
]);

export const screenHistoryEntrySchema = named('screenHistoryEntry', z.object({
  screenId: z.string(),
  version: positiveIntegerSchema,
  state: z.string(),
  framePresetId: z.string(),
  screen: savedScreenSchema,
  replacedBy: screenHistoryReplacementSchema
}));

export const screenHistoryFileSchema = named('screenHistoryFile', z.object({
  schemaVersion: z.string(),
  projectId: z.string(),
  entries: z.array(screenHistoryEntrySchema)
}));

export const screenHistoryRecordFileSchema = named('screenHistoryRecordFile', z.object({
  schemaVersion: schemaVersionSchema,
  projectId: z.string(),
  entry: screenHistoryEntrySchema
}));

export type ExplorationLifecycle = z.infer<typeof explorationLifecycleSchema>;
export type ExplorationPrototypeSource = z.infer<typeof explorationPrototypeSourceSchema>;
export type ExplorationCandidate = z.infer<typeof explorationCandidateSchema>;
export type ExplorationBaseline = z.infer<typeof explorationBaselineSchema>;
export type ExplorationTarget = z.infer<typeof explorationTargetSchema>;
export type ExplorationDefinition = z.infer<typeof explorationSchema>;
export type ExplorationFile = z.infer<typeof explorationFileSchema>;
export type ExplorationRecordFile = z.infer<typeof explorationRecordFileSchema>;
export type ScreenHistoryReplacement = z.infer<typeof screenHistoryReplacementSchema>;
export type ScreenHistoryEntry = z.infer<typeof screenHistoryEntrySchema>;
export type ScreenHistoryFile = z.infer<typeof screenHistoryFileSchema>;
export type ScreenHistoryRecordFile = z.infer<typeof screenHistoryRecordFileSchema>;

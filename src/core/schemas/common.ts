import * as z from 'zod/v4';
import { KEBAB_ID_PATTERN } from '../reusable-contract';
import { BLUEPRINT_SCHEMA_VERSION } from '../schema-version';
import { SAFE_SEGMENT } from '../storage-records';
import { named } from './registry';

export const schemaVersionSchema = z.literal(BLUEPRINT_SCHEMA_VERSION);

export const stringListSchema = named('stringArray', z.array(z.string()));

export const safeIdSchema = named('safeId', z.string().regex(SAFE_SEGMENT));

export const kebabIdSchema = z.string().regex(KEBAB_ID_PATTERN);

export function limitedText(limit: number): z.ZodString {
  return z.string().min(1).max(limit);
}

export const positiveIntegerSchema = z.number().int().min(1);

export const reusableKindSchema = z.enum(['primitive', 'component']);

export const styleEvidenceStatusSchema = z.enum(['source', 'linked-artifact-pending', 'unresolved']);

export const styleEvidenceSchema = named('styleEvidence', z.object({
  styleRef: z.string(),
  status: styleEvidenceStatusSchema,
  sourceAnchor: z.string().optional(),
  artifactRef: z.string().optional(),
  renderedSnippet: z.string().optional(),
  notes: stringListSchema.optional()
}));

export const implementationTargetSchema = named('implementationTarget', z.object({
  platform: z.string(),
  framework: z.string(),
  candidatePath: z.string(),
  symbolName: z.string(),
  operationIntent: z.string(),
  propMapping: z.record(z.string(), z.string()),
  stateMapping: z.record(z.string(), z.string()),
  tokenAdapter: z.string(),
  testPaths: stringListSchema,
  storyPaths: stringListSchema,
  unresolvedDecisions: stringListSchema
}));

export const localValueExceptionSchema = z.object({
  /** CSS property or design role receiving the literal. */
  property: z.string(),
  /** Literal value retained by the app-owned source. */
  value: z.string(),
  /** Product-specific reason the value is not reusable token state. */
  reason: z.string()
});

export const localValueExceptionsSchema = named('localValueExceptions', z.array(localValueExceptionSchema));

export const declaredGroupSchema = named('declaredGroup', z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string()
}));

export type StyleEvidenceStatus = z.infer<typeof styleEvidenceStatusSchema>;
export type StyleEvidence = z.infer<typeof styleEvidenceSchema>;
export type ImplementationTarget = z.infer<typeof implementationTargetSchema>;
export type ReusableKind = z.infer<typeof reusableKindSchema>;
export type LocalValueException = z.infer<typeof localValueExceptionSchema>;
export type DeclaredGroup = z.infer<typeof declaredGroupSchema>;

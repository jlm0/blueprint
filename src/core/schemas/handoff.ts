import * as z from 'zod/v4';
import { stringListSchema } from './common';
import { named } from './registry';

export const boundaryKindSchema = z.enum(['project', 'board', 'token-group', 'primitive', 'component', 'screen', 'section']);

export const readinessTierSchema = z.enum(['ready', 'pending', 'unresolved', 'blocked']);

export const readinessSeveritySchema = z.enum(['ready', 'pending', 'unresolved', 'blocker']);

export const readinessSourceSchema = z.enum(['resolved', 'declared', 'declared-missing-artifact', 'synthesized-missing']);

export const readinessItemSchema = named('readinessItem', z.object({
  path: z.string(),
  severity: readinessSeveritySchema,
  source: readinessSourceSchema,
  message: z.string(),
  artifactRef: z.string().optional(),
  artifactExists: z.boolean().optional()
}));

export const readinessReportSchema = named('readinessReport', z.object({
  projectId: z.string(),
  /** Sidecar-relative governed source paths; source text is intentionally omitted. */
  prototypeSources: stringListSchema,
  tier: readinessTierSchema,
  items: z.array(readinessItemSchema),
  blockers: z.array(readinessItemSchema)
}));

export const tokenUsageSchema = named('tokenUsage', z.object({
  tokenId: z.string(),
  role: z.string(),
  boundaryId: z.string(),
  boundaryKind: boundaryKindSchema,
  styleRef: z.string()
}));

/** Documents the deep packet for package consumers; `DeepHandoffPacket` in types.ts stays generic over its data. */
export const deepHandoffPacketSchema = named('deepHandoffPacket', z.object({
  extraction: z.object({}),
  boundaries: z.array(z.unknown()),
  resolvedTokens: z.array(z.unknown()),
  tokenUsage: z.array(tokenUsageSchema)
}));

export type BoundaryKind = z.infer<typeof boundaryKindSchema>;
export type ReadinessTier = z.infer<typeof readinessTierSchema>;
export type ReadinessSeverity = z.infer<typeof readinessSeveritySchema>;
export type ReadinessSource = z.infer<typeof readinessSourceSchema>;
export type ReadinessItem = z.infer<typeof readinessItemSchema>;
export type ReadinessReport = z.infer<typeof readinessReportSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

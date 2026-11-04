import * as z from 'zod/v4';
import { INSPO_ASPECTS, INSPO_DIRECTION_STATUSES, INSPO_IMAGE_PATTERN, INSPO_LIMITS, INSPO_SOURCE_URL_PATTERN, INSPO_STANCES } from '../inspo-contract';
import { limitedText, safeIdSchema, schemaVersionSchema } from './common';
import { named, uniqueList } from './registry';

export const inspoAspectSchema = named('inspoAspect', z.enum(INSPO_ASPECTS));

export const inspoEntrySchema = named('inspoEntry', z.strictObject({
  id: safeIdSchema,
  /** The link the person pasted. */
  sourceUrl: z.string().regex(INSPO_SOURCE_URL_PATTERN).max(INSPO_LIMITS.sourceUrl),
  /** Sidecar-relative cached copy under inspo/, kept out of git. */
  image: z.string().regex(INSPO_IMAGE_PATTERN),
  aspects: uniqueList(z.array(inspoAspectSchema)),
  stance: z.enum(INSPO_STANCES),
  /** The person's own words, kept verbatim. */
  note: z.string().max(INSPO_LIMITS.note),
  /** What the agent takes from the image for the aspects. */
  reading: z.string().max(INSPO_LIMITS.reading)
}));

export const inspoDirectionSchema = named('inspoDirection', z.strictObject({
  aspect: inspoAspectSchema,
  statement: limitedText(INSPO_LIMITS.statement),
  entryIds: z.array(safeIdSchema).min(1),
  status: z.enum(INSPO_DIRECTION_STATUSES)
}));

export const inspoFileSchema = named('inspoFile', z.strictObject({
  schemaVersion: schemaVersionSchema,
  projectId: z.string(),
  entries: z.array(inspoEntrySchema),
  directions: z.array(inspoDirectionSchema)
}), 'Optional reference board a new sidecar starts from. Cached images under inspo/ stay out of git.');

export type InspoAspect = z.infer<typeof inspoAspectSchema>;
export type InspoEntry = z.infer<typeof inspoEntrySchema>;
export type InspoDirection = z.infer<typeof inspoDirectionSchema>;
export type InspoFile = z.infer<typeof inspoFileSchema>;

import * as z from 'zod/v4';
import { PRODUCTION_RELATIONSHIP_KINDS } from '../screen-contract';
import {
  declaredGroupSchema,
  implementationTargetSchema,
  kebabIdSchema,
  localValueExceptionsSchema,
  positiveIntegerSchema,
  reusableKindSchema,
  schemaVersionSchema,
  stringListSchema,
  styleEvidenceSchema
} from './common';
import { named } from './registry';

export const compositionBindingSchema = named('compositionBinding', z.object({
  slot: z.string().optional(),
  state: z.string().optional(),
  variant: z.string().optional(),
  size: z.string().optional(),
  prop: z.string().optional(),
  copy: z.string().optional(),
  data: z.string().optional(),
  layout: z.string().optional(),
  accessibility: z.string().optional()
}));

export const boundaryDependencySchema = named('boundaryDependency', z.strictObject({
  kind: z.enum(['token-group', 'primitive', 'component', 'screen', 'section']),
  id: z.string(),
  reason: z.string(),
  binding: compositionBindingSchema.optional()
}));

export const screenSectionSchema = named('screenSection', z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  styleRefs: stringListSchema,
  styleEvidence: z.array(styleEvidenceSchema),
  uses: z.array(boundaryDependencySchema),
  prototypeOnly: z.boolean(),
  notes: stringListSchema,
  implementationHints: stringListSchema,
  implementationTargets: z.array(implementationTargetSchema)
}));

export const productionRelationshipKindSchema = z.enum(PRODUCTION_RELATIONSHIP_KINDS);

export const productionRelationshipSchema = named('productionRelationship', z.strictObject({
  kind: productionRelationshipKindSchema,
  routePath: z.string().optional(),
  targetScreenId: z.string().optional(),
  replacedSectionId: z.string().optional(),
  notes: stringListSchema
}));

export const reviewConditionSchema = named('reviewCondition', z.object({
  id: z.string(),
  framePresetId: z.string(),
  state: z.string()
}));

export const prototypeUseDeclarationSchema = z.object({
  kind: reusableKindSchema,
  /** App-owned local boundary ID. */
  id: z.string()
});

export const prototypeUsesSchema = named('prototypeUses', z.array(prototypeUseDeclarationSchema));

export const screenPrototypeSourceSchema = named('screenPrototype', z.strictObject({
  /** Sidecar-relative HTML source path. */
  source: z.string(),
  /** Sidecar-relative CSS source paths loaded with the HTML source. */
  styles: stringListSchema,
  /** Deterministic host-selected state IDs supported by the source. */
  states: stringListSchema,
  /** Controlled sidecar-relative images, fonts, or other local assets. */
  assetRefs: stringListSchema,
  /** Named state and frame combinations exposed to serve, capture, and review. */
  reviewConditions: z.array(reviewConditionSchema),
  /** Optional mechanically observed reusable-boundary references for declaration cross-checking. */
  renderedUses: prototypeUsesSchema.optional(),
  localValueExceptions: localValueExceptionsSchema.optional()
}));

export const screenSchema = named('screen', z.strictObject({
  id: kebabIdSchema,
  name: z.string(),
  /** One-based revision shown only when the same route and frame name have multiple versions. */
  version: positiveIntegerSchema.optional(),
  description: z.string(),
  framePresetId: z.string(),
  /** Id of the declared page in screens.pages; the screen renders on that page's canvas. */
  page: z.string(),
  styleRefs: stringListSchema,
  styleEvidence: z.array(styleEvidenceSchema),
  notes: stringListSchema,
  prototypeOnly: z.boolean(),
  implementationHints: stringListSchema,
  productionRelationship: productionRelationshipSchema.optional(),
  implementationTargets: z.array(implementationTargetSchema),
  prototype: screenPrototypeSourceSchema,
  sections: z.array(screenSectionSchema)
}));

/** A saved snapshot keeps the fields it had when it was saved: older snapshots have `flow` and no `page`, and restore puts the screen back on its current page. */
export const savedScreenSchema = named('savedScreen', z.strictObject({
  ...screenSchema.shape,
  page: z.string().optional(),
  flow: z.string().optional()
}));

export const screenFileSchema = named('screenFile', z.strictObject({
  schemaVersion: schemaVersionSchema,
  projectId: z.string(),
  /** Declared screens-board pages, such as Web, Mobile, or Landing; each page is its own canvas. */
  pages: z.array(declaredGroupSchema),
  screens: z.array(screenSchema)
}));

export type CompositionBinding = z.infer<typeof compositionBindingSchema>;
export type BoundaryDependency = z.infer<typeof boundaryDependencySchema>;
export type ScreenSection = z.infer<typeof screenSectionSchema>;
export type ProductionRelationshipKind = z.infer<typeof productionRelationshipKindSchema>;
export type ProductionRelationship = z.infer<typeof productionRelationshipSchema>;
export type ReviewCondition = z.infer<typeof reviewConditionSchema>;
export type PrototypeUseDeclaration = z.infer<typeof prototypeUseDeclarationSchema>;
export type ScreenPrototypeSource = z.infer<typeof screenPrototypeSourceSchema>;
export type PrototypeSource = Omit<ScreenPrototypeSource, 'assetRefs' | 'reviewConditions'>;
export type ScreenDefinition = z.infer<typeof screenSchema>;
export type SavedScreen = z.infer<typeof savedScreenSchema>;
export type ScreenFile = z.infer<typeof screenFileSchema>;

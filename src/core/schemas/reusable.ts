import * as z from 'zod/v4';
import { KEBAB_ID_PATTERN, PLATFORMS, REUSABLE_LIMITS } from '../reusable-contract';
import {
  implementationTargetSchema,
  kebabIdSchema,
  limitedText,
  localValueExceptionsSchema,
  reusableKindSchema,
  stringListSchema,
  styleEvidenceSchema
} from './common';
import { named, uniqueList } from './registry';

const SLOT_ACCEPT_PATTERN = new RegExp(`^(text|graphic|brand-mark|(primitive|component):${KEBAB_ID_PATTERN.source.slice(1, -1)})$`);

/** Where a reusable runs: a website or web app, a native phone app, or a native desktop app. */
export const platformSchema = named('platform', z.enum(PLATFORMS));

export const reusableAxisValueSchema = named('reusableAxisValue', z.strictObject({
  id: kebabIdSchema,
  name: limitedText(REUSABLE_LIMITS.valueName),
  description: limitedText(REUSABLE_LIMITS.valueDescription)
}));

/** Variants, sizes, or states: every value a reusable offers on that axis and the one an omitted attribute takes. */
export const reusableAxisSchema = named('reusableAxis', z.strictObject({
  default: z.string(),
  values: z.array(reusableAxisValueSchema).min(1)
}));

export const reusableUnsupportedCombinationSchema = named('reusableUnsupported', z.strictObject({
  axis: z.enum(['variant', 'size']),
  value: z.string(),
  state: z.string(),
  reason: limitedText(REUSABLE_LIMITS.unsupportedReason)
}));

export const reusableSlotSchema = named('reusableSlot', z.strictObject({
  id: kebabIdSchema,
  name: limitedText(REUSABLE_LIMITS.valueName),
  description: limitedText(REUSABLE_LIMITS.valueDescription),
  /** `text`, `graphic`, `brand-mark`, `primitive:<id>`, or `component:<id>`. */
  accepts: uniqueList(z.array(z.string().regex(SLOT_ACCEPT_PATTERN)).min(1))
}));

export const reusableDependencySchema = named('reusableUse', z.strictObject({
  kind: reusableKindSchema,
  id: z.string(),
  reason: limitedText(REUSABLE_LIMITS.reason)
}));

export const reusablePrototypeSourceSchema = named('reusablePrototype', z.strictObject({
  source: z.string(),
  styles: stringListSchema,
  localValueExceptions: localValueExceptionsSchema
}));

export const reusableSchema = named('reusable', z.strictObject({
  id: kebabIdSchema,
  name: limitedText(REUSABLE_LIMITS.name),
  description: limitedText(REUSABLE_LIMITS.description),
  /** A primitive's Blueprint group, or a component's declared entry in components.groups. */
  group: kebabIdSchema,
  platforms: uniqueList(z.array(platformSchema).min(1)),
  uses: z.array(reusableDependencySchema),
  variants: reusableAxisSchema,
  sizes: reusableAxisSchema,
  states: reusableAxisSchema,
  unsupported: z.array(reusableUnsupportedCombinationSchema),
  slots: z.array(reusableSlotSchema),
  prototype: reusablePrototypeSourceSchema,
  tokenGroupIds: z.array(z.string()).min(1),
  /** Token reference to reusable visual role mapping. */
  tokenRoles: z.record(z.string(), z.string().min(1)),
  /** The role and how assistive technology announces it. */
  accessibility: limitedText(REUSABLE_LIMITS.accessibility),
  notes: stringListSchema,
  implementationHints: stringListSchema,
  implementationTargets: z.array(implementationTargetSchema),
  styleRefs: stringListSchema,
  styleEvidence: z.array(styleEvidenceSchema),
  prototypeOnly: z.boolean()
}));

export type Platform = z.infer<typeof platformSchema>;
export type ReusableAxisValue = z.infer<typeof reusableAxisValueSchema>;
export type ReusableAxis = z.infer<typeof reusableAxisSchema>;
export type ReusableUnsupportedCombination = z.infer<typeof reusableUnsupportedCombinationSchema>;
export type ReusableSlot = z.infer<typeof reusableSlotSchema>;
export type ReusableDependency = z.infer<typeof reusableDependencySchema>;
export type ReusablePrototypeSource = z.infer<typeof reusablePrototypeSourceSchema>;
export type ReusableDefinition = z.infer<typeof reusableSchema>;

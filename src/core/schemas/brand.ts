import * as z from 'zod/v4';
import { BRAND_MARK_ROLES } from '../brand-lint';
import { schemaVersionSchema, stringListSchema } from './common';
import { named } from './registry';

export const brandTraitSchema = z.object({
  name: z.string(),
  description: z.string()
});

export const brandVoiceSchema = z.object({
  summary: z.string(),
  /** Example copy written in the voice. */
  do: stringListSchema,
  /** Example copy the voice rules out. */
  dont: stringListSchema
});

export const brandUsageSchema = z.object({
  do: stringListSchema,
  dont: stringListSchema
});

export const brandMarkRoleSchema = z.enum(BRAND_MARK_ROLES);

export const brandMarkVariantSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Color token refs such as color.background. */
  background: z.string(),
  foreground: z.string(),
  accent: z.string().optional()
});

const axisSchema = z.enum(['height', 'width']);

export const brandMarkSchema = named('brandMark', z.object({
  id: z.string(),
  name: z.string(),
  role: brandMarkRoleSchema,
  description: z.string(),
  /** Sidecar-relative SVG drawn with currentColor and, for a second color, var(--brand-accent). */
  source: z.string().regex(/\.svg$/),
  /** Approved color treatments; the first is the primary treatment. */
  variants: z.array(brandMarkVariantSchema).min(1),
  /** Empty space kept on every side, as a ratio of the mark's height or width. */
  clearSpace: z.object({
    ratio: z.number().positive(),
    basis: axisSchema,
    note: z.string().optional()
  }),
  /** Smallest on-screen size, in CSS pixels along one axis. */
  minimumSize: z.object({
    px: z.number().positive(),
    axis: axisSchema,
    note: z.string().optional()
  })
}));

export const brandFontSourceSchema = z.enum(['asset', 'system']);

export const brandFontSchema = named('brandFont', z.strictObject({
  /** The name that a font-family token value and an @font-face rule use. */
  family: z.string().min(1),
  /** `asset` loads a file from the project. `system` reads a font that the device has. */
  source: brandFontSourceSchema,
  /** Sidecar-relative files of an `asset` family. A `system` family holds none. */
  assets: stringListSchema
}));

export const brandFileSchema = named('brandFile', z.object({
  schemaVersion: schemaVersionSchema,
  projectId: z.string(),
  name: z.string(),
  /** One line that positions the product. */
  tagline: z.string().optional(),
  personality: z.array(brandTraitSchema).optional(),
  voice: brandVoiceSchema.optional(),
  marks: z.array(brandMarkSchema),
  /** Each font family that a token or an @font-face rule names, except the generic families. */
  fonts: z.array(brandFontSchema),
  usage: brandUsageSchema.optional()
}));

export type BrandTrait = z.infer<typeof brandTraitSchema>;
export type BrandVoice = z.infer<typeof brandVoiceSchema>;
export type BrandUsage = z.infer<typeof brandUsageSchema>;
export type BrandMarkRole = z.infer<typeof brandMarkRoleSchema>;
export type BrandMarkVariant = z.infer<typeof brandMarkVariantSchema>;
export type BrandMark = z.infer<typeof brandMarkSchema>;
export type BrandFontSource = z.infer<typeof brandFontSourceSchema>;
export type BrandFont = z.infer<typeof brandFontSchema>;
export type BrandFile = z.infer<typeof brandFileSchema>;

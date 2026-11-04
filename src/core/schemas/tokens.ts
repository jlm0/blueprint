import * as z from 'zod/v4';
import { TOKEN_TYPES } from '../token-contract';
import { schemaVersionSchema, stringListSchema } from './common';
import { named } from './registry';

export const designTokenSchema = named('designToken', z.strictObject({
  id: z.string(),
  name: z.string(),
  type: z.enum(TOKEN_TYPES),
  value: z.string(),
  description: z.string(),
  styleRef: z.string()
}));

export const tokenGroupSchema = named('tokenGroup', z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  styleRefs: stringListSchema,
  notes: stringListSchema,
  tokens: z.array(designTokenSchema)
}));

export const tokenFileSchema = named('tokenFile', z.strictObject({
  schemaVersion: schemaVersionSchema,
  projectId: z.string(),
  tokenGroups: z.array(tokenGroupSchema)
}));

export type DesignToken = z.infer<typeof designTokenSchema>;
export type TokenGroup = z.infer<typeof tokenGroupSchema>;
export type TokenFile = z.infer<typeof tokenFileSchema>;

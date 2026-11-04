import * as z from 'zod/v4';
import { schemaVersionSchema } from './common';
import { named } from './registry';
import { reusableSchema } from './reusable';

export const primitiveSchema = named('primitive', reusableSchema.clone(), 'One of the closed set of Blueprint primitives, in the shared reusable shape.');

export const primitiveFileSchema = named('primitiveFile', z.strictObject({
  schemaVersion: schemaVersionSchema,
  projectId: z.string(),
  primitives: z.array(primitiveSchema)
}));

export type PrimitiveDefinition = z.infer<typeof primitiveSchema>;
export type PrimitiveFile = z.infer<typeof primitiveFileSchema>;

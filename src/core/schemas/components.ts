import * as z from 'zod/v4';
import { REUSABLE_LIMITS } from '../reusable-contract';
import { kebabIdSchema, limitedText, schemaVersionSchema } from './common';
import { named } from './registry';
import { reusableSchema } from './reusable';

export const componentSchema = named('component', reusableSchema.clone(), 'An app-owned component, in the shared reusable shape.');

export const componentGroupSchema = named('componentGroup', z.strictObject({
  id: kebabIdSchema,
  name: limitedText(REUSABLE_LIMITS.groupName),
  description: limitedText(REUSABLE_LIMITS.groupDescription)
}));

export const componentFileSchema = named('componentFile', z.strictObject({
  schemaVersion: schemaVersionSchema,
  projectId: z.string(),
  /** Declared component groups; every component belongs to one. */
  groups: z.array(componentGroupSchema),
  components: z.array(componentSchema)
}));

export type ComponentDefinition = z.infer<typeof componentSchema>;
export type ComponentFile = z.infer<typeof componentFileSchema>;

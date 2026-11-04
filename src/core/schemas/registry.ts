import * as z from 'zod/v4';

interface JsonSchemaMetadata {
  id?: string;
  description?: string;
  uniqueItems?: true;
}

/** Holds the `$defs` name of each schema; a private registry keeps the JSON schema free of the `.meta()` calls in other modules. */
export const projectSchemaRegistry = z.registry<JsonSchemaMetadata>();

export function named<T extends z.ZodType>(id: string, schema: T, description?: string): T {
  projectSchemaRegistry.add(schema, description ? { id, description } : { id });
  return schema;
}

function hasNoDuplicates(values: unknown[]): boolean {
  return new Set(values).size === values.length;
}

export function uniqueList<T extends z.ZodType>(list: z.ZodArray<T>): z.ZodArray<T> {
  const unique = list.refine(hasNoDuplicates, { message: 'lists a value twice', params: { fix: 'list each value once' } });
  projectSchemaRegistry.add(unique, { uniqueItems: true });
  return unique;
}

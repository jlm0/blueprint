import * as z from 'zod/v4';
import { componentFileSchema } from './components';
import { brandFileSchema } from './brand';
import './handoff';
import { inspoFileSchema } from './inspo';
import { manifestSchema } from './manifest';
import { primitiveFileSchema } from './primitives';
import { explorationFileSchema, screenHistoryFileSchema } from './records';
import { named, projectSchemaRegistry } from './registry';
import { screenFileSchema } from './screens';
import { tokenFileSchema } from './tokens';

const PROJECT_SCHEMA_ID = 'blueprintProject';

named(PROJECT_SCHEMA_ID, z.strictObject({
  manifest: manifestSchema,
  tokens: tokenFileSchema,
  primitives: primitiveFileSchema,
  components: componentFileSchema,
  screens: screenFileSchema,
  brand: brandFileSchema.optional(),
  inspo: inspoFileSchema.optional(),
  explorations: explorationFileSchema.optional(),
  history: screenHistoryFileSchema.optional()
}));

/** The schema of each structured file, for files on the current schema version. */
export const STRUCTURED_FILE_SCHEMAS = [
  { file: 'manifest.json', key: 'manifest', schema: manifestSchema },
  { file: 'tokens.json', key: 'tokens', schema: tokenFileSchema },
  { file: 'brand.json', key: 'brand', schema: brandFileSchema },
  { file: 'inspo.json', key: 'inspo', schema: inspoFileSchema },
  { file: 'screens.json', key: 'screens', schema: screenFileSchema },
  { file: 'primitives.json', key: 'primitives', schema: primitiveFileSchema },
  { file: 'components.json', key: 'components', schema: componentFileSchema }
] as const;

function withoutSchemaIdentity(definition: object): Record<string, unknown> {
  const body: Record<string, unknown> = { ...definition };
  delete body.$schema;
  delete body.$id;
  return body;
}

export function generateProjectJsonSchema(): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(projectSchemaRegistry, {
    io: 'input',
    metadata: projectSchemaRegistry,
    uri: id => `#/$defs/${id}`,
    override: ({ jsonSchema }) => {
      delete jsonSchema.id;
      if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
      if (jsonSchema.pattern) jsonSchema.pattern = jsonSchema.pattern.replaceAll('\\/', '/');
    }
  });
  const { [PROJECT_SCHEMA_ID]: root, ...definitions } = schemas;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://blueprint.local/schema/blueprint-project.schema.json',
    title: 'Blueprint Project Structured Files',
    description: 'Machine-readable artifact aligned with the current TypeScript structured-file contract. This schema exposes the current fields for editors, agents, and package consumers.',
    ...withoutSchemaIdentity(root),
    $defs: Object.fromEntries(Object.entries(definitions).map(([id, definition]) => [id, withoutSchemaIdentity(definition)]))
  };
}

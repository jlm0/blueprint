import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import * as z from 'zod/v4';
import { collectDesignFindings } from '../src/core/findings';
import {
  INSPO_DIRECTION_FIELDS,
  INSPO_ENTRY_FIELDS,
  INSPO_FILE_FIELDS
} from '../src/core/inspo-contract';
import { loadProjectFromFs } from '../src/core/load';
import { emptyRequiredFields } from '../src/core/migrate-shapes';
import { collectProseAdvisories } from '../src/core/prose-advisories';
import { listBoundaryReferences } from '../src/core/query';
import { serializeJson } from '../src/core/raw-json';
import {
  COMPONENT_FILE_FIELDS,
  DECLARED_GROUP_FIELDS,
  PRIMITIVE_FILE_FIELDS,
  REUSABLE_AXIS_FIELDS,
  REUSABLE_AXIS_VALUE_FIELDS,
  REUSABLE_FIELDS,
  REUSABLE_PROTOTYPE_FIELDS,
  REUSABLE_SLOT_FIELDS,
  REUSABLE_UNSUPPORTED_FIELDS,
  REUSABLE_USE_FIELDS
} from '../src/core/reusable-contract';
import { BLUEPRINT_SCHEMA_VERSION, schemaVersionErrors, VERSIONED_FILES } from '../src/core/schema-version';
import { declaredGroupSchema } from '../src/core/schemas/common';
import { componentFileSchema } from '../src/core/schemas/components';
import { inspoDirectionSchema, inspoEntrySchema, inspoFileSchema } from '../src/core/schemas/inspo';
import { agentErrorForIssue } from '../src/core/schemas/issues';
import { primitiveFileSchema } from '../src/core/schemas/primitives';
import { generateProjectJsonSchema, STRUCTURED_FILE_SCHEMAS } from '../src/core/schemas/project';
import {
  reusableAxisSchema,
  reusableAxisValueSchema,
  reusableDependencySchema,
  reusablePrototypeSourceSchema,
  reusableSchema,
  reusableSlotSchema,
  reusableUnsupportedCombinationSchema
} from '../src/core/schemas/reusable';
import {
  boundaryDependencySchema,
  productionRelationshipSchema,
  screenFileSchema,
  screenPrototypeSourceSchema,
  screenSchema,
  screenSectionSchema
} from '../src/core/schemas/screens';
import { designTokenSchema, tokenFileSchema, tokenGroupSchema } from '../src/core/schemas/tokens';
import {
  PAGE_FIELDS,
  PRODUCTION_RELATIONSHIP_FIELDS,
  PRODUCTION_RELATIONSHIP_OPTIONAL_FIELDS,
  SCREEN_FIELDS,
  SCREEN_FILE_FIELDS,
  SCREEN_OPTIONAL_FIELDS,
  SCREEN_PROTOTYPE_FIELDS,
  SCREEN_PROTOTYPE_OPTIONAL_FIELDS,
  SECTION_FIELDS,
  SECTION_USE_FIELDS,
  SECTION_USE_OPTIONAL_FIELDS
} from '../src/core/screen-contract';
import { TOKEN_FIELDS, TOKEN_FILE_FIELDS, TOKEN_GROUP_FIELDS } from '../src/core/token-contract';
import { validateProject, validateProjectReadiness } from '../src/prototype/validate-project';

const SCHEMA_FILE = 'schema/blueprint-project.schema.json';
const GENERATE_FIX = 'Fix: run npm run generate:schema, then commit schema/blueprint-project.schema.json.';
const starterRoot = 'starter/design/blueprint';
const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';

/** Each `as unknown as` that src/core may keep, by file, with the reason. Keep it empty unless no schema type can replace the cast. */
const DOUBLE_CAST_ALLOW_LIST: Readonly<Record<string, string>> = {};

/** Each type in types.ts that has the fields of a schema object and differs from it, with the reason. */
const HAND_WRITTEN_SHAPES: Readonly<Record<string, string>> = {
  BoundarySelector: 'A selector can name a screen, and the kind of a reusable use names only a primitive or a component.'
};

async function withCopy(root: string, run: (copy: string) => Promise<void>): Promise<void> {
  const copy = await mkdtemp(path.join(tmpdir(), 'blueprint-schema-'));
  try {
    await cp(root, copy, { recursive: true });
    await run(copy);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

async function firstRecord(root: string, directory: string): Promise<string> {
  const names = (await readdir(path.join(root, directory))).filter(name => name.endsWith('.json')).sort();
  return `${directory}/${names[0]}`;
}

async function editJson(root: string, file: string, edit: (value: any) => void): Promise<void> {
  const value = JSON.parse(await readFile(path.join(root, file), 'utf8'));
  edit(value);
  await writeFile(path.join(root, file), JSON.stringify(value));
}

function staleSchemaError(text: string, generated: unknown): string | undefined {
  return text === serializeJson(generated) ? undefined : `${SCHEMA_FILE} does not match the zod schemas in src/core/schemas.\n${GENERATE_FIX}`;
}

function declaredShapes(text: string): Array<{ name: string; fields: string[] }> {
  const shapes: Array<{ name: string; fields: string[] }> = [];
  const fieldsOf = (members: ts.NodeArray<ts.TypeElement>): string[] => members
    .flatMap(member => (member.name && ts.isIdentifier(member.name) ? [member.name.text] : []));
  ts.createSourceFile('types.ts', text, ts.ScriptTarget.Latest, true).forEachChild(node => {
    if (ts.isInterfaceDeclaration(node)) shapes.push({ name: node.name.text, fields: fieldsOf(node.members) });
    if (ts.isTypeAliasDeclaration(node)) {
      shapes.push({ name: node.name.text, fields: ts.isTypeLiteralNode(node.type) ? fieldsOf(node.type.members) : [] });
    }
  });
  return shapes;
}

function schemaModules(): string[] {
  return readdirSync('src/core/schemas').filter(name => name.endsWith('.ts')).map(name => path.join('src/core/schemas', name));
}

function schemaOwnedTypes(): Set<string> {
  return new Set(schemaModules().flatMap(file => declaredShapes(readFileSync(file, 'utf8')).map(shape => shape.name)));
}

async function schemaObjectFields(): Promise<Set<string>> {
  const shapes = new Set<string>();
  for (const file of schemaModules()) {
    const module = await import(pathToFileURL(path.resolve(file)).href) as Record<string, unknown>;
    for (const value of Object.values(module)) {
      if (value instanceof z.ZodObject) shapes.add(Object.keys(value.shape).sort().join(','));
    }
  }
  return shapes;
}

function typeDrift(text: string, owned: ReadonlySet<string>, objectFields: ReadonlySet<string>): string[] {
  return declaredShapes(text).flatMap(({ name, fields }) => {
    if (owned.has(name)) return [`${name} is declared by hand, and a schema owns it. Fix: delete it and re-export the z.infer type from src/core/schemas.`];
    if (!Object.hasOwn(HAND_WRITTEN_SHAPES, name) && fields.length > 1 && objectFields.has([...fields].sort().join(','))) {
      return [`${name} repeats the fields of a schema. Fix: delete it and use the z.infer type from src/core/schemas.`];
    }
    return [];
  });
}

function doubleCasts(text: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) && ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true));
  return count;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function removablePaths(value: unknown, prefix: Array<string | number> = []): Array<Array<string | number>> {
  if (Array.isArray(value)) return value.length > 0 ? removablePaths(value[0], [...prefix, 0]) : [];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [[...prefix, key], ...removablePaths(child, [...prefix, key])]);
}

function withoutField(file: unknown, fieldPath: Array<string | number>): unknown {
  const next = structuredClone(file) as any;
  let holder = next;
  for (const key of fieldPath.slice(0, -1)) holder = holder[key];
  delete holder[fieldPath.at(-1)!];
  return next;
}

describe('generated JSON schema', () => {
  it('matches the zod schemas', () => {
    assert.equal(staleSchemaError(readFileSync(SCHEMA_FILE, 'utf8'), generateProjectJsonSchema()), undefined, `${SCHEMA_FILE} is stale.\n${GENERATE_FIX}`);
  });

  it('reports a stale file with a Fix line that names the npm script', () => {
    const changed = structuredClone(generateProjectJsonSchema()) as { title: string };
    changed.title = 'Changed';
    const error = staleSchemaError(readFileSync(SCHEMA_FILE, 'utf8'), changed);
    assert.ok(error);
    assert.match(error.split('\n').at(-1)!, /^Fix: run npm run generate:schema/);
  });

  it('keeps the identity of the published file', () => {
    const schema = generateProjectJsonSchema();
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.$id, 'https://blueprint.local/schema/blueprint-project.schema.json');
    assert.equal(schema.title, 'Blueprint Project Structured Files');
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { exports: Record<string, string>; scripts: Record<string, string> };
    assert.equal(manifest.exports['./schema/blueprint-project.schema.json'], `./${SCHEMA_FILE}`);
    assert.ok(manifest.scripts['generate:schema']);
  });
});

describe('types come from the schemas', () => {
  it('has a schema for each versioned file', () => {
    assert.deepEqual(STRUCTURED_FILE_SCHEMAS.map(({ file }) => file).sort(), [...VERSIONED_FILES].sort());
  });

  it('declares no schema-owned shape by hand in types.ts', async () => {
    assert.deepEqual(typeDrift(readFileSync('src/core/types.ts', 'utf8'), schemaOwnedTypes(), await schemaObjectFields()), []);
  });

  it('reports a hand-written type with the name or the fields of a schema', async () => {
    const owned = schemaOwnedTypes();
    const objectFields = await schemaObjectFields();
    assert.match(typeDrift('export interface ScreenDefinition { id: string; }', owned, objectFields).join('\n'), /ScreenDefinition is declared by hand/);
    assert.match(typeDrift('export type ScreenDefinition = { id: string; };', owned, objectFields).join('\n'), /ScreenDefinition is declared by hand/);
    assert.match(typeDrift('export interface Renamed { id: string; kind: string; name: string; description: string; }', owned, objectFields).join('\n'), /Renamed repeats the fields/);
    assert.deepEqual(typeDrift('export interface Other { id: string; only: string; }', owned, objectFields), []);
  });

  it('has no as unknown as in src/core outside the allow list', () => {
    const found = sourceFiles('src/core').filter(file => doubleCasts(readFileSync(file, 'utf8')) > 0).map(file => file.split(path.sep).join('/'));
    assert.deepEqual(found.filter(file => !Object.hasOwn(DOUBLE_CAST_ALLOW_LIST, file)), [], 'Fix: use the schema type, or add the file to DOUBLE_CAST_ALLOW_LIST with the reason.');
  });

  it('finds an as unknown as through the syntax tree', () => {
    assert.equal(doubleCasts('const a = b as unknown as C;'), 1);
    assert.equal(doubleCasts('const a = "b as unknown as C"; const d = e as F;'), 0);
  });

  it('keeps the field lists of the contracts equal to the schemas', () => {
    const fields = (schema: z.ZodObject): { required: string[]; optional: string[] } => ({
      required: Object.entries(schema.shape).filter(([, value]) => !(value instanceof z.ZodOptional)).map(([key]) => key).sort(),
      optional: Object.entries(schema.shape).filter(([, value]) => value instanceof z.ZodOptional).map(([key]) => key).sort()
    });
    const cases: Array<[string, z.ZodObject, readonly string[], readonly string[]]> = [
      ['screen file', screenFileSchema, SCREEN_FILE_FIELDS, []],
      ['page', declaredGroupSchema, PAGE_FIELDS, []],
      ['declared group', declaredGroupSchema, DECLARED_GROUP_FIELDS, []],
      ['screen', screenSchema, SCREEN_FIELDS, SCREEN_OPTIONAL_FIELDS],
      ['section', screenSectionSchema, SECTION_FIELDS, []],
      ['section use', boundaryDependencySchema, SECTION_USE_FIELDS, SECTION_USE_OPTIONAL_FIELDS],
      ['production relationship', productionRelationshipSchema, PRODUCTION_RELATIONSHIP_FIELDS, PRODUCTION_RELATIONSHIP_OPTIONAL_FIELDS],
      ['screen prototype', screenPrototypeSourceSchema, SCREEN_PROTOTYPE_FIELDS, SCREEN_PROTOTYPE_OPTIONAL_FIELDS],
      ['token file', tokenFileSchema, TOKEN_FILE_FIELDS, []],
      ['token group', tokenGroupSchema, TOKEN_GROUP_FIELDS, []],
      ['token', designTokenSchema, TOKEN_FIELDS, []],
      ['primitive file', primitiveFileSchema, PRIMITIVE_FILE_FIELDS, []],
      ['component file', componentFileSchema, COMPONENT_FILE_FIELDS, []],
      ['reusable', reusableSchema, REUSABLE_FIELDS, []],
      ['reusable axis', reusableAxisSchema, REUSABLE_AXIS_FIELDS, []],
      ['reusable axis value', reusableAxisValueSchema, REUSABLE_AXIS_VALUE_FIELDS, []],
      ['reusable slot', reusableSlotSchema, REUSABLE_SLOT_FIELDS, []],
      ['reusable use', reusableDependencySchema, REUSABLE_USE_FIELDS, []],
      ['reusable unsupported', reusableUnsupportedCombinationSchema, REUSABLE_UNSUPPORTED_FIELDS, []],
      ['reusable prototype', reusablePrototypeSourceSchema, REUSABLE_PROTOTYPE_FIELDS, []],
      ['inspo file', inspoFileSchema, INSPO_FILE_FIELDS, []],
      ['inspo entry', inspoEntrySchema, INSPO_ENTRY_FIELDS, []],
      ['inspo direction', inspoDirectionSchema, INSPO_DIRECTION_FIELDS, []]
    ];
    for (const [label, schema, required, optional] of cases) {
      assert.deepEqual(fields(schema), { required: [...required].sort(), optional: [...optional].sort() }, `${label}: Fix: change the contract list and the schema together.`);
    }
  });

  it('derives the fields migrate fills from the schemas', () => {
    assert.deepEqual(Object.keys(emptyRequiredFields(screenSchema.shape)), ['styleRefs', 'styleEvidence', 'notes', 'prototypeOnly', 'implementationHints', 'implementationTargets', 'sections']);
    assert.deepEqual(Object.keys(emptyRequiredFields(screenSectionSchema.shape)), ['styleRefs', 'styleEvidence', 'uses', 'prototypeOnly', 'notes', 'implementationHints', 'implementationTargets']);
    assert.deepEqual(Object.keys(emptyRequiredFields(productionRelationshipSchema.shape)), ['notes']);
    assert.deepEqual(emptyRequiredFields(screenSchema.shape).prototypeOnly!(), false);
    assert.deepEqual(emptyRequiredFields(screenSchema.shape).sections!(), []);
  });
});

describe('zod issues as agent errors', () => {
  const shape = z.strictObject({
    text: z.string().min(2).max(3).optional(),
    pattern: z.string().regex(/^a$/).optional(),
    list: z.array(z.string()).min(1).max(1).optional(),
    number: z.number().positive().max(2).optional(),
    whole: z.number().int().optional(),
    even: z.number().multipleOf(2).optional(),
    kind: z.enum(['a', 'b']).optional(),
    fixed: z.literal('x').optional(),
    choice: z.discriminatedUnion('type', [z.object({ type: z.literal('a') }), z.object({ type: z.literal('b') })]).optional(),
    keyed: z.record(z.string().regex(/^a$/), z.string()).optional(),
    unique: z.array(z.string()).refine(() => false, { message: 'lists a value twice', params: { fix: 'list each value once' } }).optional(),
    required: z.object({ list: z.array(z.string()) }).optional()
  });
  const inputs: Array<[string, Record<string, unknown>, RegExp]> = [
    ['invalid_type', { text: 1 }, /^f\.json: text must be a JSON string\. Fix: write text as a JSON string\.$/],
    ['invalid_type', { required: {} }, /^f\.json: required\.list is missing\. Fix: add required\.list as a JSON array\.$/],
    ['invalid_type', { whole: 1.5 }, /^f\.json: whole must be a whole number\. Fix: write whole as a whole number\.$/],
    ['too_small', { text: 'a' }, /^f\.json: text is shorter than 2 characters\. Fix: write 2 or more characters in text\.$/],
    ['too_big', { text: 'abcd' }, /^f\.json: text is longer than 3 characters\. Fix: shorten text to 3 characters or fewer\.$/],
    ['too_small', { list: [] }, /^f\.json: list has fewer than 1 item\. Fix: add items to list until it has 1 or more\.$/],
    ['too_big', { list: ['a', 'b'] }, /^f\.json: list has more than 1 item\. Fix: remove items from list until it has 1 or fewer\.$/],
    ['too_small', { number: 0 }, /^f\.json: number must be greater than 0\. Fix: set number to a number greater than 0\.$/],
    ['too_big', { number: 3 }, /^f\.json: number must be 2 or less\. Fix: set number to 2 or less\.$/],
    ['invalid_format', { pattern: 'b' }, /^f\.json: pattern does not match the pattern \/\^a\$\/\. Fix: change pattern so that it matches \/\^a\$\/\.$/],
    ['not_multiple_of', { even: 3 }, /^f\.json: even must be a multiple of 2\. Fix: set even to a multiple of 2\.$/],
    ['invalid_value', { kind: 'c' }, /^f\.json: kind is "c", which is not an allowed value\. Fix: set kind to one of "a", "b"\.$/],
    ['invalid_value', { fixed: 'y' }, /^f\.json: fixed is "y", which is not an allowed value\. Fix: set fixed to "x"\.$/],
    ['invalid_union', { choice: { type: 'c' } }, /^f\.json: choice\.type is "c", which is not an allowed value\. Fix: set choice\.type to one of "a", "b"\.$/],
    ['invalid_key', { keyed: { b: 'x' } }, /^f\.json: keyed\.b is a key that is not allowed\. Fix: rename keyed\.b\.$/],
    ['custom', { unique: ['a', 'a'] }, /^f\.json: unique lists a value twice\. Fix: list each value once\.$/],
    ['unrecognized_keys', { stray: 1 }, /^f\.json: the file has the unknown field "stray"\. Fix: remove it from the file\.$/]
  ];
  for (const [code, input, expected] of inputs) {
    it(`writes ${code} for ${JSON.stringify(input)} in the agent form`, () => {
      const issues = shape.safeParse(input).error?.issues ?? [];
      assert.equal(issues.length, 1);
      assert.equal(issues[0]!.code, code);
      assert.match(agentErrorForIssue('f.json', issues[0]!, input), expected);
    });
  }

  it('writes invalid_element in the agent form', () => {
    const input = new Map([[{}, 1]]);
    const issues = z.map(z.object({}), z.string()).safeParse(input).error?.issues ?? [];
    assert.equal(issues[0]?.code, 'invalid_element');
    assert.equal(agentErrorForIssue('f.json', issues[0]!, input), 'f.json: the file has a value that is not allowed. Fix: correct the value in the file.');
  });

  it('writes a plain union in the agent form', () => {
    const issues = z.union([z.string(), z.number()]).safeParse(true).error?.issues ?? [];
    assert.equal(issues[0]?.code, 'invalid_union');
    assert.equal(agentErrorForIssue('f.json', issues[0]!, true), 'f.json: the file does not match an allowed shape. Fix: write the file in a shape that schema/blueprint-project.schema.json allows.');
  });

  it('writes a file that is not an object in the agent form', () => {
    const issues = shape.safeParse([]).error?.issues ?? [];
    assert.equal(agentErrorForIssue('f.json', issues[0]!, []), 'f.json: the file must be a JSON object. Fix: write the file as a JSON object.');
  });
});

describe('structured files at load', () => {
  const wrongShapes: Array<{ file: () => Promise<string> | string; path: string; word: string; edit: (value: any) => void }> = [
    { file: () => 'manifest.json', path: 'project', word: 'a JSON object', edit: value => { value.project = 'fun'; } },
    { file: () => 'tokens.json', path: 'tokenGroups[0].tokens', word: 'a JSON array', edit: value => { value.tokenGroups[0].tokens = 'fun'; } },
    { file: () => 'brand.json', path: 'marks[0].variants', word: 'a JSON array', edit: value => { value.marks[0].variants = {}; } },
    { file: () => 'inspo.json', path: 'entries', word: 'a JSON array', edit: value => { value.entries = 'fun'; } },
    { file: () => 'screens.json', path: 'screens[0].prototype.styles', word: 'a JSON array', edit: value => { value.screens[0].prototype.styles = 'fun'; } },
    { file: () => 'primitives.json', path: 'primitives[0].uses', word: 'a JSON array', edit: value => { value.primitives[0].uses = 7; } },
    { file: () => 'components.json', path: 'groups', word: 'a JSON array', edit: value => { value.groups = 'fun'; } },
    { file: () => firstRecord(meridianRoot, 'explorations'), path: 'exploration.candidates[0].prototype', word: 'a JSON object', edit: value => { value.exploration.candidates[0].prototype = 7; } },
    { file: () => firstRecord(meridianRoot, 'history'), path: 'entry.screen.sections', word: 'a JSON array', edit: value => { value.entry.screen.sections = 'fun'; } }
  ];
  for (const { file: fileOf, path: fieldPath, word, edit } of wrongShapes) {
    it(`refuses a wrong shape at ${fieldPath} with the file, the path, and a Fix`, async () => {
      const file = await fileOf();
      await withCopy(meridianRoot, async copy => {
        if (file === 'inspo.json') {
          await writeFile(path.join(copy, file), JSON.stringify({ schemaVersion: BLUEPRINT_SCHEMA_VERSION, projectId: 'meridian-finance', entries: [], directions: [] }));
        }
        await editJson(copy, file, edit);
        await assert.rejects(loadProjectFromFs(copy), (error: Error) => {
          assert.ok(error.message.includes(`${file}: ${fieldPath} must be ${word}. Fix: write ${fieldPath} as ${word}.`), error.message);
          assert.doesNotMatch(error.message, /Invalid input|received/);
          return true;
        });
      });
    });
  }

  for (const content of ['[]', 'null', '1', '"x"']) {
    it(`refuses a structured file and a saved record that hold only ${content}`, async () => {
      for (const file of ['manifest.json', await firstRecord(meridianRoot, 'history')]) {
        await withCopy(meridianRoot, async copy => {
          await writeFile(path.join(copy, file), content);
          await assert.rejects(loadProjectFromFs(copy), (error: Error) => {
            assert.equal(error.message, `${file}: the file must be a JSON object. Fix: write the file as a JSON object.`);
            return true;
          });
        });
      }
    });
  }

  it('loads each project of the comparison', async () => {
    const roots = [
      starterRoot,
      ...readdirSync('fixtures/valid').map(name => path.join('fixtures/valid', name, 'design/blueprint')),
      'fixtures/invalid/broken/design/blueprint',
    ];
    assert.ok(roots.length >= 5);
    for (const root of roots) {
      await assert.doesNotReject(loadProjectFromFs(root), root);
    }
  });

  it('accepts a saved screen that has flow and no page, as older snapshots do', async () => {
    await withCopy(meridianRoot, async copy => {
      const exploration = await firstRecord(copy, 'explorations');
      const history = await firstRecord(copy, 'history');
      await editJson(copy, exploration, value => {
        delete value.exploration.target.baseline.screen.page;
        value.exploration.target.baseline.screen.flow = 'Home';
      });
      await editJson(copy, history, value => {
        delete value.entry.screen.page;
      });
      await assert.doesNotReject(loadProjectFromFs(copy));
    });
  });

  it('keeps the rules of validate on a project with a long name, an unknown field, and no description', async () => {
    await withCopy(starterRoot, async copy => {
      await editJson(copy, 'screens.json', value => {
        value.pages[0].name = 'x'.repeat(40);
        delete value.pages[0].description;
        value.pages[0].stray = true;
      });
      const errors = validateProject(await loadProjectFromFs(copy)).errors.join('\n');
      assert.match(errors, /has unknown field "stray"/);
      assert.match(errors, /description is missing\. Fix: say which screens the page holds/);
      assert.match(errors, /is 40 characters\. Fix: shorten it to 24 or fewer/);
    });
  });

  it('returns each file as it is written, with its key order and its unknown fields', async () => {
    await withCopy(starterRoot, async copy => {
      await editJson(copy, 'tokens.json', value => {
        value.stray = { z: 1, a: 2 };
      });
      const bundle = await loadProjectFromFs(copy);
      for (const [file, content] of [['manifest.json', bundle.manifest], ['tokens.json', bundle.tokens], ['screens.json', bundle.screens], ['primitives.json', bundle.primitives]] as const) {
        assert.equal(JSON.stringify(content), JSON.stringify(JSON.parse(await readFile(path.join(copy, file), 'utf8'))), file);
      }
    });
  });

  it('gives an older file the migrate refusal and not a shape error', async () => {
    const migrateRefusal = /is on schema "1\.0\.0", and Blueprint now reads "[^"]+"\. Fix: run the migrate tool/;
    await withCopy(starterRoot, async copy => {
      await editJson(copy, 'tokens.json', value => {
        value.schemaVersion = '1.0.0';
        value.tokenGroups = 'fun';
      });
      const errors = schemaVersionErrors(await loadProjectFromFs(copy));
      assert.equal(errors.length, 1);
      assert.match(errors[0]!, migrateRefusal);
    });
    await withCopy(starterRoot, async copy => {
      await editJson(copy, 'primitives.json', value => {
        value.schemaVersion = '1.0.0';
        value.primitives = 'fun';
      });
      await assert.rejects(loadProjectFromFs(copy), (error: Error) => {
        assert.ok(!(error instanceof TypeError), error.message);
        assert.match(error.message, migrateRefusal);
        return true;
      });
    });
    await withCopy(meridianRoot, async copy => {
      await editJson(copy, await firstRecord(copy, 'explorations'), value => {
        value.schemaVersion = '1.0.0';
        value.exploration = 7;
      });
      await assert.rejects(loadProjectFromFs(copy), (error: Error) => {
        assert.ok(!(error instanceof TypeError), error.message);
        assert.match(error.message, migrateRefusal);
        return true;
      });
    });
  });

  it('refuses a project that combines an older file with a wrong shape in a current file, naming the current file', async () => {
    await withCopy(starterRoot, async copy => {
      await editJson(copy, 'tokens.json', value => {
        value.schemaVersion = '1.0.0';
      });
      await editJson(copy, 'screens.json', value => {
        value.screens = 'fun';
      });
      await assert.rejects(loadProjectFromFs(copy), /^Error: screens\.json: screens must be a JSON array\. Fix: write screens as a JSON array\.$/);
    });
  });

  it('never ends in a TypeError when one field is missing', async () => {
    await withCopy(meridianRoot, async copy => {
      const keepFirst: Array<[string, string]> = [['primitives.json', 'primitives'], ['screens.json', 'screens'], ['tokens.json', 'tokenGroups'], ['components.json', 'components']];
      for (const [file, key] of keepFirst) {
        await editJson(copy, file, value => {
          value[key] = value[key].slice(0, 1);
        });
      }
      for (const [directory, file] of [['explorations', await firstRecord(copy, 'explorations')], ['history', await firstRecord(copy, 'history')]] as const) {
        for (const name of await readdir(path.join(copy, directory))) {
          if (`${directory}/${name}` !== file) await rm(path.join(copy, directory, name));
        }
      }
      await writeFile(path.join(copy, 'inspo.json'), JSON.stringify({
        schemaVersion: BLUEPRINT_SCHEMA_VERSION,
        projectId: 'meridian-finance',
        entries: [{ id: 'ref-1', sourceUrl: 'https://example.invalid/ref-1.png', image: 'inspo/ref-1.png', aspects: ['color'], stance: 'like', note: 'warm paper', reading: 'The brand uses a warm paper ground.' }],
        directions: [{ aspect: 'color', statement: 'The brand uses a warm paper ground.', entryIds: ['ref-1'], status: 'approved' }]
      }));
      const files = [
        ...VERSIONED_FILES.filter(file => existsSync(path.join(copy, file))),
        await firstRecord(copy, 'explorations'),
        await firstRecord(copy, 'history')
      ];
      const crashes: string[] = [];
      for (const file of files) {
        const original = await readFile(path.join(copy, file), 'utf8');
        const parsed = JSON.parse(original) as unknown;
        const seen = new Set<string>();
        for (const fieldPath of removablePaths(parsed)) {
          const label = fieldPath.join('.');
          if (label === 'schemaVersion' || seen.has(label)) continue;
          seen.add(label);
          await writeFile(path.join(copy, file), JSON.stringify(withoutField(parsed, fieldPath)));
          try {
            const bundle = await loadProjectFromFs(copy);
            validateProject(bundle);
            validateProject(bundle, { mode: 'strict' });
            validateProjectReadiness(bundle);
            listBoundaryReferences(bundle);
            collectDesignFindings(bundle);
            collectProseAdvisories(bundle);
          } catch (error) {
            if (error instanceof TypeError) crashes.push(`${file} ${label}: ${error.message}. Fix: add the field to REQUIRED_TO_READ in src/core/schemas/issues.ts, or check it in the reader.`);
          }
        }
        await writeFile(path.join(copy, file), original);
      }
      assert.deepEqual(crashes, []);
    });
  });
});

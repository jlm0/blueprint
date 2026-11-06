import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { boundaryDisplayName, FRAME_PRESETS_FOCUS_ID } from '../../src/core/activity';
import { DEFAULT_FRAME_MOUNT_POLICY } from '../../src/app/frame-mounting';
import { FRAME_THUMBNAIL_DOCUMENT_LIMIT } from '../../src/app/frame-thumbnails';
import { BASE_PRIMITIVE_CONTRACT } from '../../src/core/base-primitives';
import { collectNamingErrors, ID_LENGTH_CAP } from '../../src/core/naming-rules';
import { MAX_SENTENCE_WORDS } from '../../src/core/prose-lint';
import { REUSABLE_LIMITS } from '../../src/core/reusable-contract';
import { SCREEN_LIMITS } from '../../src/core/screen-contract';
import { reusablePrototypeSourceSchema, reusableSchema } from '../../src/core/schemas/reusable';
import { screenSchema, screenSectionSchema } from '../../src/core/schemas/screens';
import { designTokenSchema, tokenGroupSchema } from '../../src/core/schemas/tokens';
import { TOKEN_LIMITS } from '../../src/core/token-contract';
import type { BlueprintProjectBundle } from '../../src/core/types';
import type { BLUEPRINT_MCP_TOOL_NAMES } from '../../src/mcp/create-server';
import {
  captureInputSchema,
  exploreInputSchema,
  extractInputSchema,
  indexInputSchema,
  initInputSchema,
  inspoInputSchema,
  migrateInputSchema,
  promoteInputSchema,
  queryInputSchema,
  querySpecSchema,
  restoreInputSchema,
  selectionInputSchema,
  serveInputSchema,
  validateInputSchema
} from '../../src/mcp/schemas';

export const SELF_VALIDATING_TOOLS = ['init', 'inspo', 'migrate', 'explore', 'promote', 'restore'] as const;

export interface DirectiveText {
  agents: string;
  readme: string;
  instructions: string;
  toolNames: readonly string[];
  toolDescriptions: Readonly<Record<string, string>>;
  captureStateDescription: string;
  sources: Readonly<Record<string, string>>;
  scripts: Readonly<Record<string, string>>;
  starterScreens: ReadonlyArray<{ id: string; framePresetId: string }>;
  /** Each file under `skills/`, keyed by its path from the repository root. */
  skills: Readonly<Record<string, string>>;
}

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]);
}

function captured(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map(match => match[1]);
}

function between(text: string, start: string, end: string): string | undefined {
  const from = text.indexOf(start);
  if (from < 0) return undefined;
  const to = text.indexOf(end, from + start.length);
  return to < 0 ? undefined : text.slice(from + start.length, to);
}

function namedTools(text: string): string[] {
  return [
    ...captured(text, /`([a-z][a-z-]*)` (?:MCP )?tools?\b/g),
    ...captured(text, /\b(?:the|with) ([a-z][a-z-]*) tools?\b/g)
  ];
}

function toolNameFailures({ agents, readme, instructions, toolNames }: DirectiveText): string[] {
  const known = new Set(toolNames);
  const failures = Object.entries({ 'AGENTS.md': agents, 'README.md': readme, 'the server instructions': instructions }).flatMap(([label, text]) => (
    namedTools(text).filter(name => !known.has(name)).map(name => `${label} names the tool "${name}", which the tool list does not hold.`)
  ));
  const inAgents = new Set(backticked(agents));
  for (const tool of toolNames) {
    if (!inAgents.has(tool)) failures.push(`AGENTS.md does not name the tool "${tool}".`);
  }
  return failures;
}

function readmeToolTableFailures({ readme, toolNames }: DirectiveText): string[] {
  const table = between(readme, 'project-scoped tools:', 'Example calls:') ?? '';
  const rows = captured(table, /^\| `([a-z]+)` \|/gm);
  const failures = rows.join() === toolNames.join() ? [] : [`The tool table of README.md lists ${rows.join(', ')}, and the tool list is ${toolNames.join(', ')}.`];
  const countWords: Readonly<Record<number, string>> = { 12: 'twelve', 13: 'thirteen', 14: 'fourteen' };
  if (!readme.includes(`exposes ${countWords[toolNames.length]} project-scoped tools`)) {
    failures.push(`README.md does not state ${toolNames.length} tools.`);
  }
  return failures;
}

function fieldFailures(label: string, listed: readonly string[] | undefined, expected: readonly string[]): string[] {
  if (!listed) return [`AGENTS.md does not list the fields of ${label}.`];
  const allowed = new Set(expected);
  const present = new Set(listed);
  return [
    ...expected.filter(field => !present.has(field)).map(field => `AGENTS.md does not list the field "${field}" of ${label}.`),
    ...listed.filter(field => !allowed.has(field)).map(field => `AGENTS.md lists the field "${field}" of ${label}, which the schema does not hold.`)
  ];
}

function list(text: string | undefined): string[] | undefined {
  return text === undefined ? undefined : backticked(text);
}

function shapeFailures({ agents }: DirectiveText): string[] {
  const optionalOfScreen = Object.keys(screenSchema.shape).filter(key => screenSchema.shape[key as keyof typeof screenSchema.shape].safeParse(undefined).success);
  const requiredOfScreen = Object.keys(screenSchema.shape).filter(key => !optionalOfScreen.includes(key));
  return [
    ...fieldFailures('a reusable', list(between(agents, 'every field is required:', 'Validation rejects any other field')), [...Object.keys(reusableSchema.shape), ...Object.keys(reusablePrototypeSourceSchema.shape)]),
    ...fieldFailures('a screen', list(between(agents, 'A screen carries', 'Add `version`')), requiredOfScreen),
    ...fieldFailures('an optional part of a screen', list(between(agents, 'Add `version`', 'only when they apply')?.concat('`version`')), optionalOfScreen),
    ...fieldFailures('a section', list(between(agents, 'A section carries', 'and each use is')), Object.keys(screenSectionSchema.shape)),
    ...fieldFailures('a token group', list(between(agents, 'A token group carries', 'and each token carries')), Object.keys(tokenGroupSchema.shape)),
    ...fieldFailures('a token', list(between(agents, 'and each token carries', 'Write `[]` or `false`')), Object.keys(designTokenSchema.shape))
  ];
}

function statedNumberFailures(label: string, text: string, rows: ReadonlyArray<readonly [RegExp, readonly number[]]>): string[] {
  return rows.flatMap(([pattern, values]) => {
    const stated = pattern.exec(text)?.[1];
    if (stated === undefined) return [`${label} no longer matches ${pattern}.`];
    return values.filter(value => value !== Number(stated)).map(value => `${label} states ${stated} in ${pattern}, and the code holds ${value}.`);
  });
}

function numberFailures({ agents, readme }: DirectiveText): string[] {
  const primitiveCount = BASE_PRIMITIVE_CONTRACT.length;
  return [
    ...statedNumberFailures('AGENTS.md', agents, [
      [/the (\d+) building blocks/, [primitiveCount]],
      [/An id has at most (\d+) characters/, [ID_LENGTH_CAP]],
      [/Names are sentence case and at most (\d+) characters/, [REUSABLE_LIMITS.name]],
      [/when to use it in at most (\d+) characters/, [REUSABLE_LIMITS.description]],
      [/Value names are sentence case and at most (\d+) characters/, [REUSABLE_LIMITS.valueName]],
      [/descriptions are one sentence of at most (\d+)/, [REUSABLE_LIMITS.valueDescription]],
      [/`accessibility` says in at most (\d+) characters/, [REUSABLE_LIMITS.accessibility]],
      [/Each note and hint is at most (\d+) characters/, [REUSABLE_LIMITS.note]],
      [/Screen, section, and token names are sentence case and at most (\d+) characters/, [SCREEN_LIMITS.name, TOKEN_LIMITS.name]],
      [/page and token group names are at most (\d+)/, [SCREEN_LIMITS.pageName, TOKEN_LIMITS.groupName]],
      [/Screen and section descriptions are at most (\d+) characters/, [SCREEN_LIMITS.description]],
      [/page, token group, and token descriptions at most (\d+)/, [SCREEN_LIMITS.pageDescription, TOKEN_LIMITS.groupDescription, TOKEN_LIMITS.description]],
      [/Each note, hint, and reason is at most (\d+)/, [SCREEN_LIMITS.note, SCREEN_LIMITS.reason, TOKEN_LIMITS.note]],
      [/Write sentences of at most (\d+) words/, [MAX_SENTENCE_WORDS]],
      [/a sentence-case `name` of at most (\d+) characters/, [REUSABLE_LIMITS.groupName]],
      [/one-line `description` of at most (\d+)/, [REUSABLE_LIMITS.groupDescription]]
    ]),
    ...statedNumberFailures('README.md', readme, [
      [/the closed set of (\d+) primitives/, [primitiveCount]],
      [/neutral tokens, the (\d+) primitives/, [primitiveCount]],
      [/sentences of at most (\d+) words/, [MAX_SENTENCE_WORDS]],
      [/keeps at most (\d+) frames live/, [DEFAULT_FRAME_MOUNT_POLICY.maxFrames]],
      [/document is over (\d+) MB/, [FRAME_THUMBNAIL_DOCUMENT_LIMIT / (1024 * 1024)]]
    ])
  ];
}

function namingWordFailures({ agents }: DirectiveText): string[] {
  const groups = [
    { label: 'placeholder', words: list(between(agents, 'no placeholder word such as', ', no version word')) },
    { label: 'version', words: list(between(agents, 'no version word such as', ', and it does not end')) }
  ];
  return groups.flatMap(({ label, words }) => {
    if (!words?.length) return [`AGENTS.md lists no ${label} word.`];
    return words.filter(word => {
      const bundle = {
        manifest: { framePresets: [] },
        primitives: { primitives: [] },
        components: { components: [{ id: `row-${word}-card` }] },
        screens: { screens: [], pages: [] },
        explorations: { explorations: [] }
      } as unknown as BlueprintProjectBundle;
      return !collectNamingErrors(bundle).some(error => error.includes(`the ${label} word "${word}"`));
    }).map(word => `AGENTS.md names the ${label} word "${word}", and the naming rules accept it.`);
  });
}

function inspoFailures({ agents, toolDescriptions }: DirectiveText): string[] {
  const failures: string[] = [];
  const options = inspoInputSchema.shape.operation.options;
  const operations = new Set(options.map(option => String(option.shape.type.value)));
  for (const name of captured(agents, /`([a-z]+)` operation/g)) {
    if (!operations.has(name)) failures.push(`AGENTS.md names the inspo operation "${name}", which the schema does not hold.`);
  }
  for (const option of options) {
    const operation = String(option.shape.type.value);
    const line = agents.split('\n').find(text => text.includes(`\`${operation}\` operation`));
    const required = Object.entries(option.shape).filter(([key, field]) => key !== 'type' && !(field as { safeParse: (value: unknown) => { success: boolean } }).safeParse(undefined).success).map(([key]) => key);
    if (line === undefined) {
      if (required.length > 0 && operation !== 'update' && operation !== 'remove') failures.push(`AGENTS.md does not name the inspo operation "${operation}".`);
      continue;
    }
    for (const field of required) {
      if (!backticked(line).includes(field)) failures.push(`The AGENTS.md step for the inspo operation "${operation}" does not name its required field "${field}".`);
    }
  }
  const addSentence = /\badd\b[^.]*\./.exec(toolDescriptions.inspo ?? '')?.[0] ?? '';
  for (const field of ['url', 'id']) {
    if (!new RegExp(`\\b${field}\\b`).test(addSentence)) failures.push(`The inspo tool text does not say that add requires ${field}.`);
  }
  return failures;
}

function modeFailures({ agents }: DirectiveText): string[] {
  const modes = new Set<string>(validateInputSchema.shape.mode.unwrap().options);
  return captured(agents, /`([a-z]+)` modes?\b/g).filter(mode => !modes.has(mode)).map(mode => `AGENTS.md names the validation mode "${mode}", which the schema does not hold.`);
}

const STALE_TEXT: ReadonlyArray<{ where: (text: DirectiveText) => string; label: string; pattern: RegExp; truth: string }> = [
  { label: 'README.md', where: text => text.readme, pattern: /every tool except `migrate` refuses/i, truth: '`validate` reports and `serve` shows a notice' },
  { label: 'README.md', where: text => text.readme, pattern: /Strict-lint findings/, truth: 'the lints run in each mode' },
  { label: 'README.md', where: text => text.readme, pattern: /`strict` checks the full production handoff contract, including lints/, truth: 'the lints run in each mode' },
  { label: 'README.md', where: text => text.readme, pattern: /src\/prototype\/[^\n]*\bcapture\b/, truth: 'capture lives in src/mcp' },
  { label: 'README.md', where: text => text.readme, pattern: /While an edit is invalid/, truth: 'only a contract error holds the last good state' },
  { label: 'README.md', where: text => text.readme, pattern: /Boundaries that changed during the latest agent turn get a dashed marker/, truth: 'a mark names an element whose computed look changed' },
  { label: 'AGENTS.md', where: text => text.agents, pattern: /Errors on the shapes of reusables/, truth: 'each validation error ends with a Fix line' },
  { label: 'AGENTS.md', where: text => text.agents, pattern: /strict validation rejects primitives outside the set/, truth: 'each mode rejects them' },
  { label: 'AGENTS.md', where: text => text.agents, pattern: /Every other tool refuses the folder/, truth: 'plain `serve` and `selection` with no selection do not refuse' },
  { label: 'the server instructions', where: text => text.instructions, pattern: /every other tool refuses it until/i, truth: 'plain `serve` and `selection` with no selection do not refuse' },
  { label: 'the migrate tool text', where: text => text.toolDescriptions.migrate ?? '', pattern: /left unchanged/, truth: 'migrate repairs a project on the current schema' },
  { label: 'the capture state text', where: text => text.captureStateDescription, pattern: /Defaults to the first declared state\.$/, truth: 'a reusable defaults to its default state' },
  { label: 'src/mcp/capture.ts', where: text => text.sources['src/mcp/capture.ts'] ?? '', pattern: /apply to primitives\./, truth: 'components also take variant and size' }
];

function staleTextFailures(text: DirectiveText): string[] {
  return STALE_TEXT.filter(({ where, pattern }) => pattern.test(where(text))).map(({ label, pattern, truth }) => `${label} matches ${pattern}, and ${truth}.`);
}

const VALIDATE_AFTER_MUTATION = new RegExp(`\\b(?:${SELF_VALIDATING_TOOLS.join('|')})\\b[^.\\n]*\\bthen\\b[^.\\n]*\\b(?:call|run|fix what)\\b[^.\\n]*\\bvalidate\\b`, 'i');

function validateAfterMutationFailures({ agents, readme, instructions, toolDescriptions, sources, skills }: DirectiveText): string[] {
  const texts = { 'AGENTS.md': agents, 'README.md': readme, 'the server instructions': instructions, ...toolDescriptions, ...sources, ...skills };
  return Object.entries(texts).flatMap(([label, text]) => {
    const match = VALIDATE_AFTER_MUTATION.exec(text);
    return match ? [`${label} tells an agent to validate after a tool that validates itself: "${match[0]}".`] : [];
  });
}

function functionBody(source: string, name: string): string {
  const from = source.indexOf(`function ${name}(`);
  if (from < 0) return '';
  const to = source.indexOf('\n}\n', from);
  return to < 0 ? '' : source.slice(from, to);
}

const SELF_VALIDATION_CALLS: ReadonlyArray<{ tool: string; file: string; fn: string; calls: readonly string[] }> = [
  { tool: 'init', file: 'src/mcp/operations.ts', fn: 'initializeBlueprint', calls: ['validateOnWorker('] },
  { tool: 'migrate', file: 'src/mcp/operations.ts', fn: 'migrateBlueprint', calls: ['validateMigration('] },
  { tool: 'explore', file: 'src/mcp/operations.ts', fn: 'exploreBlueprint', calls: ['assertValidMutation(', 'commitProjectMutation('] },
  { tool: 'promote', file: 'src/mcp/operations.ts', fn: 'promoteBlueprint', calls: ['assertValidMutation(', 'commitProjectMutation('] },
  { tool: 'restore', file: 'src/mcp/operations.ts', fn: 'restoreBlueprint', calls: ['assertValidMutation(', 'commitProjectMutation('] },
  { tool: 'inspo', file: 'src/mcp/inspo.ts', fn: 'mutateInspo', calls: ['assertValidMutation(', 'commitProjectMutation('] }
];

function selfValidationFailures({ agents, instructions, sources }: DirectiveText): string[] {
  const failures = SELF_VALIDATION_CALLS.flatMap(({ tool, file, fn, calls }) => {
    const body = functionBody(sources[file] ?? '', fn);
    return calls.filter(call => !body.includes(call)).map(call => `The ${tool} tool claims to validate itself, and ${fn} in ${file} has no ${call}.`);
  });
  const listed = SELF_VALIDATING_TOOLS.map(tool => `\`${tool}\``);
  const agentsList = `The ${listed.slice(0, -1).join(', ')}, and ${listed.at(-1)} tools validate their own result in \`baseline\` mode.`;
  if (!agents.includes(agentsList)) failures.push('AGENTS.md does not list each tool that validates itself.');
  const instructionsList = `The ${SELF_VALIDATING_TOOLS.slice(0, -1).join(', ')}, and ${SELF_VALIDATING_TOOLS.at(-1)} tools validate their own result in baseline mode`;
  if (!instructions.includes(instructionsList)) failures.push('The server instructions do not list each tool that validates itself.');
  return failures;
}

function olderSchemaFailures({ agents, readme, instructions }: DirectiveText): string[] {
  const rows: ReadonlyArray<readonly [string, string, RegExp]> = [
    ['AGENTS.md', agents, /`validate` reports each file on an older schema and `serve` shows a notice\. `serve` with `focus` or `explorationId`, and every other tool that reads the folder, refuse it/],
    ['README.md', readme, /`validate` reports each older file and `serve` shows a notice on the canvas\. `serve` with `focus` or `explorationId`, and every other tool that reads the sidecar, refuse it/],
    ['the server instructions', instructions, /validate reports each file on an older schema and serve shows a notice\. Serve with focus or explorationId, and every other tool that reads the sidecar, refuse it/]
  ];
  return rows.filter(([, text, pattern]) => !pattern.test(text)).map(([label]) => `${label} does not state which tools work on an older schema.`);
}

function restartFailures({ agents, readme, instructions, sources }: DirectiveText): string[] {
  const failures = Object.entries({ 'AGENTS.md': agents, 'README.md': readme, 'the server instructions': instructions })
    .filter(([, text]) => !/restart the MCP server/i.test(text))
    .map(([label]) => `${label} does not tell the reader to restart the MCP server after a build.`);
  if (!/const indexHtml = await readFile\(indexPath/.test(sources['src/mcp/serve-server.ts'] ?? '')) {
    failures.push('The serve runtime no longer reads the canvas page once at start. Fix: check each restart directive, then update this guard.');
  }
  return failures;
}

function changeEntryFailures({ readme }: DirectiveText): string[] {
  const entry = boundaryDisplayName({ manifest: { project: { name: '' } } } as unknown as BlueprintProjectBundle, 'project', FRAME_PRESETS_FOCUS_ID);
  return readme.includes(`"${entry}"`) ? [] : [`README.md does not name the change entry "${entry}".`];
}

function starterFrameFailures({ agents, starterScreens }: DirectiveText): string[] {
  const wrong = starterScreens.filter(({ id, framePresetId }) => !agents.includes(`\`screen:${id}\` on \`${framePresetId}\``)).map(({ id }) => `AGENTS.md does not state the starter frame "${id}" and its preset.`);
  const count = /exactly (\w+) empty base frames/.exec(agents)?.[1];
  const words: Readonly<Record<number, string>> = { 1: 'one', 2: 'two', 3: 'three' };
  return count === words[starterScreens.length] ? wrong : [...wrong, `AGENTS.md states ${count} starter frames, and the starter has ${starterScreens.length}.`];
}

function layoutFailures({ readme, sources }: DirectiveText): string[] {
  const block = /## Repository layout\s+```text\n([\s\S]*?)```/.exec(readme)?.[1];
  if (!block) return ['README.md has no repository layout.'];
  const rows = captured(block, /^(\S+\/)\s/gm);
  const failures = rows.filter(row => !existsSync(row)).map(row => `The layout of README.md names ${row}, which does not exist.`);
  const directories = readdirSync('src', { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => `src/${entry.name}/`);
  failures.push(...directories.filter(directory => !rows.includes(directory)).map(directory => `The layout of README.md does not name ${directory}.`));
  const captureFile = Object.keys(sources).find(file => path.basename(file) === 'capture.ts');
  const captureOwner = captureFile ? path.dirname(captureFile) : 'src';
  if (!new RegExp(`^${captureOwner}/[^\\n]*\\bcapture\\b`, 'm').test(block)) failures.push(`The layout of README.md does not place capture in ${captureOwner}/.`);
  return failures;
}

function scriptFailures({ readme, scripts }: DirectiveText): string[] {
  const table = between(readme, '## Scripts', 'Generated evidence') ?? '';
  const named = captured(table, /^\| `npm (?:run )?([a-z:]+)` \|/gm);
  const failures = named.length === 0 ? ['README.md has no script table.'] : [];
  failures.push(...named.filter(name => !(name in scripts)).map(name => `README.md names the script "${name}", which package.json does not hold.`));
  const allOfTheAbove = named.filter(name => !['dev', 'test', 'qa'].includes(name));
  failures.push(...allOfTheAbove.filter(name => !(scripts.qa ?? '').includes(`npm run ${name}`)).map(name => `README.md says qa runs each script, and qa does not run "${name}".`));
  return failures;
}

const TOOL_INPUTS: Readonly<Record<(typeof BLUEPRINT_MCP_TOOL_NAMES)[number], { safeParse: (value: unknown) => { success: boolean } }>> = {
  init: initInputSchema,
  inspo: inspoInputSchema,
  validate: validateInputSchema,
  migrate: migrateInputSchema,
  index: indexInputSchema,
  query: queryInputSchema,
  extract: extractInputSchema,
  capture: captureInputSchema,
  serve: serveInputSchema,
  selection: selectionInputSchema,
  explore: exploreInputSchema,
  promote: promoteInputSchema,
  restore: restoreInputSchema
};

const VALIDATION_MODES = new Set<string>([...validateInputSchema.shape.mode.unwrap().options, ...extractInputSchema.shape.mode.unwrap().options]);

/** A skill example writes `<kind>:<id>`, an optional key as `"screenId?"`, and a choice as `"a\|b"` in place of a value. */
function sampleJson(example: string): unknown {
  try {
    return JSON.parse(example
      .replaceAll('<kind>:<id>', 'screen:home')
      .replace(/"([^"\\]+)(?:\\\|[^"\\]+)+"/g, '"$1"')
      .replace(/"([a-zA-Z]+)\?"/g, '"$1"'));
  } catch {
    return undefined;
  }
}

function skillFailures({ skills, toolNames }: DirectiveText): string[] {
  const known = new Set(toolNames);
  return Object.entries(skills).flatMap(([file, text]) => {
    const tools = [...captured(text, /mcp__blueprint__([a-z]+)/g), ...namedTools(text)];
    const examples = captured(text, /```json\n([\s\S]*?)```/g).map(example => example.trim());
    const queries = captured(text, /^\| [a-z /-]+ \| `(\{[^`]*\})` \|$/gm);
    return [
      ...tools.filter(name => !known.has(name)).map(name => `${file} names the tool "${name}", which the tool list does not hold.`),
      ...STALE_TEXT.filter(({ pattern }) => pattern.test(text)).map(({ pattern, truth }) => `${file} matches ${pattern}, and ${truth}.`),
      ...captured(text, /"mode":"([a-z]+)"/g).filter(mode => !VALIDATION_MODES.has(mode)).map(mode => `${file} names the mode "${mode}", which validate and extract do not hold.`),
      ...examples.filter(example => !Object.values(TOOL_INPUTS).some(schema => schema.safeParse(sampleJson(example)).success)).map(example => `${file} holds a JSON example that no tool input accepts: ${example}`),
      ...queries.filter(query => !querySpecSchema.safeParse(sampleJson(query)).success).map(query => `${file} holds the query shape ${query}, which the query schema does not accept.`)
    ];
  });
}

export function collectDirectiveFailures(text: DirectiveText): string[] {
  return [
    ...toolNameFailures(text),
    ...readmeToolTableFailures(text),
    ...shapeFailures(text),
    ...numberFailures(text),
    ...namingWordFailures(text),
    ...inspoFailures(text),
    ...modeFailures(text),
    ...staleTextFailures(text),
    ...validateAfterMutationFailures(text),
    ...selfValidationFailures(text),
    ...olderSchemaFailures(text),
    ...restartFailures(text),
    ...changeEntryFailures(text),
    ...starterFrameFailures(text),
    ...layoutFailures(text),
    ...scriptFailures(text),
    ...skillFailures(text)
  ];
}

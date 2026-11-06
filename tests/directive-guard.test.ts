import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadProjectFromFs } from '../src/core/load';
import { lintProse } from '../src/core/prose-lint';
import { captureBlueprint } from '../src/mcp/capture';
import { BLUEPRINT_MCP_TOOL_NAMES, createBlueprintMcpServer } from '../src/mcp/create-server';
import { captureInputSchema } from '../src/mcp/schemas';
import { compilePrototypeDocument } from '../src/prototype/compiler';
import { collectDirectiveFailures, type DirectiveText } from './support/directive-guard';

const STARTER = 'starter/design/blueprint';
const SKILLS = 'skills';
const SKILL_FILES = [
  'skills/blueprint-create-sidecar/SKILL.md',
  'skills/blueprint-edit-canvas/SKILL.md',
  'skills/blueprint-edit-canvas/references/prose.md',
  'skills/blueprint-handoff/SKILL.md'
];

interface ToolText {
  where: string;
  text: string;
}

function filesUnder(directory: string, keep: (name: string) => boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full, keep);
    return keep(entry.name) ? [full.split(path.sep).join('/')] : [];
  });
}

function sourceFiles(directory: string): string[] {
  return filesUnder(directory, name => name.endsWith('.ts'));
}

function describedTexts(where: string, node: unknown): ToolText[] {
  if (Array.isArray(node)) return node.flatMap((item, index) => describedTexts(`${where}[${index}]`, item));
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) => (
    key === 'description' && typeof value === 'string' ? [{ where, text: value }] : describedTexts(`${where}.${key}`, value)
  ));
}

async function readDirectiveText(): Promise<{ text: DirectiveText; toolTexts: ToolText[] }> {
  const server = createBlueprintMcpServer();
  const client = new Client({ name: 'directive-guard', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions() ?? '';
  await client.close();
  await server.close();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...BLUEPRINT_MCP_TOOL_NAMES].sort());
  const toolTexts = [
    { where: 'the server instructions', text: instructions },
    ...tools.flatMap(tool => [
      { where: `the ${tool.name} tool text`, text: tool.description ?? '' },
      ...describedTexts(`${tool.name} inputSchema`, tool.inputSchema),
      ...describedTexts(`${tool.name} outputSchema`, tool.outputSchema)
    ])
  ];
  const text: DirectiveText = {
    agents: readFileSync(path.join(STARTER, 'AGENTS.md'), 'utf8'),
    readme: readFileSync('README.md', 'utf8'),
    instructions,
    toolNames: BLUEPRINT_MCP_TOOL_NAMES,
    toolDescriptions: Object.fromEntries(tools.map(tool => [tool.name, tool.description ?? ''])),
    captureStateDescription: captureInputSchema.shape.state.description ?? '',
    sources: Object.fromEntries(['src/core', 'src/mcp', 'src/prototype'].flatMap(sourceFiles).map(file => [file, readFileSync(file, 'utf8')])),
    scripts: (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts,
    starterScreens: (JSON.parse(readFileSync(path.join(STARTER, 'screens.json'), 'utf8')) as { screens: Array<{ id: string; framePresetId: string }> }).screens,
    skills: Object.fromEntries(filesUnder(SKILLS, () => true).map(file => [file, readFileSync(file, 'utf8')]))
  };
  return { text, toolTexts };
}

function replaced(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), `The must-fail row needs the text "${from}". Fix: update this row to the current wording.`);
  return text.replace(from, to);
}

type Mutation = (text: DirectiveText) => Partial<DirectiveText>;

function skillEdit(file: string, edit: (text: string) => string): Mutation {
  return ({ skills }) => ({ skills: { ...skills, [file]: edit(skills[file] ?? '') } });
}

const MUST_FAIL: ReadonlyArray<{ name: string; mutate: Mutation; reports: string }> = [
  { name: 'a tool name that does not exist in AGENTS.md', mutate: ({ agents }) => ({ agents: replaced(agents, 'the `migrate` tool', 'the `upgrade` tool') }), reports: 'names the tool "upgrade"' },
  { name: 'a tool name that does not exist in the server instructions', mutate: ({ instructions }) => ({ instructions: replaced(instructions, 'with the inspo tool', 'with the board tool') }), reports: 'names the tool "board"' },
  { name: 'a tool that AGENTS.md does not name', mutate: ({ toolNames }) => ({ toolNames: [...toolNames, 'rename'] }), reports: 'does not name the tool "rename"' },
  { name: 'a tool table that drops a row', mutate: ({ readme }) => ({ readme: readme.replace(/^\| `restore` \|.*\n/m, '') }), reports: 'The tool table of README.md' },
  { name: 'a tool count that differs', mutate: ({ readme }) => ({ readme: replaced(readme, 'exposes thirteen', 'exposes twelve') }), reports: 'does not state 13 tools' },
  { name: 'a reusable field that AGENTS.md drops', mutate: ({ agents }) => ({ agents: replaced(agents, '`tokenRoles`, `accessibility`, `notes`, `implementationHints`, `implementationTargets`, `styleRefs`, `styleEvidence`, and `prototypeOnly`', '`accessibility`, `notes`, `implementationHints`, `implementationTargets`, `styleRefs`, `styleEvidence`, and `prototypeOnly`') }), reports: 'the field "tokenRoles" of a reusable' },
  { name: 'a screen field that the schema does not hold', mutate: ({ agents }) => ({ agents: replaced(agents, 'A screen carries `id`,', 'A screen carries `route`, `id`,') }), reports: 'the field "route" of a screen' },
  { name: 'a section field that AGENTS.md drops', mutate: ({ agents }) => ({ agents: replaced(agents, 'A section carries `id`, `name`,', 'A section carries `name`,') }), reports: 'the field "id" of a section' },
  { name: 'a token field that AGENTS.md drops', mutate: ({ agents }) => ({ agents: replaced(agents, '`description`, and `styleRef`', '`description`') }), reports: 'the field "styleRef" of a token' },
  { name: 'a stated limit that differs from the code', mutate: ({ agents }) => ({ agents: replaced(agents, 'An id has at most 36 characters', 'An id has at most 40 characters') }), reports: 'states 40' },
  { name: 'a stated limit that is gone', mutate: ({ agents }) => ({ agents: replaced(agents, 'Value names are sentence case and at most 24 characters', 'Value names are sentence case') }), reports: 'no longer matches' },
  { name: 'a primitive count that differs in README.md', mutate: ({ readme }) => ({ readme: replaced(readme, 'the closed set of 33 primitives', 'the closed set of 34 primitives') }), reports: 'states 34' },
  { name: 'a frame limit that differs', mutate: ({ readme }) => ({ readme: replaced(readme, 'keeps at most 32 frames live', 'keeps at most 64 frames live') }), reports: 'states 64' },
  { name: 'a thumbnail limit that differs', mutate: ({ readme }) => ({ readme: replaced(readme, 'document is over 4 MB', 'document is over 8 MB') }), reports: 'states 8' },
  { name: 'a placeholder word that the naming rules accept', mutate: ({ agents }) => ({ agents: replaced(agents, 'no placeholder word such as `new`', 'no placeholder word such as `home`') }), reports: 'the placeholder word "home"' },
  { name: 'a version word that the naming rules accept', mutate: ({ agents }) => ({ agents: replaced(agents, 'no version word such as `v2`', 'no version word such as `next`') }), reports: 'the version word "next"' },
  { name: 'the inspo add step without its id', mutate: ({ agents }) => ({ agents: replaced(agents, ' Put a kebab-case name in `id` that says what the image shows.', '') }), reports: 'its required field "id"' },
  { name: 'the inspo add step without its url', mutate: ({ agents }) => ({ agents: replaced(agents, ' Put the link in `url`.', '') }), reports: 'its required field "url"' },
  { name: 'the inspo direction step without its aspect', mutate: ({ agents }) => ({ agents: replaced(agents, 'Pass `aspect`, `statement`, and', 'Pass `statement` and') }), reports: 'its required field "aspect"' },
  { name: 'an inspo operation that does not exist', mutate: ({ agents }) => ({ agents: replaced(agents, 'with the `sync` operation', 'with the `pull` operation') }), reports: 'the inspo operation "pull"' },
  { name: 'the inspo tool text that drops the required id', mutate: ({ toolDescriptions }) => ({ toolDescriptions: { ...toolDescriptions, inspo: replaced(toolDescriptions.inspo, 'add requires the image link in url and a kebab-case id.', 'add requires the image link in url.') } }), reports: 'add requires id' },
  { name: 'a validation mode that does not exist', mutate: ({ agents }) => ({ agents: replaced(agents, 'in `baseline` mode after each batch', 'in `quick` mode after each batch') }), reports: 'the validation mode "quick"' },
  { name: 'the old older-schema claim in README.md', mutate: ({ readme }) => ({ readme: replaced(readme, '`validate` reports each older file and `serve` shows a notice on the canvas. `serve` with `focus` or `explorationId`, and every other tool that reads the sidecar, refuse it until `migrate` upgrades it', 'every tool except `migrate` refuses an older sidecar') }), reports: 'every tool except' },
  { name: 'the old capture text', mutate: ({ sources }) => ({ sources: { ...sources, 'src/mcp/capture.ts': replaced(sources['src/mcp/capture.ts'], 'apply to primitives and components.', 'apply to primitives.') } }), reports: 'components also take variant and size' },
  { name: 'the old migrate tool text', mutate: ({ toolDescriptions }) => ({ toolDescriptions: { ...toolDescriptions, migrate: `${toolDescriptions.migrate} A project already on the current schema is left unchanged.` } }), reports: 'migrate repairs a project' },
  { name: 'the old capture state text', mutate: () => ({ captureStateDescription: 'Declared state to render. Defaults to the first declared state.' }), reports: 'a reusable defaults to its default state' },
  { name: 'the old strict lint text', mutate: ({ readme }) => ({ readme: replaced(readme, 'Validation rejects fields', 'Strict-lint findings appear. Validation rejects fields') }), reports: 'the lints run in each mode' },
  { name: 'the old primitive set claim', mutate: ({ agents }) => ({ agents: `${agents}\nand strict validation rejects primitives outside the set.` }), reports: 'each mode rejects them' },
  { name: 'the old Fix claim', mutate: ({ agents }) => ({ agents: `${agents}\nErrors on the shapes of reusables end with Fix.` }), reports: 'each validation error ends with a Fix line' },
  { name: 'a capture row in the wrong layout row', mutate: ({ readme }) => ({ readme: replaced(readme, 'operations, capture, and stdio server', 'operations, and stdio server') }), reports: 'does not place capture' },
  { name: 'a layout row that does not exist', mutate: ({ readme }) => ({ readme: replaced(readme, 'src/hooks/ ', 'src/hook/  ') }), reports: 'src/hook/' },
  { name: 'a script that does not exist', mutate: ({ readme }) => ({ readme: replaced(readme, '`npm run scan:scope`', '`npm run scan:scopes`') }), reports: 'the script "scan:scopes"' },
  { name: 'a script that qa does not run', mutate: ({ scripts }) => ({ scripts: { ...scripts, qa: scripts.qa.replace('npm run scan:scope && ', '') } }), reports: 'does not run "scan:scope"' },
  { name: 'a text that calls validate after migrate', mutate: ({ sources }) => ({ sources: { ...sources, 'src/core/schema-version.ts': `${sources['src/core/schema-version.ts']}\nrun the migrate tool on this project, then fix what validate reports.` } }), reports: 'validate after a tool that validates itself' },
  { name: 'a text that runs validate after init', mutate: ({ agents }) => ({ agents: `${agents}\nCall init, then run validate.` }), reports: 'validate after a tool that validates itself' },
  { name: 'a tool that stops validating itself', mutate: ({ sources }) => ({ sources: { ...sources, 'src/mcp/inspo.ts': sources['src/mcp/inspo.ts'].replaceAll('assertValidMutation(', 'assertNothing(') } }), reports: 'mutateInspo in src/mcp/inspo.ts has no assertValidMutation(' },
  { name: 'a list of self-validating tools that drops a tool', mutate: ({ agents }) => ({ agents: replaced(agents, '`promote`, and `restore` tools validate', 'and `restore` tools validate') }), reports: 'does not list each tool that validates itself' },
  { name: 'a server text that drops the older-schema rule', mutate: ({ instructions }) => ({ instructions: replaced(instructions, 'Serve with focus or explorationId, and every other tool that reads the sidecar, refuse it', 'Other tools refuse it') }), reports: 'does not state which tools work on an older schema' },
  { name: 'a text that drops the restart directive', mutate: ({ readme }) => ({ readme: replaced(readme, 'Restart the MCP server after each `npm run build`, because a running server keeps its old tool text and canvas.', 'Rebuild when you need to.') }), reports: 'restart the MCP server after a build' },
  { name: 'a serve runtime that stops caching the page', mutate: ({ sources }) => ({ sources: { ...sources, 'src/mcp/serve-server.ts': replaced(sources['src/mcp/serve-server.ts'], 'const indexHtml = await readFile(indexPath', 'const indexHtml = await readPage(indexPath') } }), reports: 'no longer reads the canvas page once' },
  { name: 'a text that drops the frame sizes entry', mutate: ({ readme }) => ({ readme: replaced(readme, '"Frame sizes"', '"Frames"') }), reports: 'the change entry "Frame sizes"' },
  { name: 'a starter frame that differs', mutate: ({ agents }) => ({ agents: replaced(agents, '`screen:web-home` on `desktop-web`', '`screen:web-home` on `tablet`') }), reports: 'the starter frame "web-home"' },
  { name: 'an optional screen field that AGENTS.md drops', mutate: ({ agents }) => ({ agents: replaced(agents, 'Add `version` and `productionRelationship`', 'Add `version`') }), reports: 'the field "productionRelationship" of an optional part of a screen' },
  { name: 'a field list that AGENTS.md drops', mutate: ({ agents }) => ({ agents: replaced(agents, 'A section carries', 'A section holds') }), reports: 'does not list the fields of a section' },
  { name: 'a placeholder word list that AGENTS.md drops', mutate: ({ agents }) => ({ agents: replaced(agents, 'no placeholder word such as', 'no placeholder such as') }), reports: 'lists no placeholder word' },
  { name: 'a version word list that AGENTS.md drops', mutate: ({ agents }) => ({ agents: replaced(agents, 'no version word such as', 'no version such as') }), reports: 'lists no version word' },
  { name: 'an inspo operation that AGENTS.md drops', mutate: ({ agents }) => ({ agents: replaced(agents, 'with the `direction` operation', 'with a direction') }), reports: 'does not name the inspo operation "direction"' },
  { name: 'the old strict mode text', mutate: ({ readme }) => ({ readme: `${readme}\n\`strict\` checks the full production handoff contract, including lints.` }), reports: 'the lints run in each mode' },
  { name: 'the old capture location', mutate: ({ readme }) => ({ readme: replaced(readme, 'src/prototype/  source compiler,', 'src/prototype/  source compiler, capture,') }), reports: 'capture lives in src/mcp' },
  { name: 'the old invalid edit text', mutate: ({ readme }) => ({ readme: `${readme}\nWhile an edit is invalid, the last good state stays visible.` }), reports: 'only a contract error holds the last good state' },
  { name: 'the old change marker text', mutate: ({ readme }) => ({ readme: `${readme}\nBoundaries that changed during the latest agent turn get a dashed marker.` }), reports: 'a mark names an element whose computed look changed' },
  { name: 'the old refusal text in AGENTS.md', mutate: ({ agents }) => ({ agents: `${agents}\nEvery other tool refuses the folder until then.` }), reports: 'AGENTS.md matches' },
  { name: 'the old refusal text in the server instructions', mutate: ({ instructions }) => ({ instructions: `${instructions} Every other tool refuses it until migrate runs.` }), reports: 'the server instructions matches' },
  { name: 'a server text that drops a self-validating tool', mutate: ({ instructions }) => ({ instructions: replaced(instructions, 'The init, inspo, migrate,', 'The inspo, migrate,') }), reports: 'The server instructions do not list each tool' },
  { name: 'an AGENTS.md text that drops the older-schema rule', mutate: ({ agents }) => ({ agents: replaced(agents, '`serve` with `focus` or `explorationId`, and every other tool', 'Every other tool') }), reports: 'AGENTS.md does not state which tools work' },
  { name: 'a README.md text that drops the older-schema rule', mutate: ({ readme }) => ({ readme: replaced(readme, '`serve` shows a notice on the canvas. ', '') }), reports: 'README.md does not state which tools work' },
  { name: 'an AGENTS.md text that drops the restart directive', mutate: ({ agents }) => ({ agents: replaced(agents, 'restart the MCP server', 'reload the page') }), reports: 'AGENTS.md does not tell the reader' },
  { name: 'a server text that drops the restart directive', mutate: ({ instructions }) => ({ instructions: replaced(instructions, 'restart the MCP server', 'reload the page') }), reports: 'the server instructions does not tell the reader' },
  { name: 'a README.md with no layout', mutate: ({ readme }) => ({ readme: replaced(readme, '## Repository layout', '## Layout') }), reports: 'has no repository layout' },
  { name: 'a layout that drops a source directory', mutate: ({ readme }) => ({ readme: readme.replace(/^src\/hooks\/.*\n/m, '') }), reports: 'does not name src/hooks/' },
  { name: 'a README.md with no script table', mutate: ({ readme }) => ({ readme: replaced(readme, '## Scripts', '## Commands') }), reports: 'has no script table' },
  { name: 'a starter frame count that differs', mutate: ({ agents }) => ({ agents: replaced(agents, 'exactly two empty base frames', 'exactly three empty base frames') }), reports: 'states three starter frames' },
  { name: 'a skill query shape that does not parse', mutate: skillEdit('skills/blueprint-edit-canvas/SKILL.md', text => replaced(text, '{"type":"sections","screen":"<id>"}', '{"type":"sections","screens":"<id>"}')), reports: 'skills/blueprint-edit-canvas/SKILL.md holds the query shape {"type":"sections","screens":"<id>"}' },
  { name: 'a skill example that no tool input accepts', mutate: skillEdit('skills/blueprint-edit-canvas/SKILL.md', text => replaced(text, '"candidateLabels":["A","B"]', '"candidateLabels":["A"]')), reports: 'skills/blueprint-edit-canvas/SKILL.md holds a JSON example that no tool input accepts' },
  { name: 'the old refusal text in a skill', mutate: skillEdit('skills/blueprint-handoff/SKILL.md', text => `${text}\n- Every other tool refuses the folder.\n`), reports: 'skills/blueprint-handoff/SKILL.md matches /Every other tool refuses the folder/' },
  { name: 'a skill tool name that does not exist', mutate: skillEdit('skills/blueprint-handoff/SKILL.md', text => `${text}\n- Use \`mcp__blueprint__lint\` too.\n`), reports: 'skills/blueprint-handoff/SKILL.md names the tool "lint"' },
  { name: 'a skill text that calls validate after migrate', mutate: skillEdit('skills/blueprint-handoff/SKILL.md', text => `${text}\n- Run migrate, then call validate on the result.\n`), reports: 'skills/blueprint-handoff/SKILL.md tells an agent to validate after a tool that validates itself' }
];

describe('the directive text', () => {
  let text: DirectiveText;
  let toolTexts: ToolText[];
  before(async () => {
    ({ text, toolTexts } = await readDirectiveText());
  });

  it('matches the code', () => {
    assert.deepEqual(collectDirectiveFailures(text), [], 'Fix: correct the text or the code, so that each claim holds.');
  });

  it('reads each skill file under skills/, and each skill file matches the code', () => {
    assert.deepEqual(Object.keys(text.skills).sort(), SKILL_FILES);
    const failures = collectDirectiveFailures(text).filter(failure => failure.startsWith(`${SKILLS}/`));
    assert.deepEqual(failures, [], 'Fix: correct the skill text or the code, so that each claim holds.');
  });

  it('holds no prose error in the tool text or the server instructions', () => {
    const failures = toolTexts.flatMap(({ where, text: prose }) => lintProse(prose)
      .filter(issue => issue.level === 'error')
      .map(issue => `${where} ${issue.message} Text: ${prose}`));
    assert.deepEqual(failures, [], failures.join('\n'));
  });

  for (const { name, mutate, reports } of MUST_FAIL) {
    it(`reports ${name}`, () => {
      const failures = collectDirectiveFailures({ ...text, ...mutate(text) });
      assert.ok(failures.some(failure => failure.includes(reports)), `Expected a failure with "${reports}". Received:\n${failures.join('\n')}`);
    });
  }
});

describe('the capture text', () => {
  let directory: string;
  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'blueprint-directive-guard-'));
  });
  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('names primitives and components when a screen capture gets a variant', async () => {
    await assert.rejects(
      captureBlueprint({ project: STARTER, boundary: 'screen:home', variant: 'primary', out: path.join(directory, 'home.png') }),
      /Variant and size apply to primitives and components\. Fix:/
    );
  });

  it('states the default that a primitive takes when the call omits its state', async () => {
    const bundle = structuredClone(await loadProjectFromFs(STARTER));
    const primitive = bundle.primitives.primitives.find(candidate => candidate.states.values.length > 1);
    assert.ok(primitive);
    primitive.states.values.reverse();
    assert.notEqual(primitive.states.values[0].id, primitive.states.default);
    const compiled = compilePrototypeDocument({ bundle, target: { kind: 'primitive', id: primitive.id } });
    assert.equal(compiled.state, primitive.states.default);
    assert.match(captureInputSchema.shape.state.description ?? '', /A primitive or component defaults to its default state\./);
  });
});

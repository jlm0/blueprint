import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { Client, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const projectRoot = process.cwd();
const mcpPath = path.join(projectRoot, 'dist/mcp/server.js');
const novaRoot = 'fixtures/app-owned/nova-care/design/blueprint';
const highFidelityRoot = 'fixtures/red/high-fidelity-prototype/design/blueprint';
const toolNames = ['init', 'validate', 'index', 'query', 'extract', 'capture', 'serve'];

interface McpSession {
  client: Client;
  tools: Tool[];
  stderr: () => string;
  close: () => Promise<void>;
}

describe('Blueprint MCP and template governance', () => {
  before(() => {
    const build = run('npm', ['run', '--silent', 'build']);
    assert.equal(build.status, 0, build.stderr || build.stdout);
  });

  it('ships an MCP-only package surface with exact, strict, typed tool schemas', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      bin?: Record<string, string>;
      exports?: Record<string, unknown>;
      scripts?: Record<string, string>;
      engines?: Record<string, string>;
    };

    assert.deepEqual(packageJson.bin, { 'blueprint-mcp': './dist/mcp/server.js' });
    assert.equal(packageJson.engines?.node, '>=20');
    assert.ok(packageJson.exports?.['.']);
    assert.equal(packageJson.scripts?.['build:cli'], undefined);
    assert.ok(packageJson.scripts?.['build:mcp']);
    assert.equal((await stat(mcpPath)).isFile(), true);
    assert.equal((await stat(path.join(projectRoot, 'dist/site/index.html'))).isFile(), true);
    assert.equal(existsSync(path.join(projectRoot, 'dist/cli')), false);

    const session = await openSession(projectRoot, true);
    try {
      assert.equal(session.client.getProtocolEra(), 'modern');
      assert.deepEqual(session.tools.map(tool => tool.name), toolNames);
      for (const tool of session.tools) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} input must reject unknown fields`);
        assert.ok(tool.outputSchema, `${tool.name} must advertise an output schema`);
        assert.equal(tool.outputSchema?.$schema, 'https://json-schema.org/draft/2020-12/schema');
      }
      const query = session.tools.find(tool => tool.name === 'query');
      assert.ok(query);
      assert.match(JSON.stringify(query.inputSchema), /prototype-only/);
      assert.match(JSON.stringify(query.inputSchema), /used-by/);
      assert.equal(session.stderr(), '');
    } finally {
      await session.close();
    }
  });

  it('supports the legacy MCP negotiation path without changing the tool contract', async () => {
    const session = await openSession(projectRoot, false);
    try {
      assert.equal(session.client.getProtocolEra(), 'legacy');
      assert.deepEqual(session.tools.map(tool => tool.name), toolNames);
      const result = await call(session, 'index', { project: novaRoot });
      assert.equal(result.command, 'index');
      assert.ok((result.results as Array<{ id: string }>).some(item => item.id === 'nova-care/screen/home'));
    } finally {
      await session.close();
    }
  });

  it('initializes a safe sidecar, preserves unrelated files on force, and rewrites identity', async () => {
    await withTempDir(async tempDir => {
      const session = await openSession();
      try {
        const out = path.join(tempDir, 'app-a', 'design', 'blueprint');
        const output = await call(session, 'init', { projectId: 'app-a', name: 'App A', out });
        assert.equal(output.command, 'init');
        assert.deepEqual((output.files as string[]).sort(), ['AGENTS.md', 'components.json', 'manifest.json', 'primitives.json', 'prototype', 'screens.json', 'tokens.json']);

        const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
        const tokens = JSON.parse(await readFile(path.join(out, 'tokens.json'), 'utf8'));
        const primitives = JSON.parse(await readFile(path.join(out, 'primitives.json'), 'utf8'));
        const components = JSON.parse(await readFile(path.join(out, 'components.json'), 'utf8'));
        const screens = JSON.parse(await readFile(path.join(out, 'screens.json'), 'utf8'));
        assert.equal(manifest.project.id, 'app-a');
        assert.equal(manifest.project.name, 'App A');
        assert.equal(manifest.project.sourceRoot, normalize(out));
        assert.equal(tokens.projectId, 'app-a');
        assert.equal(primitives.projectId, 'app-a');
        assert.equal(components.projectId, 'app-a');
        assert.equal(screens.projectId, 'app-a');
        assert.equal(JSON.stringify({ manifest, tokens, primitives, components, screens }).includes('starter-app'), false);
        assert.deepEqual(screens.screens.map((screen: { id: string; sections: unknown[] }) => [screen.id, screen.sections.length]), [['home', 0], ['web-home', 0]]);

        const sentinel = path.join(out, 'keep.txt');
        await writeFile(sentinel, 'do not overwrite', 'utf8');
        const refused = await session.client.callTool({ name: 'init', arguments: { projectId: 'app-b', name: 'App B', out } });
        assertToolError(refused, /Destination is not empty/);
        assert.equal(await readFile(sentinel, 'utf8'), 'do not overwrite');

        const forced = await call(session, 'init', { projectId: 'app-b', name: 'App B', out, force: true });
        assert.equal(forced.projectId, 'app-b');
        assert.equal(await readFile(sentinel, 'utf8'), 'do not overwrite');
        assert.equal(JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8')).project.id, 'app-b');
      } finally {
        await session.close();
      }
    });
  });

  it('preserves validate, index, every query variant, and focused/deep extraction behavior', async () => {
    await withTempDir(async tempDir => {
      const session = await openSession();
      try {
        const validationOut = path.join(tempDir, 'validation.json');
        const validation = await call(session, 'validate', { project: novaRoot, out: validationOut });
        assert.equal(validation.ok, true);
        assert.deepEqual(JSON.parse(await readFile(validationOut, 'utf8')), validation);

        const strict = await call(session, 'validate', { project: novaRoot, mode: 'strict' });
        assert.equal(strict.mode, 'strict');
        assert.equal(strict.ok, true);

        const blocked = await session.client.callTool({ name: 'validate', arguments: { project: novaRoot, mode: 'readiness' } });
        assert.equal(blocked.isError, true);
        const blockedOutput = structured(blocked);
        assert.equal(blockedOutput.ok, false);
        assert.equal((blockedOutput.readiness as { tier: string }).tier, 'blocked');

        const index = await call(session, 'index', { project: novaRoot });
        assert.ok((index.results as Array<{ id: string }>).some(item => item.id === 'nova-care/screen/home'));

        const show = await call(session, 'query', { project: novaRoot, query: { type: 'show', boundary: 'screen:home' } });
        assert.equal(show.id, 'nova-care/screen/home');
        const uses = await call(session, 'query', { project: novaRoot, query: { type: 'uses', boundary: 'screen:home' } });
        assert.ok((uses.results as Array<{ localId: string }>).some(item => item.localId === 'action-button'));
        const usedBy = await call(session, 'query', { project: novaRoot, query: { type: 'used-by', boundary: 'primitive:action-button' } });
        assert.ok((usedBy.results as unknown[]).length > 0);
        const sections = await call(session, 'query', { project: novaRoot, query: { type: 'sections', screen: 'home' } });
        assert.equal((sections.results as unknown[]).length, 3);
        const prototypeOnly = await call(session, 'query', { project: novaRoot, query: { type: 'prototype-only' } });
        assert.ok(Array.isArray(prototypeOnly.results));

        const focusedOut = path.join(tempDir, 'focused.json');
        const focused = await call(session, 'extract', { project: novaRoot, boundary: 'screen:home', out: focusedOut });
        assert.equal(focused.id, 'nova-care/screen/home');
        assert.equal('boundaries' in focused, false);
        assert.deepEqual(JSON.parse(await readFile(focusedOut, 'utf8')), focused);

        const deep = await call(session, 'extract', { project: novaRoot, boundary: 'section:home/next-action', mode: 'deep' });
        assert.equal((deep.extraction as { mode: string }).mode, 'deep');
        assert.ok((deep.boundaries as unknown[]).length > 1);
        assert.ok((deep.resolvedTokens as unknown[]).length > 0);
      } finally {
        await session.close();
      }
    });
  });

  it('returns domain and schema failures as tool errors while unknown tools remain protocol errors', async () => {
    const session = await openSession();
    try {
      const missing = await session.client.callTool({ name: 'query', arguments: { project: novaRoot, query: { type: 'show', boundary: 'screen:missing' } } });
      assertToolError(missing, /not found|unknown/i);
      const invalidQuery = await session.client.callTool({ name: 'query', arguments: { project: novaRoot, query: { type: 'sections', boundary: 'screen:home' } } });
      assertToolError(invalidQuery, /input validation error|invalid/i);
      const invalidCapture = await session.client.callTool({ name: 'capture', arguments: { project: novaRoot, boundary: 'primitive:action-button', out: 'button.png' } });
      assertToolError(invalidCapture, /input validation error|screen/i);
      await assert.rejects(session.client.callTool({ name: 'missing-tool', arguments: {} }), /not found|unknown|missing-tool/i);
    } finally {
      await session.close();
    }
  });

  it('captures both legacy canvas and declared source-focused state/viewport PNGs through stdio MCP', async () => {
    await withTempDir(async tempDir => {
      const session = await openSession();
      try {
        const legacyOut = path.join(tempDir, 'home.png');
        const legacy = await call(session, 'capture', { project: novaRoot, boundary: 'screen:home', out: legacyOut });
        assert.equal(legacy.boundary, 'nova-care/screen/home');
        assert.equal((legacy.source as { captureTarget: string }).captureTarget, 'screen-frame');
        const legacyPng = await readFile(legacyOut);
        assert.equal(legacyPng.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(legacyPng.readUInt32BE(16), 786);
        assert.equal(legacyPng.readUInt32BE(20), 1704);
        const blankBaseline = await readFile('tests/baselines/nova-care-home-blank-screen-baseline.png');
        assert.notEqual(createHash('sha256').update(legacyPng).digest('hex'), createHash('sha256').update(blankBaseline).digest('hex'));

        const focusedOut = path.join(tempDir, 'waitlist-phone.png');
        const focused = await call(session, 'capture', {
          project: highFidelityRoot,
          boundary: 'screen:waitlist',
          state: 'initial',
          viewport: 'phone-review',
          out: focusedOut
        });
        assert.deepEqual(focused.dimensions, { width: 390, height: 844 });
        assert.equal(focused.state, 'initial');
        assert.equal(focused.viewport, 'phone-review');
        assert.equal((focused.source as { editorChrome: boolean }).editorChrome, false);
        const focusedPng = await readFile(focusedOut);
        assert.equal(focusedPng.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(focusedPng.readUInt32BE(16), 390);
        assert.equal(focusedPng.readUInt32BE(20), 844);
      } finally {
        await session.close();
      }
    });
  });

  it('serves, live-reloads, retains last-good content, and closes listeners with the MCP session', async () => {
    await withTempDir(async tempDir => {
      const projectCopy = path.join(tempDir, 'design', 'blueprint');
      await cp(novaRoot, projectCopy, { recursive: true });
      const manifestPath = path.join(projectCopy, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.project.name = 'Serve Copy';
      manifest.project.sourceRoot = normalize(projectCopy);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      const session = await openSession(tempDir);
      let url = '';
      try {
        const served = await call(session, 'serve', { port: 0 });
        url = served.url as string;
        assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
        const response = await fetch(url);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(await response.text(), /window\.__BLUEPRINT_PROJECT_BUNDLE__/);

        const { chromium } = await import('playwright');
        const browser = await chromium.launch();
        try {
          const page = await browser.newPage();
          await page.goto(url);
          assert.equal(await servedProjectName(page), 'Serve Copy');
          manifest.project.name = 'Serve Refreshed </script> Name';
          await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
          const refreshedHtml = await (await fetch(url)).text();
          assert.equal(refreshedHtml.includes('Serve Refreshed </script>'), false);
          await page.reload();
          assert.equal(await servedProjectName(page), manifest.project.name);
          await writeFile(manifestPath, '{ "project": ', 'utf8');
          await page.reload();
          assert.equal(await servedProjectName(page), manifest.project.name);
        } finally {
          await browser.close();
        }
      } finally {
        await session.close();
      }
      await assertEventuallyUnreachable(url);
    });
  });

  it('returns honest serve errors for occupied ports and missing projects', async () => {
    const occupied = await occupyPort(0);
    const address = occupied.address();
    assert.ok(address && typeof address !== 'string');
    const session = await openSession();
    try {
      const inUse = await session.client.callTool({ name: 'serve', arguments: { project: novaRoot, port: address.port } });
      assertToolError(inUse, /EADDRINUSE|already in use/i);
      const missing = await session.client.callTool({ name: 'serve', arguments: { project: 'does-not-exist', port: 0 } });
      assertToolError(missing, /path not found|does-not-exist/i);
    } finally {
      await session.close();
      await closeNetServer(occupied);
    }
  });

  it('ships schema, starter governance, and MCP-only documentation', async () => {
    assert.equal(existsSync('schema/blueprint-project.schema.json'), true);
    const schema = JSON.parse(await readFile('schema/blueprint-project.schema.json', 'utf8'));
    assert.ok(schema.$defs.manifest);
    assert.ok(schema.$defs.component);
    assert.ok(schema.$defs.implementationTarget);
    assert.ok(schema.$defs.styleEvidence);

    const agents = await readFile('starter/design/blueprint/AGENTS.md', 'utf8');
    assert.match(agents, /sidecar-first/i);
    assert.match(agents, /MCP/i);
    assert.match(agents, /empty base frames/i);
    assert.match(agents, /<blueprint-use/i);
    assert.match(agents, /screenshots.*evidence/i);

    const docs = `${await readFile('README.md', 'utf8')}\n${await readFile('docs/starter-scaffold.md', 'utf8')}\n${await readFile('docs/query-contract.md', 'utf8')}`;
    for (const tool of toolNames) {
      assert.match(docs, new RegExp(`\\b${tool}\\b`, 'i'));
    }
    assert.match(docs, /single-project/i);
    assert.match(docs, /baseline-compatible/i);
    assert.match(docs, /structured JSON.*owns|JSON owns/i);
    assert.doesNotMatch(docs, /Local CLI|blueprint (?:init|validate|index|query|extract|capture|serve)/i);
    assert.doesNotMatch(docs, /hosted registry|cloud dashboard/i);
  });
});

async function openSession(cwd = projectRoot, modern = true): Promise<McpSession> {
  const client = new Client(
    { name: 'blueprint-e2e', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpPath],
    cwd,
    env: { ...process.env, NO_COLOR: '1' } as Record<string, string>,
    stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => {
    stderr += chunk.toString();
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  let closed = false;
  return {
    client,
    tools,
    stderr: () => stderr,
    close: async () => {
      if (closed) return;
      closed = true;
      await client.close();
    }
  };
}

async function call(session: McpSession, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await session.client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, textContent(result));
  return structured(result);
}

function structured(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');
  const value = result.structuredContent as Record<string, unknown>;
  assert.deepEqual(JSON.parse(textContent(result)), value);
  return value;
}

function assertToolError(result: CallToolResult, pattern: RegExp): void {
  assert.equal(result.isError, true);
  assert.match(textContent(result), pattern);
}

function textContent(result: CallToolResult): string {
  const text = result.content.find(item => item.type === 'text');
  assert.ok(text && text.type === 'text');
  return text.text;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'blueprint-mcp-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function assertEventuallyUnreachable(url: string): Promise<void> {
  assert.ok(url);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Expected MCP-owned review listener to close: ${url}`);
}

function occupyPort(port: number): Promise<NetServer> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function closeNetServer(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function servedProjectName(page: { evaluate: <T>(fn: () => T) => Promise<T> }): Promise<string | undefined> {
  return page.evaluate(() => {
    type ServedWindow = Window & { __BLUEPRINT_PROJECT_BUNDLE__?: { manifest?: { project?: { name?: string } } } };
    return (window as ServedWindow).__BLUEPRINT_PROJECT_BUNDLE__?.manifest?.project?.name;
  });
}

function run(command: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    killSignal: 'SIGKILL',
    timeout: 120000
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function normalize(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

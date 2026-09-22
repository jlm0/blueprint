import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { Client, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const projectRoot = process.cwd();
const mcpPath = path.join(projectRoot, 'dist/mcp/server.js');
const codexHookPath = path.join(projectRoot, 'dist/mcp/codex-activity-hook.js');
const novaRoot = 'fixtures/app-owned/nova-care/design/blueprint';
const highFidelityRoot = 'fixtures/red/high-fidelity-prototype/design/blueprint';
const explorationRoot = 'fixtures/app-owned/blank-slate/design/blueprint';
const stillRoot = 'fixtures/app-owned/still-meditation/design/blueprint';
const toolNames = ['init', 'validate', 'index', 'query', 'extract', 'capture', 'serve', 'explore', 'promote', 'restore'];

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

    assert.deepEqual(packageJson.bin, {
      'blueprint-mcp': './dist/mcp/server.js',
      'blueprint-codex-hook': './dist/mcp/codex-activity-hook.js'
    });
    assert.equal(packageJson.engines?.node, '>=20');
    assert.ok(packageJson.exports?.['.']);
    assert.equal(packageJson.scripts?.['build:cli'], undefined);
    assert.ok(packageJson.scripts?.['build:mcp']);
    assert.equal((await stat(mcpPath)).isFile(), true);
    assert.equal((await stat(codexHookPath)).isFile(), true);
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
      assert.match(JSON.stringify(query.inputSchema), /explorations/);
      assert.match(JSON.stringify(query.inputSchema), /history-version/);
      for (const toolName of ['explore', 'promote', 'restore']) {
        const tool = session.tools.find(candidate => candidate.name === toolName);
        assert.ok(tool);
        assert.deepEqual(tool.annotations, {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        });
      }
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

  it('creates, queries, archives, serves, promotes, and restores persistent explorations and history', async () => {
    await withTempDir(async tempDir => {
      const projectCopy = path.join(tempDir, 'design', 'blueprint');
      await cp(explorationRoot, projectCopy, { recursive: true });
      const session = await openSession();
      try {
        const created = await call(session, 'explore', {
          project: projectCopy,
          operation: {
            type: 'create',
            id: 'home-hero',
            screenId: 'home',
            state: 'initial',
            framePresetId: 'desktop-web-tall',
            title: 'Home hero',
            intent: 'Compare three hero directions without changing the canonical canvas.',
            candidateLabels: ['A', 'B', 'C']
          }
        });
        assert.equal(created.command, 'explore');
        assert.equal(created.operation, 'create');
        const createdExploration = created.exploration as {
          id: string;
          lifecycle: string;
          target: { baseDigest: string };
          candidates: Array<{ id: string; prototype: { source: string } }>;
        };
        assert.equal(createdExploration.id, 'home-hero');
        assert.equal(createdExploration.lifecycle, 'active');
        assert.match(createdExploration.target.baseDigest, /^[a-f0-9]{64}$/);
        assert.deepEqual(createdExploration.candidates.map(candidate => candidate.id), ['a', 'b', 'c']);
        assert.equal(existsSync(path.join(projectCopy, 'explorations.json')), false);
        assert.equal((await stat(path.join(projectCopy, 'explorations', 'home-hero.json'))).isFile(), true);
        for (const candidate of createdExploration.candidates) {
          assert.equal((await stat(path.join(projectCopy, candidate.prototype.source))).isFile(), true);
        }

        const listed = await call(session, 'query', {
          project: projectCopy,
          query: { type: 'explorations', screenId: 'home', lifecycle: 'active' }
        });
        assert.equal((listed.results as Array<{ id: string }>)[0]?.id, 'home-hero');
        const inspected = await call(session, 'query', {
          project: projectCopy,
          query: { type: 'exploration', explorationId: 'home-hero' }
        });
        const inspection = (inspected.results as Array<{
          exploration: { target: { baseDigest: string } };
          currentDigest: string;
          candidateDigests: Record<string, string>;
        }>)[0];
        assert.ok(inspection);
        assert.match(inspection.currentDigest, /^[a-f0-9]{64}$/);
        assert.match(inspection.candidateDigests.b ?? '', /^[a-f0-9]{64}$/);

        const served = await call(session, 'serve', {
          project: projectCopy,
          port: 0,
          explorationId: 'home-hero'
        });
        const servedUrl = new URL(served.url as string);
        assert.equal(servedUrl.searchParams.get('board'), 'screens');
        assert.equal(servedUrl.searchParams.get('exploration'), 'home-hero');
        assert.deepEqual(served.selection, {
          kind: 'exploration',
          explorationId: 'home-hero',
          screenId: 'home'
        });

        const screensPath = path.join(projectCopy, 'screens.json');
        const explorationRecordPath = path.join(projectCopy, 'explorations', 'home-hero.json');
        const canonicalSourcePath = path.join(projectCopy, 'prototype/screens/home.html');
        const beforeStale = {
          screens: await readFile(screensPath),
          exploration: await readFile(explorationRecordPath),
          canonical: await readFile(canonicalSourcePath)
        };
        const stale = await session.client.callTool({
          name: 'promote',
          arguments: {
            project: projectCopy,
            explorationId: 'home-hero',
            candidateId: 'b',
            expectedBaseDigest: inspection.exploration.target.baseDigest,
            expectedCurrentDigest: inspection.currentDigest,
            expectedCandidateDigest: '0'.repeat(64)
          }
        });
        assertToolError(stale, /expectedCandidateDigest|digest mismatch/i);
        assert.deepEqual(await readFile(screensPath), beforeStale.screens);
        assert.deepEqual(await readFile(explorationRecordPath), beforeStale.exploration);
        assert.deepEqual(await readFile(canonicalSourcePath), beforeStale.canonical);

        const promoted = await call(session, 'promote', {
          project: projectCopy,
          explorationId: 'home-hero',
          candidateId: 'b',
          expectedBaseDigest: inspection.exploration.target.baseDigest,
          expectedCurrentDigest: inspection.currentDigest,
          expectedCandidateDigest: inspection.candidateDigests.b
        });
        assert.equal((promoted.promotedScreen as { id: string }).id, 'home');
        assert.equal('version' in (promoted.promotedScreen as object), false);
        assert.equal((promoted.historicalVersion as { version: number }).version, 1);
        assert.equal((promoted.exploration as { lifecycle: string }).lifecycle, 'promoted');
        assert.equal((promoted.exploration as { selectedCandidateId: string }).selectedCandidateId, 'b');
        const persistedScreens = JSON.parse(await readFile(screensPath, 'utf8')) as {
          screens: Array<{ id: string; version?: number }>;
        };
        assert.equal(persistedScreens.screens.filter(screen => screen.id === 'home').length, 1);
        assert.equal(persistedScreens.screens.some(screen => screen.id !== 'home' && screen.version === 1), false);
        assert.equal((await stat(path.join(projectCopy, 'history', 'home-v1.json'))).isFile(), true);
        assert.equal((await stat(path.join(projectCopy, createdExploration.candidates[1]!.prototype.source))).isFile(), true);

        const historyList = await call(session, 'query', {
          project: projectCopy,
          query: { type: 'history', screenId: 'home' }
        });
        assert.deepEqual((historyList.results as Array<{ version: number }>).map(entry => entry.version), [1]);
        const historyInspection = await call(session, 'query', {
          project: projectCopy,
          query: { type: 'history-version', screenId: 'home', version: 1 }
        });
        const versionInspection = (historyInspection.results as Array<{
          currentDigest: string;
          versionDigest: string;
        }>)[0];
        assert.ok(versionInspection);
        const restored = await call(session, 'restore', {
          project: projectCopy,
          screenId: 'home',
          version: 1,
          expectedCurrentDigest: versionInspection.currentDigest,
          expectedVersionDigest: versionInspection.versionDigest
        });
        assert.equal(restored.restoredFromVersion, 1);
        assert.equal((restored.historicalVersion as { version: number }).version, 2);
        assert.equal((await stat(path.join(projectCopy, 'history', 'home-v2.json'))).isFile(), true);

        const repeated = await session.client.callTool({
          name: 'promote',
          arguments: {
            project: projectCopy,
            explorationId: 'home-hero',
            candidateId: 'b',
            expectedBaseDigest: inspection.exploration.target.baseDigest,
            expectedCurrentDigest: inspection.currentDigest,
            expectedCandidateDigest: inspection.candidateDigests.b
          }
        });
        assertToolError(repeated, /must be active/i);

        const second = await call(session, 'explore', {
          project: projectCopy,
          operation: {
            type: 'create',
            id: 'home-copy',
            screenId: 'home',
            state: 'initial',
            framePresetId: 'desktop-web-tall',
            title: 'Home copy',
            intent: 'Save two copy directions for later review.',
            candidateLabels: ['Short', 'Warm']
          }
        });
        const archived = await call(session, 'explore', {
          project: projectCopy,
          operation: { type: 'archive', explorationId: 'home-copy' }
        });
        assert.equal((archived.exploration as { lifecycle: string }).lifecycle, 'archived');
        const secondSource = ((second.exploration as {
          candidates: Array<{ prototype: { source: string } }>;
        }).candidates[0]?.prototype.source) ?? '';
        assert.equal((await stat(path.join(projectCopy, secondSource))).isFile(), true);
      } finally {
        await session.close();
      }
    });
  });

  it('rejects an unknown exploration before opening its requested review listener', async () => {
    const available = await occupyPort(0);
    const address = available.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await closeNetServer(available);
    const session = await openSession();
    try {
      const missing = await session.client.callTool({
        name: 'serve',
        arguments: { project: explorationRoot, port, explorationId: 'missing-exploration' }
      });
      assertToolError(missing, /exploration.*does not exist/i);
      const stillAvailable = await occupyPort(port);
      await closeNetServer(stillAvailable);
    } finally {
      await session.close();
    }
  });

  it('compacts a legacy aggregate exploration file into independent records on mutation', async () => {
    await withTempDir(async tempDir => {
      const projectCopy = path.join(tempDir, 'design', 'blueprint');
      await cp(explorationRoot, projectCopy, { recursive: true });
      const session = await openSession();
      try {
        await call(session, 'explore', {
          project: projectCopy,
          operation: {
            type: 'create',
            id: 'legacy-home',
            screenId: 'home',
            state: 'initial',
            framePresetId: 'desktop-web-tall',
            title: 'Legacy home',
            intent: 'Exercise aggregate migration.',
            candidateLabels: ['A', 'B']
          }
        });
        const recordPath = path.join(projectCopy, 'explorations', 'legacy-home.json');
        const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
          schemaVersion: string;
          projectId: string;
          exploration: unknown;
        };
        await writeFile(path.join(projectCopy, 'explorations.json'), `${JSON.stringify({
          schemaVersion: record.schemaVersion,
          projectId: record.projectId,
          explorations: [record.exploration]
        }, null, 2)}\n`);
        await unlink(recordPath);

        await call(session, 'explore', {
          project: projectCopy,
          operation: { type: 'archive', explorationId: 'legacy-home' }
        });
        const compacted = JSON.parse(await readFile(path.join(projectCopy, 'explorations.json'), 'utf8')) as {
          explorations: unknown[];
        };
        const migrated = JSON.parse(await readFile(recordPath, 'utf8')) as {
          exploration: { lifecycle: string };
        };
        assert.deepEqual(compacted.explorations, []);
        assert.equal(migrated.exploration.lifecycle, 'archived');
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

  it('streams Codex focus, applies file changes live, retains last-good content, and closes listeners with the MCP session', async () => {
    await withTempDir(async tempDir => {
      const projectCopy = path.join(tempDir, 'design', 'blueprint');
      await cp(stillRoot, projectCopy, { recursive: true });
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
          const liveSnapshot = await (await fetch(new URL('/__blueprint/project', url))).json() as {
            version?: number;
            bundle?: { manifest?: { project?: { name?: string } } };
          };
          assert.equal(liveSnapshot.version, 1);
          assert.equal(liveSnapshot.bundle?.manifest?.project?.name, 'Serve Copy');

        const { chromium } = await import('playwright');
        const browser = await chromium.launch();
        try {
          const page = await browser.newPage();
          await page.goto(url);
          assert.equal(await servedProjectName(page), 'Serve Copy');
          await page.evaluate(() => {
            (window as Window & { __BLUEPRINT_STABLE_DOCUMENT__?: string }).__BLUEPRINT_STABLE_DOCUMENT__ = 'same-document';
          });
          const rejectedActivity = await fetch(new URL('/__blueprint/agent-activity', url), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          assert.equal(rejectedActivity.status, 403);

          await runCodexHook(tempDir, {
            session_id: 'thread-live-focus',
            turn_id: 'turn-live-focus',
            cwd: tempDir,
            hook_event_name: 'PreToolUse',
            tool_name: 'mcp__blueprint__query',
            tool_use_id: 'tool-live-focus',
            tool_input: {
              project: 'design/blueprint',
              query: { type: 'show', boundary: 'screen:home' }
            }
          });
          await page.locator('[data-boundary-id="still-meditation/screen/home"].bp-chrome-agent-focus').first().waitFor();
          assert.equal(await page.locator('.board-screens').getAttribute('hidden'), null);
          assert.match(await page.locator('.bp-chrome-agent-status').innerText(), /Codex is looking at Today/);

          await runCodexHook(tempDir, {
            session_id: 'thread-live-focus',
            turn_id: 'turn-live-focus',
            cwd: tempDir,
            hook_event_name: 'PreToolUse',
            tool_name: 'functions.exec',
            tool_use_id: 'tool-live-button-focus',
            tool_input: `await tools.apply_patch("*** Update File: design/blueprint/prototype/primitives/button.css")`
          });
          await page.locator('.bp-chrome-agent-frame-focus[data-focus-boundary-ids~="still-meditation/primitive/button"] .bp-chrome-agent-frame-focus-box').first().waitFor();
          const buttonFocus = await page.evaluate(() => {
            const layer = document.querySelector<HTMLElement>('.bp-chrome-agent-frame-focus');
            const frame = layer?.parentElement?.querySelector<HTMLIFrameElement>('iframe.canonical-prototype-iframe');
            const box = layer?.querySelector<HTMLElement>('.bp-chrome-agent-frame-focus-box');
            return {
              frameUnchanged: frame?.srcdoc.includes('data-blueprint-agent-focus') === false,
              width: box ? parseFloat(box.style.width) : 0,
              height: box ? parseFloat(box.style.height) : 0
            };
          });
          assert.equal(buttonFocus.frameUnchanged, true);
          assert.ok(buttonFocus.width > 0 && buttonFocus.height > 0);
          assert.equal(await page.locator('.board-screens').getAttribute('hidden'), null);
          assert.equal(await page.locator('.bp-chrome-agent-status-mark .bp-chrome-agent-status-dot').count(), 9);
          await runCodexHook(tempDir, {
            session_id: 'thread-live-focus',
            turn_id: 'turn-live-focus',
            cwd: tempDir,
            hook_event_name: 'PostToolUse',
            tool_name: 'functions.exec',
            tool_use_id: 'tool-live-button-focus',
            tool_input: `await tools.apply_patch("*** Update File: design/blueprint/prototype/primitives/button.css")`,
            tool_response: { isError: false }
          });
          await page.locator('.bp-chrome-agent-status[data-phase="thinking"]').waitFor();
          assert.match(await page.locator('.bp-chrome-agent-status').innerText(), /Codex is reviewing Button/);

          await runCodexHook(tempDir, {
            session_id: 'thread-live-focus',
            turn_id: 'turn-live-section-focus',
            cwd: tempDir,
            hook_event_name: 'PreToolUse',
            tool_name: 'mcp__blueprint__query',
            tool_use_id: 'tool-live-section-focus',
            tool_input: {
              project: 'design/blueprint',
              query: { type: 'show', boundary: 'section:home/featured-practice' }
            }
          });
          await page.locator('.bp-chrome-agent-frame-focus[data-focus-boundary-ids~="still-meditation/section/home/featured-practice"] .bp-chrome-agent-frame-focus-box').first().waitFor();
          assert.equal(await page.locator('.bp-chrome-agent-frame-focus-box').count(), 1);

          await runCodexHook(tempDir, {
            session_id: 'thread-live-focus',
            turn_id: 'turn-live-multi-focus',
            cwd: tempDir,
            hook_event_name: 'PreToolUse',
            tool_name: 'functions.exec',
            tool_use_id: 'tool-live-multi-focus',
            tool_input: `await tools.apply_patch("*** Update File: design/blueprint/prototype/primitives/button.css\n*** Update File: design/blueprint/prototype/primitives/badge.css")`
          });
          const multiFocus = page.locator('.bp-chrome-agent-frame-focus[data-focus-boundary-ids~="still-meditation/primitive/button"][data-focus-boundary-ids~="still-meditation/primitive/badge"]');
          await multiFocus.locator('.bp-chrome-agent-frame-focus-box').first().waitFor();
          assert.ok(await multiFocus.locator('.bp-chrome-agent-frame-focus-box').count() >= 2);
          assert.match(await page.locator('.bp-chrome-agent-status').innerText(), /Codex is looking at (Button and Badge|Badge and Button)/);

          await page.locator('#viewport').dispatchEvent('wheel', {
            deltaY: -320,
            clientX: 620,
            clientY: 420
          });
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
          const preservedTransform = await page.locator('#world').getAttribute('style');
          const screenCssPath = path.join(projectCopy, 'prototype/screens/home.css');
          await writeFile(screenCssPath, `${await readFile(screenCssPath, 'utf8')}\n.still-home { --blueprint-live-test: 1; }\n`, 'utf8');
          await page.waitForFunction(() => [...document.querySelectorAll<HTMLIFrameElement>('iframe.canonical-prototype-iframe')]
            .some(frame => frame.srcdoc.includes('--blueprint-live-test: 1')));
          await page.locator('[data-boundary-id="still-meditation/screen/home"].bp-chrome-agent-focus').first().waitFor();
          assert.equal(await page.locator('#world').getAttribute('style'), preservedTransform);
          assert.equal(await page.evaluate(() => (
            window as Window & { __BLUEPRINT_STABLE_DOCUMENT__?: string }
          ).__BLUEPRINT_STABLE_DOCUMENT__), 'same-document');

          manifest.project.name = 'Serve Refreshed </script> Name';
          await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
          const refreshedHtml = await (await fetch(url)).text();
          assert.equal(refreshedHtml.includes('Serve Refreshed </script>'), false);
          await assertEventuallyServedProjectName(page, manifest.project.name);
          assert.equal(await page.evaluate(() => (
            window as Window & { __BLUEPRINT_STABLE_DOCUMENT__?: string }
          ).__BLUEPRINT_STABLE_DOCUMENT__), 'same-document');
          assert.equal(await page.locator('#world').getAttribute('style'), preservedTransform);
          await writeFile(manifestPath, '{ "project": ', 'utf8');
          await page.locator('.bp-chrome-agent-status[data-phase="waiting"]').waitFor();
          assert.equal(await servedProjectName(page), manifest.project.name);
          await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
          await assertEventuallyServedProjectName(page, manifest.project.name);
        } finally {
          await browser.close();
        }
      } finally {
        await session.close();
      }
      await assertEventuallyUnreachable(url);
    });
  });

  it('reuses one stable runtime per project while isolating other project ports', async () => {
    await withTempDir(async tempDir => {
      const repoA = path.join(tempDir, 'repo-a', 'design', 'blueprint');
      const repoB = path.join(tempDir, 'repo-b', 'design', 'blueprint');
      await cp(novaRoot, repoA, { recursive: true });
      await cp(explorationRoot, repoB, { recursive: true });
      const session = await openSession(tempDir);
      try {
        const concurrentA = await Promise.all([
          call(session, 'serve', { project: repoA }),
          call(session, 'serve', { project: repoA })
        ]);
        const firstA = concurrentA.find(result => result.runtime === 'started');
        const joinedA = concurrentA.find(result => result.runtime === 'reused');
        assert.ok(firstA);
        assert.ok(joinedA);
        assert.equal(joinedA.port, firstA.port);
        assert.equal(joinedA.url, firstA.url);
        const repeatedA = await call(session, 'serve', { project: repoA, port: 65530 });
        assert.equal(repeatedA.runtime, 'reused');
        assert.equal(repeatedA.port, firstA.port);
        assert.equal(repeatedA.url, firstA.url);

        const firstB = await call(session, 'serve', { project: repoB });
        assert.equal(firstB.runtime, 'started');
        assert.notEqual(firstB.port, firstA.port);
        assert.notEqual(firstB.url, firstA.url);
      } finally {
        await session.close();
      }
    });
  });

  it('shares one stable project runtime across independent MCP processes', async () => {
    await withTempDir(async tempDir => {
      const projectCopy = path.join(tempDir, 'design', 'blueprint');
      await cp(novaRoot, projectCopy, { recursive: true });
      const sessions = await Promise.all([openSession(tempDir), openSession(tempDir)]);
      let ownerIndex = -1;
      try {
        const served = await Promise.all(sessions.map(session => call(session, 'serve', { project: projectCopy })));
        assert.deepEqual(served.map(result => result.runtime).sort(), ['reused', 'started']);
        assert.equal(served[0]?.port, served[1]?.port);
        assert.equal(served[0]?.url, served[1]?.url);

        ownerIndex = served.findIndex(result => result.runtime === 'started');
        assert.notEqual(ownerIndex, -1);
        const borrowerIndex = ownerIndex === 0 ? 1 : 0;
        const url = served[ownerIndex]?.url as string;
        await sessions[borrowerIndex]?.close();
        assert.equal((await fetch(url)).status, 200);
        await sessions[ownerIndex]?.close();
        await assertEventuallyUnreachable(url);
      } finally {
        await Promise.allSettled(sessions.map(session => session.close()));
      }
    });
  });

  it('closes an owned review listener promptly when the stdio connection ends', async () => {
    await withTempDir(async tempDir => {
      const projectCopy = path.join(tempDir, 'design', 'blueprint');
      await cp(novaRoot, projectCopy, { recursive: true });
      const session = await openSession(tempDir);
      const served = await call(session, 'serve', { project: projectCopy, port: 0 });
      const startedAt = Date.now();
      await session.close();
      const closeDurationMs = Date.now() - startedAt;
      assert.ok(closeDurationMs < 1_500, `Expected stdio EOF cleanup before signal fallback; close took ${closeDurationMs}ms.`);
      await assertEventuallyUnreachable(served.url as string);
    });
  });

  it('replaces a borrowed handle after its owning MCP process disconnects', async () => {
    await withTempDir(async tempDir => {
      const projectCopy = path.join(tempDir, 'design', 'blueprint');
      await cp(novaRoot, projectCopy, { recursive: true });
      const sessions = await Promise.all([openSession(tempDir), openSession(tempDir)]);
      try {
        const served = await Promise.all(sessions.map(session => call(session, 'serve', { project: projectCopy, port: 0 })));
        const ownerIndex = served.findIndex(result => result.runtime === 'started');
        assert.notEqual(ownerIndex, -1);
        const borrowerIndex = ownerIndex === 0 ? 1 : 0;
        const borrowerSession = sessions[borrowerIndex];
        assert.ok(borrowerSession);
        const originalUrl = served[ownerIndex]?.url as string;

        await sessions[ownerIndex]?.close();
        await assertEventuallyUnreachable(originalUrl);
        const restarted = await call(borrowerSession, 'serve', { project: projectCopy, port: 0 });
        assert.equal(restarted.runtime, 'started');
        assert.equal((await fetch(restarted.url as string)).status, 200);
      } finally {
        await Promise.allSettled(sessions.map(session => session.close()));
      }
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
    assert.ok(schema.$defs.exploration);
    assert.ok(schema.$defs.explorationRecordFile);
    assert.ok(schema.$defs.screenHistoryRecordFile);
    assert.ok(schema.$defs.implementationTarget);
    assert.ok(schema.$defs.styleEvidence);

    const agents = await readFile('starter/design/blueprint/AGENTS.md', 'utf8');
    assert.match(agents, /sidecar-first/i);
    assert.match(agents, /MCP/i);
    assert.match(agents, /empty base frames/i);
    assert.match(agents, /<blueprint-use/i);
    assert.match(agents, /explore.*promote/is);
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

    const hooks = JSON.parse(await readFile('.codex/hooks.json', 'utf8')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ async?: boolean; command?: string }> }>>;
    };
    for (const eventName of ['PreToolUse', 'PostToolUse']) {
      const registration = hooks.hooks?.[eventName]?.[0];
      assert.match(registration?.matcher ?? '', /mcp__blueprint__/);
      assert.match(registration?.matcher ?? '', /apply_patch/);
      assert.match(registration?.matcher ?? '', /functions\\\.exec/);
      assert.equal(registration?.hooks?.[0]?.async, undefined);
      assert.match(registration?.hooks?.[0]?.command ?? '', /codex-activity-hook/);
    }
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

async function assertEventuallyServedProjectName(
  page: { evaluate: <T>(fn: () => T) => Promise<T> },
  expected: string
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if (await servedProjectName(page) === expected) return;
    } catch {
      // The page may still be applying the fetched snapshot; keep polling the stable document.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await servedProjectName(page), expected);
}

function runCodexHook(cwd: string, input: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [codexHookPath], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `Blueprint Codex hook exited with code ${code}.`));
    });
    child.stdin.end(JSON.stringify(input));
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

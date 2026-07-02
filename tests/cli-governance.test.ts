import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';

const projectRoot = process.cwd();
const cliPath = path.join(projectRoot, 'dist/cli/cli.js');
const novaRoot = 'fixtures/app-owned/nova-care/design/blueprint';

describe('Blueprint CLI and template governance', () => {
  it('builds and exposes the local package/bin boundary', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      bin?: Record<string, string>;
      exports?: Record<string, unknown>;
      scripts?: Record<string, string>;
    };

    assert.equal(packageJson.bin?.blueprint, './dist/cli/cli.js');
    assert.ok(packageJson.exports?.['.']);
    assert.ok(packageJson.scripts?.['build:cli']);
    assert.ok(packageJson.scripts?.['build:site']);

    const build = run('npm', ['run', '--silent', 'build']);
    assert.equal(build.status, 0, build.stderr || build.stdout);
    assert.equal((await stat(cliPath)).isFile(), true);
    assert.equal((await stat(path.join(projectRoot, 'dist/site/index.html'))).isFile(), true);

    const help = run('node', [cliPath, '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /blueprint <command>/);
    assert.match(help.stdout, /serve --project <path> \[--port 4173\]/);
  });

  it('initializes a safe app-owned Blueprint project and rewrites starter identity', async () => {
    await withTempDir(async tempDir => {
      const out = path.join(tempDir, 'app-a', 'design', 'blueprint');
      const result = run('node', [
        cliPath,
        'init',
        '--project-id',
        'app-a',
        '--name',
        'App A',
        '--out',
        out
      ]);

      assert.equal(result.status, 0, result.stderr);
      const output = parseJson(result.stdout);
      assert.equal(output.command, 'init');
      assert.deepEqual(output.files.sort(), ['AGENTS.md', 'manifest.json', 'primitives.json', 'screens.json', 'tokens.json']);
      assert.ok(output.nextCommands.some((command: string) => command.includes('blueprint validate')));

      const files = await readdir(out);
      assert.deepEqual(files.sort(), ['AGENTS.md', 'manifest.json', 'primitives.json', 'screens.json', 'tokens.json']);

      const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
      const tokens = JSON.parse(await readFile(path.join(out, 'tokens.json'), 'utf8'));
      const primitives = JSON.parse(await readFile(path.join(out, 'primitives.json'), 'utf8'));
      const screens = JSON.parse(await readFile(path.join(out, 'screens.json'), 'utf8'));
      assert.equal(manifest.project.id, 'app-a');
      assert.equal(manifest.project.name, 'App A');
      assert.equal(manifest.project.sourceRoot, normalize(out));
      assert.equal(tokens.projectId, 'app-a');
      assert.equal(primitives.projectId, 'app-a');
      assert.equal(screens.projectId, 'app-a');

      const structured = JSON.stringify({ manifest, tokens, primitives, screens });
      assert.equal(structured.includes('starter-app'), false);

      const validation = run('node', [cliPath, 'validate', '--project', out]);
      assert.equal(validation.status, 0, validation.stderr);
      assert.equal(parseJson(validation.stdout).ok, true);
    });
  });

  it('preserves existing destination files by default during init', async () => {
    await withTempDir(async tempDir => {
      const out = path.join(tempDir, 'design', 'blueprint');
      await mkdir(out, { recursive: true });
      const sentinel = path.join(out, 'keep.txt');
      await writeFile(sentinel, 'do not overwrite', 'utf8');

      const result = run('node', [
        cliPath,
        'init',
        '--project-id',
        'app-b',
        '--name',
        'App B',
        '--out',
        out
      ]);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Destination is not empty/);
      assert.equal(await readFile(sentinel, 'utf8'), 'do not overwrite');

      const force = run('node', [
        cliPath,
        'init',
        '--project-id',
        'app-b',
        '--name',
        'App B',
        '--out',
        out,
        '--force'
      ]);
      assert.equal(force.status, 0, force.stderr);
      assert.equal(await readFile(sentinel, 'utf8'), 'do not overwrite');
      const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
      assert.equal(manifest.project.id, 'app-b');
    });
  });

  it('validates, indexes, queries, and extracts one project through machine-readable CLI commands', async () => {
    const validation = run('node', [cliPath, 'validate', '--project', novaRoot]);
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(parseJson(validation.stdout).ok, true);

    const strict = run('node', [cliPath, 'validate', '--project', novaRoot, '--mode', 'strict']);
    assert.equal(strict.status, 0, strict.stderr);
    assert.equal(parseJson(strict.stdout).mode, 'strict');

    const readinessRoot = await createResolvedReadinessProject();
    const readiness = run('node', [cliPath, 'validate', '--project', readinessRoot, '--mode', 'readiness']);
    assert.equal(readiness.status, 0, readiness.stderr);
    const readinessOutput = parseJson(readiness.stdout);
    assert.equal(readinessOutput.mode, 'readiness');
    assert.equal(readinessOutput.ok, true);
    assert.equal(readinessOutput.readiness.tier, 'ready');
    assert.deepEqual(readinessOutput.readiness.blockers, []);

    const blockedReadiness = run('node', [cliPath, 'validate', '--project', novaRoot, '--mode', 'readiness']);
    assert.equal(blockedReadiness.status, 1);
    const blockedOutput = parseJson(blockedReadiness.stdout);
    assert.equal(blockedOutput.mode, 'readiness');
    assert.equal(blockedOutput.ok, false);
    assert.equal(blockedOutput.readiness.tier, 'blocked');
    assert.ok(
      blockedOutput.readiness.blockers.some((item: { source: string }) => item.source === 'declared-missing-artifact'),
      'readiness mode should expose missing linked artifact evidence as blockers'
    );

    const index = run('node', [cliPath, 'index', '--project', novaRoot]);
    assert.equal(index.status, 0, index.stderr);
    assert.ok(parseJson(index.stdout).results.some((item: { id: string }) => item.id === 'nova-care/screen/home'));

    const uses = run('node', [cliPath, 'query', '--project', novaRoot, '--type', 'uses', '--boundary', 'screen:home']);
    assert.equal(uses.status, 0, uses.stderr);
    assert.ok(parseJson(uses.stdout).results.some((item: { localId: string }) => item.localId === 'action-button'));

    await withTempDir(async tempDir => {
      const out = path.join(tempDir, 'packet.json');
      const extract = run('node', [cliPath, 'extract', '--project', novaRoot, '--boundary', 'screen:home', '--out', out]);
      assert.equal(extract.status, 0, extract.stderr);
      assert.equal(parseJson(extract.stdout).out, normalize(out));

      const packet = JSON.parse(await readFile(out, 'utf8'));
      assert.equal(packet.id, 'nova-care/screen/home');
      assert.equal('boundaries' in packet, false, 'focused extract should remain the default');
    });
  });

  it('supports parameterized deep extraction when the handoff contract API is available', async () => {
    await withTempDir(async tempDir => {
      const out = path.join(tempDir, 'deep.json');
      const extract = run('node', [
        cliPath,
        'extract',
        '--project',
        novaRoot,
        '--boundary',
        'section:home/next-action',
        '--mode',
        'deep',
        '--out',
        out
      ]);

      assert.equal(extract.status, 0, extract.stderr);
      const packet = JSON.parse(await readFile(out, 'utf8'));
      assert.equal(packet.extraction.mode, 'deep');
      assert.equal(packet.extraction.selected.id, 'nova-care/section/home/next-action');
      assert.ok(packet.boundaries.length > 1);
      assert.ok(packet.resolvedTokens.length > 0);
    });
  });

  it('captures a visible screen boundary as a PNG through the CLI', async () => {
    await withTempDir(async tempDir => {
      const out = path.join(tempDir, 'home.png');
      const capture = run('node', [
        cliPath,
        'capture',
        '--project',
        novaRoot,
        '--boundary',
        'screen:home',
        '--out',
        out
      ]);

      assert.equal(capture.status, 0, capture.stderr);
      const summary = parseJson(capture.stdout);
      assert.equal(summary.command, 'capture');
      assert.equal(summary.boundary, 'nova-care/screen/home');
      assert.equal(summary.out, normalize(out));
      assert.equal(summary.mediaType, 'image/png');
      assert.equal(summary.source.captureTarget, 'screen-frame');

      const png = await readFile(out);
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16), 786);
      assert.equal(png.readUInt32BE(20), 1704);

      const projectCopy = path.join(tempDir, 'project-copy');
      await cp(novaRoot, projectCopy, { recursive: true });
      const screensPath = path.join(projectCopy, 'screens.json');
      const screens = JSON.parse(await readFile(screensPath, 'utf8'));
      screens.screens.push({
        ...screens.screens[0],
        id: 'settings',
        name: 'Settings',
        description: 'Settings capture target'
      });
      await writeFile(screensPath, `${JSON.stringify(screens, null, 2)}\n`, 'utf8');

      const settingsOut = path.join(tempDir, 'settings.png');
      const settingsCapture = run('node', [
        cliPath,
        'capture',
        '--project',
        projectCopy,
        '--boundary',
        'screen:settings',
        '--out',
        settingsOut
      ]);

      assert.equal(settingsCapture.status, 0, settingsCapture.stderr);
      assert.equal(parseJson(settingsCapture.stdout).boundary, 'nova-care/screen/settings');
      const settingsPng = await readFile(settingsOut);
      assert.equal(settingsPng.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    });
  });

  it('serves one explicit app-owned project with deterministic local lifecycle behavior', async () => {
    const projectPath = path.resolve(novaRoot);
    const port = await getAvailablePort();
    const server = await startServe(projectPath, ['--port', String(port)]);

    try {
      assert.equal(server.url, `http://127.0.0.1:${port}/`);
      assert.match(server.stdout(), new RegExp(`Blueprint serve ready: http://127\\.0\\.0\\.1:${port}/`));

      const response = await fetch(server.url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const html = await response.text();
      const injectionIndex = html.indexOf('window.__BLUEPRINT_PROJECT_BUNDLE__');
      const moduleIndex = html.indexOf('type="module"');
      assert.ok(injectionIndex >= 0, 'expected served HTML to inject an app-owned project bundle');
      assert.ok(moduleIndex > injectionIndex, 'expected the bundle injection script before the built module script');
      assert.equal(await requestStatus(port, '/%zz'), 400);
      assert.equal(server.isRunning(), true, 'malformed request paths should not stop the long-lived serve process');

      const { chromium } = await import('playwright');
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(server.url);
        const projectId = await page.evaluate(() => {
          type ServedWindow = Window & {
            __BLUEPRINT_PROJECT_BUNDLE__?: { manifest?: { project?: { id?: string; name?: string } } };
          };
          return (window as ServedWindow).__BLUEPRINT_PROJECT_BUNDLE__?.manifest?.project?.id;
        });
        assert.equal(projectId, 'nova-care');
        assert.doesNotMatch(await page.locator('body').innerText(), /Starter App/);
      } finally {
        await browser.close();
      }
    } finally {
      await server.close();
    }

    const occupied = await occupyPort(port);
    try {
      const result = run('node', [cliPath, 'serve', '--project', projectPath, '--port', String(port)], { timeoutMs: 10000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`EADDRINUSE.*${port}|${port}.*EADDRINUSE`));
    } finally {
      await closeNetServer(occupied);
    }

    const defaultPort = await occupyPort(4173).catch(() => undefined);
    try {
      const result = run('node', [cliPath, 'serve', '--project', projectPath], { timeoutMs: 10000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /4173/);
      assert.match(result.stderr, /EADDRINUSE|already in use/i);
    } finally {
      if (defaultPort) {
        await closeNetServer(defaultPort);
      }
    }

    const invalid = run('node', [cliPath, 'serve', '--project', path.join(projectRoot, 'does-not-exist'), '--port', String(await getAvailablePort())], { timeoutMs: 10000 });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Blueprint project path not found|Missing Blueprint project file|does-not-exist/i);
  });

  it('serves from the built package surface and refreshes or recovers as project files change', async () => {
    await withTempDir(async tempDir => {
      const projectCopy = path.join(tempDir, 'app-owned', 'design', 'blueprint');
      await cp(novaRoot, projectCopy, { recursive: true });
      const manifestPath = path.join(projectCopy, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.project.name = 'Serve Copy';
      manifest.project.sourceRoot = normalize(projectCopy);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      const port = await getAvailablePort();
      const server = await startServe(projectCopy, ['--port', String(port)], tempDir);

      try {
        const { chromium } = await import('playwright');
        const browser = await chromium.launch();
        try {
          const page = await browser.newPage();
          await page.goto(server.url);
          assert.equal(await servedProjectName(page), 'Serve Copy');

          const refreshedProjectName = "Serve Refreshed </script> \u2028 Save $$$ and $' Name";
          manifest.project.name = refreshedProjectName;
          await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
          const refreshedHtml = await (await fetch(server.url)).text();
          assert.equal(refreshedHtml.includes('Serve Refreshed </script>'), false, 'script-breaking project data must be escaped');
          await page.reload();
          assert.equal(await servedProjectName(page), refreshedProjectName);

          await writeFile(manifestPath, '{ "project": ', 'utf8');
          await page.reload();
          assert.equal(await servedProjectName(page), refreshedProjectName);
          assert.equal(server.isRunning(), true, 'serve process should stay alive while project JSON is malformed');

          manifest.project.name = 'Serve Recovered';
          await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
          await page.reload();
          assert.equal(await servedProjectName(page), 'Serve Recovered');
        } finally {
          await browser.close();
        }
      } finally {
        await server.close();
      }
    });
  });

  it('keeps serve alive with an actionable error for initially invalid project content', async () => {
    const invalidProject = path.resolve('fixtures/invalid/missing-section/design/blueprint');
    const port = await getAvailablePort();
    const server = await startServe(invalidProject, ['--port', String(port)]);

    try {
      const response = await fetch(server.url);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Blueprint project error/);
      assert.match(html, /screen\.home\.section\.id must be a non-empty string/);
      assert.equal(server.isRunning(), true, 'serve process should stay alive when initial project content is baseline-invalid');
    } finally {
      await server.close();
    }
  });

  it('fails capture honestly for boundaries without a canonical screen PNG target', async () => {
    await withTempDir(async tempDir => {
      const result = run('node', [
        cliPath,
        'capture',
        '--project',
        novaRoot,
        '--boundary',
        'primitive:action-button',
        '--out',
        path.join(tempDir, 'button.png')
      ]);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /currently supports screen boundaries/);
    });
  });

  it('ships schema artifacts aligned with the structured contract and template AGENTS governance', async () => {
    assert.equal(existsSync('schema/blueprint-project.schema.json'), true);
    const schema = JSON.parse(await readFile('schema/blueprint-project.schema.json', 'utf8'));
    assert.equal(schema.$id, 'https://blueprint.local/schema/blueprint-project.schema.json');
    assert.ok(schema.$defs.manifest);
    assert.ok(schema.$defs.implementationTarget);
    assert.ok(schema.$defs.styleEvidence);

    const agents = await readFile('starter/design/blueprint/AGENTS.md', 'utf8');
    assert.match(agents, /sidecar-first/i);
    assert.match(agents, /blueprint validate/i);
    assert.match(agents, /blueprint index/i);
    assert.match(agents, /new screens/i);
    assert.match(agents, /raw .*fallback/i);

    const docs = `${await readFile('README.md', 'utf8')}\n${await readFile('docs/starter-scaffold.md', 'utf8')}\n${await readFile('docs/query-contract.md', 'utf8')}`;
    for (const term of ['blueprint init', 'blueprint validate', 'blueprint serve', 'blueprint index', 'blueprint query', 'blueprint extract', 'blueprint capture', 'schema/blueprint-project.schema.json', 'AGENTS.md', 'single-project']) {
      assert.match(docs, new RegExp(escapeRegExp(term)));
    }
    assert.match(docs, /init[\s\S]+validate[\s\S]+serve[\s\S]+query[\s\S]+extract[\s\S]+capture/i);
    assert.match(docs, /never becomes a central project manager|not .*central registry|not .*centralized/i);
    assert.doesNotMatch(docs, /hosted registry|cloud dashboard/i);
  });
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'blueprint-cli-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function createResolvedReadinessProject(): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-cli-readiness-'));
  const out = path.join(tempDir, 'design', 'blueprint');
  await cp(novaRoot, out, { recursive: true });
  const primitivesPath = path.join(out, 'primitives.json');
  const screensPath = path.join(out, 'screens.json');
  const primitives = JSON.parse(await readFile(primitivesPath, 'utf8'));
  const screens = JSON.parse(await readFile(screensPath, 'utf8'));

  resolveStyleEvidence(primitives, primitivesPath);
  resolveStyleEvidence(screens, screensPath);

  await writeFile(primitivesPath, `${JSON.stringify(primitives, null, 2)}\n`, 'utf8');
  await writeFile(screensPath, `${JSON.stringify(screens, null, 2)}\n`, 'utf8');
  return out;
}

function resolveStyleEvidence(value: unknown, sourcePath: string): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      resolveStyleEvidence(item, sourcePath);
    }
    return;
  }

  const record = value as {
    id?: string;
    styleRefs?: string[];
    styleEvidence?: Array<{
      styleRef: string;
      status: string;
      sourceAnchor?: string;
      artifactRef?: string;
      notes?: string[];
    }>;
  };
  if (Array.isArray(record.styleRefs)) {
    record.styleEvidence = record.styleRefs.map(styleRef => ({
      styleRef,
      status: 'source',
      sourceAnchor: `${normalize(sourcePath)}#${record.id ?? styleRef}`
    }));
  }

  for (const child of Object.values(record)) {
    resolveStyleEvidence(child, sourcePath);
  }
}

function run(command: string, args: string[], options: { timeoutMs?: number } = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    killSignal: 'SIGKILL',
    timeout: options.timeoutMs ?? 60000
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function startServe(projectPath: string, extraArgs: string[], cwd = projectRoot): Promise<{
  url: string;
  stdout: () => string;
  stderr: () => string;
  isRunning: () => boolean;
  close: () => Promise<void>;
}> {
  const child = spawn('node', [cliPath, 'serve', '--project', projectPath, ...extraArgs], {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const readyPattern = /Blueprint serve ready: (http:\/\/127\.0\.0\.1:\d+\/)/;

  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for serve readiness.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15000);

    const inspect = (): void => {
      const match = stdout.match(readyPattern);
      if (match?.[1]) {
        clearTimeout(timeout);
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error(`Serve exited before readiness with code ${code ?? 'null'} signal ${signal ?? 'null'}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };
    const cleanup = (): void => {
      child.stdout.off('data', inspect);
      child.off('exit', onExit);
    };

    child.stdout.on('data', inspect);
    child.once('exit', onExit);
    inspect();
  });

  return {
    url,
    stdout: () => stdout,
    stderr: () => stderr,
    isRunning: () => child.exitCode === null && child.signalCode === null,
    close: () => stopServe(child, () => stderr)
  };
}

async function stopServe(child: ChildProcess, stderr: () => string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGINT');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Serve did not shut down after SIGINT.\nstderr:\n${stderr()}`));
    }, 5000);
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Serve exited with code ${code ?? 'null'} after SIGINT.\nstderr:\n${stderr()}`));
        return;
      }
      resolve();
    });
  });
}

async function getAvailablePort(): Promise<number> {
  const server = await occupyPort(0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an ephemeral TCP port.');
  }
  const port = address.port;
  await closeNetServer(server);
  return port;
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
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function requestStatus(port: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        method: 'GET',
        path: target,
        port
      },
      response => {
        response.resume();
        response.on('end', () => {
          resolve(response.statusCode ?? 0);
        });
      }
    );
    request.once('error', reject);
    request.end();
  });
}

async function servedProjectName(page: {
  evaluate: <T>(fn: () => T) => Promise<T>;
}): Promise<string | undefined> {
  return page.evaluate(() => {
    type ServedWindow = Window & {
      __BLUEPRINT_PROJECT_BUNDLE__?: { manifest?: { project?: { name?: string } } };
    };
    return (window as ServedWindow).__BLUEPRINT_PROJECT_BUNDLE__?.manifest?.project?.name;
  });
}

function parseJson(stdout: string): any {
  assert.ok(stdout.trim(), 'expected JSON stdout');
  return JSON.parse(stdout);
}

function normalize(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

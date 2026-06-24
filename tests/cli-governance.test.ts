import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

    const build = run('npm', ['run', '--silent', 'build:cli']);
    assert.equal(build.status, 0, build.stderr || build.stdout);
    assert.equal((await stat(cliPath)).isFile(), true);

    const help = run('node', [cliPath, '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /blueprint <command>/);
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
    for (const term of ['blueprint init', 'blueprint validate', 'blueprint index', 'blueprint query', 'blueprint extract', 'blueprint capture', 'schema/blueprint-project.schema.json', 'AGENTS.md', 'single-project']) {
      assert.match(docs, new RegExp(escapeRegExp(term)));
    }
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

function run(command: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' }
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
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

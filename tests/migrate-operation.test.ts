import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { migrateBlueprint } from '../src/mcp/operations';
import { validateProject } from '../src/prototype/validate-project';

const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';
const frozenV1Root = 'tests/migrations/1.0.0-to-2.0.0/input';

async function fileHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    hashes[path.relative(root, full)] = createHash('sha256').update(await readFile(full)).digest('hex');
  }
  return hashes;
}

async function withProjectCopy(fn: (project: string) => Promise<void>, source = miraRoot): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-migrate-op-'));
  try {
    const project = path.join(tempDir, 'design', 'blueprint');
    await cp(source, project, { recursive: true });
    const manifestPath = path.join(project, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.project.sourceRoot = project;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await fn(project);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe('migrate operation', () => {
  it('makes no scratch copy when the project has nothing to migrate', async () => {
    await withProjectCopy(async project => {
      const fifo = path.join(project, 'uncopyable.fifo');
      assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
      const output = await migrateBlueprint({ project, dryRun: false });
      assert.equal(output.upToDate, true);
      assert.deepEqual(output.files, []);
      assert.equal(output.validation.ok, true);
    });
  });

  it('still validates a scratch copy when the project needs a change', async () => {
    await withProjectCopy(async project => {
      const manifestPath = path.join(project, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.schemaVersion = '1.0.0';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      const dryRun = await migrateBlueprint({ project, dryRun: true });
      assert.equal(dryRun.upToDate, false);
      assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).schemaVersion, '1.0.0');
      assert.equal(dryRun.validation.ok, true);
    });
  });

  it('reports with dryRun what a real run does, and writes nothing', async () => {
    await withProjectCopy(async project => {
      const before = await fileHashes(project);

      const dryRun = await migrateBlueprint({ project, dryRun: true });
      assert.deepEqual(await fileHashes(project), before, 'dryRun writes no file');
      assert.equal(dryRun.dryRun, true);
      assert.equal(dryRun.fromVersion, '1.0.0');
      assert.equal(dryRun.upToDate, false);
      assert.ok(dryRun.files.length > 0);
      assert.ok(dryRun.changes.length > 0);

      const real = await migrateBlueprint({ project, dryRun: false });
      assert.deepEqual({ ...real, dryRun: true }, dryRun);

      const after = await fileHashes(project);
      const changed = Object.keys({ ...before, ...after }).filter(file => before[file] !== after[file]).sort();
      assert.deepEqual(changed, real.files);

      const second = await migrateBlueprint({ project, dryRun: true });
      assert.equal(second.upToDate, true);
      assert.deepEqual(second.files, []);
      assert.deepEqual(second.changes, []);
      assert.deepEqual(await fileHashes(project), after);
    }, frozenV1Root);
  });

  it('gives a dryRun on a project that needs nothing the same result as a real run', async () => {
    await withProjectCopy(async project => {
      const before = await fileHashes(project);
      const dryRun = await migrateBlueprint({ project, dryRun: true });
      const real = await migrateBlueprint({ project, dryRun: false });
      assert.deepEqual({ ...real, dryRun: true }, dryRun);
      assert.equal(real.upToDate, true);
      assert.deepEqual(await fileHashes(project), before);
    });
  });

  it('restores a missing base primitive, so baseline validation passes again', async () => {
    await withProjectCopy(async project => {
      const primitivesPath = path.join(project, 'primitives.json');
      const primitives = JSON.parse(await readFile(primitivesPath, 'utf8'));
      primitives.primitives = primitives.primitives.filter((primitive: { id: string }) => primitive.id !== 'switch');
      await writeFile(primitivesPath, `${JSON.stringify(primitives, null, 2)}\n`, 'utf8');
      await rm(path.join(project, 'prototype/primitives/switch.html'));
      await rm(path.join(project, 'prototype/primitives/switch.css'));

      const output = await migrateBlueprint({ project, dryRun: false });

      assert.equal(output.validation.ok, true, output.validation.errors.join('\n'));
      assert.deepEqual(output.files.filter(file => file.includes('switch')), ['prototype/primitives/switch.css', 'prototype/primitives/switch.html']);
      assert.equal(output.upToDate, false);
      assert.ok(output.changes.some(change => change.includes('restored 1 missing Blueprint primitive from the starter')), output.changes.join('\n'));
    });
  });

  it('keeps a valid project valid when the missing primitive names a token the project lacks', async () => {
    await withProjectCopy(async project => {
      const primitivesPath = path.join(project, 'primitives.json');
      const primitives = JSON.parse(await readFile(primitivesPath, 'utf8'));
      primitives.primitives = primitives.primitives.filter((primitive: { id: string }) => primitive.id !== 'tooltip');
      for (const primitive of primitives.primitives) delete primitive.tokenRoles['shape.shadow-md'];
      await writeFile(primitivesPath, `${JSON.stringify(primitives, null, 2)}\n`, 'utf8');
      await rm(path.join(project, 'prototype/primitives/tooltip.html'));
      await rm(path.join(project, 'prototype/primitives/tooltip.css'));
      const tokensPath = path.join(project, 'tokens.json');
      const tokens = JSON.parse(await readFile(tokensPath, 'utf8'));
      const shape = tokens.tokenGroups.find((group: { id: string }) => group.id === 'shape');
      shape.tokens = shape.tokens.filter((token: { id: string }) => token.id !== 'shadow-md');
      await writeFile(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');
      const before = validateProject(await loadProjectFromFs(project));
      assert.equal(before.ok, true, before.errors.join('\n'));

      const output = await migrateBlueprint({ project, dryRun: false });

      assert.equal(output.validation.ok, true, output.validation.errors.join('\n'));
      assert.equal(output.upToDate, true);
      assert.ok(output.changes.includes('primitives.json: left out the missing Blueprint primitive "tooltip", because tokens.json does not declare "shape.shadow-md". Fix: add them, then run migrate again.'), output.changes.join('\n'));
    });
  });
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { migrateBlueprint } from '../src/mcp/operations';

const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';

async function withProjectCopy(fn: (project: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-migrate-op-'));
  try {
    const project = path.join(tempDir, 'design', 'blueprint');
    await cp(miraRoot, project, { recursive: true });
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
});

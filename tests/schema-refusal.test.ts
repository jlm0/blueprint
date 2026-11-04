import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { migrateProjectFiles } from '../src/core/migrate';
import { loadProjectFromFs } from '../src/core/load';
import { assertCurrentSchema, BLUEPRINT_SCHEMA_VERSION, isNewerSchemaVersion, schemaVersionErrors } from '../src/core/schema-version';
import { captureBlueprint } from '../src/mcp/capture';
import { inspoBlueprint } from '../src/mcp/inspo';
import {
  exploreBlueprint,
  extractBlueprint,
  indexBlueprint,
  migrateBlueprint,
  promoteBlueprint,
  queryBlueprint,
  restoreBlueprint,
  serveBlueprint,
  validateBlueprint
} from '../src/mcp/operations';
import { readValidatedProject } from '../src/mcp/project-validation-worker';
import { readCanvasLocation, readSelectionFiles } from '../src/mcp/project-validation';
import { validateProject } from '../src/prototype/validate-project';

const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';
const historyRecord = 'history/home-v1.json';
const explorationRecord = 'explorations/ledger-density.json';

async function withProject(fn: (project: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-schema-refusal-'));
  try {
    const project = path.join(tempDir, 'design', 'blueprint');
    await cp(meridianRoot, project, { recursive: true });
    await fn(project);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function setVersion(project: string, file: string, version: string | undefined): Promise<void> {
  const target = path.join(project, file);
  const content = JSON.parse(await readFile(target, 'utf8'));
  if (version === undefined) delete content.schemaVersion;
  else content.schemaVersion = version;
  await writeFile(target, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

async function fileHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    hashes[path.relative(root, full)] = createHash('sha256').update(await readFile(full)).digest('hex');
  }
  return hashes;
}

function refusingTools(project: string): Array<[string, () => Promise<unknown>]> {
  return [
    ['index', () => indexBlueprint({ project })],
    ['query', () => queryBlueprint({ project, query: { type: 'prototype-only' } })],
    ['extract', () => extractBlueprint({ project, boundary: 'screen:home', mode: 'focused' })],
    ['capture', () => captureBlueprint({ project, boundary: 'screen:home', out: path.join(project, '..', 'capture.png') })],
    ['explore', () => exploreBlueprint({ project, operation: { type: 'archive', explorationId: 'ledger-density' } })],
    ['promote', () => promoteBlueprint({ project, explorationId: 'ledger-density', candidateId: 'x', expectedBaseDigest: 'x' } as unknown as Parameters<typeof promoteBlueprint>[0])],
    ['restore', () => restoreBlueprint({ project, screenId: 'home', version: 1, expectedCurrentDigest: 'x' } as unknown as Parameters<typeof restoreBlueprint>[0])],
    ['inspo', () => inspoBlueprint({ project, operation: { type: 'remove', id: 'ref-1' } })],
    ['serve focus', () => readCanvasLocation(project, 'screen:home')],
    ['selection files', () => readSelectionFiles(project, { kind: 'screen', screenId: 'home' } as unknown as Parameters<typeof readSelectionFiles>[1])]
  ];
}

async function assertToolsRefuse(project: string, pattern: RegExp): Promise<void> {
  for (const [tool, call] of refusingTools(project)) {
    await assert.rejects(call(), (error: Error) => {
      assert.match(error.message, pattern, tool);
      return true;
    }, tool);
  }
}

describe('a record on an older schema', () => {
  for (const [file, version] of [[historyRecord, '1.0.0'], [explorationRecord, '1.0.0']] as const) {
    it(`refuses ${file} on ${version} in each tool, until migrate brings it to the current schema`, async () => {
      await withProject(async project => {
        assert.equal((await validateBlueprint({ project, mode: 'baseline' })).ok, true);

        await setVersion(project, file, version);
        const message = `${file} is on schema "${version}", and Blueprint now reads "${BLUEPRINT_SCHEMA_VERSION}". Fix: run the migrate tool on this project, then fix what validate reports.`;

        const validated = await validateBlueprint({ project, mode: 'baseline' });
        assert.equal(validated.ok, false);
        assert.deepEqual(validated.errors, [message]);

        await assertToolsRefuse(project, new RegExp(`${file.replace(/[/.-]/g, '\\$&')} is on schema "1\\.0\\.0".*Fix: run the migrate tool`));

        const served = await readValidatedProject(project);
        assert.ok('error' in served);
        assert.deepEqual(served.outdatedFiles, [{ file, version }]);
        assert.match(served.error ?? '', /Fix: run the migrate tool/);
        await assert.rejects(serveBlueprint({ project, port: 0, focus: 'screen:home' }), /is on schema "1\.0\.0"/);

        const dryRun = await migrateBlueprint({ project, dryRun: true });
        assert.deepEqual([dryRun.fromVersion, dryRun.files], ['1.0.0', [file]]);
        assert.equal(JSON.parse(await readFile(path.join(project, file), 'utf8')).schemaVersion, version);

        const migrated = await migrateBlueprint({ project, dryRun: false });
        assert.deepEqual([migrated.fromVersion, migrated.toVersion, migrated.files], ['1.0.0', BLUEPRINT_SCHEMA_VERSION, [file]]);
        assert.deepEqual(migrated.changes, [`explorations and history: 1 saved record now carry schemaVersion "${BLUEPRINT_SCHEMA_VERSION}".`]);
        assert.equal(migrated.validation.ok, true, migrated.validation.errors.join('\n'));
        assert.equal(JSON.parse(await readFile(path.join(project, file), 'utf8')).schemaVersion, BLUEPRINT_SCHEMA_VERSION);

        assert.equal((await validateBlueprint({ project, mode: 'baseline' })).ok, true);
        await indexBlueprint({ project });
      });
    });
  }

  it('refuses a record with no version, and migrate puts the version first', async () => {
    await withProject(async project => {
      await setVersion(project, historyRecord, undefined);

      assert.match((await validateBlueprint({ project, mode: 'baseline' })).errors[0], /history\/home-v1\.json is on schema "undefined".*Fix: run the migrate tool/);
      await assert.rejects(indexBlueprint({ project }), /history\/home-v1\.json is on schema "undefined"/);

      const migrated = await migrateBlueprint({ project, dryRun: false });
      assert.deepEqual(migrated.files, [historyRecord]);
      const record = JSON.parse(await readFile(path.join(project, historyRecord), 'utf8'));
      assert.equal(Object.keys(record)[0], 'schemaVersion');
      assert.equal(record.schemaVersion, BLUEPRINT_SCHEMA_VERSION);
    });
  });

  it('migrate refuses a record on a version outside the chain, and writes nothing', async () => {
    for (const version of ['0.5.0', '1.5.0', 'draft', '']) {
      await withProject(async project => {
        await setVersion(project, explorationRecord, version);
        const before = await fileHashes(project);
        assert.match((await validateBlueprint({ project, mode: 'baseline' })).errors[0], /ledger-density\.json is on schema .*Fix: run the migrate tool/);
        await assert.rejects(indexBlueprint({ project }), /ledger-density\.json is on schema/);
        for (const dryRun of [true, false]) {
          await assert.rejects(migrateBlueprint({ project, dryRun }), new RegExp(`ledger-density\\.json is on schema "${version.replace(/\./g, '\\.')}", which migrate does not know how to upgrade`));
        }
        assert.deepEqual(await fileHashes(project), before);
      });
    }
  });
});

describe('a file or record on a newer schema', () => {
  const NEWER = /is on schema "9\.9\.9", which is newer than schema "2\.0\.0" that this Blueprint reads\. Fix: update Blueprint to a release that reads this schema/;

  for (const file of ['manifest.json', 'tokens.json', 'brand.json', 'screens.json', 'primitives.json', 'components.json', historyRecord, explorationRecord]) {
    it(`refuses ${file} in each tool and in migrate, and writes nothing`, async () => {
      await withProject(async project => {
        await setVersion(project, file, '9.9.9');
        const before = await fileHashes(project);

        await assert.rejects(validateBlueprint({ project, mode: 'baseline' }), NEWER);
        await assertToolsRefuse(project, NEWER);

        const served = await readValidatedProject(project);
        assert.ok('error' in served);
        assert.match(served.error ?? '', NEWER);
        assert.deepEqual(served.outdatedFiles, [], 'the migrate notice would tell the person to run a tool that refuses');

        for (const dryRun of [true, false]) {
          await assert.rejects(migrateBlueprint({ project, dryRun }), NEWER);
        }
        assert.deepEqual(await fileHashes(project), before);
      });
    });
  }

  it('names each newer file, and does not read a shape it cannot know', async () => {
    await withProject(async project => {
      await writeFile(path.join(project, 'manifest.json'), JSON.stringify({ schemaVersion: '9.9.9', layout: 'future' }));
      await setVersion(project, 'tokens.json', '3.0.0');
      await assert.rejects(loadProjectFromFs(project), (error: Error) => {
        assert.match(error.message, /manifest\.json is on schema "9\.9\.9".*Fix: update Blueprint/);
        assert.match(error.message, /tokens\.json is on schema "3\.0\.0".*Fix: update Blueprint/);
        return true;
      });
    });
  });

  it('reports a newer version in a bundle that did not come from the disk', async () => {
    const bundle = structuredClone(await loadProjectFromFs(meridianRoot));
    (bundle.manifest as { schemaVersion: string }).schemaVersion = '9.9.9';
    bundle.recordSchemaVersions = { [historyRecord]: '10.0.0', [explorationRecord]: '1.0.0' };

    const errors = schemaVersionErrors(bundle);
    assert.equal(errors.length, 3);
    assert.match(errors[0], /manifest\.json is on schema "9\.9\.9".*Fix: update Blueprint/);
    assert.match(errors[1], /history\/home-v1\.json is on schema "10\.0\.0".*Fix: update Blueprint/);
    assert.match(errors[2], /ledger-density\.json is on schema "1\.0\.0".*Fix: run the migrate tool/);
    assert.deepEqual(validateProject(bundle).errors, errors);
    assert.throws(() => assertCurrentSchema(bundle), /Fix: update Blueprint/);
  });

  it('compares each part of the version as a number, and treats text as not newer', () => {
    const cases: Array<[unknown, boolean]> = [
      ['9.9.9', true], ['2.0.1', true], ['2.1.0', true], ['3.0.0', true], ['10.0.0', true],
      ['2.0.0', false], ['1.0.0', false], ['1.9.9', false], ['0.10.0', false],
      ['draft', false], ['', false], ['3', false], ['3.0.0-beta', false], [undefined, false], [null, false], [7, false]
    ];
    for (const [version, newer] of cases) assert.equal(isNewerSchemaVersion(version), newer, String(version));
  });

  it('refuses in migrateProjectFiles before it reads anything else, and lists each file', () => {
    const base = { projectId: 'demo' };
    const files = new Map<string, string>(['manifest.json', 'tokens.json', 'screens.json', 'primitives.json', 'components.json'].map(file => [file, JSON.stringify({ ...base, schemaVersion: BLUEPRINT_SCHEMA_VERSION })]));
    files.set('history/a-v1.json', JSON.stringify({ ...base, schemaVersion: '9.9.9' }));
    files.set('explorations/b.json', JSON.stringify({ ...base, schemaVersion: '9.9.9' }));
    assert.throws(() => migrateProjectFiles({ files, starterFiles: new Map() }), (error: Error) => {
      assert.match(error.message, /explorations\/b\.json is on schema "9\.9\.9".*Fix: update Blueprint/);
      assert.match(error.message, /history\/a-v1\.json is on schema "9\.9\.9".*Fix: update Blueprint/);
      return true;
    });
  });
});

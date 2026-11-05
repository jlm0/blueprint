import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { computeExplorationBaselineDigest } from '../src/core/exploration';
import { loadProjectFromFs } from '../src/core/load';
import { migrateProjectFiles } from '../src/core/migrate';
import { step } from '../src/core/migrations/2.0.0-to-3.0.0';
import { BLUEPRINT_SCHEMA_VERSION } from '../src/core/schema-version';
import { migrateBlueprint } from '../src/mcp/operations';

const FROZEN_V1 = 'tests/migrations/1.0.0-to-2.0.0/input';
const STARTER = 'starter/design/blueprint';
const MERIDIAN = 'fixtures/valid/meridian-finance/design/blueprint';
const EXPLORATION = 'explorations/ledger-density.json';

async function textFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(json|html|css|md)$/.test(entry.name)) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.set(path.relative(root, full).split(path.sep).join('/'), await readFile(full, 'utf8'));
  }
  return files;
}

function baseProject(extra: Record<string, unknown>): Map<string, string> {
  const files: Record<string, unknown> = {
    'manifest.json': { schemaVersion: '2.0.0', project: { id: 'demo', name: 'Demo' } },
    'tokens.json': { schemaVersion: '2.0.0', projectId: 'demo', tokenGroups: [] },
    'screens.json': { schemaVersion: '2.0.0', projectId: 'demo', pages: [], screens: [] },
    'primitives.json': { schemaVersion: '2.0.0', projectId: 'demo', primitives: [] },
    'components.json': { schemaVersion: '2.0.0', projectId: 'demo', groups: [], components: [] },
    ...extra
  };
  return new Map(Object.entries(files).map(([file, value]) => [file, JSON.stringify(value)]));
}

async function withCopy(source: string, run: (project: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'blueprint-step-3-'));
  try {
    const project = path.join(directory, 'design', 'blueprint');
    await cp(source, project, { recursive: true });
    await run(project);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('step 2.0.0 to 3.0.0', () => {
  it('moves flow to page in an exploration baseline and a history snapshot, in the same key position', () => {
    const { files, changes, stamped } = step.run(baseProject({
      'explorations/a.json': { schemaVersion: '2.0.0', exploration: { id: 'a', target: { baseline: { screen: { id: 'home', flow: 'Sign Up', name: 'Home' } } } } },
      'history/home-v1.json': { schemaVersion: '2.0.0', entry: { screenId: 'home', version: 1, screen: { id: 'home', flow: 'web', name: 'Home' } } }
    }));
    const baseline = JSON.parse(files.get('explorations/a.json')!).exploration.target.baseline.screen;
    const snapshot = JSON.parse(files.get('history/home-v1.json')!).entry.screen;
    assert.deepEqual(Object.keys(baseline), ['id', 'page', 'name']);
    assert.equal(baseline.page, 'sign-up');
    assert.equal(snapshot.page, 'web');
    assert.ok(changes.includes('explorations and history: moved flow to page in 2 saved screens.'), changes.join('\n'));
    assert.deepEqual(stamped.records, ['explorations/a.json', 'history/home-v1.json']);
  });

  it('keeps a page that a snapshot already holds, and removes flow in each other form', () => {
    const { files } = step.run(baseProject({
      'history/a-v1.json': { schemaVersion: '2.0.0', entry: { screen: { id: 'a', page: 'web', flow: 'mobile' } } },
      'history/b-v1.json': { schemaVersion: '2.0.0', entry: { screen: { id: 'b', flow: 7 } } },
      'history/c-v1.json': { schemaVersion: '2.0.0', entry: { screen: { id: 'c', flow: '  ' } } }
    }));
    assert.deepEqual(JSON.parse(files.get('history/a-v1.json')!).entry.screen, { id: 'a', page: 'web' });
    assert.deepEqual(JSON.parse(files.get('history/b-v1.json')!).entry.screen, { id: 'b' });
    assert.deepEqual(JSON.parse(files.get('history/c-v1.json')!).entry.screen, { id: 'c' });
  });

  it('does not assume that a record holds a screen', () => {
    const { files, changes } = step.run(baseProject({
      'explorations/a.json': { schemaVersion: '2.0.0', exploration: { id: 'a' } },
      'explorations/b.json': { schemaVersion: '2.0.0', exploration: { target: { baseline: { screen: 'home' } } } },
      'history/c-v1.json': { schemaVersion: '2.0.0', entry: null }
    }));
    assert.equal(JSON.parse(files.get('explorations/a.json')!).schemaVersion, '3.0.0');
    assert.deepEqual(changes, []);
  });
});

describe('the whole chain', () => {
  it('runs the frozen 1.0.0 input through each step and the normalizers to the current version', async () => {
    const files = await textFiles(FROZEN_V1);
    const output = migrateProjectFiles({ files, starterFiles: await textFiles(STARTER) });
    assert.equal(output.fromVersion, '1.0.0');
    assert.equal(output.toVersion, BLUEPRINT_SCHEMA_VERSION);
    const final = new Map([...files, ...output.writes]);
    for (const file of ['manifest.json', 'tokens.json', 'screens.json', 'primitives.json', 'components.json']) {
      assert.equal(JSON.parse(final.get(file)!).schemaVersion, BLUEPRINT_SCHEMA_VERSION, file);
    }
    for (const file of [...final.keys()].filter(name => /^(explorations|history)\/[^/]+\.json$/.test(name))) {
      assert.equal(JSON.parse(final.get(file)!).schemaVersion, BLUEPRINT_SCHEMA_VERSION, file);
    }
  });

  it('reports upToDate true with no change line and no write', async () => {
    await withCopy(MERIDIAN, async project => {
      const clean = await migrateBlueprint({ project, dryRun: false });
      assert.deepEqual(clean.changes, []);
      assert.equal(clean.upToDate, true);
    });
  });

  it('holds a current digest in a migrated exploration', async () => {
    await withCopy(MERIDIAN, async project => {
      const record = JSON.parse(await readFile(path.join(project, EXPLORATION), 'utf8'));
      record.exploration.target.baseDigest = '0'.repeat(64);
      await writeFile(path.join(project, EXPLORATION), `${JSON.stringify(record, null, 2)}\n`);
      const output = await migrateBlueprint({ project, dryRun: false });
      assert.ok(output.changes.some(line => line.includes('recomputed target.baseDigest')), output.changes.join('\n'));
      const bundle = await loadProjectFromFs(project);
      for (const exploration of bundle.explorations.explorations) {
        assert.equal(exploration.target.baseDigest, computeExplorationBaselineDigest(bundle, exploration.id));
      }
    });
  });
});

describe('digest order', () => {
  const PROGRAM = `
    import { stableStringify } from './src/core/exploration.ts';
    console.log(stableStringify({ z: 1, 'ä': 2, 'a-b': 3, aB: 4, Z: 5 }));
  `;

  function orderUnder(locale: string): string {
    return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', PROGRAM], {
      env: { ...process.env, LC_ALL: locale, LANG: locale },
      encoding: 'utf8'
    }).trim();
  }

  it('sorts keys by code unit, under each locale', () => {
    const expected = '{"Z":5,"a-b":3,"aB":4,"z":1,"ä":2}';
    assert.equal(orderUnder('en_US.UTF-8'), expected);
    assert.equal(orderUnder('sv_SE.UTF-8'), expected);
  });
});

describe('full-schema load', () => {
  const REFUSALS: Array<[string, string, (value: any) => void, string]> = [
    ['a missing field that a reader does not need', 'screens.json', value => { delete value.pages[0].description; },
      'screens.json: pages[0].description is missing. Fix: add pages[0].description as a JSON string: one line that says what it is and when to use it.'],
    ['an unknown field', 'tokens.json', value => { value.extra = 1; },
      'tokens.json: the file has the unknown field "extra". Fix: remove it from the file.'],
    ['a field that migrate fills', 'brand.json', value => { delete value.fonts; },
      'brand.json: fonts is missing. Fix: run the migrate tool, which fills fonts in brand.json from the font tokens and the @font-face rules.'],
    ['a value that is out of range', 'components.json', value => { value.components[0].platforms = []; },
      'components.json: components[0].platforms has fewer than 1 item. Fix: add items to components[0].platforms until it has 1 or more.'],
    ['flow in a saved screen', 'history/home-v1.json', value => { value.entry.screen.flow = 'web'; },
      'history/home-v1.json: entry.screen has the unknown field "flow". Fix: remove it from entry.screen.']
  ];

  for (const [name, file, edit, expected] of REFUSALS) {
    it(`refuses ${name}, with a Fix`, async () => {
      await withCopy(MERIDIAN, async project => {
        const value = JSON.parse(await readFile(path.join(project, file), 'utf8'));
        edit(value);
        await writeFile(path.join(project, file), `${JSON.stringify(value, null, 2)}\n`);
        await assert.rejects(loadProjectFromFs(project), (error: Error) => {
          for (const line of error.message.split('\n')) assert.match(line, /Fix: /);
          assert.ok(error.message.split('\n').some(line => line.startsWith(expected)), error.message);
          return true;
        });
      });
    });
  }

  it('keeps the raw object and its key order as the result', async () => {
    const bundle = await loadProjectFromFs(MERIDIAN);
    const raw = JSON.parse(await readFile(path.join(MERIDIAN, 'screens.json'), 'utf8'));
    assert.deepEqual(Object.keys(bundle.screens.screens[0]), Object.keys(raw.screens[0]));
  });

  it('migrate writes its repairs and reports the refusal when the result still cannot load', async () => {
    await withCopy(MERIDIAN, async project => {
      const screens = JSON.parse(await readFile(path.join(project, 'screens.json'), 'utf8'));
      delete screens.pages[0].description;
      screens.schemaVersion = '2.0.0';
      await writeFile(path.join(project, 'screens.json'), `${JSON.stringify(screens, null, 2)}\n`);
      const output = await migrateBlueprint({ project, dryRun: false });
      assert.equal(output.validation.ok, false);
      assert.ok(output.validation.errors.includes('screens.json: pages[0].description is missing. Fix: add pages[0].description as a JSON string: one line that says what it is and when to use it.'), output.validation.errors.join('\n'));
      assert.equal(JSON.parse(await readFile(path.join(project, 'screens.json'), 'utf8')).schemaVersion, BLUEPRINT_SCHEMA_VERSION);
    });
  });
});

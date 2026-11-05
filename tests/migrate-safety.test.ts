import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BLUEPRINT_SCHEMA_VERSION } from '../src/core/schema-version';
import { loadProjectFromFs } from '../src/core/load';
import { migrateProjectFiles } from '../src/core/migrate';
import { MIGRATIONS } from '../src/core/migrations';
import { rewriteScreenRecordBindings, type PlacementRemap } from '../src/core/placement-remap';
import { isSavedRecordFile } from '../src/core/storage-records';
import { toolErrorText } from '../src/mcp/create-server';
import { indexBlueprint, migrateBlueprint } from '../src/mcp/operations';

const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';
const frozenV1Root = 'tests/migrations/1.0.0-to-2.0.0/input';
const starterRoot = 'starter/design/blueprint';

type Json = Record<string, any>;

async function withCopy(run: (project: string, tempDir: string) => Promise<void>, source = meridianRoot): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-migrate-safety-'));
  try {
    const project = path.join(tempDir, 'design', 'blueprint');
    await cp(source, project, { recursive: true });
    await run(project, tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function editJson(project: string, file: string, edit: (value: Json) => void): Promise<void> {
  const target = path.join(project, file);
  const value = JSON.parse(await readFile(target, 'utf8')) as Json;
  edit(value);
  await writeFile(target, JSON.stringify(value, null, 2));
}

function textFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(json|html|css|md)$/.test(entry.name)) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.set(path.relative(root, full).split(path.sep).join('/'), readFileSync(full, 'utf8'));
  }
  return files;
}

function migrateFiles(files: Map<string, string>): ReturnType<typeof migrateProjectFiles> {
  return migrateProjectFiles({ files, starterFiles: textFiles(starterRoot) });
}

function firstRecord(project: string, directory: string): string {
  return `${directory}/${readdirSync(path.join(project, directory)).filter(name => name.endsWith('.json')).sort()[0]}`;
}

describe('migrate with a symlink in the project', () => {
  async function linkToShared(project: string, html: string): Promise<string> {
    const shared = path.join(project, 'prototype', 'shared', 'badge.html');
    await mkdir(path.dirname(shared), { recursive: true });
    const original = await readFile(path.join(project, html), 'utf8');
    await writeFile(shared, original.replace(/^(\s*<[a-z]+)/, '$1 data-blueprint-variant="neutral"'));
    await unlink(path.join(project, html));
    await symlink('../shared/badge.html', path.join(project, html));
    return shared;
  }

  it('writes nothing through a link on a dry run', async () => {
    await withCopy(async project => {
      const shared = await linkToShared(project, 'prototype/primitives/badge.html');
      const before = await readFile(shared, 'utf8');
      await migrateBlueprint({ project, dryRun: true });
      assert.equal(await readFile(shared, 'utf8'), before);
    });
  });

  it('leaves a file outside the project unchanged on a dry run and on a real run', async () => {
    await withCopy(async (project, tempDir) => {
      const outside = path.join(tempDir, 'outside-tokens.json');
      const tokens = JSON.parse(await readFile(path.join(project, 'tokens.json'), 'utf8')) as Json;
      tokens.tokenGroups[0].name = 'Color Tokens';
      const before = `${JSON.stringify(tokens, null, 2)}\n`;
      await writeFile(outside, before);
      await unlink(path.join(project, 'tokens.json'));
      await symlink(outside, path.join(project, 'tokens.json'));
      await migrateBlueprint({ project, dryRun: true }).catch(() => undefined);
      assert.equal(await readFile(outside, 'utf8'), before);
      await migrateBlueprint({ project, dryRun: false }).catch(() => undefined);
      assert.equal(await readFile(outside, 'utf8'), before);
    });
  });
});

describe('migrate with a symlink that loops', () => {
  it('refuses a project that needs writes, and the tool error names the repair', async () => {
    await withCopy(async project => {
      await editJson(project, 'tokens.json', value => {
        value.tokenGroups[0].name = 'Color Tokens';
      });
      await symlink('.', path.join(project, 'prototype', 'loop'));
      await assert.rejects(migrateBlueprint({ project, dryRun: true }), (error: Error) => {
        assert.match(toolErrorText(error), /Fix: remove the symbolic link that loops in /);
        return true;
      });
    });
  });

  it('leaves a project alone when it needs no writes', async () => {
    await withCopy(async project => {
      await symlink('.', path.join(project, 'prototype', 'loop'));
      const output = await migrateBlueprint({ project, dryRun: true });
      assert.equal(output.upToDate, true);
    });
  });
});

describe('a schemaVersion that is not a string', () => {
  const versions: unknown[] = [[BLUEPRINT_SCHEMA_VERSION], ['1.0.0'], ['99.0.0'], 2, true, {}];

  for (const version of versions) {
    for (const target of ['tokens.json', 'explorations', 'history']) {
      it(`every tool refuses ${JSON.stringify(version)} on ${target}, and no tool reads it as a version`, async () => {
        await withCopy(async project => {
          const file = target.endsWith('.json') ? target : firstRecord(project, target);
          await editJson(project, file, value => {
            value.schemaVersion = version;
          });
          await assert.rejects(indexBlueprint({ project }), (error: Error) => {
            assert.match(error.message, /Fix: /);
            assert.ok(error.message.includes(JSON.stringify(version)), error.message);
            return true;
          });
          await assert.rejects(migrateBlueprint({ project, dryRun: true }), (error: Error) => {
            assert.match(error.message, /Fix: /);
            assert.ok(error.message.includes(JSON.stringify(version)), error.message);
            return true;
          });
        });
      });
    }
  }
});

describe('migrate on a broken current file', () => {
  function removableFields(value: unknown, trail: Array<string | number> = []): Array<Array<string | number>> {
    if (Array.isArray(value)) return value.length > 0 ? [[...trail, 0], ...removableFields(value[0], [...trail, 0])] : [];
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value).flatMap(([key, child]) => [[...trail, key], ...removableFields(child, [...trail, key])]);
  }

  function withValue(value: unknown, trail: Array<string | number>, replacement: unknown): unknown {
    const copy = structuredClone(value) as Json;
    let cursor: Json = copy;
    for (const key of trail.slice(0, -1)) cursor = cursor[key];
    const last = trail.at(-1)!;
    if (replacement === undefined) delete cursor[last];
    else cursor[last] = replacement;
    return copy;
  }

  function assertNoRawCrash(files: Map<string, string>, label: string): void {
    try {
      migrateFiles(files);
    } catch (error) {
      assert.ok(!(error instanceof TypeError), `${label}: ${String(error)}`);
      assert.match((error as Error).message, /Fix: /, label);
    }
  }

  for (const file of ['primitives.json', 'components.json', 'screens.json', 'tokens.json']) {
    it(`ends each change to ${file} in a result or in an error with a Fix`, () => {
      const files = textFiles(meridianRoot);
      const parsed = JSON.parse(files.get(file)!) as Json;
      const seen = new Set<string>();
      for (const trail of removableFields(parsed)) {
        const shape = trail.map(key => (typeof key === 'number' ? '[]' : key)).join('.');
        if (shape === 'schemaVersion' || seen.has(shape)) continue;
        seen.add(shape);
        for (const replacement of [undefined, null, 1, 'x', [], {}, [null], ['x']]) {
          const broken = new Map(files);
          broken.set(file, JSON.stringify(withValue(parsed, trail, replacement)));
          assertNoRawCrash(broken, `${file} ${shape} = ${JSON.stringify(replacement)}`);
        }
      }
    });
  }

  it('names the field and its fix when an axis is missing', () => {
    const files = textFiles(meridianRoot);
    const parsed = JSON.parse(files.get('primitives.json')!) as Json;
    delete parsed.primitives[0].sizes;
    files.set('primitives.json', JSON.stringify(parsed));
    assert.throws(() => migrateFiles(files), /primitives\.json: primitives\[0\]\.sizes is missing\. Fix: /);
  });

  it('still upgrades a v1 project', () => {
    const output = migrateFiles(textFiles(frozenV1Root));
    assert.equal(output.fromVersion, '1.0.0');
    assert.ok(output.writes.has('primitives.json'));
  });
});

describe('the 1.0.0 to 2.0.0 step', () => {
  const step = MIGRATIONS.find(candidate => candidate.from === '1.0.0')!;

  it('keeps a field it does not know, so that validate reports the field and nothing is lost', () => {
    const files = textFiles(frozenV1Root);
    const primitives = JSON.parse(files.get('primitives.json')!) as Json;
    primitives.reviewerNote = 'top of primitives';
    primitives.primitives[0].ownerTeam = 'design';
    primitives.primitives[0].prototype.origin = 'import';
    files.set('primitives.json', JSON.stringify(primitives));
    const components = JSON.parse(files.get('components.json')!) as Json;
    components.reviewerNote = 'top of components';
    components.components[0].ownerTeam = 'design';
    components.components[0].prototype.origin = 'import';
    const groups = components.groups ?? components.sections;
    groups[0].ownerTeam = 'design';
    files.set('components.json', JSON.stringify(components));

    const output = step.run(files);
    const newPrimitives = JSON.parse(output.files.get('primitives.json')!) as Json;
    const newComponents = JSON.parse(output.files.get('components.json')!) as Json;
    assert.equal(newPrimitives.reviewerNote, 'top of primitives');
    assert.equal(newPrimitives.primitives[0].ownerTeam, 'design');
    assert.equal(newPrimitives.primitives[0].prototype.origin, 'import');
    assert.equal(newComponents.reviewerNote, 'top of components');
    assert.equal(newComponents.components[0].ownerTeam, 'design');
    assert.equal(newComponents.components[0].prototype.origin, 'import');
    assert.equal(newComponents.groups[0].ownerTeam, 'design');
  });

  it('adds no field to a project that holds only known fields', () => {
    const output = step.run(textFiles(frozenV1Root));
    const primitives = JSON.parse(output.files.get('primitives.json')!) as Json;
    assert.deepEqual(Object.keys(primitives), ['schemaVersion', 'projectId', 'primitives']);
    assert.equal('stateSets' in primitives.primitives[0], false);
    assert.equal('section' in (JSON.parse(output.files.get('components.json')!) as Json).components[0], false);
  });
});

describe('a section binding that a size move cannot place', () => {
  const remaps = new Map<string, PlacementRemap>([['primitive:button', { state: new Map(), variant: new Map([['compact', 'size']]) }]]);
  const record = (binding: Record<string, string>): Json => ({
    screens: [{ id: 'home', sections: [{ id: 'main', uses: [{ kind: 'primitive', id: 'button', binding }] }] }]
  });

  it('keeps the source value and reports the conflict', () => {
    const input = record({ variant: 'compact', size: 'lg' });
    const { count, conflicts } = rewriteScreenRecordBindings(input, remaps);
    assert.equal(count, 0);
    assert.deepEqual(input.screens[0].sections[0].uses[0].binding, { variant: 'compact', size: 'lg' });
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0], /button/);
    assert.match(conflicts[0], /Fix: /);
  });

  it('moves the value when the target axis is free', () => {
    const input = record({ variant: 'compact' });
    const { count, conflicts } = rewriteScreenRecordBindings(input, remaps);
    assert.equal(count, 1);
    assert.deepEqual(input.screens[0].sections[0].uses[0].binding, { size: 'compact' });
    assert.deepEqual(conflicts, []);
  });

  it('reports the conflict in the change list of migrate', () => {
    const files = textFiles(meridianRoot);
    const primitives = JSON.parse(files.get('primitives.json')!) as Json;
    const button = primitives.primitives.find((primitive: Json) => primitive.id === 'button');
    button.variants.values.push({ id: 'compact', name: 'Compact', description: 'A small button.' });
    files.set('primitives.json', JSON.stringify(primitives));
    const screens = JSON.parse(files.get('screens.json')!) as Json;
    const use = screens.screens
      .flatMap((screen: Json) => screen.sections)
      .flatMap((section: Json) => section.uses)
      .find((candidate: Json) => candidate.kind === 'primitive' && candidate.id === 'button');
    use.binding = { ...use.binding, variant: 'compact', size: 'lg' };
    files.set('screens.json', JSON.stringify(screens));
    const output = migrateFiles(files);
    assert.ok(output.changes.some(line => /button/.test(line) && /Fix: /.test(line)), output.changes.join('\n'));
  });
});

describe('a saved record with a hidden name', () => {
  it('is not a saved record', () => {
    assert.equal(isSavedRecordFile('explorations/.draft.json'), false);
    assert.equal(isSavedRecordFile('history/.home-v1.json'), false);
    assert.equal(isSavedRecordFile('explorations/draft.json'), true);
  });

  it('does not stop a tool, because migrate cannot see it', async () => {
    await withCopy(async project => {
      for (const directory of ['explorations', 'history']) {
        await writeFile(path.join(project, directory, '.hidden.json'), JSON.stringify({ schemaVersion: '1.0.0' }));
      }
      const bundle = await loadProjectFromFs(project);
      assert.ok(bundle.manifest.project.id);
      const output = await migrateBlueprint({ project, dryRun: true });
      assert.equal(output.fromVersion, BLUEPRINT_SCHEMA_VERSION);
    });
  });
});

describe('a field whose name is on Object.prototype', () => {
  it('survives a screen normalization', () => {
    const files = textFiles(meridianRoot);
    const raw = files.get('screens.json')!;
    const withFields = raw.replace('"screens": [\n    {', '"screens": [\n    {\n      "constructor": "kept",\n      "__proto__": "kept too",\n      "toString": "kept three",');
    assert.notEqual(withFields, raw);
    files.set('screens.json', withFields);
    const output = migrateFiles(files);
    const written = output.writes.get('screens.json') ?? withFields;
    const screen = (JSON.parse(written) as Json).screens[0] as Json;
    assert.equal(Object.getOwnPropertyDescriptor(screen, 'constructor')?.value, 'kept');
    assert.equal(Object.getOwnPropertyDescriptor(screen, '__proto__')?.value, 'kept too');
    assert.equal(Object.getOwnPropertyDescriptor(screen, 'toString')?.value, 'kept three');
  });
});

describe('load refuses a field that a reader or a Fix line needs', () => {
  const missingCases: Array<[string, (project: string) => string, (value: Json) => void, RegExp]> = [
    ['manifest project id', () => 'manifest.json', value => { delete value.project.id; }, /manifest\.json: project\.id is missing\. Fix: /],
    ['exploration id', project => firstRecord(project, 'explorations'), value => { delete value.exploration.id; }, /exploration\.id is missing\. Fix: /],
    ['history screen id', project => firstRecord(project, 'history'), value => { delete value.entry.screenId; }, /entry\.screenId is missing\. Fix: /],
    ['history version', project => firstRecord(project, 'history'), value => { delete value.entry.version; }, /entry\.version is missing\. Fix: /]
  ];

  for (const [label, target, edit, expected] of missingCases) {
    it(`names the field when the ${label} is missing, and does not offer a rename to undefined`, async () => {
      await withCopy(async project => {
        await editJson(project, target(project), edit);
        await assert.rejects(loadProjectFromFs(project), (error: Error) => {
          assert.match(error.message, expected);
          assert.doesNotMatch(error.message, /undefined/);
          return true;
        });
      });
    });
  }

  for (const name of ['constructor', '__proto__', 'toString']) {
    it(`refuses a prototype ref named ${name}, with a Fix`, async () => {
      await withCopy(async project => {
        await editJson(project, 'primitives.json', value => {
          value.primitives[0].prototype.source = name;
        });
        await assert.rejects(loadProjectFromFs(project), (error: Error) => {
          assert.ok(!(error instanceof TypeError), error.message);
          assert.match(error.message, new RegExp(`"${name}".*Fix: `));
          return true;
        });
      });
    });
  }
});

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MIGRATABLE_SCHEMA_VERSIONS, MIGRATIONS, OLDEST_SCHEMA_VERSION, stepsFrom } from '../src/core/migrations';
import type { MigrationStep } from '../src/core/migrations/step';
import { BLUEPRINT_SCHEMA_VERSION } from '../src/core/schema-version';

const frozenRoot = 'tests/migrations';
const starterRoot = 'starter/design/blueprint';

function chainErrors(steps: ReadonlyArray<Pick<MigrationStep, 'from' | 'to'>>, current: string): string[] {
  const errors: string[] = [];
  if (steps.at(-1)?.to !== current) {
    errors.push(`BLUEPRINT_SCHEMA_VERSION is "${current}", and no last chain step reaches it. Fix: add a step that ends on it to MIGRATIONS in src/core/migrations/index.ts.`);
  }
  steps.forEach((step, index) => {
    const next = steps[index + 1];
    if (next && next.from !== step.to) {
      errors.push(`The step ${step.from} to ${step.to} ends where no step starts: the next step starts on ${next.from}. Fix: make each "to" the next "from".`);
    }
    let reached = step.to;
    const seen = new Set([step.from]);
    while (reached !== current && !seen.has(reached)) {
      seen.add(reached);
      const onward = steps.find(candidate => candidate.from === reached);
      if (!onward) break;
      reached = onward.to;
    }
    if (reached !== current) {
      errors.push(`The chain from ${step.from} stops at ${reached} and does not reach ${current}. Fix: add the missing step.`);
    }
  });
  return errors;
}

function frozenFixtureErrors(steps: ReadonlyArray<Pick<MigrationStep, 'from' | 'to'>>, root: string): string[] {
  const errors: string[] = [];
  for (const { from, to } of steps) {
    const folder = path.join(root, `${from}-to-${to}`);
    for (const [part, version] of [['input', from], ['expected', to]] as const) {
      const manifest = path.join(folder, part, 'manifest.json');
      if (!existsSync(manifest)) {
        errors.push(`${manifest} does not exist. Fix: freeze a real project on ${from} under ${folder}/input, and the output of the step under ${folder}/expected.`);
      } else if (JSON.parse(readFileSync(manifest, 'utf8')).schemaVersion !== version) {
        errors.push(`${manifest} is not on schema ${version}. Fix: freeze the file set of that schema there.`);
      }
    }
  }
  return errors;
}

function textFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(json|html|css|md)$/.test(entry.name)) files.set(path.relative(root, full).split(path.sep).join('/'), readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return files;
}

function schemaVersionConstants(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaVersionConstants);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const constant = key === 'schemaVersion' ? (child as { const?: string }).const : undefined;
    return [...(constant === undefined ? [] : [constant]), ...schemaVersionConstants(child)];
  });
}

describe('migration chain', () => {
  it('ends on the current schema, with each "to" the next "from"', () => {
    assert.deepEqual(chainErrors(MIGRATIONS, BLUEPRINT_SCHEMA_VERSION), []);
  });

  it('reports a schema with no step, a gap, and a dead end', () => {
    const one = { from: '1.0.0', to: '2.0.0' };
    const two = { from: '2.0.0', to: '3.0.0' };
    assert.match(chainErrors([one], '3.0.0')[0], /no last chain step reaches it/);
    assert.match(chainErrors([], '3.0.0')[0], /no last chain step reaches it/);
    assert.ok(chainErrors([one, { from: '2.5.0', to: '3.0.0' }], '3.0.0').some(error => /ends where no step starts/.test(error)));
    assert.ok(chainErrors([one, { from: '2.5.0', to: '3.0.0' }], '3.0.0').some(error => /chain from 1\.0\.0 stops at 2\.0\.0/.test(error)));
    assert.ok(chainErrors([two, one], '2.0.0').some(error => /ends where no step starts/.test(error)));
    assert.deepEqual(chainErrors([one, two], '3.0.0'), []);
  });

  it('derives the versions migrate reads from the chain', () => {
    assert.deepEqual([...MIGRATABLE_SCHEMA_VERSIONS], [...MIGRATIONS.map(step => step.from), BLUEPRINT_SCHEMA_VERSION]);
    assert.equal(OLDEST_SCHEMA_VERSION, MIGRATIONS[0].from);
  });

  it('walks every remaining step from a version, and none from the current schema', () => {
    assert.deepEqual(stepsFrom(OLDEST_SCHEMA_VERSION), MIGRATIONS);
    assert.deepEqual(stepsFrom(BLUEPRINT_SCHEMA_VERSION), []);
    assert.deepEqual(stepsFrom('0.0.1'), []);
  });

  it('holds a frozen input and golden for each step, and no folder without a step', () => {
    assert.deepEqual(frozenFixtureErrors(MIGRATIONS, frozenRoot), []);
    assert.match(frozenFixtureErrors([{ from: '3.0.0', to: '4.0.0' }], frozenRoot).join('\n'), /3\.0\.0-to-4\.0\.0\/input\/manifest\.json does not exist\. Fix: freeze/);
    assert.deepEqual(
      readdirSync(frozenRoot).filter(name => !name.startsWith('.')).sort(),
      MIGRATIONS.map(step => `${step.from}-to-${step.to}`).sort()
    );
  });

  for (const step of MIGRATIONS) {
    describe(`step ${step.from} to ${step.to}`, () => {
      const folder = path.join(frozenRoot, `${step.from}-to-${step.to}`);

      it('gives the golden bytes on the frozen project', () => {
        const output = step.run(textFiles(path.join(folder, 'input'))).files;
        const golden = textFiles(path.join(folder, 'expected'));
        assert.deepEqual([...output.keys()].sort(), [...golden.keys()].sort());
        const different = [...golden.keys()].filter(file => output.get(file) !== golden.get(file));
        assert.deepEqual(different, [], 'Fix: restore the step, because a released step does not change. Do not regenerate the golden.');
      });

      it('leaves its input as it was, and gives the same output twice', () => {
        const input = textFiles(path.join(folder, 'input'));
        const before = new Map(input);
        const first = step.run(input);
        assert.deepEqual(input, before);
        assert.deepEqual(step.run(input), first);
      });

      it('has nothing left to do on its own golden', () => {
        const golden = textFiles(path.join(folder, 'expected'));
        const result = step.run(golden);
        assert.deepEqual(result.files, golden);
        assert.deepEqual(result.changes, []);
        assert.deepEqual(result.stamped, { files: [], records: [] });
      });
    });
  }
});

function holdsVersionLiteral(source: string, version: string): boolean {
  return ["'", '"', '`'].some(quote => source.includes(`${quote}${version}${quote}`));
}

describe('one schema version', () => {
  it('finds a version literal in each quote form', () => {
    for (const source of ["const a = '2.0.0';", 'const a = "2.0.0";', 'const a = `2.0.0`;']) assert.equal(holdsVersionLiteral(source, '2.0.0'), true, source);
    assert.equal(holdsVersionLiteral('const a = "12.0.0";', '2.0.0'), false);
  });


  it('holds in every schemaVersion constant of the JSON schema', () => {
    const constants = schemaVersionConstants(JSON.parse(readFileSync('schema/blueprint-project.schema.json', 'utf8')));
    assert.ok(constants.length > 0);
    assert.deepEqual([...new Set(constants)], [BLUEPRINT_SCHEMA_VERSION]);
  });

  it('holds in the version line of the starter AGENTS.md', () => {
    const agents = readFileSync(path.join(starterRoot, 'AGENTS.md'), 'utf8');
    const lines = [...agents.matchAll(/"schemaVersion": "([^"]*)"/g)].map(match => match[1]);
    assert.ok(lines.length > 0);
    assert.deepEqual([...new Set(lines)], [BLUEPRINT_SCHEMA_VERSION]);
  });

  it('holds in each structured file of the starter and the fixtures', () => {
    const roots = [
      starterRoot,
      ...readdirSync('fixtures/valid').map(name => path.join('fixtures/valid', name, 'design/blueprint')),
      ...readdirSync('fixtures/invalid').map(name => path.join('fixtures/invalid', name, 'design/blueprint'))
    ];
    const wrong: string[] = [];
    let checked = 0;
    for (const root of roots) {
      for (const [file, text] of textFiles(root)) {
        if (!file.endsWith('.json')) continue;
        const parsed = JSON.parse(text) as { schemaVersion?: unknown };
        if (!('schemaVersion' in parsed)) continue;
        checked += 1;
        if (parsed.schemaVersion !== BLUEPRINT_SCHEMA_VERSION) wrong.push(`${root}/${file}: ${String(parsed.schemaVersion)}`);
      }
    }
    assert.ok(checked > 0);
    assert.deepEqual(wrong, []);
  });

  it('is written in source only by schema-version.ts and the chain steps', () => {
    const repeats: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && holdsVersionLiteral(readFileSync(full, 'utf8'), BLUEPRINT_SCHEMA_VERSION)) repeats.push(full);
      }
    };
    walk('src');
    assert.deepEqual(repeats.filter(file => file !== path.join('src/core/schema-version.ts') && !file.startsWith(path.join('src/core/migrations') + path.sep)), []);
  });
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { createExplorationMetadata } from '../src/core/exploration';
import { loadProjectFromFs } from '../src/core/load';
import { migrateProjectFiles } from '../src/core/migrate';
import { collectNamingErrors, ID_LENGTH_CAP } from '../src/core/naming-rules';
import { BLUEPRINT_SCHEMA_VERSION } from '../src/core/schema-version';
import type { BlueprintProjectBundle } from '../src/core/types';
import { inspoInputSchema } from '../src/mcp/schemas';
import { validateProject } from '../src/prototype/validate-project';

const MERIDIAN = 'fixtures/valid/meridian-finance/design/blueprint';
const STARTER = 'starter/design/blueprint';

async function namingErrors(root: string, edit: (bundle: BlueprintProjectBundle) => void): Promise<string[]> {
  const bundle = structuredClone(await loadProjectFromFs(root));
  edit(bundle);
  return collectNamingErrors(bundle);
}

function screenOf(bundle: BlueprintProjectBundle, id: string) {
  return bundle.screens.screens.find(screen => screen.id === id)!;
}

describe('a screen id with a version suffix', () => {
  const cases: Array<[string, string, number | undefined, RegExp | undefined]> = [
    ['equals the version field, 2 or greater', 'overview-v2', 2, undefined],
    ['equals a greater version field', 'overview-v12', 12, undefined],
    ['differs from the version field', 'overview-v3', 2, /screen\.overview-v3 id holds the version word "v3"/],
    ['has no version field', 'overview-v2', undefined, /screen\.overview-v2 id holds the version word "v2"/],
    ['is version 1', 'overview-v1', 1, /screen\.overview-v1 id holds the version word "v1"/],
    ['stands in the middle', 'v2-overview', 2, /screen\.v2-overview id holds the version word "v2"/]
  ];
  for (const [name, id, version, expected] of cases) {
    it(`${expected ? 'fails' : 'passes'} when it ${name}`, async () => {
      const errors = await namingErrors(MERIDIAN, bundle => {
        const screen = screenOf(bundle, 'overview-v2');
        screen.id = id;
        if (version === undefined) delete screen.version;
        else screen.version = version;
      });
      if (expected) assert.ok(errors.some(error => expected.test(error)), errors.join('\n'));
      else assert.deepEqual(errors, []);
    });
  }

  it('still checks the words before the suffix', async () => {
    const errors = await namingErrors(MERIDIAN, bundle => {
      const screen = screenOf(bundle, 'overview-v2');
      screen.id = 'thing-v2';
    });
    assert.ok(errors.includes('screen.thing-v2 id holds the placeholder word "thing". Fix: rename it with a word that says what it is.'), errors.join('\n'));
  });
});

describe('the classes that each naming rule reads', () => {
  it('reads a section, an active exploration, and its candidate', async () => {
    const errors = await namingErrors(MERIDIAN, bundle => {
      bundle.screens.screens[0]!.sections[0]!.id = 'section-1';
      const active = bundle.explorations.explorations.find(exploration => exploration.lifecycle === 'active')!;
      active.id = 'home-old';
      active.candidates[0]!.id = 'option-1';
    });
    assert.ok(errors.some(error => error.includes('section.section-1 id ends in a number')), errors.join('\n'));
    assert.ok(errors.some(error => error.includes('exploration.home-old id holds the version word "old"')), errors.join('\n'));
    assert.ok(errors.some(error => error.includes('candidate.option-1 id ends in a number')), errors.join('\n'));
  });

  it('keeps the id of an exploration that is not active, because the id names its stored files', async () => {
    const errors = await namingErrors(MERIDIAN, bundle => {
      const active = bundle.explorations.explorations[0]!;
      active.lifecycle = 'archived';
      active.id = `old-${'x'.repeat(ID_LENGTH_CAP)}-2`;
    });
    assert.deepEqual(errors, []);
  });

  it('keeps a number and a placeholder word in an axis value, a slot, and a state', async () => {
    const errors = await namingErrors(STARTER, bundle => {
      const component = bundle.components.components[0]!;
      component.variants = { default: 'new', values: [{ id: 'new', name: 'New', description: 'A badge.' }, { id: 'level-1', name: 'Level', description: 'A level.' }] };
      component.slots[0]!.id = 'item-1';
    });
    assert.deepEqual(errors, []);
  });

  it('caps the length of an axis value and a state, and reads kebab-case on a state, a condition, and a mark', async () => {
    const long = 'x'.repeat(ID_LENGTH_CAP + 1);
    const errors = await namingErrors(MERIDIAN, bundle => {
      bundle.components.components.find(component => component.slots.length > 0)!.slots[0]!.id = long;
      const home = screenOf(bundle, 'home');
      home.prototype.states = ['Bad_State'];
      home.prototype.reviewConditions[0]!.id = 'Bad Condition';
      bundle.brand!.marks[0]!.id = 'BadMark';
    });
    assert.ok(errors.some(error => error.includes(`slots.${long} id is 37 characters`)), errors.join('\n'));
    assert.ok(errors.includes('screen.home.state.Bad_State id "Bad_State" is not kebab-case. Fix: rename it to "bad-state", in its declaration and in each place that names it.'), errors.join('\n'));
    assert.ok(errors.some(error => error.includes('reviewCondition.Bad Condition id "Bad Condition" is not kebab-case')), errors.join('\n'));
    assert.ok(errors.some(error => error.includes('brand.mark.BadMark id "BadMark" is not kebab-case')), errors.join('\n'));
  });

  it('compares a name without case, and treats no version as version 1', async () => {
    const errors = await namingErrors(MERIDIAN, bundle => {
      const [first, second] = [screenOf(bundle, 'home'), screenOf(bundle, 'transfer')];
      second.name = first.name.toUpperCase();
      first.version = 1;
      delete second.version;
    });
    assert.ok(errors.some(error => /^screen\.(home|transfer) has the name/.test(error) && error.includes('and version 1')), errors.join('\n'));
  });

  it('accepts two versions of a shared name', async () => {
    const bundle = await loadProjectFromFs(MERIDIAN);
    assert.equal(screenOf(bundle, 'overview').name, screenOf(bundle, 'overview-v2').name);
    assert.deepEqual(collectNamingErrors(bundle), []);
  });
});

describe('Blueprint makes no numbered id', () => {
  const create = (overrides: Record<string, unknown>) => ({
    screenId: 'home',
    state: 'default',
    framePresetId: 'phone',
    title: 'Hero order',
    intent: 'Compare the order of the hero.',
    candidateLabels: ['Calm', 'Bold'],
    ...overrides
  });

  async function miniBundle(): Promise<BlueprintProjectBundle> {
    const bundle = await loadProjectFromFs(MERIDIAN);
    bundle.explorations.explorations = bundle.explorations.explorations.filter(exploration => exploration.target.screenId !== 'home');
    return bundle;
  }

  it('refuses a title that gives an id in use, with a Fix', async () => {
    const bundle = await miniBundle();
    const created = createExplorationMetadata(bundle, create({}));
    created.exploration.lifecycle = 'archived';
    bundle.explorations.explorations.push(created.exploration);
    assert.throws(
      () => createExplorationMetadata(bundle, create({})),
      /Exploration id "home-hero-order" already exists\. Fix: pass another descriptive title, or pass id\./
    );
    assert.equal(createExplorationMetadata(bundle, create({ title: 'Hero spacing' })).exploration.id, 'home-hero-spacing');
  });

  it('refuses an id in use that the agent passes, with a Fix', async () => {
    const bundle = await miniBundle();
    const taken = bundle.explorations.explorations[0]!.id;
    assert.throws(() => createExplorationMetadata(bundle, create({ id: taken })), new RegExp(`Exploration id "${taken}" already exists\\. Fix: pass another descriptive id\\.`));
  });

  it('refuses two labels that give the same id, with a Fix', async () => {
    const bundle = await miniBundle();
    assert.throws(
      () => createExplorationMetadata(bundle, create({ candidateLabels: ['Calm!', 'Calm?'] })),
      /Candidate id "calm" already exists\. Fix: pass another descriptive candidate label\./
    );
  });

  it('makes no hash and no number from a name without a letter', async () => {
    const bundle = await miniBundle();
    assert.throws(() => createExplorationMetadata(bundle, create({ candidateLabels: ['!!', 'Bold'] })), /Candidate label "!!" has no letter or digit.*Fix: pass a name/);
    assert.throws(() => createExplorationMetadata(bundle, create({ title: '!!' })), /Exploration title "!!" has no letter or digit.*Fix: pass a name/);
  });

  it('refuses a title that gives an id over the limit, with a Fix', async () => {
    const bundle = await miniBundle();
    assert.throws(() => createExplorationMetadata(bundle, create({ title: 'A very long title that goes on past the limit' })), /over the limit of 36\. Fix: pass a shorter title, or pass id\./);
    assert.throws(() => createExplorationMetadata(bundle, create({ candidateLabels: ['A very long label that goes on past the limit', 'Bold'] })), /over the limit of 36\. Fix: pass a shorter candidate label\./);
  });

  it('requires an id when the agent adds an inspo entry', () => {
    const missing = inspoInputSchema.safeParse({ project: '/tmp/app/design/blueprint', operation: { type: 'add', url: 'https://images.example.com/a.png' } });
    const passed = inspoInputSchema.safeParse({ project: '/tmp/app/design/blueprint', operation: { type: 'add', id: 'warm-paper-ground', url: 'https://images.example.com/a.png' } });
    assert.equal(missing.success, false);
    assert.equal(passed.success, true);
  });
});

function reusableProject(component: Record<string, unknown>, extra: Record<string, string> = {}, primitives: unknown[] = []): Map<string, string> {
  const version = BLUEPRINT_SCHEMA_VERSION;
  const base: Record<string, unknown> = {
    'manifest.json': { schemaVersion: version, project: { id: 'demo', name: 'Demo' } },
    'tokens.json': { schemaVersion: version, projectId: 'demo', tokenGroups: [] },
    'screens.json': { schemaVersion: version, projectId: 'demo', pages: [], screens: [] },
    'primitives.json': { schemaVersion: version, projectId: 'demo', primitives },
    'components.json': { schemaVersion: version, projectId: 'demo', groups: [], components: [component] }
  };
  return new Map([...Object.entries(base).map(([file, value]) => [file, JSON.stringify(value)] as [string, string]), ...Object.entries(extra)]);
}

const AXIS = (id: string) => ({ default: id, values: [{ id, name: id, description: 'The only one.' }] });

function reusable(id: string, axes: Record<string, unknown>, styles: string[] = [`prototype/components/${id}.css`]): Record<string, unknown> {
  return {
    id,
    name: id,
    uses: [],
    slots: [],
    unsupported: [],
    tokenGroupIds: [],
    tokenRoles: {},
    styleRefs: [],
    variants: AXIS('default'),
    sizes: AXIS('default'),
    states: AXIS('default'),
    prototype: { source: `prototype/components/${id}.html`, styles, localValueExceptions: [] },
    ...axes
  };
}

describe('migrate renames the only value of an axis', () => {
  async function run(files: Map<string, string>) {
    const starterFiles = new Map([['primitives.json', await readFile(`${STARTER}/primitives.json`, 'utf8')]]);
    const primitives = JSON.parse(files.get('primitives.json')!);
    primitives.primitives = JSON.parse(starterFiles.get('primitives.json')!).primitives;
    files.set('primitives.json', JSON.stringify(primitives));
    for (const primitive of primitives.primitives) {
      for (const file of [primitive.prototype.source, ...primitive.prototype.styles]) files.set(file, await readFile(`${STARTER}/${file}`, 'utf8'));
    }
    files.set('tokens.json', await readFile(`${STARTER}/tokens.json`, 'utf8'));
    const output = migrateProjectFiles({ files, starterFiles });
    return { output, text: (file: string) => output.writes.get(file) ?? files.get(file)! };
  }

  it('rewrites the declaration, a placement, a compounded selector, its own sheet, a binding, and an unsupported line', async () => {
    const component = reusable('tier', { states: AXIS('normal'), variants: AXIS('main'), unsupported: [{ axis: 'variant', value: 'main', state: 'normal', reason: 'Not drawn.' }] });
    const { output, text } = await run(reusableProject(component, {
      'prototype/components/tier.html': '<div data-blueprint-component="tier"></div>',
      'prototype/components/tier.css': '[data-blueprint-component="tier"][data-blueprint-state="normal"] { color: inherit }\n.tier__a[data-blueprint-variant=\'main\'] { color: inherit }',
      'prototype/screens/home.html': '<main data-blueprint-screen="home"><blueprint-use kind="component" ref="tier" state="normal" variant="main"></blueprint-use><blueprint-use kind="component" ref="other" state="normal"></blueprint-use></main>',
      'prototype/screens/home.css': '[data-blueprint-screen="home"] [data-blueprint-component="tier"][data-blueprint-state="normal"] { color: inherit }\n[data-blueprint-screen="home"][data-blueprint-state="normal"] { color: inherit }',
      'history/home-v1.json': JSON.stringify({ schemaVersion: BLUEPRINT_SCHEMA_VERSION, entry: { screen: { id: 'home', sections: [{ id: 'a', uses: [{ kind: 'component', id: 'tier', reason: 'x', binding: { state: 'normal', variant: 'main', size: 'lg' } }] }] } } })
    }));
    const declared = JSON.parse(text('components.json')).components[0];
    assert.deepEqual(declared.states, { default: 'default', values: [{ id: 'default', name: 'Default', description: 'The only one.' }] });
    assert.equal(declared.variants.default, 'default');
    assert.deepEqual(declared.unsupported, [{ axis: 'variant', value: 'default', state: 'default', reason: 'Not drawn.' }]);
    assert.equal(text('prototype/components/tier.css'), '[data-blueprint-component="tier"][data-blueprint-state="default"] { color: inherit }\n.tier__a[data-blueprint-variant=\'default\'] { color: inherit }');
    assert.equal(text('prototype/screens/home.html'), '<main data-blueprint-screen="home"><blueprint-use kind="component" ref="tier" state="default" variant="default"></blueprint-use><blueprint-use kind="component" ref="other" state="normal"></blueprint-use></main>');
    assert.equal(text('prototype/screens/home.css'), '[data-blueprint-screen="home"] [data-blueprint-component="tier"][data-blueprint-state="default"] { color: inherit }\n[data-blueprint-screen="home"][data-blueprint-state="normal"] { color: inherit }');
    assert.deepEqual(JSON.parse(text('history/home-v1.json')).entry.screen.sections[0].uses[0].binding, { state: 'default', variant: 'default', size: 'lg' });
    assert.ok(output.changes.some(line => line.startsWith('Renamed the only value of 2 axes to "default", and rewrote 2 placements: component tier variant main, component tier state normal')), output.changes.join('\n'));
  });

  it('leaves the value when a loose selector in another sheet can mean this reusable', async () => {
    const { output, text } = await run(reusableProject(reusable('tier', { states: AXIS('normal') }), {
      'prototype/components/tier.html': '<div data-blueprint-component="tier"></div>',
      'prototype/components/tier.css': '[data-blueprint-component="tier"][data-blueprint-state="normal"] { color: inherit }',
      'prototype/screens/home.css': '.home__tile[data-blueprint-state="normal"] { color: inherit }'
    }));
    assert.equal(JSON.parse(text('components.json')).components[0].states.default, 'normal');
    assert.equal(text('prototype/components/tier.css'), '[data-blueprint-component="tier"][data-blueprint-state="normal"] { color: inherit }');
    assert.equal(output.changes.some(line => line.startsWith('Renamed the only value')), false);
  });

  it('leaves the value when two reusables share a sheet that holds a loose selector', async () => {
    const shared = 'prototype/components/shared.css';
    const { text } = await run(reusableProject(reusable('tier', { states: AXIS('normal') }, [shared]), {
      'prototype/components/tier.html': '<div data-blueprint-component="tier"></div>',
      'prototype/components/other.html': '<div data-blueprint-component="other"></div>',
      [shared]: '.a[data-blueprint-state="normal"] { color: inherit }'
    }));
    const components = JSON.parse(text('components.json')).components;
    assert.equal(components[0].states.default, 'default', 'One owner reads the sheet as its own.');
    const withSecond = reusableProject(reusable('tier', { states: AXIS('normal') }, [shared]), {
      'prototype/components/tier.html': '<div data-blueprint-component="tier"></div>',
      'prototype/components/other.html': '<div data-blueprint-component="other"></div>',
      [shared]: '.a[data-blueprint-state="normal"] { color: inherit }'
    });
    const file = JSON.parse(withSecond.get('components.json')!);
    file.components.push(reusable('other', {}, [shared]));
    withSecond.set('components.json', JSON.stringify(file));
    const second = await run(withSecond);
    assert.equal(JSON.parse(second.text('components.json')).components[0].states.default, 'normal');
  });

  it('leaves an axis with two values and an axis already on default', async () => {
    const component = reusable('tier', { variants: { default: 'a', values: [{ id: 'a', name: 'A', description: 'A.' }, { id: 'b', name: 'B', description: 'B.' }] } });
    const { output } = await run(reusableProject(component, { 'prototype/components/tier.html': '<div data-blueprint-component="tier"></div>', 'prototype/components/tier.css': '' }));
    assert.equal(output.changes.some(line => line.startsWith('Renamed the only value')), false);
  });

  it('gives a project that validate passes after the rename', async () => {
    const bundle = await loadProjectFromFs(MERIDIAN);
    assert.deepEqual(validateProject(bundle).errors, []);
    assert.equal(bundle.primitives.primitives.find(primitive => primitive.id === 'row-layout')!.variants.default, 'default');
  });
});

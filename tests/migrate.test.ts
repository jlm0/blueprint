import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BLUEPRINT_SCHEMA_VERSION } from '../src/core/schema-version';
import { BASE_PRIMITIVE_TEXT } from '../src/core/base-primitive-text';
import { migrateProjectFiles, type MigrationInput } from '../src/core/migrate';
import type { BlueprintManifest, ComponentFile, PrimitiveFile, ScreenFile, TokenFile } from '../src/core/types';

const starterRoot = 'starter/design/blueprint';
const fixtureRoots = ['mira-ai', 'umbra-gaming', 'meridian-finance'].map(id => `fixtures/valid/${id}/design/blueprint`);

describe('Blueprint migrate', () => {
  it('restores a missing base primitive and its prototype files from the starter', async () => {
    const input = await migrationInput(fixtureRoots[0]);
    input.starterFiles = await textFiles(starterRoot);
    const primitives = JSON.parse(input.files.get('primitives.json')!) as PrimitiveFile;
    input.files.set('primitives.json', JSON.stringify({
      ...primitives,
      primitives: primitives.primitives.filter(primitive => primitive.id !== 'switch' && primitive.id !== 'table-row')
    }));
    input.files.delete('prototype/primitives/switch.html');
    input.files.delete('prototype/primitives/switch.css');
    input.files.delete('prototype/primitives/table-row.html');
    input.files.set('prototype/primitives/table-row.css', '/* the app kept this file */');

    const output = migrateProjectFiles(input);

    const starter = JSON.parse(input.starterFiles.get('primitives.json')!) as PrimitiveFile;
    const migrated = (JSON.parse(output.writes.get('primitives.json')!) as PrimitiveFile).primitives;
    for (const id of ['switch', 'table-row']) {
      assert.deepEqual(migrated.find(primitive => primitive.id === id), starter.primitives.find(primitive => primitive.id === id));
    }
    assert.equal(output.writes.get('prototype/primitives/switch.html'), input.starterFiles.get('prototype/primitives/switch.html'));
    assert.equal(output.writes.get('prototype/primitives/switch.css'), input.starterFiles.get('prototype/primitives/switch.css'));
    assert.equal(output.writes.get('prototype/primitives/table-row.html'), input.starterFiles.get('prototype/primitives/table-row.html'));
    assert.equal(output.writes.has('prototype/primitives/table-row.css'), false);
    assert.deepEqual(output.changes.filter(change => change !== 'AGENTS.md: replaced with the current starter copy.'), ['primitives.json: restored 2 missing Blueprint primitives from the starter, with the prototype files: "switch", "table-row".']);

    for (const [file, content] of output.writes) input.files.set(file, content);
    assert.equal(migrateProjectFiles(input).upToDate, true, 'a second run has nothing left to do');
  });

  it('leaves out a missing base primitive that names a token the project lacks, until the project declares it', async () => {
    const input = await migrationInput(fixtureRoots[0]);
    input.starterFiles = await textFiles(starterRoot);
    const primitives = JSON.parse(input.files.get('primitives.json')!) as PrimitiveFile;
    input.files.set('primitives.json', JSON.stringify({ ...primitives, primitives: primitives.primitives.filter(primitive => primitive.id !== 'tooltip') }));
    input.files.delete('prototype/primitives/tooltip.html');
    input.files.delete('prototype/primitives/tooltip.css');
    const tokens = JSON.parse(input.files.get('tokens.json')!) as TokenFile;
    const shape = tokens.tokenGroups.find(group => group.id === 'shape')!;
    const shadow = shape.tokens.find(token => token.id === 'shadow-md')!;
    shape.tokens = shape.tokens.filter(token => token !== shadow);
    input.files.set('tokens.json', JSON.stringify(tokens));

    const refused = migrateProjectFiles(input);
    assert.ok(refused.changes.includes('primitives.json: left out the missing Blueprint primitive "tooltip", because tokens.json does not declare "shape.shadow-md". Fix: add them, then run migrate again.'), refused.changes.join('\n'));
    assert.equal(refused.writes.has('primitives.json'), false);
    assert.equal(refused.writes.has('prototype/primitives/tooltip.html'), false);

    shape.tokens.push(shadow);
    input.files.set('tokens.json', JSON.stringify(tokens));
    const restored = migrateProjectFiles(input);
    assert.ok(restored.changes.some(change => change.startsWith('primitives.json: restored 1 missing Blueprint primitive from the starter')), restored.changes.join('\n'));
    assert.equal(restored.writes.get('prototype/primitives/tooltip.css'), input.starterFiles.get('prototype/primitives/tooltip.css'));
  });

  it('leaves a current project untouched', async () => {
    for (const root of [starterRoot, ...fixtureRoots]) {
      const output = migrateProjectFiles(await migrationInput(root));
      assert.deepEqual(output.changes, [], `${root} should need no changes`);
      assert.equal(output.upToDate, true);
      assert.equal(output.writes.size, 0);
    }
  });

  it('restores Blueprint primitive text, drops retired starter notes, and keeps app notes as hints', async () => {
    const input = await migrationInput(fixtureRoots[0]);
    const primitives = JSON.parse(input.files.get('primitives.json')!) as PrimitiveFile;
    const button = primitives.primitives.find(primitive => primitive.id === 'button')!;
    button.description = 'Our checkout button.';
    button.variants.values[0].name = 'Main';
    button.notes = [
      'Apps should replace token values and variant naming only when their design system requires it; do not recreate one-off buttons per screen.',
      'Keep the checkout button sticky on phones.'
    ];
    button.implementationHints = ['Hover: Apply on pointer hover only; touch platforms skip it.'];
    input.files.set('primitives.json', JSON.stringify(primitives));

    const output = migrateProjectFiles(input);
    const migrated = (JSON.parse(output.writes.get('primitives.json')!) as PrimitiveFile).primitives.find(primitive => primitive.id === 'button')!;
    assert.equal(migrated.description, BASE_PRIMITIVE_TEXT.button.description);
    assert.equal(migrated.variants.values[0].name, BASE_PRIMITIVE_TEXT.button.variants.primary.name);
    assert.deepEqual(migrated.notes, BASE_PRIMITIVE_TEXT.button.notes);
    assert.deepEqual(migrated.implementationHints, [
      'Hover: Apply it on pointer hover only. Touch platforms skip it.',
      'Keep the checkout button sticky on phones.'
    ]);
    assert.ok(output.changes.some(change => change.startsWith("primitives.json: 1 primitive now carry Blueprint's description")), output.changes.join('\n'));
    assert.ok(output.changes.includes('primitives.json: moved 1 app note on Blueprint primitives to implementationHints.'), output.changes.join('\n'));

    for (const [file, content] of output.writes) input.files.set(file, content);
    assert.equal(migrateProjectFiles(input).upToDate, true, 'a second run has nothing left to do');
  });

  it('keeps the state a v1 source root rendered as the default', async () => {
    const input = await migrationInput(fixtureRoots[2]);
    const components = JSON.parse(input.files.get('components.json')!) as ComponentFile & Record<string, unknown>;
    const v1 = {
      schemaVersion: '1.0.0',
      projectId: components.projectId,
      sections: components.groups,
      components: [
        ...components.components,
        {
          id: 'tier-card',
          name: 'Tier card',
          description: 'A membership tier with its price.',
          section: components.groups[0].id,
          uses: [{ kind: 'primitive', id: 'text', reason: 'The tier name.' }],
          tokenGroupIds: ['color'],
          prototype: { source: 'prototype/components/tier-card.html', styles: [], slots: [], states: ['hero', 'card'] }
        }
      ]
    };
    input.files.set('components.json', JSON.stringify(v1));
    input.files.set(
      'prototype/components/tier-card.html',
      '<section data-blueprint-component="tier-card" data-blueprint-state="card"><blueprint-use kind="primitive" ref="text">Gold</blueprint-use></section>'
    );

    const output = migrateProjectFiles(input);
    const tier = (JSON.parse(output.writes.get('components.json')!) as ComponentFile).components.find(component => component.id === 'tier-card')!;
    assert.equal(tier.states.default, 'card');
    assert.doesNotMatch(output.writes.get('prototype/components/tier-card.html')!, /data-blueprint-state/);
  });
  it('moves axis selectors in CSS and keeps every other byte', async () => {
    const input = await migrationInput(fixtureRoots[2]);
    useV1Slider(input);
    const own = [
      '/* [data-blueprint-state="hero"] */',
      '.slider__a[data-blueprint-state=hero] ,',
      '.slider__b:not( [ data-blueprint-state = \'hero\' ] )  {',
      '  content: "[data-blueprint-state=hero]";',
      '}',
      '[data-blueprint-state="hero" i] { color: inherit }',
      '@scope ([data-blueprint-state=hero]) { .slider__c { color: inherit } }'
    ].join('\n');
    input.files.set('prototype/primitives/slider.css', own);
    const other = [
      '[data-blueprint-primitive="slider"][data-blueprint-state="hero"]:hover > [data-blueprint-state="hero"] { color: inherit }',
      '/* [data-blueprint-primitive="slider"][data-blueprint-state="hero"] */',
      '.unrelated[data-blueprint-state="hero"] { color: inherit }'
    ].join('\n');
    input.files.set('prototype/screens/slider-host.css', other);

    const output = migrateProjectFiles(input);

    assert.equal(output.writes.get('prototype/primitives/slider.css'), [
      '/* [data-blueprint-state="hero"] */',
      '.slider__a[data-blueprint-variant="hero"] ,',
      '.slider__b:not( [data-blueprint-variant=\'hero\'] )  {',
      '  content: "[data-blueprint-state=hero]";',
      '}',
      '[data-blueprint-state="hero" i] { color: inherit }',
      '@scope ([data-blueprint-variant="hero"]) { .slider__c { color: inherit } }'
    ].join('\n'));
    assert.equal(output.writes.get('prototype/screens/slider-host.css'), [
      '[data-blueprint-primitive="slider"][data-blueprint-variant="hero"]:hover > [data-blueprint-state="hero"] { color: inherit }',
      '/* [data-blueprint-primitive="slider"][data-blueprint-state="hero"] */',
      '.unrelated[data-blueprint-state="hero"] { color: inherit }'
    ].join('\n'));
  });

  it('moves axis selectors in a stylesheet that postcss cannot parse', async () => {
    const input = await migrationInput(fixtureRoots[2]);
    useV1Slider(input);
    input.files.set('prototype/primitives/slider.css', '.a[data-blueprint-state=hero] { color: inherit');
    assert.equal(migrateProjectFiles(input).writes.get('prototype/primitives/slider.css'), '.a[data-blueprint-variant="hero"] { color: inherit');
  });

  it('moves flows to declared pages, fills the fixed screen and token shapes, and puts every file on the current schema', async () => {
    const input = await migrationInput(fixtureRoots[0]);
    const screens = JSON.parse(input.files.get('screens.json')!) as ScreenFile & Record<string, unknown>;
    const [workspace, chat] = screens.screens;
    delete (screens as Partial<ScreenFile>).pages;
    for (const [screen, flow] of [[workspace, 'Onboarding'], [chat, 'home']] as const) {
      delete (screen as { page?: string }).page;
      Object.assign(screen, { flow });
    }
    delete (workspace as { styleEvidence?: unknown }).styleEvidence;
    delete (workspace.sections[0] as { implementationTargets?: unknown }).implementationTargets;
    workspace.sections[0].name = 'Thread Library';
    const tokens = JSON.parse(input.files.get('tokens.json')!) as TokenFile;
    delete (tokens.tokenGroups[0] as { notes?: unknown }).notes;
    tokens.tokenGroups[0].name = 'Color Roles';
    const manifest = JSON.parse(input.files.get('manifest.json')!) as BlueprintManifest;
    for (const [file, value] of [['screens.json', screens], ['tokens.json', tokens], ['manifest.json', manifest]] as const) {
      input.files.set(file, JSON.stringify({ ...value, schemaVersion: '1.0.0' }));
    }

    const output = migrateProjectFiles(input);
    assert.equal(output.fromVersion, '1.0.0');
    const migratedScreens = JSON.parse(output.writes.get('screens.json')!) as ScreenFile;
    assert.equal(migratedScreens.schemaVersion, BLUEPRINT_SCHEMA_VERSION);
    assert.deepEqual(migratedScreens.pages, [{ id: 'onboarding', name: 'Onboarding' }, { id: 'home', name: 'Home' }]);
    assert.deepEqual(migratedScreens.screens.map(screen => [screen.page, 'flow' in screen]), [['onboarding', false], ['home', false]]);
    assert.deepEqual(migratedScreens.screens[0].styleEvidence, []);
    assert.deepEqual(migratedScreens.screens[0].sections[0].implementationTargets, []);
    assert.equal(migratedScreens.screens[0].sections[0].name, 'Thread library');
    const migratedTokens = JSON.parse(output.writes.get('tokens.json')!) as TokenFile;
    assert.deepEqual(migratedTokens.tokenGroups[0].notes, []);
    assert.equal(migratedTokens.tokenGroups[0].name, 'Color roles');
    assert.equal((JSON.parse(output.writes.get('manifest.json')!) as BlueprintManifest).schemaVersion, BLUEPRINT_SCHEMA_VERSION);
    assert.ok(output.changes.includes('screens.json: 2 screens moved from flow to page, and 2 new pages are declared: "onboarding", "home". Give each new page a description.'), output.changes.join('\n'));
    assert.ok(output.changes.includes(`manifest.json, tokens.json, screens.json: schemaVersion is now "${BLUEPRINT_SCHEMA_VERSION}".`), output.changes.join('\n'));

    for (const [file, content] of output.writes) input.files.set(file, content);
    assert.equal(migrateProjectFiles(input).upToDate, true, 'a second run has nothing left to do');
  });
});

function useV1Slider(input: MigrationInput): void {
  const primitives = JSON.parse(input.files.get('primitives.json')!) as PrimitiveFile;
  input.files.set('primitives.json', JSON.stringify({
    ...primitives,
    schemaVersion: '1.0.0',
    primitives: [
      ...primitives.primitives.filter(primitive => primitive.id !== 'slider'),
      {
        id: 'slider',
        name: 'Slider',
        uses: [],
        tokenGroupIds: ['color'],
        prototype: { source: 'prototype/primitives/slider.html', styles: ['prototype/primitives/slider.css'], slots: [], states: ['default', 'hero', 'lead'] }
      }
    ]
  }));
  input.files.set('prototype/primitives/slider.html', '<div data-blueprint-primitive="slider"></div>');
}

async function textFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(json|html|css|md)$/.test(entry.name)) files.set(path.relative(root, full).split(path.sep).join('/'), await readFile(full, 'utf8'));
    }
  };
  await walk(root);
  return files;
}

async function migrationInput(root: string): Promise<MigrationInput> {
  return {
    files: await textFiles(root),
    starterFiles: new Map([['primitives.json', await readFile(path.join(starterRoot, 'primitives.json'), 'utf8')]])
  };
}

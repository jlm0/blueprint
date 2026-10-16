import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BASE_PRIMITIVE_TEXT } from '../src/core/base-primitive-text';
import { migrateProjectFiles, type MigrationInput } from '../src/core/migrate';
import type { ComponentFile, PrimitiveFile } from '../src/core/types';

const starterRoot = 'starter/design/blueprint';
const fixtureRoots = ['mira-ai', 'umbra-gaming', 'meridian-finance'].map(id => `fixtures/valid/${id}/design/blueprint`);

describe('Blueprint migrate', () => {
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
});

async function migrationInput(root: string): Promise<MigrationInput> {
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
  return {
    files,
    starterPrimitives: JSON.parse(await readFile(path.join(starterRoot, 'primitives.json'), 'utf8')) as PrimitiveFile,
    starterAgents: files.get('AGENTS.md') ?? ''
  };
}

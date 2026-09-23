import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createExtractionPacket, queryPrototypeOnly, querySections, queryUsedBy, queryUses, showBoundary } from '../src/core/query';
import { loadProjectFromFs } from '../src/core/load';
import { validateProject } from '../src/core/validate';
import type { BoundaryPacket, PrimitiveDefinition, PrimitiveState, ScreenDefinition, ScreenSection } from '../src/core/types';

const stillRoot = 'fixtures/app-owned/still-meditation/design/blueprint';
const denseRoot = 'fixtures/app-owned/dense-ops/design/blueprint';
const blankSlateRoot = 'fixtures/app-owned/blank-slate/design/blueprint';

describe('Blueprint schema contract', () => {
  it('validates the app-owned project fixtures and rejects an invalid copy', async () => {
    for (const root of [stillRoot, denseRoot, blankSlateRoot]) {
      const bundle = await loadProjectFromFs(root);
      const result = validateProject(bundle);
      assert.equal(result.ok, true, result.errors.join('\n'));
      assert.equal(bundle.manifest.project.sourceRoot, root);
      assert.equal(bundle.manifest.defaultBoardId, 'screens');
      assert.deepEqual(
        bundle.manifest.boards.map(board => board.kind),
        ['primitives', 'screens']
      );
    }

    const invalid = structuredClone(await loadProjectFromFs(stillRoot));
    const section = invalid.screens.screens[0]?.sections[0];
    assert.ok(section);
    delete (section as Partial<ScreenSection>).id;
    const invalidResult = validateProject(invalid);
    assert.equal(invalidResult.ok, false);
    assert.match(invalidResult.errors.join('\n'), /section\.id/);
  });

  it('rejects sidecars missing the prototype host policy or prototype sources', async () => {
    const bundle = structuredClone(await loadProjectFromFs(stillRoot));
    const primitive = bundle.primitives.primitives.find(candidate => candidate.id === 'button');
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'home');
    assert.ok(primitive && screen);

    delete (bundle.manifest as Partial<typeof bundle.manifest>).prototypeHost;
    delete (primitive as Partial<PrimitiveDefinition>).prototype;
    delete (screen as Partial<ScreenDefinition>).prototype;

    const errors = validateProject(bundle).errors;
    assert.ok(errors.includes('manifest.prototypeHost must declare assetRoots, network "deny", and scripts "none".'), errors.join('\n'));
    assert.ok(errors.includes('primitive.button.prototype must declare a canonical HTML/CSS source.'), errors.join('\n'));
    assert.ok(errors.includes('screen.home.prototype must declare a browser-native HTML/CSS source.'), errors.join('\n'));

    const permissive = structuredClone(await loadProjectFromFs(stillRoot));
    Object.assign(permissive.manifest.prototypeHost, { network: 'allow', scripts: 'inline' });
    const hostErrors = validateProject(permissive).errors;
    assert.ok(hostErrors.includes('manifest.prototypeHost.network must be "deny".'), hostErrors.join('\n'));
    assert.ok(hostErrors.includes('manifest.prototypeHost.scripts must be "none".'), hostErrors.join('\n'));
  });

  it('represents tokens, primitives, state sets, screens, sections, notes, style refs, and hints as structured files', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    assert.ok(bundle.tokens.tokenGroups.length >= 3);
    assert.ok(bundle.primitives.primitives.some(primitive => primitive.stateSets.length > 0));
    assert.ok(bundle.screens.screens.some(screen => screen.sections.length > 0));
    assert.equal(bundle.manifest.framePresets[0]?.width, 393);
    assert.equal(bundle.manifest.framePresets[0]?.height, 852);
    assert.equal(bundle.manifest.framePresets[0]?.safeArea.top, 59);

    const screen = showBoundary(bundle, 'screen:home');
    assertCanonicalPacket(screen);
    assert.ok(screen.styleRefs.length > 0);
    assert.ok(screen.dependencies.uses.some(ref => ref.kind === 'primitive'));
    assert.ok(screen.notes.length > 0);
    assert.ok(screen.implementationHints.length > 0);
  });

  it('rejects primitive states missing required canvas metadata before serve can crash', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    const broken = structuredClone(bundle);
    const state = broken.primitives.primitives[0]?.stateSets[0]?.states[0];
    assert.ok(state);

    delete (state as Partial<PrimitiveState>).notes;
    delete (state as Partial<PrimitiveState>).implementationHints;
    delete (state as Partial<PrimitiveState>).prototypeOnly;

    const result = validateProject(broken);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /state\..*\.notes must be an array/);
    assert.match(result.errors.join('\n'), /state\..*\.implementationHints must be an array/);
    assert.match(result.errors.join('\n'), /state\..*\.prototypeOnly must be a boolean/);
  });

  it('keeps frame presets scoped to mobile and desktop prototype modes', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    const broken = structuredClone(bundle);
    const preset = broken.manifest.framePresets[0];
    assert.ok(preset);

    (preset as { type: string }).type = 'tablet';
    preset.width = 0;

    const result = validateProject(broken);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /framePreset\..*\.type must be "mobile" or "desktop"/);
    assert.match(result.errors.join('\n'), /framePreset\..*\.width must be a positive number/);
  });

  it('accepts primitive platform tags and rejects unknown or repeated platforms', async () => {
    const bundle = structuredClone(await loadProjectFromFs(stillRoot));
    const [first, second, third] = bundle.primitives.primitives;
    assert.ok(first && second && third);

    first.platforms = ['mobile'];
    second.platforms = ['mobile', 'desktop'];
    assert.equal(validateProject(bundle).ok, true, validateProject(bundle).errors.join('\n'));

    (second as { platforms: string[] }).platforms = ['tablet'];
    third.platforms = ['desktop', 'desktop'];
    const result = validateProject(bundle);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), new RegExp(`primitive\\.${second.id}\\.platforms must list "mobile" and/or "desktop" once each`));
    assert.match(result.errors.join('\n'), new RegExp(`primitive\\.${third.id}\\.platforms must list`));
  });
});

describe('Blueprint query contract', () => {
  it('answers focused dependency and section questions without whole-board parsing', async () => {
    const bundle = await loadProjectFromFs(stillRoot);

    const screenUses = queryUses(bundle, 'screen:home');
    assert.ok(screenUses.results.some(result => isReference(result) && result.localId === 'button'));

    const usedBy = queryUsedBy(bundle, 'primitive:button');
    assert.ok(usedBy.results.some(result => isReference(result) && result.localId === 'home/featured-practice'));

    const sections = querySections(bundle, 'home');
    assert.equal(sections.results.length, 5);

    assert.deepEqual(queryPrototypeOnly(bundle).results, []);
    const flagged = structuredClone(bundle);
    const navigation = flagged.screens.screens.find(screen => screen.id === 'home')?.sections.find(section => section.id === 'navigation');
    assert.ok(navigation);
    navigation.prototypeOnly = true;
    assert.deepEqual(
      queryPrototypeOnly(flagged).results.map(result => (result as { id: string }).id),
      ['still-meditation/section/home/navigation']
    );
  });

  it('creates canonical extraction packets for one primitive and one screen', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    const primitive = createExtractionPacket(bundle, 'primitive:button');
    const screen = createExtractionPacket(bundle, 'screen:home');

    assertCanonicalPacket(primitive);
    assertCanonicalPacket(screen);
    assert.equal(primitive.kind, 'primitive');
    assert.equal(screen.kind, 'screen');
    assert.equal((primitive.data as PrimitiveDefinition).id, 'button');
    assert.equal((screen.data as ScreenDefinition).id, 'home');
    assert.equal('value' in (primitive.data as Record<string, unknown>), false);
    assert.equal('value' in (screen.data as Record<string, unknown>), false);
    assert.ok(primitive.dependencies.usedBy.length > 0);
    assert.ok(screen.dependencies.uses.length > 0);
  });
});

describe('Blueprint no-framework package boundary', () => {
  it('keeps framework-like runtime libraries out of package dependencies', async () => {
    const raw = await readFile('package.json', 'utf8');
    const packageJson = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };

    for (const forbidden of ['react', 'react-dom', 'next', 'svelte', 'vue', 'preact', 'solid-js', 'lit', 'alpinejs']) {
      assert.equal(dependencies[forbidden], undefined, `${forbidden} should not be installed`);
    }
  });

  it('keeps rendered HTML from becoming the fixture source of truth', async () => {
    const files = await readdir(denseRoot);
    assert.deepEqual(
      files.filter(file => file !== '.blueprint-artifacts').sort(),
      ['components.json', 'manifest.json', 'primitives.json', 'prototype', 'screens.json', 'tokens.json'],
      'app-owned fixture should be structured data plus governed prototype sources only'
    );
    assert.equal(path.extname('index.html'), '.html');
  });
});

function assertCanonicalPacket(packet: BoundaryPacket): void {
  for (const field of ['id', 'kind', 'projectId', 'sourceFiles', 'data', 'styleRefs', 'dependencies', 'notes', 'prototypeOnly', 'implementationHints']) {
    assert.ok(field in packet, `packet missing ${field}`);
  }
  assert.ok('uses' in packet.dependencies);
  assert.ok('usedBy' in packet.dependencies);
}

function isReference(value: unknown): value is { localId: string; kind: string } {
  return typeof value === 'object' && value !== null && 'localId' in value && 'kind' in value;
}

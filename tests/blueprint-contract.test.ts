import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createExtractionPacket, queryPrototypeOnly, querySections, queryUsedBy, queryUses, showBoundary } from '../src/core/query';
import { loadProjectFromFs } from '../src/core/load';
import { validateProject } from '../src/core/validate';
import type { BoundaryPacket, PrimitiveDefinition, ReusableDefinition, ScreenDefinition, ScreenSection } from '../src/core/types';

const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';
const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';
const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';

describe('Blueprint schema contract', () => {
  it('validates the valid project fixtures and rejects an invalid copy', async () => {
    for (const root of [miraRoot, umbraRoot, meridianRoot]) {
      const bundle = await loadProjectFromFs(root);
      const result = validateProject(bundle);
      assert.equal(result.ok, true, result.errors.join('\n'));
      assert.equal(bundle.manifest.project.sourceRoot, 'design/blueprint');
      assert.equal(bundle.manifest.defaultBoardId, 'primitives');
      assert.deepEqual(
        bundle.manifest.boards.map(board => board.kind),
        ['primitives', 'screens']
      );
    }

    const invalid = structuredClone(await loadProjectFromFs(miraRoot));
    const section = invalid.screens.screens[0]?.sections[0];
    assert.ok(section);
    delete (section as Partial<ScreenSection>).id;
    const invalidResult = validateProject(invalid);
    assert.equal(invalidResult.ok, false);
    assert.match(invalidResult.errors.join('\n'), /sections\[0\] is missing "id"\. Fix: add it/);
  });

  it('rejects sidecars missing the prototype host policy or prototype sources', async () => {
    const bundle = structuredClone(await loadProjectFromFs(miraRoot));
    const primitive = bundle.primitives.primitives.find(candidate => candidate.id === 'button');
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'workspace');
    assert.ok(primitive && screen);

    delete (bundle.manifest as Partial<typeof bundle.manifest>).prototypeHost;
    delete (primitive as Partial<PrimitiveDefinition>).prototype;
    delete (screen as Partial<ScreenDefinition>).prototype;

    const errors = validateProject(bundle).errors;
    assert.ok(errors.includes('manifest.prototypeHost must declare assetRoots, network "deny", and scripts "none".'), errors.join('\n'));
    assert.ok(errors.includes('primitive.button.prototype must be { "source", "styles", "localValueExceptions" }. Fix: point "source" at its HTML and "styles" at its CSS.'), errors.join('\n'));
    assert.ok(errors.includes('screen.workspace.prototype must declare a browser-native HTML/CSS source.'), errors.join('\n'));

    const permissive = structuredClone(await loadProjectFromFs(miraRoot));
    Object.assign(permissive.manifest.prototypeHost, { network: 'allow', scripts: 'inline' });
    const hostErrors = validateProject(permissive).errors;
    assert.ok(hostErrors.includes('manifest.prototypeHost.network must be "deny".'), hostErrors.join('\n'));
    assert.ok(hostErrors.includes('manifest.prototypeHost.scripts must be "none".'), hostErrors.join('\n'));
  });

  it('represents tokens, primitives, screens, sections, notes, style refs, and hints as structured files', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    assert.ok(bundle.tokens.tokenGroups.length >= 3);
    assert.ok(bundle.primitives.primitives.some(primitive => primitive.states.values.length > 1));
    assert.ok(bundle.screens.screens.some(screen => screen.sections.length > 0));
    assert.equal(bundle.manifest.framePresets[0]?.width, 393);
    assert.equal(bundle.manifest.framePresets[0]?.height, 852);
    assert.equal(bundle.manifest.framePresets[0]?.safeArea.top, 59);

    const screen = showBoundary(bundle, 'screen:launch');
    assertCanonicalPacket(screen);
    assert.ok(screen.styleRefs.length > 0);
    assert.ok(screen.dependencies.uses.some(ref => ref.kind === 'primitive'));
    assert.ok(screen.notes.length > 0);
    assert.ok(screen.implementationHints.length > 0);
  });

  it('rejects reusables missing required fields, naming each fix, before serve can crash', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const broken = structuredClone(bundle);
    const primitive = broken.primitives.primitives[0];
    const component = broken.components.components[0];
    assert.ok(primitive && component);

    delete (primitive as Partial<ReusableDefinition>).notes;
    delete (primitive as Partial<ReusableDefinition>).prototypeOnly;
    delete (component as Partial<ReusableDefinition>).platforms;
    Object.assign(component, { tone: 'warm' });

    const errors = validateProject(broken).errors.join('\n');
    assert.match(errors, new RegExp(`primitive\\.${primitive.id} is missing "notes", "prototypeOnly"\\. Fix: `));
    assert.match(errors, new RegExp(`component\\.${component.id} has unknown field "tone"\\. Fix: remove it`));
    assert.match(errors, new RegExp(`component\\.${component.id} is missing "platforms"\\. Fix: `));
    for (const error of validateProject(broken).errors.filter(error => error.startsWith(`primitive.${primitive.id}`) || error.startsWith(`component.${component.id}`))) {
      assert.match(error, /Fix: /, `every reusable error names its fix: ${error}`);
    }
  });

  it('keeps frame presets scoped to mobile and desktop prototype modes', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
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

  it('locks primitive platforms and keeps component platforms inside what they use', async () => {
    const bundle = structuredClone(await loadProjectFromFs(miraRoot));
    const button = bundle.primitives.primitives.find(primitive => primitive.id === 'button');
    const [first, second, third] = bundle.components.components;
    assert.ok(button && first && second && third);
    assert.equal(validateProject(bundle).ok, true, validateProject(bundle).errors.join('\n'));

    button.platforms = ['mobile'];
    (first as { platforms: string[] }).platforms = ['tablet'];
    second.platforms = ['web', 'web'];
    third.platforms = [];
    const errors = validateProject(bundle).errors.join('\n');
    assert.match(errors, /primitive\.button\.platforms is "mobile"\. Fix: set it to the Blueprint platforms "web", "mobile", "desktop"/);
    assert.match(errors, new RegExp(`component\\.${first.id}\\.platforms has "tablet"\\. Fix: use only "web", "mobile", "desktop"`));
    assert.match(errors, new RegExp(`component\\.${second.id}\\.platforms repeats a platform\\. Fix: list each platform once`));
    assert.match(errors, new RegExp(`component\\.${third.id}\\.platforms is empty\\. Fix: list where it runs`));
  });

  it('rejects a component that claims a platform one of its pieces does not run on', async () => {
    const bundle = structuredClone(await loadProjectFromFs(miraRoot));
    const component = bundle.components.components.find(candidate => candidate.uses.some(use => use.kind === 'primitive'));
    assert.ok(component);
    const use = component.uses.find(candidate => candidate.kind === 'primitive')!;
    const primitive = bundle.primitives.primitives.find(candidate => candidate.id === use.id)!;
    primitive.platforms = ['mobile'];
    component.platforms = ['web', 'mobile'];
    assert.match(
      validateProject(bundle).errors.join('\n'),
      new RegExp(`component\\.${component.id}\\.platforms includes "web", but it uses primitive "${primitive.id}" \\("mobile"\\)\\. Fix: remove "web"`)
    );
  });

  it('validates the brand guideline, its mark sources, and its variants, and requires it for a strict handoff', async () => {
    const meridian = await loadProjectFromFs(meridianRoot);
    assert.equal(validateProject(meridian, { mode: 'strict' }).ok, true, validateProject(meridian, { mode: 'strict' }).errors.join('\n'));

    const mira = await loadProjectFromFs(miraRoot);
    assert.equal(mira.brand, undefined);
    assert.equal(validateProject(mira).errors.some(error => error.startsWith('brand')), false, 'The brand is optional below strict');
    assert.match(validateProject(mira, { mode: 'strict' }).errors.join('\n'), /brand\.json is required for a strict handoff/);

    const broken = structuredClone(meridian);
    const [globe, wordmark, lockup] = broken.brand!.marks;
    assert.ok(globe && wordmark && lockup);
    broken.prototypeSourceContents[globe.source] = broken.prototypeSourceContents[globe.source]!.replace('<circle', '<script>fetch("https://example.com")</script><circle');
    broken.prototypeSourceContents[wordmark.source] = broken.prototypeSourceContents[wordmark.source]!
      .replace('fill="currentColor"', 'fill="#16140f"')
      .replace('<path', '<text>Meridian</text><path');
    broken.prototypeSourceContents[lockup.source] = broken.prototypeSourceContents[lockup.source]!.replace(/d="M[\d.]+/, 'd="MNaN');
    globe.variants[0]!.accent = 'color.brand-blue';
    wordmark.variants.push({ id: 'faint', name: 'Faint', background: 'color.background', foreground: 'color.surface-2' });
    lockup.role = 'badge' as typeof lockup.role;
    lockup.minimumSize.px = 0;

    const baseline = validateProject(broken).errors.join('\n');
    assert.match(baseline, /brand\.mark\.globe\.source contains a script/);
    assert.match(baseline, /brand\.mark\.lockup\.source contains a NaN or Infinity coordinate/);
    assert.match(baseline, /brand\.mark\.globe\.variant\.ink\.accent "color\.brand-blue" must reference a declared color token/);
    assert.match(baseline, /brand\.mark\.lockup\.role must be one of "mark", "wordmark", "lockup", "app-icon"/);
    assert.match(baseline, /brand\.mark\.lockup\.minimumSize\.px must be a positive number/);
    assert.doesNotMatch(baseline, /literal color|live text|contrast/, 'Handoff rules apply only in strict mode');

    const strict = validateProject(broken, { mode: 'strict' }).errors.join('\n');
    assert.match(strict, /brand\.mark\.wordmark\.source draws with a literal color/);
    assert.match(strict, /brand\.mark\.wordmark\.source sets live text; outline the lettering/);
    assert.match(strict, /brand\.mark\.wordmark\.variant\.faint\.foreground color\.surface-2 on color\.background has contrast [\d.]+:1; a mark needs at least 3:1/);
  });

  it('requires every screen page and component group to be declared before use', async () => {
    const bundle = structuredClone(await loadProjectFromFs(miraRoot));
    const [screen, other] = bundle.screens.screens;
    const [component, ungrouped] = bundle.components.components;
    assert.ok(screen && other && component && ungrouped);

    bundle.screens.pages.push({ id: 'landing', name: 'Landing', description: 'Marketing pages.' });
    assert.equal(validateProject(bundle).ok, true, 'A declared page may start empty');

    screen.page = 'onboarding';
    (other as { page?: string }).page = undefined;
    Object.assign(other, { flow: 'Legacy' });
    component.group = 'charts';
    (ungrouped as { group?: string }).group = undefined;
    bundle.screens.pages.push({ id: 'landing', name: '', description: 'Marketing pages.' });

    const errors = validateProject(bundle).errors.join('\n');
    assert.match(errors, new RegExp(`screen\\.${screen.id}\\.page "onboarding" is not declared\\. Fix: add it to screens\\.pages`));
    assert.match(errors, new RegExp(`screen\\.${other.id}\\.page is missing\\. Fix: set it to the id of a page`));
    assert.match(errors, new RegExp(`screen\\.${other.id}\\.flow was replaced by page\\. Fix: run the migrate tool`));
    assert.match(errors, new RegExp(`component\\.${component.id}\\.group "charts" is not declared\\. Fix: add`));
    assert.match(errors, new RegExp(`component\\.${ungrouped.id}\\.group is missing\\. Fix: set it to a group declared in components\\.json`));
    assert.match(errors, /Duplicate id "landing" in screens\.pages/);
    assert.match(errors, /screens\.page\.landing\.name is missing\. Fix: give it a short sentence-case name/);
  });
});

describe('Blueprint query contract', () => {
  it('answers focused dependency and section questions without whole-board parsing', async () => {
    const bundle = await loadProjectFromFs(miraRoot);

    const screenUses = queryUses(bundle, 'screen:workspace');
    assert.ok(screenUses.results.some(result => isReference(result) && result.localId === 'button'));

    const usedBy = queryUsedBy(bundle, 'primitive:button');
    assert.ok(usedBy.results.some(result => isReference(result) && result.localId === 'workspace/library'));

    const sections = querySections(bundle, 'workspace');
    assert.equal(sections.results.length, 6);

    assert.deepEqual(queryPrototypeOnly(bundle).results, []);
    const flagged = structuredClone(bundle);
    const library = flagged.screens.screens.find(screen => screen.id === 'workspace')?.sections.find(section => section.id === 'library');
    assert.ok(library);
    library.prototypeOnly = true;
    assert.deepEqual(
      queryPrototypeOnly(flagged).results.map(result => (result as { id: string }).id),
      ['mira-ai/section/workspace/library']
    );
  });

  it('creates canonical extraction packets for one primitive and one screen', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const primitive = createExtractionPacket(bundle, 'primitive:button');
    const screen = createExtractionPacket(bundle, 'screen:workspace');

    assertCanonicalPacket(primitive);
    assertCanonicalPacket(screen);
    assert.equal(primitive.kind, 'primitive');
    assert.equal(screen.kind, 'screen');
    assert.equal((primitive.data as PrimitiveDefinition).id, 'button');
    assert.equal((screen.data as ScreenDefinition).id, 'workspace');
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
    const files = await readdir(miraRoot);
    assert.deepEqual(
      files.filter(file => file !== '.blueprint-artifacts').sort(),
      ['components.json', 'manifest.json', 'primitives.json', 'prototype', 'screens.json', 'tokens.json'],
      'fixture should be structured data plus governed prototype sources only'
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

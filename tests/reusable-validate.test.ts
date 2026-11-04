import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { basePrimitiveText } from '../src/core/base-primitive-text';
import { loadProjectFromFs } from '../src/core/load';
import { validateReusables } from '../src/core/reusable-validate';
import type { BlueprintProjectBundle, ReusableDefinition } from '../src/core/types';
import { validateProject } from '../src/prototype/validate-project';

const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';
const starterRoot = 'starter/design/blueprint';
const composerSource = 'prototype/components/composer.html';

function reusableErrors(bundle: BlueprintProjectBundle): string[] {
  const groups = bundle.tokens.tokenGroups;
  const tokenGroupIds = new Set(groups.map(group => group.id));
  const tokenIds = new Set(groups.flatMap(group => group.tokens.map(token => `${group.id}.${token.id}`)));
  const errors: string[] = [];
  validateReusables(errors, bundle, tokenGroupIds, tokenIds);
  return errors;
}

function primitive(bundle: BlueprintProjectBundle, id: string): ReusableDefinition {
  const found = bundle.primitives.primitives.find(candidate => candidate.id === id);
  assert.ok(found, `the fixture declares primitive ${id}`);
  return found;
}

function composer(bundle: BlueprintProjectBundle): ReusableDefinition {
  const found = bundle.components.components.find(candidate => candidate.id === 'composer');
  assert.ok(found, 'the fixture declares component composer');
  return found;
}

function raw(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function assertReports(errors: string[], expected: string): void {
  assert.ok(errors.some(error => error.includes(expected)), `expected "${expected}" in:\n${errors.join('\n')}`);
}

function assertSilentOn(errors: string[], text: string): void {
  assert.deepEqual(errors.filter(error => error.includes(text)), []);
}

describe('validateReusables', () => {
  it('accepts the primitives and components of the starter and a valid fixture', async () => {
    for (const root of [starterRoot, miraRoot]) {
      assert.deepEqual(reusableErrors(await loadProjectFromFs(root)), [], root);
    }
  });

  it('requires each locked base primitive, and the later additions only in strict mode', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    bundle.primitives.primitives = bundle.primitives.primitives.filter(item => item.id !== 'switch' && item.id !== 'textarea');

    const baseline = validateProject(bundle).errors;
    assertReports(baseline, 'primitives is missing locked base primitive "switch". Fix: restore it from the Blueprint starter');
    assertSilentOn(baseline, 'locked base primitive "textarea"');

    assertReports(validateProject(bundle, { mode: 'strict' }).errors, 'primitives is missing locked base primitive "textarea". Fix:');
  });

  it('locks the name, group, and platforms of a base primitive', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const button = primitive(bundle, 'button');
    button.name = 'Action button';
    button.group = 'inputs';
    button.platforms = ['web'];

    const errors = reusableErrors(bundle);
    assertReports(errors, 'primitive.button.name is "Action button". Fix: set it to the Blueprint name "Button".');
    assertReports(errors, 'primitive.button.group is "inputs". Fix: set it to the Blueprint group "actions".');
    assertReports(errors, 'primitive.button.platforms is "web". Fix: set it to the Blueprint platforms "web", "mobile", "desktop".');
  });

  it('requires the axis and slot floor of a base primitive, and lets an app add above it', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const button = primitive(bundle, 'button');
    button.states.values = button.states.values.filter(value => value.id !== 'loading');
    button.variants.values = button.variants.values.filter(value => value.id !== 'ghost' && value.id !== 'link');
    button.sizes.default = 'lg';
    button.slots = button.slots.filter(slot => slot.id !== 'label');

    const errors = reusableErrors(bundle);
    assertReports(errors, 'primitive.button.states is missing the Blueprint state "loading". Fix: add it and style it');
    assertReports(errors, 'primitive.button.variants is missing the Blueprint variants "ghost", "link". Fix: add them and style each');
    assertReports(errors, 'primitive.button.sizes.default is "lg". Fix: set it to the Blueprint default "md".');
    assertReports(errors, 'primitive.button.slots is missing the Blueprint slot "label". Fix: declare it and keep its marker');

    const added = await loadProjectFromFs(miraRoot);
    const addedButton = primitive(added, 'button');
    addedButton.variants.values.push({ id: 'soft', name: 'Soft', description: 'A quiet filled action.' });
    assert.deepEqual(reusableErrors(added), []);
  });

  it('requires Blueprint text on a base primitive', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const button = primitive(bundle, 'button');
    const text = basePrimitiveText('button');
    assert.ok(text);
    button.description = 'Runs a command.';
    button.accessibility = 'A button.';
    button.notes = ['An app note.'];
    const primary = button.variants.values.find(value => value.id === 'primary');
    assert.ok(primary);
    primary.name = 'Main';
    const label = button.slots.find(slot => slot.id === 'label');
    assert.ok(label);
    label.description = 'The words.';

    const errors = reusableErrors(bundle);
    assertReports(errors, `primitive.button.description is not Blueprint's text. Fix: set it to "${text.description}", or run the migrate tool`);
    assertReports(errors, `primitive.button.accessibility is not Blueprint's text. Fix: set it to "${text.accessibility}"`);
    assertReports(errors, "primitive.button.notes are not Blueprint's notes. Fix: set them to");
    assertReports(errors, `primitive.button.variants.primary.name is not Blueprint's text. Fix: set it to "${text.variants.primary.name}"`);
    assertReports(errors, `primitive.button.slots.label.description is not Blueprint's text. Fix: set it to "${text.slots.label.description}"`);
  });

  it('requires a component to use a reusable, and checks each use', async () => {
    const empty = await loadProjectFromFs(miraRoot);
    composer(empty).uses = [];
    assert.equal(primitive(empty, 'button').uses.length, 0);
    assert.deepEqual(reusableErrors(empty).map(error => error.split('. Fix:')[0]), ['component.composer.uses is empty']);

    const notList = await loadProjectFromFs(miraRoot);
    raw(composer(notList)).uses = 'button';
    assertReports(reusableErrors(notList), 'component.composer.uses must be a list. Fix:');

    const wrong = await loadProjectFromFs(miraRoot);
    composer(wrong).uses = [
      { kind: 'primitive', id: 'missing', reason: 'A missing piece.' },
      { kind: 'component', id: 'composer', reason: 'Itself.' },
      { kind: 'primitive', id: 'button', reason: 'First.' },
      { kind: 'primitive', id: 'button', reason: 'Again.' },
      { kind: 'primitive', id: 'badge', reason: '' }
    ];
    primitive(wrong, 'badge').uses = [{ kind: 'component', id: 'composer', reason: 'A component.' }];

    const errors = reusableErrors(wrong);
    assertReports(errors, 'component.composer.uses[0] names primitive "missing", which does not exist. Fix: use a declared primitive id');
    assertReports(errors, 'component.composer.uses[1] names the component itself. Fix: remove it');
    assertReports(errors, 'component.composer.uses[3] repeats primitive:button. Fix: keep one entry per reusable');
    assertReports(errors, 'component.composer.uses[4].reason is missing. Fix: say what the piece does');
    assertReports(errors, 'primitive.badge.uses[0].kind is "component". Fix: use "primitive"; a primitive is built only from primitives and tokens.');
  });

  it('keeps size words out of variants and states, and allows them in sizes', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const reusable = composer(bundle);
    reusable.variants.values.push(
      { id: 'sm', name: 'Small', description: 'A tighter composer.' },
      { id: 'primary-lg', name: 'Primary large', description: 'A larger primary composer.' }
    );
    reusable.states.values.push({ id: 'large', name: 'Large', description: 'A larger composer.' });
    reusable.sizes.values.push({ id: 'lg', name: 'Large', description: 'A larger composer.' });

    const errors = reusableErrors(bundle);
    assertReports(errors, 'component.composer.variants.sm is a size, not a variant. Fix: run the migrate tool');
    assertReports(errors, 'component.composer.states.large is a size, not a state. Fix: run the migrate tool');
    assertReports(errors, 'component.composer.variants.primary-lg combines size "lg" with a variant. Fix: add "lg" to "sizes", keep "primary" as the variant, and place it with size="lg".');
    assertSilentOn(errors, 'sizes.lg');
  });

  it('checks what a slot accepts', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const slot = composer(bundle).slots.find(candidate => candidate.id === 'placeholder');
    assert.ok(slot);
    const label = 'component.composer.slots.placeholder.accepts';
    const cases: Array<[string[], string]> = [
      [[], `${label} is empty. Fix: list what it takes: "text", "graphic", "brand-mark", "primitive:<id>", or "component:<id>".`],
      [['text', 'image'], `${label} has "image". Fix: use "text", "graphic", "brand-mark"`],
      [['text', 'primitive:missing'], `${label} names "primitive:missing", which does not exist. Fix: name a declared primitive or component.`],
      [['text', 'component:composer'], `${label} names the component itself. Fix: remove it.`],
      [['text', 'text'], `${label} repeats an entry. Fix: list each once.`]
    ];
    for (const [accepts, expected] of cases) {
      slot.accepts = accepts;
      assertReports(reusableErrors(bundle), expected);
    }

    slot.accepts = ['text', 'primitive:badge'];
    assert.deepEqual(reusableErrors(bundle), []);
  });

  it('matches declared slots to the markers and default content of the source', async () => {
    const unmarked = await loadProjectFromFs(miraRoot);
    composer(unmarked).slots.push({ id: 'footer', name: 'Footer', description: 'A line below the bar.', accepts: ['text'] });
    assertReports(reusableErrors(unmarked), `component.composer.slots.footer is not marked in ${composerSource}. Fix: mark the element it fills with data-blueprint-slot="footer", or remove the slot.`);

    const undeclared = await loadProjectFromFs(miraRoot);
    composer(undeclared).slots = [];
    assertReports(reusableErrors(undeclared), `${composerSource} marks slot "placeholder", which component.composer.slots does not declare. Fix: declare it in slots or remove data-blueprint-slot="placeholder".`);

    const bareSlot = await loadProjectFromFs(miraRoot);
    bareSlot.prototypeSourceContents[composerSource] += '<slot></slot>';
    assertReports(reusableErrors(bareSlot), `${composerSource} marks slot "default", which component.composer.slots does not declare. Fix: declare it in slots or remove a bare <slot>.`);

    const refused = await loadProjectFromFs(miraRoot);
    composer(refused).slots[0].accepts = ['graphic'];
    assertReports(reusableErrors(refused), `component.composer.slots.placeholder default content in ${composerSource} is "text", which it does not accept. Fix: add "text" to accepts, or change the default content.`);
  });

  it('holds platforms to the list, and to what the reusable is built from', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const reusable = composer(bundle);
    reusable.uses = [{ kind: 'primitive', id: 'nav-bar', reason: 'The header.' }];
    assertReports(reusableErrors(bundle), 'component.composer.platforms includes "web", but it uses primitive "nav-bar" ("mobile"). Fix: remove "web", or build it from pieces that support "web".');

    reusable.platforms = [];
    assertReports(reusableErrors(bundle), 'component.composer.platforms is empty. Fix: list where it runs: one or more of "web", "mobile", "desktop"; what it is built from allows "mobile".');

    raw(reusable).platforms = ['tv', 'mobile', 'mobile'];
    const errors = reusableErrors(bundle);
    assertReports(errors, 'component.composer.platforms has "tv". Fix: use only "web", "mobile", "desktop".');
    assertReports(errors, 'component.composer.platforms repeats a platform. Fix: list each platform once.');
  });

  it('checks the axis shape and the unsupported combinations of a reusable', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const reusable = composer(bundle);
    raw(reusable).variants = 'default';
    reusable.sizes.values = [];
    reusable.states.default = 'gone';
    reusable.states.values.push(
      { id: 'hero', name: 'Hero again', description: 'A second entry.' },
      { id: 'quiet', name: 'Quiet', description: '' },
      { id: 'only', name: 'Only', description: 'The only state.' }
    );

    const axisErrors = reusableErrors(bundle);
    assertReports(axisErrors, 'component.composer.variants must be { "default", "values" }. Fix:');
    assertReports(axisErrors, 'component.composer.sizes.values is empty. Fix: list at least one size');
    assertReports(axisErrors, 'component.composer.states.default is "gone". Fix: set it to one of "default", "hero", "quiet", "only".');
    assertReports(axisErrors, 'component.composer.states lists "hero" twice. Fix: keep one entry per state.');
    assertReports(axisErrors, 'component.composer.states has no description for "quiet". Fix:');
    assertReports(axisErrors, 'component.composer.states.only.description says "The only state.", but component.composer.states has 5 values. Fix:');

    const combinations = await loadProjectFromFs(miraRoot);
    const target = composer(combinations);
    raw(target).unsupported = [
      { axis: 'state', value: 'default', state: 'hero', reason: 'A wrong axis.' },
      { axis: 'size', value: 'huge', state: 'hero', reason: 'An unknown size.' },
      { axis: 'size', value: 'compact', state: 'gone', reason: 'An unknown state.' },
      { axis: 'variant', value: 'default', state: 'default', reason: 'The defaults.' },
      { axis: 'size', value: 'compact', state: 'hero', reason: '' },
      { axis: 'size', value: 'compact', state: 'hero', reason: 'A repeat.' }
    ];

    const errors = reusableErrors(combinations);
    assertReports(errors, 'component.composer.unsupported[0].axis is "state". Fix: use "variant" or "size".');
    assertReports(errors, 'component.composer.unsupported[1].value "huge" is not a declared size. Fix: use one of "default", "compact".');
    assertReports(errors, 'component.composer.unsupported[2].state "gone" is not a declared state. Fix: use one of "default", "hero".');
    assertReports(errors, 'component.composer.unsupported[3] removes the default variant in the default state. Fix: remove the entry');
    assertReports(errors, 'component.composer.unsupported[4].reason is missing. Fix: say why the combination does not exist');
    assertReports(errors, 'component.composer.unsupported[5] repeats an earlier entry. Fix: remove the duplicate.');
  });

  it('checks groups, the prototype root, and token references', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const reusable = composer(bundle);
    reusable.group = 'missing';
    bundle.components.groups.push({ id: 'answers', name: 'Answers', description: 'A second entry.' });
    bundle.prototypeSourceContents[composerSource] = '<div data-blueprint-state="hero" data-blueprint-slot="placeholder">Ask</div>';
    reusable.tokenGroupIds = ['missing'];
    reusable.tokenRoles = { 'color.missing': 'fill', 'color.primary': '' };

    const errors = reusableErrors(bundle);
    assertReports(errors, 'component.composer.group "missing" is not declared. Fix: add { "id": "missing", "name", "description" } to components.json "groups"');
    assertReports(errors, 'components.group.answers is declared twice. Fix: keep one entry per group id.');
    assertReports(errors, `component.composer root element in ${composerSource} sets "data-blueprint-state". Fix: remove it; the compiler stamps`);
    assertReports(errors, 'component.composer.tokenGroupIds names "missing", which tokens.json does not declare. Fix:');
    assertReports(errors, 'component.composer.tokenRoles names "color.missing", which tokens.json does not declare. Fix:');
    assertReports(errors, 'component.composer.tokenRoles.color.primary has no role. Fix:');

    primitive(bundle, 'button').group = '';
    primitive(bundle, 'badge').name = '';
    raw(primitive(bundle, 'icon')).sparkle = true;
    raw(bundle.primitives).primitives = [...bundle.primitives.primitives, 'not an object'];
    const malformed = reusableErrors(bundle);
    assertReports(malformed, 'primitive.button.group is missing. Fix: set it to "actions".');
    assertReports(malformed, 'primitive.badge.name is missing. Fix:');
    assertReports(malformed, 'primitive.icon has unknown field "sparkle". Fix: remove it');
    assertReports(malformed, `primitives[${bundle.primitives.primitives.length - 1}] must be an object. Fix:`);

    raw(bundle.components).groups = 'answers';
    assertReports(reusableErrors(bundle), 'components.groups must be an array. Fix:');
  });
});

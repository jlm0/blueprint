import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import {
  pageProseFields,
  screenProseFields,
  sectionProseFields,
  validateScreenContract
} from '../src/core/screen-contract';
import type { DeclaredGroup, ScreenDefinition, ScreenFile, ScreenSection } from '../src/core/types';

const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';
const starterRoot = 'starter/design/blueprint';

type Raw = Record<string, any>;

function contractErrors(screens: unknown): string[] {
  const errors: string[] = [];
  validateScreenContract(errors, screens as ScreenFile);
  return errors;
}

async function loadScreens(): Promise<Raw> {
  return (await loadProjectFromFs(miraRoot)).screens as unknown as Raw;
}

function firstScreen(screens: Raw): Raw {
  return screens.screens.find((screen: Raw) => screen.id === 'workspace');
}

function firstSection(screens: Raw): Raw {
  return firstScreen(screens).sections[0];
}

function assertReports(errors: string[], expected: string): void {
  assert.ok(errors.some(error => error.includes(expected)), `expected "${expected}" in:\n${errors.join('\n')}`);
}

describe('screen prose fields', () => {
  it('lists the prose of a screen with its path, and skips blank and non-string entries', () => {
    const screen = {
      description: 'What it shows.',
      notes: ['First note.', '  ', 7, 'Last note.'],
      implementationHints: ['A hint.'],
      productionRelationship: { kind: 'new-route', notes: ['A route note.'] }
    } as unknown as ScreenDefinition;

    assert.deepEqual(screenProseFields(screen), [
      { path: 'description', text: 'What it shows.' },
      { path: 'notes[0]', text: 'First note.' },
      { path: 'notes[3]', text: 'Last note.' },
      { path: 'implementationHints[0]', text: 'A hint.' },
      { path: 'productionRelationship.notes[0]', text: 'A route note.' }
    ]);
    assert.deepEqual(screenProseFields({ description: 7, notes: 'x', productionRelationship: 'y' } as unknown as ScreenDefinition), []);
  });

  it('lists the prose of a section and the reason of each use', () => {
    const section = {
      description: ' ',
      uses: [null, { reason: 'Why it is here.' }],
      notes: ['A note.'],
      implementationHints: 'not a list'
    } as unknown as ScreenSection;

    assert.deepEqual(sectionProseFields(section), [
      { path: 'uses[1].reason', text: 'Why it is here.' },
      { path: 'notes[0]', text: 'A note.' }
    ]);
    assert.deepEqual(sectionProseFields({ uses: 'x' } as unknown as ScreenSection), []);
  });

  it('lists only the description of a page', () => {
    assert.deepEqual(pageProseFields({ id: 'web', name: 'Web', description: 'The web pages.' }), [{ path: 'description', text: 'The web pages.' }]);
    assert.deepEqual(pageProseFields({ id: 'web', name: 'Web' } as DeclaredGroup), []);
  });
});

describe('validateScreenContract', () => {
  it('accepts the screens of the starter and a valid fixture', async () => {
    for (const root of [starterRoot, miraRoot]) {
      assert.deepEqual(contractErrors((await loadProjectFromFs(root)).screens), [], root);
    }
  });

  it('closes the file shape and requires a list of pages', async () => {
    const screens = await loadScreens();
    screens.extra = 1;
    delete screens.projectId;
    screens.pages = 'web';

    const errors = contractErrors(screens);
    assertReports(errors, 'screens.json has unknown field "extra". Fix: remove it; it carries only "schemaVersion", "projectId", "pages", "screens".');
    assertReports(errors, 'screens.json is missing "projectId". Fix: add it; every field is required.');
    assertReports(errors, 'screens.pages must be a list. Fix: declare each page as { "id", "name", "description" }.');

    screens.screens = 'not a list';
    assert.doesNotThrow(() => contractErrors(screens));
  });

  it('checks the shape, limits, and prose of a page', async () => {
    const screens = await loadScreens();
    screens.pages = [
      'not a page',
      { id: 'Web Page', name: 'Web', description: 'The web pages.' },
      { id: 'title', name: 'Web Pages', description: 'The web pages.' },
      { id: 'long', name: 'x'.repeat(25), description: 'x'.repeat(121) },
      { id: 'blank', name: 'Blank', description: ' ', extra: true },
      { id: 'prose', name: 'Prose', description: 'The web pages; the phone pages.' }
    ];

    const errors = contractErrors(screens);
    assertReports(errors, 'screens.pages[0] must be an object. Fix: declare it as { "id", "name", "description" }.');
    assertReports(errors, 'screens.page.Web Page.id "Web Page" is not kebab-case. Fix:');
    assertReports(errors, 'screens.page.title.name "Web Pages" is in title case. Fix: write it in sentence case, "Web pages"');
    assertReports(errors, `screens.page.long.name "${'x'.repeat(25)}" is 25 characters. Fix: shorten it to 24 or fewer.`);
    assertReports(errors, 'screens.page.long.description is 121 characters. Fix: shorten it to 120 or fewer.');
    assertReports(errors, 'screens.page.blank.description is missing. Fix: say which screens the page holds, in 120 characters or fewer.');
    assertReports(errors, 'screens.page.blank has unknown field "extra". Fix: remove it');
    assertReports(errors, 'screens.page.prose.description has a semicolon. Fix: split it into two sentences.');
  });

  it('closes the screen shape, allows the optional fields to be absent, and tolerates an old flow', async () => {
    const screens = await loadScreens();
    const screen = firstScreen(screens);
    screen.flow = 'Main';
    delete screen.productionRelationship;
    delete screen.version;
    assert.deepEqual(contractErrors(screens), []);

    screen.banner = true;
    delete screen.notes;
    screens.screens.push('not a screen');
    const errors = contractErrors(screens);
    assertReports(errors, 'screen.workspace has unknown field "banner". Fix: remove it');
    assertReports(errors, 'screen.workspace is missing "notes". Fix: add it; every field except "version", "productionRelationship" is required.');
    assertReports(errors, `screens.screens[${screens.screens.length - 1}] must be an object. Fix: write it in the screen shape`);
  });

  it('checks the id, name, description, and prose of a screen', async () => {
    const screens = await loadScreens();
    const screen = firstScreen(screens);
    screen.id = 'Work Space';
    screen.name = 'x'.repeat(33);
    screen.description = '';
    screen.notes = ['First part; second part.'];

    const errors = contractErrors(screens);
    assertReports(errors, 'screen.Work Space.id "Work Space" is not kebab-case. Fix:');
    assertReports(errors, 'screen.Work Space.name "' + 'x'.repeat(33) + '" is 33 characters. Fix: shorten it to 32 or fewer.');
    assertReports(errors, 'screen.Work Space.description is missing. Fix: say what the screen shows and when it appears, in 200 characters or fewer.');
    assertReports(errors, 'screen.Work Space.notes[0] has a semicolon. Fix: split it into two sentences.');
  });

  it('checks the list fields of a screen and a section', async () => {
    const screens = await loadScreens();
    const screen = firstScreen(screens);
    screen.styleRefs = [1];
    screen.notes = 'a note';
    screen.implementationHints = ['x'.repeat(201)];
    screen.styleEvidence = 'evidence';
    screen.implementationTargets = {};
    screen.prototypeOnly = 'no';
    const section = firstSection(screens);
    section.uses = 'button';
    section.prototypeOnly = 1;

    const errors = contractErrors(screens);
    assertReports(errors, 'screen.workspace.styleRefs must be a list of strings. Fix: write it as [] or ["…"].');
    assertReports(errors, 'screen.workspace.notes must be a list of strings. Fix:');
    assertReports(errors, 'screen.workspace.implementationHints[0] is 201 characters. Fix: shorten it to 200 or fewer, or split it into two entries.');
    assertReports(errors, 'screen.workspace.styleEvidence must be a list. Fix: write it as [] when there is nothing to record.');
    assertReports(errors, 'screen.workspace.implementationTargets must be a list. Fix:');
    assertReports(errors, 'screen.workspace.prototypeOnly must be true or false. Fix: write false unless it never ships.');
    assertReports(errors, `screen.workspace.section.${section.id}.uses must be a list. Fix:`);
    assertReports(errors, `screen.workspace.section.${section.id}.prototypeOnly must be true or false. Fix:`);
  });

  it('checks a production relationship', async () => {
    const screens = await loadScreens();
    const screen = firstScreen(screens);
    screen.productionRelationship = 'new-route';
    assertReports(contractErrors(screens), 'screen.workspace.productionRelationship must be an object. Fix: write it as { "kind", "notes" }');

    screen.productionRelationship = { kind: 'portal', notes: 'x', owner: 'me' };
    const errors = contractErrors(screens);
    assertReports(errors, 'screen.workspace.productionRelationship.kind "portal" is not a relationship kind. Fix: set it to one of "new-route", "existing-route"');
    assertReports(errors, 'screen.workspace.productionRelationship.notes must be a list of strings. Fix:');
    assertReports(errors, 'screen.workspace.productionRelationship has unknown field "owner". Fix: remove it');

    screen.productionRelationship = { notes: [] };
    assertReports(contractErrors(screens), 'screen.workspace.productionRelationship.kind is missing and is not a relationship kind. Fix:');

    screen.productionRelationship = { kind: 'section-replacement', notes: [], routePath: '/a', targetScreenId: 'chat', replacedSectionId: 'x' };
    assert.deepEqual(contractErrors(screens), []);
  });

  it('closes the prototype shape of a screen', async () => {
    const screens = await loadScreens();
    const screen = firstScreen(screens);
    screen.prototype.scripts = ['a.js'];
    delete screen.prototype.states;
    delete screen.prototype.renderedUses;

    const errors = contractErrors(screens);
    assertReports(errors, 'screen.workspace.prototype has unknown field "scripts". Fix: remove it');
    assertReports(errors, 'screen.workspace.prototype is missing "states". Fix: add it; every field except "renderedUses", "localValueExceptions" is required.');
  });

  it('closes the section shape, and checks each use and its prose', async () => {
    const screens = await loadScreens();
    const screen = firstScreen(screens);
    const section = firstSection(screens);
    const label = `screen.workspace.section.${section.id}`;
    section.layout = 'grid';
    section.description = 'One part; two parts.';
    section.uses = [
      'button',
      { kind: 'primitive', id: 'button', reason: 'x'.repeat(201) },
      { kind: 'primitive', id: 'button', reason: '' },
      { kind: 'primitive', id: 'button', reason: 'One part; two parts.', extra: true },
      { kind: 'primitive', id: 'button', reason: 'A bound piece.', binding: 'thread' }
    ];
    screen.sections.push('not a section');

    const errors = contractErrors(screens);
    assertReports(errors, `${label} has unknown field "layout". Fix: remove it`);
    assertReports(errors, `${label}.description has a semicolon. Fix:`);
    assertReports(errors, `${label}.uses[0] must be an object. Fix: write it as { "kind", "id", "reason" }.`);
    assertReports(errors, `${label}.uses[1].reason is 201 characters. Fix: shorten it to 200 or fewer.`);
    assertReports(errors, `${label}.uses[2].reason is missing. Fix: say what the piece does in this section`);
    assertReports(errors, `${label}.uses[3] has unknown field "extra". Fix: remove it`);
    assertReports(errors, `${label}.uses[3].reason has a semicolon. Fix:`);
    assert.equal(errors.some(error => error.includes(`${label}.uses[4]`)), false);
    assertReports(errors, `screen.workspace.sections[${screen.sections.length - 1}] must be an object. Fix: write it in the section shape`);
  });
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { normalizeScreenShapes, normalizeTokenShapes, reportNames, sentenceCaseName } from '../src/core/migrate-shapes';
import { PAGE_FIELDS, SECTION_FIELDS } from '../src/core/screen-contract';
import { structuredFileErrors } from '../src/core/schemas/issues';
import { STRUCTURED_FILE_SCHEMAS } from '../src/core/schemas/project';

type RawObject = Record<string, unknown>;
type Normalize = typeof normalizeScreenShapes;

const fixtureRoot = 'fixtures/valid/mira-ai/design/blueprint';

function runNormalize(normalize: Normalize, files: Record<string, unknown>) {
  const input = new Map(Object.entries(files).map(([file, value]) => [file, JSON.stringify(value)]));
  const writes = new Map<string, string>();
  const changes: string[] = [];
  normalize(input, writes, changes);
  return {
    writes,
    changes,
    read: (file: string): any => {
      const text = writes.get(file);
      assert.ok(text, `expected a write to ${file}`);
      return JSON.parse(text);
    }
  };
}

function screensFile(screens: unknown[], pages: unknown[] = []): RawObject {
  return { schemaVersion: '2.0.0', projectId: 'demo', pages, screens };
}

function assertChange(changes: string[], expected: string): void {
  assert.ok(changes.some(change => change.includes(expected)), `expected "${expected}" in:\n${changes.join('\n')}`);
}

describe('normalizeScreenShapes', () => {
  it('does nothing without screens.json or with a file in the fixed shape, and is stable on its own output', async () => {
    const missing = runNormalize(normalizeScreenShapes, {});
    assert.equal(missing.writes.size, 0);
    assert.deepEqual(missing.changes, []);

    const fixture = JSON.parse(await readFile(path.join(fixtureRoot, 'screens.json'), 'utf8'));
    const clean = runNormalize(normalizeScreenShapes, { 'screens.json': fixture });
    assert.equal(clean.writes.size, 0);
    assert.deepEqual(clean.changes, []);

    const first = runNormalize(normalizeScreenShapes, { 'screens.json': screensFile([{ name: 'Sign In', id: 'a', flow: 'Sign In' }]) });
    const second = runNormalize(normalizeScreenShapes, { 'screens.json': first.read('screens.json') });
    assert.equal(second.writes.size, 0);
    assert.deepEqual(second.changes, []);
  });

  it('moves a flow to a declared page and reports the new page', () => {
    const { read, changes } = runNormalize(normalizeScreenShapes, {
      'screens.json': screensFile([{ id: 'login', name: 'Login', flow: 'Sign In' }])
    });

    const file = read('screens.json');
    assert.equal(file.screens[0].page, 'sign-in');
    assert.equal('flow' in file.screens[0], false);
    assert.deepEqual(file.pages, [{ id: 'sign-in', name: 'Sign in' }]);
    assertChange(changes, 'screens.json: 1 screen moved from flow to page, and 1 new page is declared: "sign-in". Give each new page a description.');
  });

  it('derives a page id and name from any flow text, and declares a page once', () => {
    const { read, changes } = runNormalize(normalizeScreenShapes, {
      'screens.json': screensFile([
        { id: 'a', flow: 'checkout_steps' },
        { id: 'b', flow: 'checkout_steps' },
        { id: 'c', flow: '!!!' },
        { id: 'd', flow: '   ' }
      ])
    });

    const file = read('screens.json');
    assert.deepEqual(file.screens.map((screen: RawObject) => screen.page), ['checkout-steps', 'checkout-steps', 'screens', undefined]);
    assert.equal(file.screens.some((screen: RawObject) => 'flow' in screen), false);
    assert.deepEqual(file.pages.map((page: RawObject) => page.id), ['checkout-steps', 'screens']);
    assert.equal(file.pages[0].name, 'Checkout steps');
    assertChange(changes, 'and 2 new pages are declared: "checkout-steps", "screens".');
  });

  it('keeps the page a screen has, and does not redeclare a page', () => {
    const page = { id: 'web', name: 'Web', description: 'The web pages.' };
    const { read, changes } = runNormalize(normalizeScreenShapes, {
      'screens.json': screensFile([{ id: 'a', page: 'web', flow: 'Other' }, { id: 'b', flow: 'web' }], [page])
    });

    const file = read('screens.json');
    assert.deepEqual(file.screens.map((screen: RawObject) => screen.page), ['web', 'web']);
    assert.deepEqual(file.pages, [page]);
    assertChange(changes, 'screens.json: 1 screen moved from flow to page.');
    assertChange(changes, 'screens.json: dropped the flow of 1 screen that already had a page or had no flow text.');
    assert.equal(changes.some(change => change.includes('new page')), false);
  });

  it('fills required fields with empty values, and keeps values already set', () => {
    const { read, changes } = runNormalize(normalizeScreenShapes, {
      'screens.json': screensFile([
        { id: 'a', notes: ['Keep me.'], sections: [{ id: 's', prototypeOnly: true }], productionRelationship: { kind: 'new-route' } }
      ])
    });

    const screen = read('screens.json').screens[0];
    assert.deepEqual(screen.notes, ['Keep me.']);
    assert.deepEqual(screen.styleRefs, []);
    assert.equal(screen.prototypeOnly, false);
    assert.equal(screen.sections[0].prototypeOnly, true);
    assert.deepEqual(screen.sections[0].uses, []);
    assert.deepEqual(screen.productionRelationship.notes, []);
    assertChange(changes, 'screens.json: added the fields the fixed shape requires to 3 of the screens and sections, as empty lists or false.');
  });

  it('writes the contract field order, with unknown fields last for validation to report', () => {
    const { read, changes } = runNormalize(normalizeScreenShapes, {
      'screens.json': {
        screens: [{
          legacy: true,
          sections: [{
            uses: [{ binding: 'x', reason: 'r', id: 'button', kind: 'primitive' }],
            description: 'The body.',
            name: 'Body',
            id: 'body'
          }],
          productionRelationship: { notes: [], routePath: '/a', kind: 'new-route' },
          name: 'Home',
          id: 'home'
        }],
        pages: [{ description: 'All.', name: 'All', id: 'all' }],
        projectId: 'demo',
        schemaVersion: '2.0.0'
      }
    });

    const file = read('screens.json');
    assert.deepEqual(Object.keys(file), ['schemaVersion', 'projectId', 'pages', 'screens']);
    assert.deepEqual(Object.keys(file.pages[0]), [...PAGE_FIELDS]);
    const screen = file.screens[0];
    assert.deepEqual(Object.keys(screen).slice(0, 2), ['id', 'name']);
    assert.equal(Object.keys(screen).at(-1), 'legacy');
    assert.deepEqual(Object.keys(screen.productionRelationship), ['kind', 'routePath', 'notes']);
    assert.deepEqual(Object.keys(screen.sections[0]), [...SECTION_FIELDS]);
    assert.deepEqual(Object.keys(screen.sections[0].uses[0]), ['kind', 'id', 'reason', 'binding']);
    assertChange(changes, 'screens.json: pages, screens, and sections now use the fixed field order.');
  });

  it('sentence-cases names, and leaves a malformed entry in place for validation', () => {
    const { read, changes } = runNormalize(normalizeScreenShapes, {
      'screens.json': screensFile(
        ['not a screen', { id: 'a', name: 'Home Page', sections: ['not a section', { id: 's', name: 'Hero Banner', uses: [7] }] }],
        [{ id: 'p', name: 'Web Pages' }, { id: 'q', name: 'Phone' }, 'archive']
      )
    });

    const file = read('screens.json');
    assert.equal(file.pages[0].name, 'Web pages');
    assert.equal(file.pages[2], 'archive');
    const screensSchema = STRUCTURED_FILE_SCHEMAS.find(entry => entry.file === 'screens.json')!.schema;
    assert.ok(
      structuredFileErrors('screens.json', screensSchema, file).includes('screens.json: pages[2] must be a JSON object. Fix: write pages[2] as a JSON object.'),
      'load reports the malformed page'
    );
    assert.equal(file.screens[0], 'not a screen');
    assert.equal(file.screens[1].name, 'Home page');
    assert.equal(file.screens[1].sections[0], 'not a section');
    assert.equal(file.screens[1].sections[1].name, 'Hero banner');
    assert.deepEqual(file.screens[1].sections[1].uses, [7]);
    assertChange(changes, 'screens.json: 3 names now use sentence case, such as "Home page", "Hero banner", "Web pages".');
  });

  it('puts saved screen snapshots in the fixed shape, and keeps their flow', () => {
    const { read, writes, changes } = runNormalize(normalizeScreenShapes, {
      'screens.json': screensFile([]),
      'explorations/one.json': { exploration: { target: { baseline: { screen: { name: 'Home Page', flow: 'Main', id: 'a' } } } } },
      'history/two.json': { entry: { screen: { id: 'b' } } },
      'history/no-screen.json': { entry: { other: true } },
      'explorations/nested/three.json': { entry: { screen: { id: 'c' } } }
    });

    const baseline = read('explorations/one.json').exploration.target.baseline.screen;
    assert.equal(baseline.flow, 'Main');
    assert.equal(baseline.page, undefined);
    assert.equal(baseline.name, 'Home page');
    assert.deepEqual(baseline.notes, []);
    assert.deepEqual(read('history/two.json').entry.screen.sections, []);
    assert.equal(writes.has('history/no-screen.json'), false);
    assert.equal(writes.has('explorations/nested/three.json'), false);
    assertChange(changes, 'explorations and history: 2 saved screen snapshots now use the fixed screen shape.');
  });

  it('reads a pending write in place of the file on disk', () => {
    const pending = JSON.stringify(screensFile([{ id: 'pending', flow: 'Main' }]));
    const writes = new Map([['screens.json', pending]]);
    normalizeScreenShapes(new Map([['screens.json', JSON.stringify(screensFile([{ id: 'stale' }]))]]), writes, []);

    assert.equal(JSON.parse(writes.get('screens.json') ?? '').screens[0].id, 'pending');
  });
});

describe('normalizeTokenShapes', () => {
  it('does nothing without tokens.json, and leaves a file in the fixed shape alone', async () => {
    const missing = runNormalize(normalizeTokenShapes, {});
    assert.equal(missing.writes.size, 0);
    assert.deepEqual(missing.changes, []);

    const fixture = JSON.parse(await readFile(path.join(fixtureRoot, 'tokens.json'), 'utf8'));
    const clean = runNormalize(normalizeTokenShapes, { 'tokens.json': fixture });
    assert.equal(clean.writes.size, 0);
    assert.deepEqual(clean.changes, []);
  });

  it('renames old token types, fills group fields, sentence-cases names, and orders fields', () => {
    const { read, changes } = runNormalize(normalizeTokenShapes, {
      'tokens.json': {
        tokenGroups: [{
          tokens: [
            { value: '4px', type: 'spacing', name: 'Base Unit', id: 'base' },
            { id: 'wide', name: 'Wide', type: 'spacing', value: '8px' },
            { id: 'ink', name: 'Ink', type: 'colour', value: '#000' },
            { id: 'odd', name: 'Odd', type: 'constructor', value: 'x' },
            'not a token'
          ],
          name: 'Space Scale',
          id: 'space'
        }, 'not a group'],
        projectId: 'demo',
        schemaVersion: '2.0.0'
      }
    });

    const file = read('tokens.json');
    assert.equal(file.tokenGroups[1], 'not a group');
    const group = file.tokenGroups[0];
    assert.deepEqual(group.tokens.slice(0, 4).map((token: RawObject) => token.type), ['space', 'space', 'color', 'constructor']);
    assert.equal(group.tokens[4], 'not a token');
    assert.equal(group.tokens[0].name, 'Base unit');
    assert.deepEqual(Object.keys(group.tokens[0]).slice(0, 2), ['id', 'name']);
    assert.equal(group.name, 'Space scale');
    assert.deepEqual(group.styleRefs, []);
    assert.deepEqual(group.notes, []);
    assert.deepEqual(Object.keys(file).slice(0, 2), ['schemaVersion', 'projectId']);
    assertChange(changes, 'tokens.json: 2 tokens of type "spacing" now use the type "space".');
    assertChange(changes, 'tokens.json: 1 token of type "colour" now uses the type "color".');
    assertChange(changes, 'styleRefs and notes');
    assertChange(changes, 'tokens.json: 2 names now use sentence case, such as "Space scale", "Base unit".');
    assertChange(changes, 'tokens.json: token groups and tokens now use the fixed field order.');
  });
});

describe('sentenceCaseName and reportNames', () => {
  it('rewrites only a title-case name, and reports the rewrites with at most three examples', () => {
    const tally = { renamed: [] as string[] };
    const items: RawObject[] = [{ name: 'Auth Heading' }, { name: 'OTP input' }, { name: 'Ask AI' }, { name: 7 }, {}];
    for (const item of items) sentenceCaseName(item, tally);

    assert.deepEqual(items.map(item => item.name), ['Auth heading', 'OTP input', 'Ask AI', 7, undefined]);
    assert.deepEqual(tally.renamed, ['Auth heading']);

    const none: string[] = [];
    reportNames(none, 'components.json', { renamed: [] });
    assert.deepEqual(none, []);

    const changes: string[] = [];
    reportNames(changes, 'components.json', { renamed: ['One a', 'Two b', 'Three c', 'Four d'] });
    assert.equal(changes.length, 1);
    assert.match(changes[0], /^components\.json: 4 names now use sentence case, such as "One a", "Two b", "Three c"\. Capitalize/);
    assert.doesNotMatch(changes[0], /Four d/);
  });
});

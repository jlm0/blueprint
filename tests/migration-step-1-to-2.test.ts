import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { step } from '../src/core/migrations/1.0.0-to-2.0.0';

type RawObject = Record<string, any>;

function project(primitives: unknown[], extra: Record<string, unknown> = {}): Map<string, string> {
  const files: Record<string, unknown> = {
    'manifest.json': { schemaVersion: '1.0.0', project: { id: 'demo', name: 'Demo' } },
    'tokens.json': { schemaVersion: '1.0.0', projectId: 'demo', tokenGroups: [] },
    'screens.json': { schemaVersion: '1.0.0', projectId: 'demo', screens: [] },
    'primitives.json': { schemaVersion: '1.0.0', projectId: 'demo', primitives },
    'components.json': { schemaVersion: '1.0.0', projectId: 'demo', sections: [], components: [] },
    ...extra
  };
  return new Map(Object.entries(files).map(([file, value]) => [file, typeof value === 'string' ? value : JSON.stringify(value)]));
}

function primitive(output: Map<string, string>, id: string): RawObject {
  return JSON.parse(output.get('primitives.json')!).primitives.find((candidate: RawObject) => candidate.id === id);
}

function valueIds(axis: RawObject): string[] {
  return axis.values.map((value: RawObject) => value.id);
}

const V1_STATES_TO_VARIANTS = ['slider', 'surface', 'nav-bar', 'list', 'pressable-row', 'row-layout', 'loading-mark', 'skeleton', 'alert-dialog', 'bottom-sheet', 'tooltip'];

describe('step 1.0.0 to 2.0.0: axis moves', () => {
  for (const id of V1_STATES_TO_VARIANTS) {
    it(`moves the non-runtime states of ${id} to variants, in the file, its placements, its CSS, and its bindings`, () => {
      const source = `prototype/primitives/${id}.html`;
      const styles = `prototype/primitives/${id}.css`;
      const { files, changes } = step.run(project(
        [{ id, name: id, prototype: { source, styles: [styles], states: ['hover', 'app-tone'] } }],
        {
          [source]: `<div data-blueprint-primitive="${id}"></div>`,
          [styles]: '.a[data-blueprint-state="app-tone"] { color: inherit }',
          'prototype/screens/home.html': `<blueprint-use kind="primitive" ref="${id}" state="app-tone"></blueprint-use><blueprint-use kind="primitive" ref="${id}" state="hover"></blueprint-use>`,
          'screens.json': {
            schemaVersion: '1.0.0',
            projectId: 'demo',
            screens: [{ id: 'home', sections: [{ id: 'body', uses: [{ kind: 'primitive', id, binding: { state: 'app-tone' } }] }] }]
          }
        }
      ));

      const moved = primitive(files, id);
      assert.ok(valueIds(moved.variants).includes('app-tone'));
      assert.ok(!valueIds(moved.states).includes('app-tone'));
      assert.ok(valueIds(moved.states).includes('hover'));
      assert.equal(files.get('prototype/screens/home.html'), `<blueprint-use kind="primitive" ref="${id}" variant="app-tone"></blueprint-use><blueprint-use kind="primitive" ref="${id}" state="hover"></blueprint-use>`);
      assert.equal(files.get(styles), '.a[data-blueprint-variant="app-tone"] { color: inherit }');
      assert.deepEqual(JSON.parse(files.get('screens.json')!).screens[0].sections[0].uses[0].binding, { variant: 'app-tone' });
      assert.ok(changes.includes(`primitive ${id}: states app-tone are now variants.`), changes.join('\n'));
    });
  }

  it('moves every variant of text to sizes and every state of text to variants', () => {
    const { files, changes } = step.run(project(
      [{ id: 'text', name: 'Text', prototype: { source: 'prototype/primitives/text.html', styles: [], variants: ['display', 'body'], states: ['default', 'muted'] } }],
      {
        'prototype/primitives/text.html': '<span data-blueprint-primitive="text"></span>',
        'prototype/screens/home.html': '<blueprint-use kind="primitive" ref="text" variant="display" state="muted"></blueprint-use>'
      }
    ));

    const text = primitive(files, 'text');
    assert.deepEqual(valueIds(text.sizes), ['display', 'body']);
    assert.deepEqual(valueIds(text.variants), ['default', 'muted']);
    assert.deepEqual(valueIds(text.states), ['default']);
    assert.equal(files.get('prototype/screens/home.html'), '<blueprint-use kind="primitive" ref="text" size="display" variant="muted"></blueprint-use>');
    assert.ok(changes.includes('primitive text: variants display, body are now sizes.'), changes.join('\n'));
    assert.ok(changes.includes('primitive text: states default, muted are now variants.'), changes.join('\n'));
  });

  it('moves the non-runtime states of back-button to sizes, and adds the resting state Blueprint requires', () => {
    const { files, changes } = step.run(project(
      [{ id: 'back-button', name: 'Back Button', prototype: { source: 'prototype/primitives/back-button.html', styles: [], states: ['md', 'sm'] } }],
      {
        'prototype/primitives/back-button.html': '<button data-blueprint-primitive="back-button"></button>',
        'prototype/screens/home.html': '<blueprint-use kind="primitive" ref="back-button" state="sm"></blueprint-use>'
      }
    ));

    const back = primitive(files, 'back-button');
    assert.deepEqual(valueIds(back.sizes), ['md', 'sm']);
    assert.deepEqual(valueIds(back.states), ['normal']);
    assert.equal(back.name, 'Back button');
    assert.equal(files.get('prototype/screens/home.html'), '<blueprint-use kind="primitive" ref="back-button" size="sm"></blueprint-use>');
    assert.ok(changes.includes('primitive back-button: states md, sm are now sizes.'), changes.join('\n'));
    assert.ok(changes.includes('primitive back-button: added the resting state "normal" Blueprint now requires.'), changes.join('\n'));
    assert.ok(changes.includes('primitive back-button: renamed "Back Button" to its Blueprint name "Back button".'), changes.join('\n'));
  });

  it('moves no value of a primitive outside the move list', () => {
    const { files, changes } = step.run(project(
      [{ id: 'rating', name: 'Rating', prototype: { source: 'prototype/primitives/rating.html', styles: [], variants: ['stars'], states: ['app-tone'] } }],
      {
        'prototype/primitives/rating.html': '<div data-blueprint-primitive="rating"></div>',
        'prototype/screens/home.html': '<blueprint-use kind="primitive" ref="rating" state="app-tone"></blueprint-use>'
      }
    ));

    const rating = primitive(files, 'rating');
    assert.deepEqual(valueIds(rating.variants), ['stars']);
    assert.deepEqual(valueIds(rating.states), ['app-tone']);
    assert.equal(files.get('prototype/screens/home.html'), '<blueprint-use kind="primitive" ref="rating" state="app-tone"></blueprint-use>');
    assert.equal(changes.some(change => change.includes('are now')), false, changes.join('\n'));
  });

  it('reports a placement that a move would give the same attribute twice, and leaves it', () => {
    const { files, changes } = step.run(project(
      [{ id: 'slider', name: 'Slider', prototype: { source: 'prototype/primitives/slider.html', styles: [], variants: ['wide'], states: ['app-tone'] } }],
      {
        'prototype/primitives/slider.html': '<div data-blueprint-primitive="slider"></div>',
        'prototype/screens/home.html': '<blueprint-use kind="primitive" ref="slider" variant="wide" state="app-tone"></blueprint-use>'
      }
    ));

    assert.equal(files.get('prototype/screens/home.html'), '<blueprint-use kind="primitive" ref="slider" variant="wide" state="app-tone"></blueprint-use>');
    assert.ok(changes.includes('prototype/screens/home.html: a slider placement would set "variant" twice after the move, so it was left as it was; set its variant, size, and state by hand.'), changes.join('\n'));
  });
});

describe('step 1.0.0 to 2.0.0: state sets', () => {
  it('folds state names, notes, and hints into the primitive, and drops the state sets', () => {
    const { files } = step.run(project([{
      id: 'rating',
      name: 'Rating',
      notes: ['Own note.'],
      implementationHints: ['Own hint.'],
      stateSets: [
        { id: 'one', states: [{ id: 'hover', name: 'Pointer Over', notes: ['Lifts the star.'], implementationHints: ['Use a transform.'] }] },
        { id: 'two', states: [{ id: 'hover', name: 'Other Name', notes: ['Lifts the star.'] }, { id: 'app-tone', implementationHints: ['Tint it.'] }] }
      ],
      prototype: { source: 'prototype/primitives/rating.html', styles: [], states: ['hover', 'app-tone', 'open'] }
    }], { 'prototype/primitives/rating.html': '<div data-blueprint-primitive="rating"></div>' }));

    const rating = primitive(files, 'rating');
    assert.equal('stateSets' in rating, false);
    assert.deepEqual(rating.states.values.map((value: RawObject) => [value.id, value.name]), [['hover', 'Pointer over'], ['app-tone', 'app-tone'], ['open', 'Open']]);
    assert.deepEqual(rating.notes, ['Own note.', 'Pointer over: Lifts the star.', 'Other name: Lifts the star.']);
    assert.deepEqual(rating.implementationHints, ['Own hint.', 'Pointer over: Use a transform.', 'app-tone: Tint it.']);
  });

  it('keeps the frozen Blueprint name of a value over a state set name', () => {
    const { files } = step.run(project([{
      id: 'switch',
      name: 'Switch',
      stateSets: [{ id: 'one', states: [{ id: 'disabled', name: 'Turned Off' }] }],
      prototype: { source: 'prototype/primitives/switch.html', styles: [], states: ['disabled'] }
    }], { 'prototype/primitives/switch.html': '<button data-blueprint-primitive="switch"></button>' }));

    const value = primitive(files, 'switch').states.values.find((candidate: RawObject) => candidate.id === 'disabled');
    assert.equal(value.name, 'Disabled');
  });

  it('turns a state-set use into a primitive use, a token-group use into a token group, and drops the other kinds with a report', () => {
    const { files, changes } = step.run(project([
      {
        id: 'rating',
        name: 'Rating',
        tokenGroupIds: ['color'],
        uses: [
          { kind: 'state-set', id: 'button/default', reason: 'The press state.' },
          { kind: 'primitive', id: 'button', reason: 'The action.' },
          { kind: 'token-group', id: 'space' },
          { kind: 'brand-mark', id: 'logo' }
        ],
        prototype: { source: 'prototype/primitives/rating.html', styles: [] }
      }
    ], { 'prototype/primitives/rating.html': '<div data-blueprint-primitive="rating"></div>' }));

    const rating = primitive(files, 'rating');
    assert.deepEqual(rating.uses, [{ kind: 'primitive', id: 'button', reason: 'The press state.; The action.' }]);
    assert.deepEqual(rating.tokenGroupIds, ['color', 'space']);
    assert.ok(changes.includes('primitive rating: dropped its brand-mark dependency "logo"; a reusable lists only the primitives and components it renders.'), changes.join('\n'));
  });

  it('turns state-set section uses in screens and saved snapshots into primitive uses', () => {
    const use = { kind: 'state-set', id: 'button/hover' };
    const { files, changes } = step.run(project([], {
      'screens.json': { schemaVersion: '1.0.0', projectId: 'demo', screens: [{ id: 'home', sections: [{ id: 'body', uses: [use] }] }] },
      'history/home-v1.json': { schemaVersion: '1.0.0', projectId: 'demo', entry: { screen: { id: 'home', sections: [{ id: 'body', uses: [use] }] } } }
    }));

    assert.deepEqual(JSON.parse(files.get('screens.json')!).screens[0].sections[0].uses, [{ kind: 'primitive', id: 'button' }]);
    assert.deepEqual(JSON.parse(files.get('history/home-v1.json')!).entry.screen.sections[0].uses, [{ kind: 'primitive', id: 'button' }]);
    assert.ok(changes.includes('Moved 2 screen section binding values to the new axes.'), changes.join('\n'));
  });
});

describe('step 1.0.0 to 2.0.0: versions', () => {
  it('stamps every structured file and saved record on 1.0.0, and reports only the files it did not reshape', () => {
    const { files, stamped } = step.run(project([], {
      'brand.json': { schemaVersion: '1.0.0', projectId: 'demo' },
      'explorations/a.json': { schemaVersion: '1.0.0', projectId: 'demo' },
      'history/b-v1.json': { projectId: 'demo' },
      'history/c-v1.json': { schemaVersion: '2.0.0', projectId: 'demo' },
      'explorations/nested/d.json': { schemaVersion: '1.0.0' }
    }));

    assert.deepEqual(stamped, { files: ['manifest.json', 'tokens.json', 'brand.json', 'screens.json'], records: ['explorations/a.json', 'history/b-v1.json'] });
    for (const file of ['manifest.json', 'tokens.json', 'brand.json', 'screens.json', 'primitives.json', 'components.json', 'explorations/a.json', 'history/b-v1.json']) {
      assert.equal(JSON.parse(files.get(file)!).schemaVersion, '2.0.0', file);
    }
    assert.deepEqual(Object.keys(JSON.parse(files.get('history/b-v1.json')!)), ['schemaVersion', 'projectId']);
    assert.equal(files.get('history/c-v1.json'), JSON.stringify({ schemaVersion: '2.0.0', projectId: 'demo' }));
    assert.equal(files.get('explorations/nested/d.json'), JSON.stringify({ schemaVersion: '1.0.0' }));
  });

  it('does not reshape reusables already on 2.0.0, and keeps a version past 2.0.0', () => {
    const current = { schemaVersion: '2.0.0', projectId: 'demo', primitives: [], extra: true };
    const { files, changes } = step.run(project([], {
      'primitives.json': current,
      'components.json': { schemaVersion: '2.0.0', projectId: 'demo', groups: [], components: [], extra: true },
      'tokens.json': { schemaVersion: '3.0.0', projectId: 'demo', tokenGroups: [] }
    }));

    assert.deepEqual(changes, []);
    assert.equal(files.get('primitives.json'), JSON.stringify(current));
    assert.equal(JSON.parse(files.get('tokens.json')!).schemaVersion, '3.0.0');
    assert.equal(JSON.parse(files.get('manifest.json')!).schemaVersion, '2.0.0');
  });

  it('keeps each reshaped primitive already in the shared shape when only components.json is on 1.0.0', () => {
    const shared = { id: 'rating', name: 'Rating', states: { default: 'default', values: [{ id: 'default', name: 'Default', description: '' }] } };
    const { files, stamped } = step.run(project([], {
      'primitives.json': { schemaVersion: '2.0.0', projectId: 'demo', primitives: [shared] }
    }));

    assert.deepEqual(JSON.parse(files.get('primitives.json')!).primitives, [shared]);
    assert.equal(JSON.parse(files.get('components.json')!).schemaVersion, '2.0.0');
    assert.equal(stamped.files.includes('primitives.json'), false);
  });
});

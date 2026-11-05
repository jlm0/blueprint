import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElementIndex, createFrameOutputHasher, frameOutputOutsideRules, type FrameOutputTarget, type FrameShape } from '../src/app/frame-output';
import { createFrameOutputService, framesInChangeScope, type FrameOutputAnswer } from '../src/app/frame-output-service';
import { onlyTokenValuesChanged } from '../src/app/frame-rebuild';
import { listCssOutputItems, listCssRules } from '../src/core/css';
import { loadProjectFromFs } from '../src/core/load';
import { createPrototypeDocumentCompiler } from '../src/prototype/compiler';
import type { CanvasProjectBundle, FramePreset } from '../src/core/types';

const preset = { id: 'phone', name: 'Phone', type: 'mobile', width: 390, height: 844 } as FramePreset;
const target: FrameOutputTarget = { key: 'one', screenId: 'one', state: 'default', preset };
const otherTarget: FrameOutputTarget = { key: 'two', screenId: 'two', state: 'default', preset };

interface Files {
  css?: string;
  html?: string;
  primary?: string;
  quiet?: string;
  title?: string;
  safeTop?: number;
}

function screen(id: string, source: string, styles: string[]) {
  return {
    id,
    name: id,
    sections: [],
    prototype: { source, styles, assetRefs: ['logo.png'], states: ['default'], renderedUses: [], reviewConditions: [] }
  };
}

function bundle({ css = '.a { color: var(--primary); }', html = '<main><p class="a">One</p></main>', primary = '#111111', quiet = '#222222', title = 'Demo' }: Files = {}, logo = 'sha-1'): CanvasProjectBundle {
  return {
    manifest: { project: { id: 'demo', name: title }, prototypeHost: { network: 'deny', scripts: 'none' }, framePresets: [preset] },
    tokens: { tokenGroups: [{ id: 'color', tokens: [
      { id: 'primary', value: primary, styleRef: '--primary' },
      { id: 'quiet', value: quiet, styleRef: '--quiet' }
    ] }] },
    primitives: { primitives: [] },
    components: { components: [] },
    screens: { screens: [screen('one', 'one.html', ['one.css']), screen('two', 'two.html', ['two.css'])] },
    prototypeSourceContents: { 'one.html': html, 'one.css': css, 'two.html': '<main><p class="b">Two</p></main>', 'two.css': '.b { color: var(--quiet); }' },
    prototypeAssetContents: { 'logo.png': { sha256: logo, mediaType: 'image/png', size: 1 } }
  } as unknown as CanvasProjectBundle;
}

function hash(files: Files, frame: FrameOutputTarget = target, logo?: string): string {
  return createFrameOutputHasher(bundle(files, logo))(frame);
}

describe('Blueprint frame output hash', () => {
  it('keeps a rule on an element that the parser adds', () => {
    const table = '<main><table><td>One</td><col></table></main>';
    for (const tag of ['tbody', 'tr', 'colgroup']) {
      assert.notEqual(hash({ html: table, css: `${tag} { color: #111111; }` }), hash({ html: table, css: `${tag} { color: #222222; }` }), tag);
    }
    const image = '<main><image src="logo.png" alt=""></main>';
    assert.notEqual(hash({ html: image, css: 'img { width: 10px; }' }), hash({ html: image, css: 'img { width: 20px; }' }));
  });

  it('reads the first value of a duplicate attribute, as the browser does', () => {
    const html = '<main><p data-tone="one" data-tone="two">One</p></main>';
    assert.notEqual(hash({ html, css: '[data-tone="one"] { color: #111111; }' }), hash({ html, css: '[data-tone="one"] { color: #222222; }' }));
  });

  it('keeps the white space of a string', () => {
    assert.notEqual(hash({ css: '.a::before { content: "a b"; white-space: pre; }' }), hash({ css: '.a::before { content: "a  b"; white-space: pre; }' }));
    assert.equal(hash({ css: '.a::before { content: "a b"; }' }), hash({ css: '.a::before {\n  content:   "a b";\n}' }));
  });

  it('holds one value for one source', () => {
    assert.equal(hash({}), hash({}));
    assert.ok(!hash({}).startsWith('error:'), hash({}));
  });

  it('changes when a token that the frame reads changes, and not for a token that it does not read', () => {
    assert.notEqual(hash({ primary: '#333333' }), hash({}));
    assert.equal(hash({ quiet: '#333333' }), hash({}));
  });

  it('changes when the markup, a live rule, or the safe area changes', () => {
    assert.notEqual(hash({ html: '<main><p class="a">Two</p></main>' }), hash({}));
    assert.notEqual(hash({ css: '.a { color: red; }' }), hash({}));
    assert.notEqual(createFrameOutputHasher(bundle())({ ...target, preset: { ...preset, safeArea: { top: 20, right: 0, bottom: 0, left: 0 } } }), hash({}));
  });

  it('does not change for a comment, for white space in a sheet, or for the project name', () => {
    assert.equal(hash({ css: '/* note */\n.a {\n  /* why */\n  color:   var(--primary);\n}\n' }), hash({}));
    assert.equal(hash({ title: 'Renamed' }), hash({}));
  });

  it('does not change for a rule that no element of the frame can match', () => {
    const dead = (opacity: number): Files => ({ css: `.a { color: var(--primary); }\n[data-state="off"].a { opacity: ${opacity}; }` });
    assert.equal(hash(dead(0.3)), hash(dead(0.5)));
    assert.equal(hash({ css: '.a { color: red; } .missing { color: var(--quiet); }', quiet: '#000000' }), hash({ css: '.a { color: red; } .missing { color: var(--quiet); }' }));
  });

  it('changes when an element can match the rule on one element', () => {
    const html = '<main><p class="a" data-state="off">One</p></main>';
    const live = (opacity: number): Files => ({ html, css: `[data-state="off"].a { opacity: ${opacity}; }` });
    assert.notEqual(hash(live(0.3)), hash(live(0.5)));
  });

  it('treats a selector that needs 2 elements as live only when both exist', () => {
    const rule = (opacity: number, html: string): Files => ({ html, css: `.x .a { opacity: ${opacity}; }` });
    const absent = '<main><p class="a">One</p></main>';
    assert.equal(hash(rule(0.3, absent)), hash(rule(0.5, absent)));
    const present = '<main class="x"><p class="a">One</p></main>';
    assert.notEqual(hash(rule(0.3, present)), hash(rule(0.5, present)));
  });

  it('counts the state on the html element', () => {
    const rule = (opacity: number, state: string): Files => ({ css: `html[data-blueprint-state="${state}"] .a { opacity: ${opacity}; }` });
    assert.notEqual(hash(rule(0.3, 'default')), hash(rule(0.5, 'default')));
    assert.equal(hash(rule(0.3, 'other')), hash(rule(0.5, 'other')));
  });

  it('keeps a rule live for an operator that it cannot compare, for a character reference, and for a selector that it cannot read', () => {
    const cases: Array<[string, string]> = [
      ['<main><p class="a b" data-x="one two">One</p></main>', '[data-x~="two"]'],
      ['<main><p data-x="one&amp;two">One</p></main>', '[data-x="one&two"]'],
      ['<main><p class="a&#98;">One</p></main>', '.ab'],
      ['<main><p>One</p></main>', ':not(.missing)'],
      ['<main><p>One</p></main>', ':is(.missing, p)'],
      ['<main><p>One</p></main>', ':where(main p)'],
      ['<main><p>One</p></main>', ':is(p:has(.x), .missing)'],
      ['<main><p>One</p></main>', 'p:hover'],
      ['<main><p>One</p></main>', 'p::before']
    ];
    for (const [html, selector] of cases) {
      assert.notEqual(hash({ html, css: `${selector} { opacity: 0.3; }` }), hash({ html, css: `${selector} { opacity: 0.5; }` }), selector);
    }
  });

  it('keeps each rule in a keyframes block and each nested rule', () => {
    const keyframes = (opacity: number): Files => ({ css: `@keyframes pulse { from { opacity: ${opacity}; } }` });
    assert.notEqual(hash(keyframes(0.3)), hash(keyframes(0.5)));
    const nested = (opacity: number): Files => ({ css: `.missing { opacity: 1; .a { opacity: ${opacity}; } }` });
    assert.notEqual(hash(nested(0.3)), hash(nested(0.5)));
    const reads = (primary: string): Files => ({ css: '@keyframes pulse { from { color: var(--primary); } }', primary });
    assert.notEqual(hash(reads('#333333')), hash(reads('#444444')));
  });

  it('hashes each token for a sheet or a markup that it cannot read', () => {
    const unreadable = (quiet: string): Files => ({ css: '.a { color: var(--primary); ', quiet });
    assert.equal(listCssRules('.a { color: var(--primary); '), null);
    assert.notEqual(hash(unreadable('#333333')), hash(unreadable('#444444')));
    const styleElement = (quiet: string): Files => ({ html: '<main><style>.a { color: red; }</style></main>', css: '', quiet });
    assert.notEqual(hash(styleElement('#333333')), hash(styleElement('#444444')));
    const reference = (quiet: string): Files => ({ html: '<main><p style="color: var(&#45;-quiet)"></p></main>', css: '', quiet });
    assert.notEqual(hash(reference('#333333')), hash(reference('#444444')));
    const query = (quiet: string): Files => ({ css: '@container style(--quiet: red) { .a { color: red; } }', quiet });
    assert.notEqual(hash(query('#333333')), hash(query('#444444')));
  });

  it('reads a token through a var() in an HTML attribute', () => {
    const attribute = (quiet: string): Files => ({ html: '<svg><rect fill="var(--quiet)"></rect></svg>', css: '', quiet });
    assert.notEqual(hash(attribute('#333333')), hash(attribute('#444444')));
  });

  it('answers with the compile error of a frame that does not compile', () => {
    assert.match(hash({ html: '<blueprint-use kind="primitive" ref="missing"></blueprint-use>' }), /^error:/);
  });

  it('names apart the output that a computed style cannot read', () => {
    const outside = (files: Files, logo?: string): string => frameOutputOutsideRules(hash(files, target, logo));
    const img = '<main><p class="a">One</p><img src="logo.png" alt=""></main>';
    assert.notEqual(outside({ html: img }, 'sha-2'), outside({ html: img }, 'sha-1'), 'asset bytes');
    assert.equal(outside({ primary: '#333333' }), outside({}), 'a token that a plain rule reads');
    assert.equal(outside({ css: '.a { color: red; }' }), outside({}), 'a plain rule');
    assert.equal(outside({ css: '.a::before { content: "x"; color: red; }' }), outside({ css: '.a::before { content: "x"; color: blue; }' }), 'a generated part that the diff reads');
    assert.notEqual(outside({ css: '.a::first-line { color: red; }' }), outside({ css: '.a::first-line { color: blue; }' }), 'a part that the diff does not read');
    assert.notEqual(outside({ css: '.a:first-letter { color: red; }' }), outside({ css: '.a:first-letter { color: blue; }' }), 'a legacy form of that part');
    assert.equal(outside({ css: '.a:before { content: "x"; color: red; }' }), outside({ css: '.a:before { content: "x"; color: blue; }' }), 'a legacy form of a generated part');
    assert.notEqual(outside({ css: '@keyframes k { to { opacity: 0; } }' }), outside({ css: '@keyframes k { to { opacity: 1; } }' }), 'a keyframes block');
    const firstLine = { css: '.a::first-line { color: var(--primary); }' };
    assert.notEqual(outside({ ...firstLine, primary: '#333333' }), outside(firstLine), 'a token that a part reads');
    const keyframes = { css: '@keyframes k { to { color: var(--primary); } }' };
    assert.notEqual(outside({ ...keyframes, primary: '#333333' }), outside(keyframes), 'a token that a keyframes block reads');
  });

  it('changes when the bytes of an asset that the frame holds change', () => {
    const html = '<main><img src="logo.png" alt=""></main>';
    assert.notEqual(hash({ html }, target, 'sha-2'), hash({ html }, target, 'sha-1'));
    assert.equal(hash({}, target, 'sha-2'), hash({}, target, 'sha-1'));
  });
});

describe('Blueprint CSS output items', () => {
  it('drop comments and white space, and keep at-rules', () => {
    const items = listCssOutputItems('/* a */ @media (min-width: 1px) { .a { /* b */ color : red ; } }');
    assert.deepEqual(items?.map(item => item.text), ['@media (min-width: 1px){', '.a{color:red;}', '}']);
    assert.deepEqual(items?.[1].selectors?.map(selector => selector.text), ['.a']);
  });

  it('are null for a read that this reader cannot name', () => {
    assert.equal(listCssOutputItems('.a { color: var(--\\69 nk); }'), null);
    assert.equal(listCssOutputItems('@container style(--ink: red) { .a { color: red; } }'), null);
    assert.equal(listCssOutputItems('.a { color: red; '), null);
  });
});

describe('Blueprint element index', () => {
  it('requires each part of a compound on one element', () => {
    const { canMatch } = createElementIndex('<p class="a" data-x="1"></p><p class="b" data-x="2"></p>', 'default');
    const selector = (text: string) => {
      const rules = listCssRules(`${text} { color: red; }`);
      assert.ok(rules);
      return rules[0].selectors[0];
    };
    assert.equal(canMatch(selector('.a[data-x="1"]')), true);
    assert.equal(canMatch(selector('.a[data-x="2"]')), false);
    assert.equal(canMatch(selector('p.a.b')), false);
    assert.equal(canMatch(selector('.a + .b')), true);
    assert.equal(canMatch(selector('.a .missing')), false);
    assert.equal(canMatch(selector('body')), true);
    assert.equal(canMatch(selector('DIV')), false);
    assert.equal(canMatch(selector('P')), true);
    assert.equal(canMatch(selector(':is(.a, .missing)')), true);
    assert.equal(canMatch(selector(':is(.missing, .other)')), false);
    assert.equal(canMatch(selector(':where(.a .missing)')), false);
    assert.equal(canMatch(selector('p:is(.a):where(.b)')), true);
    assert.equal(canMatch(selector('.missing:is(.a)')), false);
  });
});

describe('Blueprint frame output service', () => {
  const withPreset = (change: Partial<FramePreset>): CanvasProjectBundle => {
    const next = bundle();
    (next.manifest as unknown as { framePresets: FramePreset[] }).framePresets = [{ ...preset, ...change }];
    return next;
  };
  const comparePresets = (before: CanvasProjectBundle, after: CanvasProjectBundle, frame: FrameOutputTarget): FrameOutputAnswer | undefined => {
    const service = createFrameOutputService();
    service({ kind: 'snapshot', snapshot: 1, bundle: before });
    service({ kind: 'snapshot', snapshot: 2, bundle: after });
    return service({ kind: 'compare', request: 1, before: 1, after: 2, targets: [frame] });
  };

  it('names a frame whose preset size changes, and the diff cannot confirm it', () => {
    const frame = { ...target, preset: { ...preset, width: 500 } };
    assert.deepEqual(comparePresets(withPreset({}), withPreset({ width: 500 }), frame), { kind: 'compare', request: 1, changed: ['one'], unconfirmable: ['one'] });
  });

  it('names a frame whose preset safe area changes, and leaves it to the diff', () => {
    const safeArea = { top: 40, right: 0, bottom: 0, left: 0 };
    const frame = { ...target, preset: { ...preset, safeArea } };
    assert.deepEqual(comparePresets(withPreset({}), withPreset({ safeArea }), frame), { kind: 'compare', request: 1, changed: ['one'], unconfirmable: [] });
  });

  const compare = (answer: ReturnType<typeof createFrameOutputService>, request: number, before: number, after: number): FrameOutputAnswer | undefined => (
    answer({ kind: 'compare', request, before, after, targets: [target, otherTarget] })
  );

  it('holds no compile session after a compare', async () => {
    setFlagsFromString('--expose-gc');
    const collectGarbage = runInNewContext('gc') as () => void;
    const sessions: Array<WeakRef<object>> = [];
    const answer = createFrameOutputService(files => {
      const hasher = createFrameOutputHasher(files);
      sessions.push(new WeakRef(hasher));
      return hasher;
    });
    answer({ kind: 'snapshot', snapshot: 1, bundle: bundle({ css: '.a { color: red; }' }) });
    answer({ kind: 'snapshot', snapshot: 2, bundle: bundle({ css: '.a { color: blue; }' }) });
    assert.deepEqual(compare(answer, 1, 1, 2), { kind: 'compare', request: 1, changed: [target.key], unconfirmable: [] });
    assert.equal(sessions.length, 2);
    await new Promise(resolve => setImmediate(resolve));
    collectGarbage();
    assert.deepEqual(sessions.map(session => session.deref()), [undefined, undefined]);
  });

  it('compiles nothing for a compare that the kept hashes answer', () => {
    let sessions = 0;
    const answer = createFrameOutputService(files => {
      sessions += 1;
      return createFrameOutputHasher(files);
    });
    answer({ kind: 'snapshot', snapshot: 1, bundle: bundle({ css: '.a { color: red; }' }) });
    answer({ kind: 'snapshot', snapshot: 2, bundle: bundle({ css: '.a { color: blue; }' }) });
    assert.deepEqual(compare(answer, 1, 1, 2), compare(answer, 1, 1, 2));
    assert.equal(sessions, 2);
  });

  it('lends the frame shapes to a snapshot that differs only in token values', () => {
    const shapesSeen: Array<Map<string, FrameShape> | undefined> = [];
    const answer = createFrameOutputService((files, shapes) => {
      shapesSeen.push(shapes);
      return createFrameOutputHasher(files, shapes);
    });
    answer({ kind: 'snapshot', snapshot: 1, bundle: bundle({ primary: '#111111' }) });
    answer({ kind: 'snapshot', snapshot: 2, bundle: bundle({ primary: '#222222' }) });
    answer({ kind: 'snapshot', snapshot: 3, bundle: bundle({ primary: '#111111', css: '.a { color: var(--primary); margin: 1px; }' }) });
    assert.deepEqual(compare(answer, 1, 1, 2), { kind: 'compare', request: 1, changed: [target.key], unconfirmable: [] });
    assert.equal(shapesSeen.length, 2);
    assert.ok(shapesSeen[0]);
    assert.equal(shapesSeen[0], shapesSeen[1]);
    assert.equal(shapesSeen[0].size, 1);
    compare(answer, 2, 1, 3);
    assert.equal(shapesSeen.length, 3);
    assert.notEqual(shapesSeen[2], shapesSeen[0]);
  });

  it('names the changed frames that the element diff cannot confirm', () => {
    const answer = createFrameOutputService();
    answer({ kind: 'snapshot', snapshot: 1, bundle: bundle({ css: '@keyframes k { to { opacity: 0; } } .a { color: red; }' }) });
    answer({ kind: 'snapshot', snapshot: 2, bundle: bundle({ css: '@keyframes k { to { opacity: 1; } } .a { color: red; }' }) });
    answer({ kind: 'snapshot', snapshot: 3, bundle: bundle({ css: '@keyframes k { to { opacity: 0; } } .a { color: blue; }' }) });
    assert.deepEqual(compare(answer, 1, 1, 2), { kind: 'compare', request: 1, changed: [target.key], unconfirmable: [target.key] });
    assert.deepEqual(compare(answer, 2, 1, 3), { kind: 'compare', request: 2, changed: [target.key], unconfirmable: [] });
  });

  it('answers the frames whose hash changed, and only compares the frames in scope', () => {
    const answer = createFrameOutputService();
    answer({ kind: 'snapshot', snapshot: 1, bundle: bundle() });
    answer({ kind: 'snapshot', snapshot: 2, bundle: bundle({ primary: '#333333' }) });
    assert.deepEqual(compare(answer, 7, 1, 2), { kind: 'compare', request: 7, changed: ['one'], unconfirmable: [] });
    answer({ kind: 'snapshot', snapshot: 3, bundle: bundle({ quiet: '#333333' }) });
    assert.deepEqual(compare(answer, 8, 1, 3), { kind: 'compare', request: 8, changed: ['two'], unconfirmable: [] });
    assert.deepEqual(framesInChangeScope(bundle(), bundle({ quiet: '#333333' }), [target, otherTarget]).map(frame => frame.key), ['two']);
    assert.deepEqual(framesInChangeScope(bundle(), bundle({ quiet: '#333333' }), [target, otherTarget], false).map(frame => frame.key), ['one', 'two']);
  });

  it('compiles an old document, and fails a request for a released snapshot', () => {
    const answer = createFrameOutputService();
    answer({ kind: 'snapshot', snapshot: 1, bundle: bundle() });
    const document = answer({ kind: 'document', request: 1, snapshot: 1, target, assetOrigin: 'http://127.0.0.1:1234' });
    assert.ok(document?.kind === 'document' && document.html.includes('One'));
    answer({ kind: 'release', snapshot: 1 });
    assert.equal(answer({ kind: 'document', request: 2, snapshot: 1, target, assetOrigin: 'http://127.0.0.1:1234' })?.kind, 'failed');
    assert.equal(compare(answer, 3, 1, 1)?.kind, 'failed');
  });
});

describe('Blueprint token value edit', () => {
  const editableBundle = (change: (next: CanvasProjectBundle) => void): CanvasProjectBundle => {
    const next = structuredClone(bundle());
    change(next);
    return next;
  };

  it('tells an edit of only token values from every other edit', () => {
    const base = bundle();
    const rows: Array<[string, (next: CanvasProjectBundle) => void, boolean]> = [
      ['a token value', next => { next.tokens.tokenGroups[0].tokens[0].value = '#222222'; }, true],
      ['two token values', next => { for (const token of next.tokens.tokenGroups[0].tokens) token.value = '#222222'; }, true],
      ['nothing', () => undefined, false],
      ['a styleRef', next => { next.tokens.tokenGroups[0].tokens[0].styleRef = '--renamed'; }, false],
      ['a token id', next => { next.tokens.tokenGroups[0].tokens[0].id = 'renamed'; }, false],
      ['a new token', next => { next.tokens.tokenGroups[0].tokens.push({ id: 'new', value: '#000000', styleRef: '--new' } as never); }, false],
      ['a token value and a source file', next => {
        next.tokens.tokenGroups[0].tokens[0].value = '#222222';
        next.prototypeSourceContents['one.css'] = '.a { color: blue; }';
      }, false],
      ['a token value and a manifest field', next => {
        next.tokens.tokenGroups[0].tokens[0].value = '#222222';
        next.manifest.project.name = 'Renamed';
      }, false]
    ];
    for (const [name, change, expected] of rows) assert.equal(onlyTokenValuesChanged(base, editableBundle(change)), expected, name);
  });

  const roots = ['starter/design/blueprint', 'fixtures/valid/mira-ai/design/blueprint', 'fixtures/valid/umbra-gaming/design/blueprint', 'fixtures/valid/meridian-finance/design/blueprint'];

  const withEveryTokenValueChanged = (project: CanvasProjectBundle): CanvasProjectBundle => {
    const next = structuredClone(project);
    const tokens = next.tokens.tokenGroups.flatMap(group => group.tokens);
    tokens.forEach((token, index) => {
      token.value = index % 3 === 2 ? `var(${tokens[index - 1].styleRef})` : `#${(index + 1).toString(16).padStart(6, '0')}`;
    });
    return next;
  };

  const framesOf = (project: CanvasProjectBundle): FrameOutputTarget[] => project.screens.screens.flatMap(item => (item.prototype?.states ?? []).map(state => {
    const framePreset = project.manifest.framePresets[0];
    return { key: `${item.id}\0${state}`, screenId: item.id, state, preset: framePreset };
  }));

  it('compiles equal output when only token values change', async () => {
    for (const root of roots) {
      const before = await loadProjectFromFs(root) as unknown as CanvasProjectBundle;
      const after = withEveryTokenValueChanged(before);
      const compileBefore = createPrototypeDocumentCompiler(before);
      const compileAfter = createPrototypeDocumentCompiler(after);
      const frames = framesOf(before);
      assert.ok(frames.length > 0, root);
      for (const frame of frames) {
        const options = { target: { kind: 'screen' as const, id: frame.screenId }, state: frame.state, framePreset: frame.preset };
        const left = compileBefore(options);
        const right = compileAfter(options);
        assert.deepEqual({ state: right.state, sheets: right.sheets, body: right.body, assetRefs: right.assetRefs }, { state: left.state, sheets: left.sheets, body: left.body, assetRefs: left.assetRefs }, `${root} ${frame.key}`);
      }
    }
  });

  it('gives a frame the same hash from a kept shape as from a new compile', async () => {
    for (const root of roots) {
      const before = await loadProjectFromFs(root) as unknown as CanvasProjectBundle;
      const after = withEveryTokenValueChanged(before);
      const shapes = new Map<string, FrameShape>();
      const hashBefore = createFrameOutputHasher(before, shapes);
      const frames = framesOf(before);
      for (const frame of frames) hashBefore(frame);
      const kept = createFrameOutputHasher(after, shapes);
      const fresh = createFrameOutputHasher(after);
      let differs = 0;
      for (const frame of frames) {
        assert.equal(kept(frame), fresh(frame), `${root} ${frame.key}`);
        if (kept(frame) !== hashBefore(frame)) differs += 1;
      }
      assert.ok(differs > 0, `${root}: The edit must change a hash, or this test proves nothing.`);
    }
  });
});

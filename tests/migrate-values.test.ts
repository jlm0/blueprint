import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeLiteralValues } from '../src/core/migrate-values';
import { serializeJson } from '../src/core/raw-json';

interface Project {
  css?: string;
  html?: string;
  tokens?: Array<{ type: string; value: string; styleRef: string }>;
  exceptions?: Array<{ property: string; value: string; reason: string }>;
  extra?: Record<string, string>;
}

const SHEET = 'prototype/screens/home.css';
const SOURCE = 'prototype/screens/home.html';
const TOKENS = [
  { type: 'color', value: '#112233', styleRef: '--app-color-ink' },
  { type: 'color', value: '#445566', styleRef: '--app-color-line' },
  { type: 'color', value: 'rgba(1, 2, 3, 0.5)', styleRef: '--app-color-veil' },
  { type: 'color', value: '#777777', styleRef: '--app-color-twin-a' },
  { type: 'color', value: '#777777', styleRef: '--app-color-twin-b' },
  { type: 'space', value: '4px', styleRef: '--app-space-1' },
  { type: 'space', value: '8px', styleRef: '--app-space-2' },
  { type: 'space', value: '12px', styleRef: '--app-space-3a' },
  { type: 'space', value: '12px', styleRef: '--app-space-3b' },
  { type: 'radius', value: '8px', styleRef: '--app-radius-md' },
  { type: 'size', value: '32px', styleRef: '--app-size-control' },
  { type: 'typography', value: '13px', styleRef: '--app-text-13' },
  { type: 'typography', value: '15px', styleRef: '--app-text-15a' },
  { type: 'typography', value: '15px', styleRef: '--app-text-15b' },
  { type: 'typography', value: '600 14px/1.4 Inter', styleRef: '--app-type-title' }
];

function run(project: Project): { files: Map<string, string>; writes: Map<string, string>; changes: string[] } {
  const files = new Map<string, string>([
    ['tokens.json', serializeJson({ schemaVersion: 'x', projectId: 'p', tokenGroups: [{ id: 'all', tokens: (project.tokens ?? TOKENS).map((token, index) => ({ id: `t${index}`, ...token })) }] })],
    ['primitives.json', serializeJson({ primitives: [] })],
    ['components.json', serializeJson({ components: [] })],
    ['screens.json', serializeJson({ screens: [{ id: 'home', prototype: { source: SOURCE, styles: [SHEET], ...(project.exceptions ? { localValueExceptions: project.exceptions } : {}) } }] })],
    [SHEET, project.css ?? ''],
    [SOURCE, project.html ?? '<main></main>'],
    ...Object.entries(project.extra ?? {})
  ]);
  const writes = new Map<string, string>();
  const changes: string[] = [];
  normalizeLiteralValues(files, writes, changes);
  return { files, writes, changes };
}

function css(project: Project): string {
  const { writes } = run(project);
  return writes.get(SHEET) ?? project.css ?? '';
}

function html(project: Project): string {
  const { writes } = run(project);
  return writes.get(SOURCE) ?? project.html ?? '';
}

describe('literal value repairs in migrate', () => {
  describe('svg-paint-attribute', () => {
    it('rewrites a literal color to the one color token that holds it, and adds a change line', () => {
      const project = { html: '<main><svg><rect fill="#112233" stroke="#445566"/><stop stop-color="#112233"/></svg></main>' };
      const { writes, changes } = run(project);
      assert.equal(writes.get(SOURCE), '<main><svg><rect fill="var(--app-color-ink)" stroke="var(--app-color-line)"/><stop stop-color="var(--app-color-ink)"/></svg></main>');
      assert.deepEqual(changes, [`Rewrote 3 SVG paint attributes in 1 source to var() of the one color token that holds each value.`]);
    });

    it('leaves a color that two tokens hold, a color that no token holds, and a safe paint', () => {
      const source = '<main><svg><rect fill="#777777" stroke="#abcdef"/><path fill="none" stroke="currentColor"/><path fill="url(#g)"/></svg></main>';
      const { writes, changes } = run({ html: source });
      assert.equal(writes.has(SOURCE), false);
      assert.deepEqual(changes, []);
    });

    it('reads no attribute outside an svg', () => {
      assert.equal(html({ html: '<main><font color="#112233">x</font></main>' }), '<main><font color="#112233">x</font></main>');
    });
  });

  describe('literal-color', () => {
    it('rewrites a whole value, a shorthand, a gradient, a shadow, and a color function', () => {
      const project = {
        css: [
          '.a { color: #112233; }',
          '.b { border: 1px solid #445566; }',
          '.c { background: linear-gradient(90deg, #112233 0%, #445566 100%); }',
          '.d { box-shadow: 0 0 1px #112233; }',
          '.e { background-color: RGBA(1, 2, 3, 0.5); }',
          '.f { outline-color: #112233 !important; }'
        ].join('\n')
      };
      const { writes, changes } = run(project);
      assert.equal(writes.get(SHEET), [
        '.a { color: var(--app-color-ink); }',
        '.b { border: 1px solid var(--app-color-line); }',
        '.c { background: linear-gradient(90deg, var(--app-color-ink) 0%, var(--app-color-line) 100%); }',
        '.d { box-shadow: 0 0 1px var(--app-color-ink); }',
        '.e { background-color: var(--app-color-veil); }',
        '.f { outline-color: var(--app-color-ink) !important; }'
      ].join('\n'));
      assert.deepEqual(changes, ['Rewrote 7 literal colors in 1 stylesheet to var() of the one color token that holds each value.']);
    });

    it('leaves a color that two tokens hold, and repairs the other color of that value', () => {
      assert.equal(css({ css: '.a { background: linear-gradient(#777777, #112233); }' }), '.a { background: linear-gradient(#777777, var(--app-color-ink)); }');
      const { writes, changes } = run({ css: '.a { color: #777777; }' });
      assert.equal(writes.has(SHEET), false);
      assert.deepEqual(changes, []);
    });

    for (const [form, text] of [
      ['a color inside url()', '.a { background: url("data:image/svg+xml,%3Csvg fill=\'#112233\'/%3E"); }'],
      ['a fragment url', '.a { filter: url(#112233); }'],
      ['a string', '.a::after { content: "#112233"; }'],
      ['the fallback of var()', '.a { color: var(--app-color-line, #112233); }'],
      ['a custom property', '.a { --local: #112233; }'],
      ['a mask, which reads alpha', '.a { mask-image: linear-gradient(#112233, transparent); }'],
      ['a value with a comment', '.a { color: #112233 /* ink */; }'],
      ['an attribute selector', '[fill="#112233"] { margin: 0; }'],
      ['a font face', '@font-face { font-family: "X"; src: url(x.woff2); font-size: 13px; }']
    ] as const) {
      it(`leaves ${form}`, () => {
        assert.equal(css({ css: text }), text);
      });
    }

    it('leaves a token that a stylesheet declares again, because its value can change in a scope', () => {
      const text = '.a { --app-color-ink: #000000; color: #112233; }';
      assert.equal(css({ css: text }), text);
    });

    it('leaves a declaration that a local value exception names', () => {
      const text = '.a { color: #112233; }';
      assert.equal(css({ css: text, exceptions: [{ property: 'color', value: '#112233', reason: 'r' }] }), text);
    });

    it('leaves a stylesheet that does not parse', () => {
      const text = '.a { color: #112233;';
      assert.equal(css({ css: text }), text);
    });
  });

  describe('raw-font-size', () => {
    it('rewrites a size to the one typography token that holds it, and a whole font shorthand', () => {
      const { writes, changes } = run({ css: '.a { font-size: 13px; }\n.b { font: 600 14px/1.4 Inter; }' });
      assert.equal(writes.get(SHEET), '.a { font-size: var(--app-text-13); }\n.b { font: var(--app-type-title); }');
      assert.deepEqual(changes, ['Rewrote 2 raw font sizes in 1 stylesheet to var() of the one typography token that holds each value.']);
    });

    it('leaves a size that two tokens hold, a size that no token holds, and a partial font shorthand', () => {
      const text = '.a { font-size: 15px; }\n.b { font-size: 21px; }\n.c { font: 600 13px/1.4 Inter; }';
      const { writes, changes } = run({ css: text });
      assert.equal(writes.has(SHEET), false);
      assert.deepEqual(changes, []);
    });

    it('does not read a space token for a font size', () => {
      assert.equal(css({ css: '.a { font-size: 8px; }' }), '.a { font-size: 8px; }');
    });
  });

  describe('restated-token', () => {
    it('rewrites each length to the one token of the matching type', () => {
      const { writes, changes } = run({ css: '.a { padding: 4px 8px; }\n.b { border-radius: 8px; }\n.c { margin: calc(100% - 4px); }' });
      assert.equal(writes.get(SHEET), '.a { padding: var(--app-space-1) var(--app-space-2); }\n.b { border-radius: var(--app-radius-md); }\n.c { margin: calc(100% - var(--app-space-1)); }');
      assert.deepEqual(changes, ['Rewrote 4 restated lengths in 1 stylesheet to var() of the one token of that type that holds each value.']);
    });

    it('leaves a length that two tokens hold, a negative length, another word, and a property with no token type', () => {
      const text = '.a { padding: 12px; }\n.b { margin: -8px; }\n.c { margin: 18px; }\n.d { width: 8px; }\n.e { height: 32px; }';
      const { writes, changes } = run({ css: text });
      assert.equal(writes.has(SHEET), false);
      assert.deepEqual(changes, []);
    });

    it('keeps the other length of a value when one length has two tokens', () => {
      assert.equal(css({ css: '.a { padding: 4px 12px; }' }), '.a { padding: var(--app-space-1) 12px; }');
    });
  });

  it('repairs an active candidate, and leaves a frozen baseline and a history record', () => {
    const candidate = 'prototype/screens/home.exploration-x-a.css';
    const baseline = 'prototype/screens/home.exploration-x-baseline.css';
    const history = 'prototype/screens/home.history-home-v1.css';
    const text = '.a { color: #112233; }';
    const { writes } = run({
      extra: {
        [candidate]: text,
        [baseline]: text,
        [history]: text,
        'explorations/x.json': serializeJson({ exploration: {
          id: 'x',
          lifecycle: 'active',
          target: { screenId: 'home', baseline: { source: SOURCE, styles: [baseline] } },
          candidates: [{ id: 'a', prototype: { source: SOURCE, styles: [candidate] } }]
        } }),
        'history/home-v1.json': serializeJson({ screen: { id: 'home', prototype: { source: SOURCE, styles: [history] } } })
      }
    });
    assert.equal(writes.get(candidate), '.a { color: var(--app-color-ink); }');
    assert.equal(writes.has(baseline), false);
    assert.equal(writes.has(history), false);
  });

  it('leaves the candidate of an archived exploration', () => {
    const candidate = 'prototype/screens/home.exploration-x-a.css';
    const { writes } = run({
      extra: {
        [candidate]: '.a { color: #112233; }',
        'explorations/x.json': serializeJson({ exploration: { id: 'x', lifecycle: 'archived', target: { screenId: 'home' }, candidates: [{ id: 'a', prototype: { source: SOURCE, styles: [candidate] } }] } })
      }
    });
    assert.equal(writes.has(candidate), false);
  });

  it('changes nothing on a second run', () => {
    const { writes } = run({ css: '.a { color: #112233; padding: 4px; font-size: 13px; }', html: '<svg><rect fill="#112233"/></svg>' });
    const again = run({ css: writes.get(SHEET), html: writes.get(SOURCE) });
    assert.equal(again.writes.size, 0);
    assert.deepEqual(again.changes, []);
  });
});

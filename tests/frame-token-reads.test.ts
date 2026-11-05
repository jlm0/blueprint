import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { changedTokenRefs, screenTokenReads, tokenReadClosure } from '../src/app/frame-token-reads';
import { loadProjectFromFs } from '../src/core/load';
import type { CanvasProjectBundle, ScreenDefinition } from '../src/core/types';
import { compilePrototypeDocument } from '../src/prototype/compiler';

const projects = [
  'starter/design/blueprint',
  ...readdirSync('fixtures/valid').map(name => path.join('fixtures/valid', name, 'design/blueprint'))
];

/** Each custom property that a compiled document names outside its token block. */
function documentReads(html: string): Set<string> {
  const start = html.indexOf('<style data-blueprint-token-overrides>');
  const end = html.indexOf('</style>', start);
  const outside = `${html.slice(0, start)}${html.slice(end)}`.replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set(outside.match(/--[\w-]+/g) ?? []);
}

function fixture(tokens: Array<{ styleRef: string; value: string }>, screenFiles: Record<string, string>): { bundle: CanvasProjectBundle; screen: ScreenDefinition } {
  const screen = {
    id: 'one',
    sections: [],
    prototype: { source: 'one.html', styles: ['one.css'], renderedUses: [], assetRefs: [] }
  } as unknown as ScreenDefinition;
  const bundle = {
    manifest: { project: { id: 'demo' } },
    tokens: { tokenGroups: [{ id: 'color', tokens: tokens.map(token => ({ ...token, id: token.styleRef.slice(2) })) }] },
    primitives: { primitives: [] },
    components: { components: [] },
    screens: { screens: [screen] },
    brand: { marks: [{ id: 'logo', source: 'logo.svg', variants: [{ id: 'ink', foreground: 'color.ink', accent: 'color.accent' }] }] },
    prototypeSourceContents: { 'one.html': '<main></main>', 'one.css': '', 'logo.svg': '<svg></svg>', ...screenFiles },
    prototypeAssetContents: {}
  } as unknown as CanvasProjectBundle;
  return { bundle, screen };
}

const tokens = [
  { styleRef: '--ink', value: '#000000' },
  { styleRef: '--accent', value: '#111111' },
  { styleRef: '--shadow', value: '0 1px 0 var(--ink)' },
  { styleRef: '--lift', value: '0 2px 0 var(--shadow)' }
];

describe('Blueprint token-to-frame map', () => {
  for (const projectPath of projects) {
    it(`holds each frame of ${projectPath} that reads each token`, async () => {
      const bundle = await loadProjectFromFs(projectPath);
      const frames = bundle.screens.screens.flatMap(screen => screen.prototype.states.map(state => ({
        screen,
        state,
        reads: documentReads(compilePrototypeDocument({ bundle, target: { kind: 'screen', id: screen.id }, state }).html)
      })));
      let framesOutsideTheMap = 0;
      for (const group of bundle.tokens.tokenGroups) {
        for (const token of group.tokens) {
          const next = structuredClone(bundle);
          const edited = next.tokens.tokenGroups.find(candidate => candidate.id === group.id)?.tokens.find(candidate => candidate.id === token.id);
          assert.ok(edited);
          edited.value = `${edited.value} `;
          const changed = changedTokenRefs(bundle, next);
          assert.ok(changed.has(token.styleRef));
          for (const { screen, state, reads } of frames) {
            const mapped = [...changed].some(ref => screenTokenReads(next, screen).variables.has(ref)) || screenTokenReads(next, screen).unknown;
            if (!mapped) framesOutsideTheMap += 1;
            if ([...changed].some(ref => reads.has(ref))) {
              assert.ok(mapped, `The map misses screen ${screen.id} in state ${state} for token ${token.styleRef}.`);
            }
          }
        }
      }
      assert.ok(framesOutsideTheMap > 0, 'The map holds each frame for each token, so it scopes nothing.');
    });
  }

  it('closes a changed token over each var() chain in token values', () => {
    const { bundle } = fixture(tokens, {});
    const next = fixture(tokens.map(token => token.styleRef === '--ink' ? { ...token, value: '#222222' } : token), {}).bundle;
    assert.deepEqual([...changedTokenRefs(bundle, next)].sort(), ['--ink', '--lift', '--shadow']);
    assert.deepEqual([...tokenReadClosure(next, ['--lift']).keys()].sort(), ['--ink', '--lift', '--shadow']);
  });

  it('counts a token that a change adds or removes as changed, and a description edit as no change', () => {
    const { bundle } = fixture(tokens, {});
    const added = fixture([...tokens, { styleRef: '--new', value: '#333333' }], {}).bundle;
    assert.deepEqual([...changedTokenRefs(bundle, added)], ['--new']);
    assert.deepEqual([...changedTokenRefs(added, bundle)], ['--new']);
    assert.deepEqual([...changedTokenRefs(bundle, fixture(tokens, {}).bundle)], []);
  });

  it('reads var() in an HTML attribute', () => {
    const { bundle, screen } = fixture(tokens, { 'one.html': '<svg><rect fill="var(--accent)"></rect></svg>' });
    assert.deepEqual(screenTokenReads(bundle, screen), { variables: new Set(['--accent']), unknown: false });
  });

  it('reads the source and the variant colors of a placed brand mark', () => {
    const { bundle, screen } = fixture(tokens, {
      'one.html': '<blueprint-use kind="brand-mark" ref="logo" variant="ink"></blueprint-use>',
      'logo.svg': '<svg><path fill="var(--shadow)"></path></svg>'
    });
    assert.deepEqual(screenTokenReads(bundle, screen), { variables: new Set(['--ink', '--accent', '--shadow']), unknown: false });
    const plain = fixture(tokens, {
      'one.html': '<blueprint-use kind="brand-mark" ref="logo"></blueprint-use>',
      'logo.svg': '<svg><path fill="var(--shadow)"></path></svg>'
    });
    assert.deepEqual(screenTokenReads(plain.bundle, plain.screen), { variables: new Set(['--shadow']), unknown: false });
    const unnamed = fixture(tokens.filter(token => token.styleRef !== '--ink'), { 'one.html': '<blueprint-use kind="brand-mark" ref="logo" variant="ink"></blueprint-use>' });
    assert.equal(screenTokenReads(unnamed.bundle, unnamed.screen).unknown, true);
  });

  const unknownCases: Record<string, Record<string, string>> = {
    'a sheet that does not parse': { 'one.css': '.a { color: var(--ink); ' },
    'a container style query': { 'one.css': '@container style(--ink: red) { .a { color: red; } }' },
    'an escaped name in a sheet': { 'one.css': '.a { color: var(--\\69 nk); }' },
    'a missing sheet': { 'one.css': undefined as unknown as string },
    'a style element': { 'one.html': '<style>.a { color: var(--ink); }</style>' },
    'a character reference in an attribute': { 'one.html': '<p style="color: var(&#45;-ink)"></p>' },
    'an attribute value that this reader cannot name': { 'one.html': '<p style="color: var()"></p>' },
    'an unknown brand mark': { 'one.html': '<blueprint-use kind="brand-mark" ref="missing"></blueprint-use>' }
  };
  for (const [name, files] of Object.entries(unknownCases)) {
    it(`counts ${name} as an unknown read`, () => {
      const { bundle, screen } = fixture(tokens, files);
      assert.equal(screenTokenReads(bundle, screen).unknown, true);
    });
  }
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import type { BlueprintProjectBundle } from '../src/core/types';
import { compilePrototypeDocument, inspectPrototypeSourceGraph } from '../src/prototype/compiler';
import { validateProject } from '../src/prototype/validate-project';

const fixtureRoot = 'fixtures/valid/mira-ai/design/blueprint';

const panelSource = '<section data-blueprint-component="panel"><slot name="body">Empty</slot></section>';
const panelFilledWithText = '<p slot="body">Filled</p>';

interface Piece {
  id: string;
  uses?: string[];
  source: string;
}

function use(id: string, children = ''): string {
  return `<blueprint-use kind="component" ref="${id}">${children}</blueprint-use>`;
}

function panelHolding(id: string): string {
  return use('panel', `<div slot="body">${use(id)}</div>`);
}

function boundary(id: string): string {
  return `mira-ai/component/${id}`;
}

function cycleMessage(...ids: string[]): string {
  return `Prototype composition cycle detected: ${ids.map(boundary).join(' -> ')}.`;
}

function addComponents(bundle: BlueprintProjectBundle, pieces: Piece[]): void {
  const [template] = bundle.components.components;
  const onlyDefault = { default: 'default', values: [{ id: 'default', name: 'Default', description: 'The only value.' }] };
  for (const piece of pieces) {
    const source = `prototype/components/${piece.id}.html`;
    bundle.prototypeSourceContents[source] = piece.source;
    bundle.components.components.push({
      ...structuredClone(template),
      id: piece.id,
      name: piece.id,
      uses: (piece.uses ?? []).map(id => ({ kind: 'component' as const, id, reason: 'A test piece.' })),
      variants: structuredClone(onlyDefault),
      sizes: structuredClone(onlyDefault),
      states: structuredClone(onlyDefault),
      unsupported: [],
      slots: [{ id: 'body', name: 'Body', description: 'The panel body.', accepts: ['text', 'component:card', 'component:wrapper'] }],
      prototype: { source, styles: [], localValueExceptions: [] }
    });
  }
}

const panelAndCard: Piece[] = [
  { id: 'panel', source: panelSource },
  { id: 'card', uses: ['panel'], source: `<article>${use('panel', panelFilledWithText)}</article>` }
];

async function bundleWith(pieces: Piece[]): Promise<BlueprintProjectBundle> {
  const bundle = await loadProjectFromFs(fixtureRoot);
  addComponents(bundle, pieces);
  return bundle;
}

function issuesFor(bundle: BlueprintProjectBundle, id: string) {
  return inspectPrototypeSourceGraph(bundle).filter(issue => issue.boundaryId === boundary(id));
}

describe('fragment reuse under a stack that holds a reused reusable', () => {
  it('reports the cycle in one document, in place of replaying the fragment', async () => {
    const bundle = await bundleWith([
      ...panelAndCard,
      { id: 'shell', uses: ['card', 'panel'], source: `<div>${use('card')}${panelHolding('card')}</div>` }
    ]);

    assert.throws(
      () => compilePrototypeDocument({ bundle, target: { kind: 'component', id: 'shell' } }),
      { message: cycleMessage('shell', 'panel', 'card', 'panel') }
    );
  });

  it('reports the cycle for a fragment an earlier document in the session cached', async () => {
    const bundle = await bundleWith([
      ...panelAndCard,
      { id: 'first', uses: ['card'], source: `<div>${use('card')}</div>` },
      { id: 'second', uses: ['panel', 'card'], source: `<div>${panelHolding('card')}</div>` }
    ]);

    assert.deepEqual(issuesFor(bundle, 'second'), [{
      boundaryId: boundary('second'),
      state: 'default',
      message: cycleMessage('second', 'panel', 'card', 'panel')
    }]);
    assert.deepEqual(issuesFor(bundle, 'first'), []);
    assert.deepEqual(issuesFor(bundle, 'card'), []);
    assert.deepEqual(issuesFor(bundle, 'panel'), []);
  });

  it('reports the same issue whichever document compiles first', async () => {
    const first: Piece = { id: 'first', uses: ['card'], source: `<div>${use('card')}</div>` };
    const second: Piece = { id: 'second', uses: ['panel', 'card'], source: `<div>${panelHolding('card')}</div>` };

    const forward = issuesFor(await bundleWith([...panelAndCard, first, second]), 'second');
    const backward = issuesFor(await bundleWith([second, first, ...panelAndCard]), 'second');

    assert.equal(forward.length, 1);
    assert.deepEqual(backward, forward);
  });

  it('reports the cycle when the fragment holds the reusable only through a replayed fragment', async () => {
    const bundle = await bundleWith([
      ...panelAndCard,
      { id: 'wrapper', uses: ['card'], source: `<div>${use('card')}</div>` },
      { id: 'shell', uses: ['card', 'wrapper', 'panel'], source: `<div>${use('card')}${use('wrapper')}${panelHolding('wrapper')}</div>` }
    ]);

    assert.throws(
      () => compilePrototypeDocument({ bundle, target: { kind: 'component', id: 'shell' } }),
      { message: cycleMessage('shell', 'panel', 'wrapper', 'card', 'panel') }
    );
  });

  it('blocks validation of a project with such a document', async () => {
    const bundle = await bundleWith([
      ...panelAndCard,
      { id: 'shell', uses: ['card', 'panel'], source: `<div>${use('card')}${panelHolding('card')}</div>` }
    ]);

    const result = validateProject(bundle);

    assert.equal(result.ok, false);
    const expected = `Prototype source graph ${boundary('shell')} state "default" cannot compile: ${cycleMessage('shell', 'panel', 'card', 'panel')}`;
    assert.ok(result.errors.includes(expected), result.errors.join('\n'));
  });

  it('accepts the same placements when no stack holds the reused reusable', async () => {
    const bundle = await bundleWith([
      ...panelAndCard,
      { id: 'shell', uses: ['card', 'panel'], source: `<div>${use('card')}${use('panel', '<div slot="body">Plain</div>')}</div>` }
    ]);

    assert.deepEqual(issuesFor(bundle, 'shell'), []);
    const { html } = compilePrototypeDocument({ bundle, target: { kind: 'component', id: 'shell' } });
    assert.match(html, /Filled/);
    assert.match(html, /Plain/);
  });

  it('replays the fragment and its uses when a reusable is placed twice', async () => {
    const bundle = await bundleWith([
      ...panelAndCard,
      { id: 'shell', uses: ['card'], source: `<div>${use('card')}${use('card')}</div>` }
    ]);

    const { html, observedUses } = compilePrototypeDocument({ bundle, target: { kind: 'component', id: 'shell' } });

    assert.equal(html.match(/Filled/g)?.length, 2);
    assert.deepEqual(observedUses.map(item => `${item.sourceBoundaryId}>${item.id}`), [
      `${boundary('shell')}>card`,
      `${boundary('card')}>panel`,
      `${boundary('shell')}>card`,
      `${boundary('card')}>panel`
    ]);
  });

  it('reports a plain cycle without any reuse', async () => {
    const bundle = await bundleWith([
      { id: 'ping', uses: ['pong'], source: `<div>${use('pong')}</div>` },
      { id: 'pong', uses: ['ping'], source: `<div>${use('ping')}</div>` }
    ]);

    assert.equal(issuesFor(bundle, 'ping')[0]?.message, cycleMessage('ping', 'pong', 'ping'));
    assert.equal(issuesFor(bundle, 'pong')[0]?.message, cycleMessage('pong', 'ping', 'pong'));
  });
});

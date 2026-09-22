import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { parseCanvasSelection, selectionReference, selectionSourceFiles } from '../src/core/selection';
import type { ExplorationDefinition } from '../src/core/types';

const stillRoot = 'fixtures/app-owned/still-meditation/design/blueprint';

const buttonInSection = {
  boundaryId: 'still-meditation/primitive/button',
  kind: 'primitive',
  localId: 'button',
  label: 'Button',
  context: [
    { boundaryId: 'still-meditation/section/home/featured-practice', kind: 'section', localId: 'home/featured-practice', label: 'Featured Practice' },
    { boundaryId: 'still-meditation/screen/home', kind: 'screen', localId: 'home', label: 'Today' }
  ],
  screenId: 'home',
  state: 'default',
  framePresetId: 'phone'
};

describe('canvas selection contract', () => {
  it('references the selected boundary inside its enclosing boundaries', () => {
    const selection = parseCanvasSelection(buttonInSection);
    assert.ok(selection);
    assert.equal(selectionReference(selection), 'primitive:button in section:home/featured-practice in screen:home');
  });

  it('resolves the owning prototype files from the innermost boundary that has them', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    const button = parseCanvasSelection(buttonInSection);
    const section = parseCanvasSelection({ ...buttonInSection.context[0], context: [buttonInSection.context[1]] });
    assert.ok(button && section);
    assert.deepEqual(selectionSourceFiles(bundle, button), ['prototype/primitives/button.html', 'prototype/primitives/button.css']);
    assert.deepEqual(selectionSourceFiles(bundle, section), ['prototype/screens/home.html', 'prototype/screens/home.css']);
  });

  it('names the exploration candidate or history version and resolves its own source files', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    bundle.explorations.explorations.push({
      id: 'home-hero',
      title: 'Home hero',
      intent: 'Compare hero directions.',
      lifecycle: 'active',
      target: {} as ExplorationDefinition['target'],
      candidates: [{ id: 'calm', label: 'Calm', prototype: { source: 'prototype/screens/home.calm.html', styles: ['prototype/screens/home.calm.css'], assetRefs: [] } }]
    });
    const screenInCandidate = parseCanvasSelection({
      ...buttonInSection.context[1],
      context: [],
      screenId: 'home',
      explorationId: 'home-hero',
      explorationRole: 'candidate',
      candidateId: 'calm'
    });
    const buttonInCandidate = parseCanvasSelection({ ...buttonInSection, explorationId: 'home-hero', explorationRole: 'candidate', candidateId: 'calm' });
    assert.ok(screenInCandidate && buttonInCandidate);
    assert.equal(selectionReference(screenInCandidate), 'screen:home in exploration:home-hero candidate:calm');
    assert.deepEqual(selectionSourceFiles(bundle, screenInCandidate), ['prototype/screens/home.calm.html', 'prototype/screens/home.calm.css']);
    assert.deepEqual(selectionSourceFiles(bundle, buttonInCandidate), ['prototype/primitives/button.html', 'prototype/primitives/button.css']);
    const version = parseCanvasSelection({ ...buttonInSection.context[1], context: [], explorationRole: 'version', historyVersion: 2 });
    assert.ok(version);
    assert.equal(selectionReference(version), 'screen:home in history version:2');
  });

  it('rejects malformed, mismatched, or non-selectable boundaries', () => {
    assert.equal(parseCanvasSelection(null), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, context: undefined }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, kind: 'project' }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, localId: 'badge' }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, label: 'x'.repeat(513) }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, state: 7 }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, explorationRole: 'draft' }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, historyVersion: 0 }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, context: [{ boundaryId: 'x', kind: 'screen', localId: 'home', label: 'Today' }] }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, context: Array(17).fill(buttonInSection.context[1]) }), undefined);
  });
});

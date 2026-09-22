import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { parseCanvasSelection, selectionReference, selectionSourceFiles } from '../src/core/selection';

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

  it('rejects malformed, mismatched, or non-selectable boundaries', () => {
    assert.equal(parseCanvasSelection(null), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, context: undefined }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, kind: 'project' }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, localId: 'badge' }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, label: 'x'.repeat(513) }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, state: 7 }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, context: [{ boundaryId: 'x', kind: 'screen', localId: 'home', label: 'Today' }] }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, context: Array(17).fill(buttonInSection.context[1]) }), undefined);
  });
});

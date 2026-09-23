import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { parseCanvasSelection, selectionReference, selectionSourceFiles } from '../src/core/selection';
import type { ExplorationDefinition } from '../src/core/types';

const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';

const buttonInSection = {
  boundaryId: 'mira-ai/primitive/button',
  kind: 'primitive',
  localId: 'button',
  label: 'Button',
  context: [
    { boundaryId: 'mira-ai/section/workspace/thread-header', kind: 'section', localId: 'workspace/thread-header', label: 'Thread Header' },
    { boundaryId: 'mira-ai/screen/workspace', kind: 'screen', localId: 'workspace', label: 'Workspace' }
  ],
  screenId: 'workspace',
  state: 'default',
  framePresetId: 'desktop-web'
};

describe('canvas selection contract', () => {
  it('references the selected boundary inside its enclosing boundaries', () => {
    const selection = parseCanvasSelection(buttonInSection);
    assert.ok(selection);
    assert.equal(selectionReference(selection), 'primitive:button in section:workspace/thread-header in screen:workspace');
  });

  it('resolves the owning prototype files from the innermost boundary that has them', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const button = parseCanvasSelection(buttonInSection);
    const section = parseCanvasSelection({ ...buttonInSection.context[0], context: [buttonInSection.context[1]] });
    assert.ok(button && section);
    assert.deepEqual(selectionSourceFiles(bundle, button), ['prototype/primitives/button.html', 'prototype/primitives/button.css']);
    assert.deepEqual(selectionSourceFiles(bundle, section), ['prototype/screens/workspace.html', 'prototype/screens/workspace.css']);
  });

  it('names the exploration candidate or history version and resolves its own source files', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    bundle.explorations.explorations.push({
      id: 'workspace-hero',
      title: 'Workspace hero',
      intent: 'Compare hero directions.',
      lifecycle: 'active',
      target: {} as ExplorationDefinition['target'],
      candidates: [{ id: 'calm', label: 'Calm', prototype: { source: 'prototype/screens/workspace.calm.html', styles: ['prototype/screens/workspace.calm.css'], assetRefs: [] } }]
    });
    const screenInCandidate = parseCanvasSelection({
      ...buttonInSection.context[1],
      context: [],
      screenId: 'workspace',
      explorationId: 'workspace-hero',
      explorationRole: 'candidate',
      candidateId: 'calm'
    });
    const buttonInCandidate = parseCanvasSelection({ ...buttonInSection, explorationId: 'workspace-hero', explorationRole: 'candidate', candidateId: 'calm' });
    assert.ok(screenInCandidate && buttonInCandidate);
    assert.equal(selectionReference(screenInCandidate), 'screen:workspace in exploration:workspace-hero candidate:calm');
    assert.deepEqual(selectionSourceFiles(bundle, screenInCandidate), ['prototype/screens/workspace.calm.html', 'prototype/screens/workspace.calm.css']);
    assert.deepEqual(selectionSourceFiles(bundle, buttonInCandidate), ['prototype/primitives/button.html', 'prototype/primitives/button.css']);
    const version = parseCanvasSelection({ ...buttonInSection.context[1], context: [], explorationRole: 'version', historyVersion: 2 });
    assert.ok(version);
    assert.equal(selectionReference(version), 'screen:workspace in history version:2');
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
    assert.equal(parseCanvasSelection({ ...buttonInSection, context: [{ boundaryId: 'x', kind: 'screen', localId: 'workspace', label: 'Workspace' }] }), undefined);
    assert.equal(parseCanvasSelection({ ...buttonInSection, context: Array(17).fill(buttonInSection.context[1]) }), undefined);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activityFocusesForChangedPaths, boundaryDisplayName, FRAME_PRESETS_FOCUS_ID } from '../src/core/activity';
import { changedBoundaries } from '../src/core/change';
import { loadProjectFromFs } from '../src/core/load';

const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';
const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';

describe('changed boundary detection', () => {
  it('reports a screen when the bytes of its asset change', async () => {
    const previous = await loadProjectFromFs(miraRoot);
    const screen = previous.screens.screens[0];
    const assetRef = 'prototype/assets/probe.png';
    screen.prototype.assetRefs.push(assetRef);
    previous.prototypeAssetContents[assetRef] = { mediaType: 'image/png', sha256: 'old', size: 1 } as never;
    const next = structuredClone(previous);
    next.prototypeAssetContents[assetRef] = { mediaType: 'image/png', sha256: 'new', size: 1 } as never;
    assert.deepEqual(changedBoundaries(previous, next).map(change => change.boundaryId), [`mira-ai/screen/${screen.id}`]);
  });

  it('reports a token group that the next snapshot removes, because a frame can read it through a var() fallback', async () => {
    const previous = await loadProjectFromFs(miraRoot);
    const next = structuredClone(previous);
    const [removed] = next.tokens.tokenGroups.splice(0, 1);
    assert.deepEqual(changedBoundaries(previous, next).map(change => change.boundaryId), [`mira-ai/token-group/${removed.id}`]);
  });

  it('reports the frame presets when a size or a safe area changes', async () => {
    const previous = await loadProjectFromFs(miraRoot);
    const next = structuredClone(previous);
    next.manifest.framePresets[0].width += 10;
    const changes = changedBoundaries(previous, next);
    assert.deepEqual(changes.map(change => change.boundaryId), [`mira-ai/project/${FRAME_PRESETS_FOCUS_ID}`]);
    assert.equal(boundaryDisplayName(next, 'project', FRAME_PRESETS_FOCUS_ID), 'Frame sizes');
  });

  it('reports nothing for identical snapshots', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    assert.deepEqual(changedBoundaries(bundle, structuredClone(bundle)), []);
  });

  it('reports boundaries whose owned prototype files or declarations changed', async () => {
    const previous = await loadProjectFromFs(miraRoot);
    const next = structuredClone(previous);
    next.prototypeSourceContents['prototype/primitives/button.css'] += '\n/* changed */\n';
    next.prototypeSourceContents['prototype/screens/workspace.html'] = next.prototypeSourceContents['prototype/screens/workspace.html'].replace('Q3 churn drivers', 'Q4 churn drivers');
    next.tokens.tokenGroups[0].tokens[0].value = '#010203';
    assert.deepEqual(
      changedBoundaries(previous, next).map(change => change.boundaryId).sort(),
      [
        `mira-ai/primitive/button`,
        `mira-ai/screen/workspace`,
        `mira-ai/token-group/${previous.tokens.tokenGroups[0].id}`
      ].sort()
    );
  });

  it('reports a brand.json or mark source edit as a change to the Brand page', async () => {
    const previous = await loadProjectFromFs(meridianRoot);
    const voice = structuredClone(previous);
    voice.brand!.voice!.summary = 'Plainer still.';
    const mark = structuredClone(previous);
    mark.prototypeSourceContents['brand/mark.svg'] = mark.prototypeSourceContents['brand/mark.svg'].replace('r="12.25"', 'r="12"');
    for (const next of [voice, mark]) {
      const changes = changedBoundaries(previous, next);
      assert.deepEqual(changes.map(change => `${change.kind}:${change.localId}`), ['project:brand']);
      assert.equal(boundaryDisplayName(next, 'project', changes[0]!.localId), 'Brand');
    }
    const removed = structuredClone(previous);
    delete removed.brand;
    assert.deepEqual(changedBoundaries(previous, removed), []);
    assert.deepEqual(
      activityFocusesForChangedPaths(previous, ['brand/wordmark.svg', 'brand.json']).map(focus => focus.boundaryId),
      ['meridian-finance/project/brand']
    );
  });

  it('reports added boundaries and omits removed ones', async () => {
    const previous = await loadProjectFromFs(miraRoot);
    const next = structuredClone(previous);
    const badge = next.primitives.primitives.findIndex(primitive => primitive.id === 'badge');
    next.primitives.primitives.push({ ...next.primitives.primitives[badge], id: 'badge-copy' });
    next.primitives.primitives.splice(badge, 1);
    assert.deepEqual(changedBoundaries(previous, next).map(change => change.boundaryId), ['mira-ai/primitive/badge-copy']);
  });
});

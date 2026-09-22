import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changedBoundaries } from '../src/core/change';
import { loadProjectFromFs } from '../src/core/load';

const stillRoot = 'fixtures/app-owned/still-meditation/design/blueprint';

describe('changed boundary detection', () => {
  it('reports nothing for identical snapshots', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    assert.deepEqual(changedBoundaries(bundle, structuredClone(bundle)), []);
  });

  it('reports boundaries whose owned prototype files or declarations changed', async () => {
    const previous = await loadProjectFromFs(stillRoot);
    const next = structuredClone(previous);
    next.prototypeSourceContents['prototype/primitives/button.css'] += '\n/* changed */\n';
    next.prototypeSourceContents['prototype/screens/home.html'] = next.prototypeSourceContents['prototype/screens/home.html'].replace('Find your', 'Find our');
    next.tokens.tokenGroups[0].tokens[0].value = '#010203';
    assert.deepEqual(
      changedBoundaries(previous, next).map(change => change.boundaryId).sort(),
      [
        `still-meditation/primitive/button`,
        `still-meditation/screen/home`,
        `still-meditation/token-group/${previous.tokens.tokenGroups[0].id}`
      ].sort()
    );
  });

  it('reports added boundaries and omits removed ones', async () => {
    const previous = await loadProjectFromFs(stillRoot);
    const next = structuredClone(previous);
    const badge = next.primitives.primitives.findIndex(primitive => primitive.id === 'badge');
    next.primitives.primitives.push({ ...next.primitives.primitives[badge], id: 'badge-copy' });
    next.primitives.primitives.splice(badge, 1);
    assert.deepEqual(changedBoundaries(previous, next).map(change => change.boundaryId), ['still-meditation/primitive/badge-copy']);
  });
});

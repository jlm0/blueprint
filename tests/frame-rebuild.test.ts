import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { frameNeedsRebuild, rebuildScope } from '../src/app/frame-rebuild';
import type { CanvasProjectBundle } from '../src/core/types';

function reusable(id: string, styles: string[], description = id) {
  return { id, description, prototype: { source: `prototype/components/${id}.html`, styles } };
}

function screen(id: string, styles: string[]) {
  return { id, prototype: { source: `prototype/screens/${id}.html`, styles, assetRefs: [] } };
}

function bundle(components = [
  reusable('shutter', ['prototype/foundation/base.css', 'prototype/components/shutter.css']),
  reusable('notice', ['prototype/foundation/base.css', 'prototype/components/notice.css'])
]): CanvasProjectBundle {
  return {
    manifest: { project: { id: 'demo' } },
    primitives: { primitives: [] },
    components: { components },
    screens: { screens: [screen('sign-in', ['prototype/screens/shared.css']), screen('home', ['prototype/screens/shared.css']), screen('item', [])] }
  } as unknown as CanvasProjectBundle;
}

describe('Blueprint frame rebuild scope', () => {
  it('rebuilds only the frames whose last compile used an edited component', () => {
    const scope = rebuildScope(['prototype/components/shutter.css'], bundle(), bundle());
    assert.ok(scope);
    assert.deepEqual([...scope.boundaryIds], ['demo/component/shutter']);
    assert.equal(frameNeedsRebuild(scope, 'sign-in', new Set(['demo/component/notice'])), false);
    assert.equal(frameNeedsRebuild(scope, 'capture', new Set(['demo/component/shutter'])), true);
    assert.equal(frameNeedsRebuild(scope, 'capture', undefined), true);
  });

  it('rebuilds every frame after a token or brand edit', () => {
    for (const changedPath of ['tokens.json', 'brand.json']) {
      const scope = rebuildScope([changedPath], bundle(), bundle());
      assert.ok(scope);
      assert.equal(frameNeedsRebuild(scope, 'sign-in', new Set()), true);
    }
  });

  it('scopes a components.json edit to the definitions that changed', () => {
    const next = bundle([
      reusable('shutter', ['prototype/foundation/base.css', 'prototype/components/shutter.css']),
      reusable('notice', ['prototype/foundation/base.css', 'prototype/components/notice.css'], 'A changed notice.')
    ]);
    const scope = rebuildScope(['components.json'], bundle(), next);
    assert.ok(scope);
    assert.deepEqual([...scope.boundaryIds], ['demo/component/notice']);
  });

  it('marks every component and every screen that shares an edited file', () => {
    const shared = rebuildScope(['prototype/foundation/base.css'], bundle(), bundle());
    assert.ok(shared);
    assert.deepEqual([...shared.boundaryIds].sort(), ['demo/component/notice', 'demo/component/shutter']);
    const screens = rebuildScope(['prototype/screens/shared.css'], bundle(), bundle());
    assert.ok(screens);
    assert.deepEqual([...screens.screenIds].sort(), ['home', 'sign-in']);
    assert.equal(frameNeedsRebuild(screens, 'home', new Set()), true);
    assert.equal(frameNeedsRebuild(screens, 'item', new Set()), false);
  });

  it('asks for a full rebuild when the screens or the manifest change', () => {
    assert.equal(rebuildScope(['screens.json'], bundle(), bundle()), undefined);
    assert.equal(rebuildScope(['manifest.json'], bundle(), bundle()), undefined);
  });
});

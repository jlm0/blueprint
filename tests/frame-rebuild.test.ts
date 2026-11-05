import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changedBundlePaths, frameNeedsRebuild, rebuildScope } from '../src/app/frame-rebuild';
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
], primary = '#111111'): CanvasProjectBundle {
  return {
    manifest: { project: { id: 'demo' } },
    tokens: { tokenGroups: [{ id: 'color', tokens: [
      { id: 'primary', value: primary, styleRef: '--color-primary' },
      { id: 'quiet', value: '#222222', styleRef: '--color-quiet' }
    ] }] },
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

  it('rebuilds every frame after a brand edit', () => {
    const scope = rebuildScope(['brand.json'], bundle(), bundle());
    assert.ok(scope);
    assert.equal(frameNeedsRebuild(scope, 'sign-in', new Set()), true);
  });

  it('rebuilds only the frames that read a token that a token edit changed', () => {
    const scope = rebuildScope(['tokens.json'], bundle(), bundle(undefined, '#333333'));
    assert.ok(scope);
    assert.deepEqual([...scope.tokenRefs], ['--color-primary']);
    assert.equal(frameNeedsRebuild(scope, 'sign-in', new Set(), { variables: new Set(['--color-primary']), unknown: false }), true);
    assert.equal(frameNeedsRebuild(scope, 'sign-in', new Set(), { variables: new Set(['--color-quiet']), unknown: false }), false);
    assert.equal(frameNeedsRebuild(scope, 'sign-in', new Set(), { variables: new Set(), unknown: true }), true);
    assert.equal(frameNeedsRebuild(scope, 'sign-in', new Set()), true);
  });

  it('rebuilds every frame after a token edit without an earlier snapshot', () => {
    const scope = rebuildScope(['tokens.json'], undefined, bundle());
    assert.ok(scope);
    assert.equal(scope.all, true);
  });

  it('lists each path that differs between 2 snapshots', () => {
    const files = { prototypeSourceContents: { 'a.css': 'a', 'b.css': 'b' }, prototypeAssetContents: { 'c.png': { sha256: 'c' } } };
    const previous = { ...bundle(), ...files } as unknown as CanvasProjectBundle;
    const next = {
      ...bundle(undefined, '#333333'),
      prototypeSourceContents: { 'a.css': 'changed', 'b.css': 'b' },
      prototypeAssetContents: { 'c.png': { sha256: 'changed' } }
    } as unknown as CanvasProjectBundle;
    assert.deepEqual(changedBundlePaths(previous, next), ['tokens.json', 'a.css', 'c.png']);
    assert.deepEqual(changedBundlePaths(previous, previous), []);
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

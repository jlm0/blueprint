import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compilePrototypeDocument } from '../src/prototype/compiler';
import { compilePrototypeReview, resolvePrototypeReviewSelection } from '../src/cli/prototype-review';
import { loadProjectFromFs } from '../src/core/load';
import { createExtractionPacket, queryUsedBy, showBoundary } from '../src/core/query';
import type { BoundaryReference, DeepHandoffPacket } from '../src/core/types';

const blankSlateRoot = 'fixtures/app-owned/blank-slate/design/blueprint';

describe('canonical prototype propagation', () => {
  it('materializes one token mutation through the primitive, component, and screen review condition', async () => {
    const original = await loadProjectFromFs(blankSlateRoot);
    const changed = structuredClone(original);
    const primary = changed.tokens.tokenGroups
      .find(group => group.id === 'color')
      ?.tokens.find(token => token.id === 'primary');
    assert.ok(primary);
    primary.value = 'rgb(17 34 51)';

    const primitive = compilePrototypeDocument({
      bundle: changed,
      target: { kind: 'primitive', id: 'button' },
      state: 'normal'
    });
    const component = compilePrototypeDocument({
      bundle: changed,
      target: { kind: 'component', id: 'cta-band' },
      state: 'initial'
    });
    const desktop = compilePrototypeReview(
      changed,
      resolvePrototypeReviewSelection(changed, {
        screenId: 'home',
        state: 'initial',
        viewport: 'desktop-web-tall'
      })
    );

    for (const html of [primitive.html, component.html, desktop.html]) {
      assert.match(html, /--app-color-primary: rgb\(17 34 51\)/);
    }
    assert.equal(desktop.selection.width, 1440);
    assert.equal(desktop.selection.height, 2600);
  });

  it('propagates one primitive source edit to its direct specimen and every declared composed consumer', async () => {
    const original = await loadProjectFromFs(blankSlateRoot);
    const changed = structuredClone(original);
    const sourceRef = 'prototype/primitives/button.html';
    changed.prototypeSourceContents[sourceRef] = changed.prototypeSourceContents[sourceRef].replace(
      '<button ',
      '<button data-propagation-probe="button-v2" '
    );

    const primitive = compilePrototypeDocument({
      bundle: changed,
      target: { kind: 'primitive', id: 'button' },
      state: 'normal'
    });
    const component = compilePrototypeDocument({
      bundle: changed,
      target: { kind: 'component', id: 'cta-band' },
      state: 'initial'
    });
    const screen = compilePrototypeDocument({
      bundle: changed,
      target: { kind: 'screen', id: 'home' },
      state: 'initial'
    });

    for (const html of [primitive.html, component.html, screen.html]) {
      assert.match(html, /data-propagation-probe="button-v2"/);
    }
    assert.equal(screen.observedUses.some(use => use.targetBoundaryId.endsWith('/primitive/button')), true);
  });

  it('reuses the same component source across distinct screen consumers', async () => {
    const bundle = await loadProjectFromFs(blankSlateRoot);
    const home = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'home' },
      state: 'initial'
    });
    const pricing = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'pricing' },
      state: 'initial'
    });
    const reusedComponentId = 'blank-slate-proof/component/site-footer';

    assert.equal(home.state, 'initial');
    assert.equal(pricing.state, 'initial');
    assert.ok(home.observedUses.some(use => use.targetBoundaryId === reusedComponentId));
    assert.ok(pricing.observedUses.some(use => use.targetBoundaryId === reusedComponentId));
    assert.match(pricing.html, /data-blueprint-boundary-local-id="pricing"/);
    assert.match(pricing.html, /data-blueprint-state="initial"/);
  });

  it('carries component-owned token groups and canonical primitive roles through deterministic handoff packets', async () => {
    const bundle = await loadProjectFromFs(blankSlateRoot);
    const component = showBoundary(bundle, 'component:feature-card');
    const componentUses = component.dependencies.uses.map(reference => reference.id);
    assert.deepEqual(componentUses, [
      'blank-slate-proof/token-group/color',
      'blank-slate-proof/token-group/space',
      'blank-slate-proof/token-group/shape',
      'blank-slate-proof/token-group/typography',
      'blank-slate-proof/primitive/icon'
    ]);

    const usedByColor = queryUsedBy(bundle, 'token-group:color').results as BoundaryReference[];
    assert.ok(
      usedByColor.some(reference => reference.id === 'blank-slate-proof/component/feature-card'),
      'token-group reverse lookup must include direct component ownership'
    );

    const first = createExtractionPacket(bundle, 'component:feature-card', { mode: 'deep' }) as DeepHandoffPacket;
    const second = createExtractionPacket(bundle, 'component:feature-card', { mode: 'deep' }) as DeepHandoffPacket;
    assert.equal(JSON.stringify(first), JSON.stringify(second), 'repeated deep packets must be byte-deterministic');
    assert.deepEqual(first.extraction.includedBoundaryIds, [
      'blank-slate-proof/component/feature-card',
      'blank-slate-proof/primitive/icon',
      'blank-slate-proof/token-group/color',
      'blank-slate-proof/token-group/shape',
      'blank-slate-proof/token-group/space',
      'blank-slate-proof/token-group/typography',
      'blank-slate-proof/state-set/icon/tone'
    ]);
    assert.ok(first.resolvedTokens.some(token => token.id === 'color.primary'));
    assert.ok(first.resolvedTokens.some(token => token.id === 'typography.body'));

    const primitive = createExtractionPacket(bundle, 'primitive:button', { mode: 'deep' }) as DeepHandoffPacket;
    const canonicalRole = primitive.tokenUsage.filter(
      usage =>
        usage.boundaryId === 'blank-slate-proof/primitive/button' &&
        usage.tokenId === 'shape.radius-md' &&
        usage.role === 'radius'
    );
    assert.equal(canonicalRole.length, 1, 'canonical prototype roles must be present exactly once');
  });
});

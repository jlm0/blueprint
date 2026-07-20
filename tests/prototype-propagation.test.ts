import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compilePrototypeDocument } from '../src/prototype/compiler';
import { compilePrototypeReview, resolvePrototypeReviewSelection } from '../src/cli/prototype-review';
import { loadProjectFromFs } from '../src/core/load';
import { createExtractionPacket, queryUsedBy, showBoundary } from '../src/core/query';
import type { BoundaryReference, DeepHandoffPacket } from '../src/core/types';

const nowWhatRoot = 'fixtures/app-owned/nowwhat/design/blueprint';

describe('canonical prototype propagation', () => {
  it('materializes one token mutation through the primitive, component, and both screen review conditions', async () => {
    const original = await loadProjectFromFs(nowWhatRoot);
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
      target: { kind: 'component', id: 'email-capture' },
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
    const phone = compilePrototypeReview(
      changed,
      resolvePrototypeReviewSelection(changed, {
        screenId: 'home',
        state: 'initial',
        viewport: 'phone-tall'
      })
    );

    for (const html of [primitive.html, component.html, desktop.html, phone.html]) {
      assert.match(html, /--nw-color-primary: rgb\(17 34 51\)/);
    }
    assert.equal(desktop.selection.width, 1440);
    assert.equal(desktop.selection.height, 3515);
    assert.equal(phone.selection.width, 390);
    assert.equal(phone.selection.height, 5390);
  });

  it('propagates one primitive source edit to its direct specimen and every declared composed consumer', async () => {
    const original = await loadProjectFromFs(nowWhatRoot);
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
      target: { kind: 'component', id: 'email-capture' },
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
    const bundle = await loadProjectFromFs(nowWhatRoot);
    const home = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'home' },
      state: 'initial'
    });
    const login = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'login' },
      state: 'initial'
    });
    const reusedComponentId = 'nowwhat-web/component/site-footer';

    assert.equal(home.state, 'initial');
    assert.equal(login.state, 'initial');
    assert.ok(home.observedUses.some(use => use.targetBoundaryId === reusedComponentId));
    assert.ok(login.observedUses.some(use => use.targetBoundaryId === reusedComponentId));
    assert.match(login.html, /data-blueprint-boundary-local-id="login"/);
    assert.match(login.html, /data-blueprint-state="initial"/);
  });

  it('carries component-owned token groups and canonical primitive roles through deterministic handoff packets', async () => {
    const bundle = await loadProjectFromFs(nowWhatRoot);
    const component = showBoundary(bundle, 'component:feature-card');
    const componentUses = component.dependencies.uses.map(reference => reference.id);
    assert.deepEqual(componentUses, [
      'nowwhat-web/token-group/color',
      'nowwhat-web/token-group/space',
      'nowwhat-web/token-group/shape',
      'nowwhat-web/token-group/typography',
      'nowwhat-web/token-group/motion',
      'nowwhat-web/primitive/icon'
    ]);

    const usedByColor = queryUsedBy(bundle, 'token-group:color').results as BoundaryReference[];
    assert.ok(
      usedByColor.some(reference => reference.id === 'nowwhat-web/component/feature-card'),
      'token-group reverse lookup must include direct component ownership'
    );

    const first = createExtractionPacket(bundle, 'component:feature-card', { mode: 'deep' }) as DeepHandoffPacket;
    const second = createExtractionPacket(bundle, 'component:feature-card', { mode: 'deep' }) as DeepHandoffPacket;
    assert.equal(JSON.stringify(first), JSON.stringify(second), 'repeated deep packets must be byte-deterministic');
    assert.deepEqual(first.extraction.includedBoundaryIds, [
      'nowwhat-web/component/feature-card',
      'nowwhat-web/primitive/icon',
      'nowwhat-web/token-group/color',
      'nowwhat-web/token-group/motion',
      'nowwhat-web/token-group/shape',
      'nowwhat-web/token-group/space',
      'nowwhat-web/token-group/typography',
      'nowwhat-web/state-set/icon/tone'
    ]);
    assert.ok(first.resolvedTokens.some(token => token.id === 'color.primary'));
    assert.ok(first.resolvedTokens.some(token => token.id === 'motion.base'));

    const primitive = createExtractionPacket(bundle, 'primitive:button', { mode: 'deep' }) as DeepHandoffPacket;
    const canonicalRole = primitive.tokenUsage.filter(
      usage =>
        usage.boundaryId === 'nowwhat-web/primitive/button' &&
        usage.tokenId === 'shape.radius-md' &&
        usage.role === 'radius'
    );
    assert.equal(canonicalRole.length, 1, 'canonical prototype roles must be present exactly once');
  });
});

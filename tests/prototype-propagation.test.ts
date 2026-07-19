import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compilePrototypeDocument } from '../src/prototype/compiler';
import { compilePrototypeReview, resolvePrototypeReviewSelection } from '../src/cli/prototype-review';
import { loadProjectFromFs } from '../src/core/load';
import { createExtractionPacket, queryUsedBy, showBoundary } from '../src/core/query';
import type { BoundaryReference, DeepHandoffPacket } from '../src/core/types';

const nowWhatRoot = 'fixtures/app-owned/nowwhat-waitlist/design/blueprint';

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
      target: { kind: 'primitive', id: 'primary-action' },
      state: 'default'
    });
    const component = compilePrototypeDocument({
      bundle: changed,
      target: { kind: 'component', id: 'email-signup-form' },
      state: 'initial'
    });
    const desktop = compilePrototypeReview(
      changed,
      resolvePrototypeReviewSelection(changed, {
        screenId: 'waitlist',
        state: 'initial',
        viewport: 'desktop-reference'
      })
    );
    const phone = compilePrototypeReview(
      changed,
      resolvePrototypeReviewSelection(changed, {
        screenId: 'waitlist',
        state: 'initial',
        viewport: 'phone-reference'
      })
    );

    for (const html of [primitive.html, component.html, desktop.html, phone.html]) {
      assert.match(html, /--nw-color-primary: rgb\(17 34 51\)/);
    }
    assert.equal(desktop.selection.width, 1280);
    assert.equal(desktop.selection.height, 800);
    assert.equal(phone.selection.width, 390);
    assert.equal(phone.selection.height, 844);
  });

  it('propagates one primitive source edit to its direct specimen and every declared composed consumer', async () => {
    const original = await loadProjectFromFs(nowWhatRoot);
    const changed = structuredClone(original);
    const sourceRef = 'prototype/primitives/primary-action.html';
    changed.prototypeSourceContents[sourceRef] = changed.prototypeSourceContents[sourceRef].replace(
      '<button ',
      '<button data-propagation-probe="primary-action-v2" '
    );

    const primitive = compilePrototypeDocument({
      bundle: changed,
      target: { kind: 'primitive', id: 'primary-action' },
      state: 'default'
    });
    const component = compilePrototypeDocument({
      bundle: changed,
      target: { kind: 'component', id: 'email-signup-form' },
      state: 'initial'
    });
    const screen = compilePrototypeDocument({
      bundle: changed,
      target: { kind: 'screen', id: 'waitlist' },
      state: 'initial'
    });

    for (const html of [primitive.html, component.html, screen.html]) {
      assert.match(html, /data-propagation-probe="primary-action-v2"/);
    }
    assert.equal(screen.observedUses.some(use => use.targetBoundaryId.endsWith('/primitive/primary-action')), true);
  });

  it('reuses the same component source across two distinct screen-state consumers', async () => {
    const bundle = await loadProjectFromFs(nowWhatRoot);
    const initial = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'waitlist' },
      state: 'initial'
    });
    const emailFocused = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'waitlist' },
      state: 'email-focused'
    });
    const reusedComponentId = 'nowwhat-waitlist-proof/component/email-signup-form';

    assert.equal(initial.state, 'initial');
    assert.equal(emailFocused.state, 'email-focused');
    assert.ok(initial.observedUses.some(use => use.targetBoundaryId === reusedComponentId));
    assert.ok(emailFocused.observedUses.some(use => use.targetBoundaryId === reusedComponentId));
    assert.match(emailFocused.html, /data-blueprint-screen="waitlist"[^>]+data-blueprint-state="email-focused"/);
  });

  it('carries component-owned token groups and canonical primitive roles through deterministic handoff packets', async () => {
    const bundle = await loadProjectFromFs(nowWhatRoot);
    const component = showBoundary(bundle, 'component:feature-action-cards');
    const componentUses = component.dependencies.uses.map(reference => reference.id);
    assert.deepEqual(componentUses, [
      'nowwhat-waitlist-proof/token-group/color',
      'nowwhat-waitlist-proof/token-group/space',
      'nowwhat-waitlist-proof/token-group/shape',
      'nowwhat-waitlist-proof/token-group/typography',
      'nowwhat-waitlist-proof/token-group/motion'
    ]);

    const usedByColor = queryUsedBy(bundle, 'token-group:color').results as BoundaryReference[];
    assert.ok(
      usedByColor.some(reference => reference.id === 'nowwhat-waitlist-proof/component/feature-action-cards'),
      'token-group reverse lookup must include direct component ownership'
    );

    const first = createExtractionPacket(bundle, 'component:feature-action-cards', { mode: 'deep' }) as DeepHandoffPacket;
    const second = createExtractionPacket(bundle, 'component:feature-action-cards', { mode: 'deep' }) as DeepHandoffPacket;
    assert.equal(JSON.stringify(first), JSON.stringify(second), 'repeated deep packets must be byte-deterministic');
    assert.deepEqual(first.extraction.includedBoundaryIds, [
      'nowwhat-waitlist-proof/component/feature-action-cards',
      'nowwhat-waitlist-proof/token-group/color',
      'nowwhat-waitlist-proof/token-group/motion',
      'nowwhat-waitlist-proof/token-group/shape',
      'nowwhat-waitlist-proof/token-group/space',
      'nowwhat-waitlist-proof/token-group/typography'
    ]);
    assert.ok(first.resolvedTokens.some(token => token.id === 'color.primary'));
    assert.ok(first.resolvedTokens.some(token => token.id === 'motion.base'));

    const primitive = createExtractionPacket(bundle, 'primitive:primary-action', { mode: 'deep' }) as DeepHandoffPacket;
    const canonicalRole = primitive.tokenUsage.filter(
      usage =>
        usage.boundaryId === 'nowwhat-waitlist-proof/primitive/primary-action' &&
        usage.tokenId === 'shape.radius-md' &&
        usage.role === 'radius'
    );
    assert.equal(canonicalRole.length, 1, 'canonical prototype roles must be present exactly once');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compilePrototypeDocument } from '../src/prototype/compiler';
import { compilePrototypeReview, resolvePrototypeReviewSelection } from '../src/prototype/review';
import { loadProjectFromFs } from '../src/core/load';
import { createExtractionPacket, queryUsedBy, showBoundary } from '../src/core/query';
import type { BoundaryReference, DeepHandoffPacket } from '../src/core/types';

const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';

describe('canonical prototype propagation', () => {
  it('materializes one token mutation through the primitive, component, and screen review condition', async () => {
    const original = await loadProjectFromFs(umbraRoot);
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
      target: { kind: 'component', id: 'edition-card' },
      state: 'default'
    });
    const desktop = compilePrototypeReview(
      changed,
      resolvePrototypeReviewSelection(changed, {
        screenId: 'launch',
        state: 'default',
        viewport: 'desktop-web-page'
      })
    );

    for (const html of [primitive.html, component.html, desktop.html]) {
      assert.match(html, /--app-color-primary: rgb\(17 34 51\)/);
    }
    assert.equal(desktop.selection.width, 1440);
    assert.equal(desktop.selection.height, 1760);
  });

  it('propagates one primitive source edit to its direct specimen and every declared composed consumer', async () => {
    const original = await loadProjectFromFs(umbraRoot);
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
      target: { kind: 'component', id: 'edition-card' },
      state: 'default'
    });
    const screen = compilePrototypeDocument({
      bundle: changed,
      target: { kind: 'screen', id: 'launch' },
      state: 'default'
    });

    for (const html of [primitive.html, component.html, screen.html]) {
      assert.match(html, /data-propagation-probe="button-v2"/);
    }
    assert.equal(screen.observedUses.some(use => use.targetBoundaryId.endsWith('/primitive/button')), true);
  });

  it('reuses the same component source across distinct screen consumers', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    const hub = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'hub' },
      state: 'default'
    });
    const match = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'match' },
      state: 'default'
    });
    const reusedComponentId = 'umbra-gaming/component/squad-member';

    assert.equal(hub.state, 'default');
    assert.equal(match.state, 'default');
    assert.ok(hub.observedUses.some(use => use.targetBoundaryId === reusedComponentId));
    assert.ok(match.observedUses.some(use => use.targetBoundaryId === reusedComponentId));
    assert.match(match.html, /data-blueprint-boundary-local-id="match"/);
    assert.match(match.html, /data-blueprint-state="default"/);
  });

  it('carries component-owned token groups and canonical primitive roles through deterministic handoff packets', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    const component = showBoundary(bundle, 'component:mode-tile');
    const componentUses = component.dependencies.uses.map(reference => reference.id);
    assert.deepEqual(componentUses, [
      'umbra-gaming/token-group/color',
      'umbra-gaming/token-group/space',
      'umbra-gaming/token-group/shape',
      'umbra-gaming/token-group/typography',
      'umbra-gaming/primitive/badge'
    ]);

    const usedByColor = queryUsedBy(bundle, 'token-group:color').results as BoundaryReference[];
    assert.ok(
      usedByColor.some(reference => reference.id === 'umbra-gaming/component/mode-tile'),
      'token-group reverse lookup must include direct component ownership'
    );

    const first = createExtractionPacket(bundle, 'component:mode-tile', { mode: 'deep' }) as DeepHandoffPacket;
    const second = createExtractionPacket(bundle, 'component:mode-tile', { mode: 'deep' }) as DeepHandoffPacket;
    assert.equal(JSON.stringify(first), JSON.stringify(second), 'repeated deep packets must be byte-deterministic');
    assert.deepEqual(first.extraction.includedBoundaryIds, [
      'umbra-gaming/component/mode-tile',
      'umbra-gaming/primitive/badge',
      'umbra-gaming/token-group/color',
      'umbra-gaming/token-group/shape',
      'umbra-gaming/token-group/space',
      'umbra-gaming/token-group/typography',
      'umbra-gaming/state-set/badge/variant'
    ]);
    assert.ok(first.resolvedTokens.some(token => token.id === 'color.primary'));
    assert.ok(first.resolvedTokens.some(token => token.id === 'typography.body'));

    const primitive = createExtractionPacket(bundle, 'primitive:button', { mode: 'deep' }) as DeepHandoffPacket;
    const canonicalRole = primitive.tokenUsage.filter(
      usage =>
        usage.boundaryId === 'umbra-gaming/primitive/button' &&
        usage.tokenId === 'shape.radius-md' &&
        usage.role === 'radius'
    );
    assert.equal(canonicalRole.length, 1, 'canonical prototype roles must be present exactly once');
  });
});

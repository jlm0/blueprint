import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { compilePrototypeDocument } from '../src/prototype/compiler';
import { createExtractionPacket } from '../src/core/query';
import { loadProjectFromFs } from '../src/core/load';
import type { DeepHandoffPacket } from '../src/core/types';
import { createReadinessReport, validateProject } from '../src/core/validate';

const starterRoot = 'starter/design/blueprint';
const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';

describe('starter and high-fidelity portability contract', () => {
  it('keeps the initialized starter sparse while providing a governed canonical composition foundation', async () => {
    const bundle = await loadProjectFromFs(starterRoot);

    assert.equal(validateProject(bundle).ok, true);
    assert.equal(bundle.components.components.length, 1);
    assert.deepEqual(
      bundle.components.components[0]?.uses.map(use => `${use.kind}:${use.id}`),
      ['primitive:button']
    );
    assert.equal(bundle.primitives.primitives.find(primitive => primitive.id === 'button')?.prototype?.source, 'prototype/primitives/button.html');
    assert.deepEqual(
      bundle.screens.screens.map(screen => ({ id: screen.id, sections: screen.sections.length, prototype: screen.prototype })),
      [
        {
          id: 'home',
          sections: 0,
          prototype: {
            source: 'prototype/screens/home.html',
            styles: ['prototype/screens/home.css'],
            assetRefs: [],
            states: ['default'],
            reviewConditions: [{ id: 'phone-default', framePresetId: 'phone', state: 'default' }],
            renderedUses: []
          }
        },
        {
          id: 'web-home',
          sections: 0,
          prototype: {
            source: 'prototype/screens/web-home.html',
            styles: ['prototype/screens/web-home.css'],
            assetRefs: [],
            states: ['default'],
            reviewConditions: [{ id: 'desktop-web-default', framePresetId: 'desktop-web', state: 'default' }],
            renderedUses: []
          }
        }
      ]
    );

    const governedSource = Object.values(bundle.prototypeSourceContents).join('\n');
    assert.doesNotMatch(governedSource, /<script\b|https?:\/\//i);
  });

  it('compiles the unrelated finance application through the same component and primitive graph', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    const readiness = createReadinessReport(bundle);
    const deep = createExtractionPacket(bundle, 'screen:transactions', { mode: 'deep' }) as DeepHandoffPacket;
    const compiled = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'transactions' },
      state: 'default'
    });

    assert.equal(validateProject(bundle).ok, true);
    assert.equal(validateProject(bundle, { mode: 'strict' }).ok, true);
    assert.ok(readiness.prototypeSources.includes('prototype/screens/transactions.html'));
    assert.equal(readiness.tier, 'ready');
    assert.deepEqual(deep.extraction.includedBoundaryIds, [
      'meridian-finance/screen/transactions',
      'meridian-finance/section/transactions/header',
      'meridian-finance/section/transactions/ledger',
      'meridian-finance/section/transactions/detail',
      'meridian-finance/component/web-header',
      'meridian-finance/primitive/segmented-control',
      'meridian-finance/primitive/input',
      'meridian-finance/primitive/select',
      'meridian-finance/primitive/badge',
      'meridian-finance/primitive/button',
      'meridian-finance/primitive/table-row',
      'meridian-finance/primitive/avatar',
      'meridian-finance/primitive/tabs',
      'meridian-finance/token-group/color',
      'meridian-finance/token-group/shape',
      'meridian-finance/token-group/space',
      'meridian-finance/token-group/typography',
      'meridian-finance/state-set/segmented-control/state',
      'meridian-finance/token-group/motion',
      'meridian-finance/token-group/size',
      'meridian-finance/state-set/input/interaction',
      'meridian-finance/state-set/input/variant',
      'meridian-finance/state-set/select/state',
      'meridian-finance/state-set/badge/variant',
      'meridian-finance/state-set/button/interaction',
      'meridian-finance/state-set/button/size',
      'meridian-finance/state-set/button/variant',
      'meridian-finance/state-set/table-row/state',
      'meridian-finance/state-set/avatar/content',
      'meridian-finance/state-set/avatar/size',
      'meridian-finance/state-set/tabs/state'
    ]);
    assert.doesNotMatch(compiled.html, /<blueprint-use\b/i);
    assert.match(compiled.html, /data-blueprint-boundary-id="meridian-finance\/component\/web-header"/);
    assert.equal(compiled.observedUses.filter(use => use.kind === 'primitive' && use.id === 'table-row').length, 10);
    assert.match(compiled.html, /<aside class="detail"/);
    assert.match(compiled.html, /role="table"/);
    assert.doesNotMatch(compiled.html, /composer|insight-chart/i);
  });

  it('keeps runtime code free of fixture-specific branches', async () => {
    const runtime = (await Promise.all([
      'src/app/main.ts',
      'src/prototype/compiler.ts',
      'src/core/load.ts',
      'src/core/query.ts',
      'src/core/validate.ts',
      'src/mcp/create-server.ts',
      'src/mcp/operations.ts',
      'src/mcp/schemas.ts'
    ].map(file => readFile(file, 'utf8')))).join('\n');
    assert.doesNotMatch(runtime, /meridian-finance|mira-ai|umbra-gaming|transfer-summary|insight-chart|rank-emblem/i);
  });
});

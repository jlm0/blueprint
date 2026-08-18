import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { compilePrototypeDocument } from '../src/prototype/compiler';
import { createExtractionPacket } from '../src/core/query';
import { loadProjectFromFs } from '../src/core/load';
import type { DeepHandoffPacket } from '../src/core/types';
import { createReadinessReport, validateProject } from '../src/core/validate';

const starterRoot = 'starter/design/blueprint';
const denseRoot = 'fixtures/app-owned/dense-ops/design/blueprint';

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
        { id: 'home', sections: 0, prototype: undefined },
        { id: 'web-home', sections: 0, prototype: undefined }
      ]
    );

    const governedSource = Object.values(bundle.prototypeSourceContents).join('\n');
    assert.doesNotMatch(governedSource, /<script\b|https?:\/\//i);
  });

  it('compiles the unrelated dense application through the same component and primitive graph', async () => {
    const bundle = await loadProjectFromFs(denseRoot);
    const readiness = createReadinessReport(bundle);
    const deep = createExtractionPacket(bundle, 'screen:service-health', { mode: 'deep' }) as DeepHandoffPacket;
    const compiled = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'service-health' },
      state: 'populated'
    });

    assert.equal(validateProject(bundle).ok, true);
    assert.equal(validateProject(bundle, { mode: 'strict' }).ok, true);
    assert.equal(readiness.fidelityTier, 'high-fidelity');
    assert.equal(readiness.tier, 'ready');
    assert.deepEqual(deep.extraction.includedBoundaryIds, [
      'dense-ops/screen/service-health',
      'dense-ops/section/service-health/service-table',
      'dense-ops/component/service-health-table',
      'dense-ops/primitive/action-button',
      'dense-ops/token-group/color',
      'dense-ops/token-group/shape',
      'dense-ops/token-group/space',
      'dense-ops/token-group/typography',
      'dense-ops/state-set/action-button/interaction'
    ]);
    assert.doesNotMatch(compiled.html, /<blueprint-use\b/i);
    assert.match(compiled.html, /data-blueprint-boundary-id="dense-ops\/component\/service-health-table"/);
    assert.equal(compiled.observedUses.filter(use => use.kind === 'primitive' && use.id === 'action-button').length, 6);
    assert.match(compiled.html, /<aside class="ops-rail"/);
    assert.match(compiled.html, /<table>/);
    assert.doesNotMatch(compiled.html, /email-signup|waitlist/i);
  });

  it('retains honest legacy compatibility without fixture-specific runtime branches', async () => {
    for (const root of [
      'fixtures/app-owned/atlas-pay/design/blueprint',
      'fixtures/app-owned/nova-care/design/blueprint'
    ]) {
      const report = createReadinessReport(await loadProjectFromFs(root));
      assert.equal(report.fidelityTier, 'baseline-compatible');
      assert.deepEqual(report.prototypeSources, []);
    }

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
    assert.doesNotMatch(runtime, /dense-ops|service-health-table|Dense Ops/i);
  });
});

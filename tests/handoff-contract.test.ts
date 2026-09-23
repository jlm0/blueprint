import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { createExtractionPacket, showBoundary } from '../src/core/query';
import { createCanvasStyleEvidence, createReviewManifest } from '../src/core/review';
import { createReadinessReport, validateProject } from '../src/core/validate';
import { compilePrototypeReview, resolvePrototypeReviewSelection } from '../src/prototype/review';
import type {
  BlueprintProjectBundle,
  BoundaryPacket,
  DeepHandoffPacket,
  ScreenDefinition,
  ValidationResult
} from '../src/core/types';

const denseRoot = 'fixtures/app-owned/dense-ops/design/blueprint';

type ExtractionOptions = { mode?: 'focused' | 'deep' };
type ValidateOptions = { mode?: 'baseline' | 'strict' };

const extract = createExtractionPacket as unknown as (
  bundle: BlueprintProjectBundle,
  selector: string,
  options?: ExtractionOptions
) => Record<string, any>;

const validate = validateProject as unknown as (
  bundle: BlueprintProjectBundle,
  options?: ValidateOptions
) => ValidationResult;

describe('Blueprint production handoff contract', () => {
  it('exposes an honest unresolved capture with exact prototype review and standalone style-evidence context', async () => {
    const bundle = await loadProjectFromFs(denseRoot);
    const query = showBoundary(bundle, 'screen:service-health') as BoundaryPacket<ScreenDefinition>;
    const focused = createExtractionPacket(bundle, 'screen:service-health', { mode: 'focused' }) as BoundaryPacket<ScreenDefinition>;
    const deep = createExtractionPacket(bundle, 'screen:service-health', { mode: 'deep' }) as DeepHandoffPacket<ScreenDefinition>;
    const selection = resolvePrototypeReviewSelection(bundle, {
      screenId: 'service-health',
      state: 'populated',
      viewport: 'desktop-ops'
    });
    const compiled = compilePrototypeReview(bundle, selection);
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'service-health');
    assert.ok(screen?.prototype);
    const record = {
      id: selection.boundaryId,
      kind: 'screen' as const,
      board: 'screens' as const,
      label: screen.name,
      screenId: screen.id
    };
    const manifest = createReviewManifest(bundle, [record], {
      generatedAt: '2026-07-15T06:41:07.000Z',
      board: 'screens',
      screenId: screen.id,
      captureStatus: 'unresolved',
      captureReason: 'No current Blueprint candidate capture exists.',
      prototypeReview: {
        source: screen.prototype.source,
        state: selection.state,
        framePresetId: selection.framePresetId,
        conditionId: selection.conditionId
      },
      packetToolName: 'extract'
    });
    const styleEvidence = createCanvasStyleEvidence(bundle, [record], {
      generatedAt: '2026-07-15T06:41:07.000Z'
    });
    const readiness = createReadinessReport(bundle);
    const strict = validateProject(bundle, { mode: 'strict' });

    assert.ok(query.data.prototype);
    assert.equal(query.data.prototype.source, 'prototype/screens/service-health.html');
    assert.equal('boundaries' in focused, false);
    assert.equal(deep.extraction.mode, 'deep');
    assert.ok(deep.boundaries.some(boundary => boundary.kind === 'component'));
    assert.ok(deep.resolvedTokens.length > 0);
    assert.ok(compiled.observedBoundaryIds.some(id => id.endsWith('/component/service-health-table')));
    assert.deepEqual(manifest.capture, {
      status: 'unresolved',
      reason: 'No current Blueprint candidate capture exists.'
    });
    assert.equal(manifest.prototypeReview?.source, 'prototype/screens/service-health.html');
    assert.equal(manifest.prototypeReview?.state, 'populated');
    assert.equal(manifest.prototypeReview?.framePresetId, 'desktop-ops');
    assert.equal(manifest.prototypeReview?.conditionId, 'desktop-populated');
    assert.equal(styleEvidence.boundaries[0]?.status, 'unresolved');
    // Dense Ops ships its font assets locally, so unresolvedDecisions is
    // empty and readiness is legitimately ready.
    assert.equal(readiness.tier, 'ready');
    assert.equal(strict.ok, true);
    assert.deepEqual(strict.errors, []);
  });

  it('blocks baseline, strict, and readiness claims when governed visual source drifts from its declared graph', async () => {
    const bundle = await loadProjectFromFs(denseRoot);
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'service-health');
    assert.ok(screen?.prototype);
    bundle.prototypeSourceContents[screen.prototype.source] = bundle.prototypeSourceContents[
      screen.prototype.source
    ].replace(
      '</main>',
      '<blueprint-use kind="component" ref="missing" state="initial"></blueprint-use></main>'
    );

    const baseline = validateProject(bundle);
    const strict = validateProject(bundle, { mode: 'strict' });
    const readiness = createReadinessReport(bundle);
    const driftPattern = /Prototype source graph.*missing|renders undeclared component "missing"/;

    assert.equal(baseline.ok, false);
    assert.equal(strict.ok, false);
    assert.match(baseline.errors.join('\n'), driftPattern);
    assert.match(strict.errors.join('\n'), driftPattern);
    assert.equal(readiness.tier, 'blocked');
    assert.ok(readiness.blockers.some(item => driftPattern.test(item.message)));
  });

  it('keeps focused packets available while deep packets include transitive boundary data in stable order', async () => {
    const bundle = await loadProjectFromFs(denseRoot);

    const focused = extract(bundle, 'screen:service-health', { mode: 'focused' });
    assert.equal(focused.kind, 'screen');
    assert.equal(focused.extraction?.mode ?? 'focused', 'focused');
    assert.equal('boundaries' in focused, false);

    const first = extract(bundle, 'screen:service-health', { mode: 'deep' });
    const second = extract(bundle, 'screen:service-health', { mode: 'deep' });
    const boundaryIds = first.boundaries.map((boundary: { id: string }) => boundary.id);

    assert.equal(first.extraction.mode, 'deep');
    assert.deepEqual(boundaryIds, [...new Set(boundaryIds)], 'deep packet should dedupe repeated dependencies');
    assert.deepEqual(
      second.boundaries.map((boundary: { id: string }) => boundary.id),
      boundaryIds,
      'deep packet ordering should be deterministic across runs'
    );
    assert.ok(boundaryIds.includes('dense-ops/screen/service-health'));
    assert.ok(boundaryIds.includes('dense-ops/section/service-health/service-table'));
    assert.ok(boundaryIds.includes('dense-ops/component/service-health-table'));
    assert.ok(boundaryIds.includes('dense-ops/primitive/action-button'));
    assert.ok(boundaryIds.includes('dense-ops/state-set/action-button/interaction'));
    assert.ok(boundaryIds.includes('dense-ops/token-group/color'));

    const section = extract(bundle, 'section:service-health/service-table', { mode: 'deep' });
    assert.equal(section.extraction.selected.id, 'dense-ops/section/service-health/service-table');
    assert.ok(section.boundaries.some((boundary: { id: string }) => boundary.id === 'dense-ops/primitive/action-button'));

    const stateSet = extract(bundle, 'state-set:action-button/interaction', { mode: 'deep' });
    assert.equal(stateSet.extraction.selected.id, 'dense-ops/state-set/action-button/interaction');
    assert.ok(stateSet.boundaries.some((boundary: { id: string }) => boundary.id === 'dense-ops/primitive/action-button'));
    assert.ok(stateSet.boundaries.some((boundary: { id: string }) => boundary.id === 'dense-ops/token-group/color'));
  });

  it('resolves token records for primitive and screen deep packets without follow-up token queries', async () => {
    const bundle = await loadProjectFromFs(denseRoot);
    const packet = extract(bundle, 'screen:service-health', { mode: 'deep' });
    const tokenIds = packet.resolvedTokens.map((token: { id: string }) => token.id);
    const accent = packet.resolvedTokens.find((token: { id: string }) => token.id === 'color.accent');

    assert.ok(tokenIds.includes('color.accent'));
    assert.ok(tokenIds.includes('shape.control'));
    assert.equal(accent.groupId, 'color');
    assert.equal(accent.tokenId, 'accent');
    assert.equal(accent.type, 'color');
    assert.equal(accent.value, '#d4f35b');
    assert.equal(accent.description, 'Canonical inspection action.');
    assert.equal(accent.styleRef, '--ops-color-accent');
  });

  it('reports unresolved token references during baseline validation', async () => {
    const bundle = await loadProjectFromFs(denseRoot);
    const broken = structuredClone(bundle);
    broken.primitives.primitives[0].stateSets[0].states[0].tokens.push('color.missing');

    const result = validate(broken);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /color\.missing/);
  });

  it('carries production relationship metadata and composition bindings into focused and deep packets', async () => {
    const bundle = await loadProjectFromFs(denseRoot);
    const screen = showBoundary(bundle, 'screen:service-health') as any;
    const serviceTable = screen.data.sections.find((section: { id: string }) => section.id === 'service-table');
    const component = showBoundary(bundle, 'component:service-health-table') as any;

    assert.equal(screen.data.productionRelationship.kind, 'new-route');
    assert.equal(screen.data.productionRelationship.routePath, '/ops/services');
    assert.equal(serviceTable.uses[0].binding.slot, 'content');
    assert.equal(serviceTable.uses[0].binding.state, 'populated');
    assert.equal(serviceTable.uses[0].binding.data, 'services');
    assert.equal(component.data.uses[0].binding.variant, 'inspect');
    assert.equal(component.data.uses[0].binding.copy, 'Inspect');

    const packet = extract(bundle, 'screen:service-health', { mode: 'deep' });
    const section = packet.boundaries.find(
      (boundary: { id: string }) => boundary.id === 'dense-ops/section/service-health/service-table'
    );
    assert.equal(section.data.uses[0].binding.slot, 'content');
    const table = packet.boundaries.find((boundary: { id: string }) => boundary.id === 'dense-ops/component/service-health-table');
    assert.equal(table.data.uses[0].binding.slot, 'row-action');
  });

  it('carries implementation target metadata without generating target code', async () => {
    const bundle = await loadProjectFromFs(denseRoot);
    const primitive = showBoundary(bundle, 'primitive:action-button') as any;
    const screen = showBoundary(bundle, 'screen:service-health') as any;
    const target = primitive.data.implementationTargets[0];

    assert.equal(target.platform, 'web');
    assert.equal(target.framework, 'framework-neutral');
    assert.equal(target.candidatePath, 'src/components/InspectionAction');
    assert.equal(target.symbolName, 'InspectionAction');
    assert.equal(target.operationIntent, 'create-component');
    assert.equal(target.propMapping.label, 'children');
    assert.deepEqual(target.stateMapping, { default: 'default', disabled: 'disabled' });
    assert.equal(target.tokenAdapter, 'ops tokens');
    assert.deepEqual(target.testPaths, []);
    assert.deepEqual(target.storyPaths, []);
    assert.deepEqual(target.unresolvedDecisions, []);
    assert.equal(screen.data.implementationTargets[0].candidatePath, 'src/screens/ServiceHealth');
    assert.equal('generatedCode' in primitive.data, false);
  });

  it('separates baseline project validity from strict handoff readiness and version compatibility', async () => {
    const ready = await loadProjectFromFs(denseRoot);
    const unversioned = structuredClone(ready);
    delete unversioned.manifest.handoffContractVersion;

    assert.equal(validate(ready).ok, true);
    assert.equal(validate(unversioned).ok, true);
    assert.equal(validate(ready, { mode: 'strict' }).ok, true);

    const unversionedStrict = validate(unversioned, { mode: 'strict' });
    assert.equal(unversionedStrict.ok, false);
    assert.match(unversionedStrict.errors.join('\n'), /handoffContractVersion/);

    const mismatched = structuredClone(ready);
    mismatched.manifest.handoffContractVersion = '999.0.0';
    const mismatchResult = validate(mismatched, { mode: 'strict' });
    assert.equal(mismatchResult.ok, false);
    assert.match(mismatchResult.errors.join('\n'), /Unsupported handoff contract version "999\.0\.0"/);

    const unresolved = structuredClone(ready);
    const firstPrimitiveEvidence = unresolved.primitives.primitives[0]?.styleEvidence?.[0];
    assert.ok(firstPrimitiveEvidence);
    firstPrimitiveEvidence.status = 'unresolved';
    const unresolvedResult = validate(unresolved, { mode: 'strict' });
    assert.equal(unresolvedResult.ok, false);
    assert.match(unresolvedResult.errors.join('\n'), /style evidence .* unresolved/);
  });

  it('terminates cyclic deep traversal and reports cycles without destabilizing packet order', async () => {
    const bundle = await loadProjectFromFs(denseRoot);
    const cyclic = structuredClone(bundle);
    cyclic.screens.screens[0].sections[0].uses.push({
      kind: 'screen',
      id: 'service-health',
      reason: 'Regression fixture for screen-to-screen cycle handling',
      binding: {
        slot: 'cycleGuard',
        layout: 'Do not inline recursively.'
      }
    });

    const first = extract(cyclic, 'screen:service-health', { mode: 'deep' });
    const second = extract(cyclic, 'screen:service-health', { mode: 'deep' });

    assert.ok(
      first.extraction.cycles.some((cycle: { from: string; to: string }) => cycle.to === 'dense-ops/screen/service-health')
    );
    assert.deepEqual(
      second.boundaries.map((boundary: { id: string }) => boundary.id),
      first.boundaries.map((boundary: { id: string }) => boundary.id)
    );
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { createExtractionPacket, showBoundary } from '../src/core/query';
import { validateProject } from '../src/core/validate';
import type { BlueprintProjectBundle, ValidationResult } from '../src/core/types';

const novaRoot = 'fixtures/app-owned/nova-care/design/blueprint';
const atlasRoot = 'fixtures/app-owned/atlas-pay/design/blueprint';

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
  it('keeps focused packets available while deep packets include transitive boundary data in stable order', async () => {
    const bundle = await loadProjectFromFs(novaRoot);

    const focused = extract(bundle, 'screen:home', { mode: 'focused' });
    assert.equal(focused.kind, 'screen');
    assert.equal(focused.extraction?.mode ?? 'focused', 'focused');
    assert.equal('boundaries' in focused, false);

    const first = extract(bundle, 'screen:home', { mode: 'deep' });
    const second = extract(bundle, 'screen:home', { mode: 'deep' });
    const boundaryIds = first.boundaries.map((boundary: { id: string }) => boundary.id);

    assert.equal(first.extraction.mode, 'deep');
    assert.deepEqual(boundaryIds, [...new Set(boundaryIds)], 'deep packet should dedupe repeated dependencies');
    assert.deepEqual(
      second.boundaries.map((boundary: { id: string }) => boundary.id),
      boundaryIds,
      'deep packet ordering should be deterministic across runs'
    );
    assert.ok(boundaryIds.includes('nova-care/screen/home'));
    assert.ok(boundaryIds.includes('nova-care/section/home/next-action'));
    assert.ok(boundaryIds.includes('nova-care/primitive/action-button'));
    assert.ok(boundaryIds.includes('nova-care/state-set/action-button/intent'));
    assert.ok(boundaryIds.includes('nova-care/token-group/color'));

    const section = extract(bundle, 'section:home/next-action', { mode: 'deep' });
    assert.equal(section.extraction.selected.id, 'nova-care/section/home/next-action');
    assert.ok(section.boundaries.some((boundary: { id: string }) => boundary.id === 'nova-care/primitive/action-button'));

    const stateSet = extract(bundle, 'state-set:action-button/intent', { mode: 'deep' });
    assert.equal(stateSet.extraction.selected.id, 'nova-care/state-set/action-button/intent');
    assert.ok(stateSet.boundaries.some((boundary: { id: string }) => boundary.id === 'nova-care/token-group/color'));
  });

  it('resolves token records for primitive and screen deep packets without follow-up token queries', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const packet = extract(bundle, 'screen:home', { mode: 'deep' });
    const tokenIds = packet.resolvedTokens.map((token: { id: string }) => token.id);
    const accent = packet.resolvedTokens.find((token: { id: string }) => token.id === 'color.accent');

    assert.ok(tokenIds.includes('color.accent'));
    assert.ok(tokenIds.includes('shape.radius-control'));
    assert.equal(accent.groupId, 'color');
    assert.equal(accent.tokenId, 'accent');
    assert.equal(accent.type, 'color');
    assert.equal(accent.value, '#3e7c61');
    assert.equal(accent.description, 'Primary command color.');
    assert.equal(accent.styleRef, '--nova-color-accent');
  });

  it('reports unresolved token references during baseline validation', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const broken = structuredClone(bundle);
    broken.primitives.primitives[0].stateSets[0].states[0].tokens.push('color.missing');

    const result = validate(broken);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /color\.missing/);
  });

  it('carries production relationship metadata and composition bindings into focused and deep packets', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const screen = showBoundary(bundle, 'screen:home') as any;
    const nextAction = screen.data.sections.find((section: { id: string }) => section.id === 'next-action');

    assert.equal(screen.data.productionRelationship.kind, 'new-route');
    assert.equal(screen.data.productionRelationship.routePath, '/care');
    assert.equal(nextAction.uses[0].binding.slot, 'primaryContent');
    assert.equal(nextAction.uses[0].binding.state, 'compact');
    assert.equal(nextAction.uses[1].binding.variant, 'primary');
    assert.equal(nextAction.uses[1].binding.accessibility, 'Primary and secondary commands remain keyboard reachable.');

    const packet = extract(bundle, 'screen:home', { mode: 'deep' });
    const section = packet.boundaries.find((boundary: { id: string }) => boundary.id === 'nova-care/section/home/next-action');
    assert.equal(section.data.uses[0].binding.slot, 'primaryContent');
  });

  it('carries implementation target metadata without generating target code', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const primitive = showBoundary(bundle, 'primitive:action-button') as any;
    const screen = showBoundary(bundle, 'screen:home') as any;
    const target = primitive.data.implementationTargets[0];

    assert.equal(target.platform, 'web');
    assert.equal(target.framework, 'react');
    assert.equal(target.candidatePath, 'src/components/ActionButton.tsx');
    assert.equal(target.symbolName, 'ActionButton');
    assert.equal(target.operationIntent, 'adapt-existing-component');
    assert.equal(target.propMapping.intent, 'variant');
    assert.equal(target.tokenAdapter, 'theme.tokens');
    assert.deepEqual(target.testPaths, ['src/components/ActionButton.test.tsx']);
    assert.deepEqual(target.storyPaths, ['src/components/ActionButton.stories.tsx']);
    assert.deepEqual(target.unresolvedDecisions, []);
    assert.equal(screen.data.implementationTargets[0].candidatePath, 'src/screens/CareHome.tsx');
    assert.equal('generatedCode' in primitive.data, false);
  });

  it('separates baseline project validity from strict handoff readiness and version compatibility', async () => {
    const ready = await loadProjectFromFs(novaRoot);
    const legacy = await loadProjectFromFs(atlasRoot);

    assert.equal(validate(ready).ok, true);
    assert.equal(validate(legacy).ok, true);
    assert.equal(validate(ready, { mode: 'strict' }).ok, true);

    const legacyStrict = validate(legacy, { mode: 'strict' });
    assert.equal(legacyStrict.ok, false);
    assert.match(legacyStrict.errors.join('\n'), /handoffContractVersion/);

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
    const bundle = await loadProjectFromFs(novaRoot);
    const cyclic = structuredClone(bundle);
    cyclic.screens.screens[0].sections[0].uses.push({
      kind: 'screen',
      id: 'home',
      reason: 'Regression fixture for screen-to-screen cycle handling',
      binding: {
        slot: 'cycleGuard',
        layout: 'Do not inline recursively.'
      }
    });

    const first = extract(cyclic, 'screen:home', { mode: 'deep' });
    const second = extract(cyclic, 'screen:home', { mode: 'deep' });

    assert.ok(first.extraction.cycles.some((cycle: { from: string; to: string }) => cycle.to === 'nova-care/screen/home'));
    assert.deepEqual(
      second.boundaries.map((boundary: { id: string }) => boundary.id),
      first.boundaries.map((boundary: { id: string }) => boundary.id)
    );
  });
});

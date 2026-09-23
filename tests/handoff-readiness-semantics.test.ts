import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { createExtractionPacket, queryUsedBy, showBoundary } from '../src/core/query';
import * as validateCore from '../src/core/validate';
import type {
  BlueprintProjectBundle,
  BoundaryDependency,
  BoundaryPacket,
  BoundaryReference,
  DeepHandoffPacket,
  PrimitiveDefinition,
  TokenUsage,
  ValidationResult
} from '../src/core/types';

const starterRoot = 'starter/design/blueprint';
const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';
const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';
const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';

type ReadinessTier = 'ready' | 'pending' | 'unresolved' | 'blocked';
type ReadinessSeverity = 'ready' | 'pending' | 'unresolved' | 'blocker';
type ReadinessSource = 'resolved' | 'declared' | 'declared-missing-artifact' | 'synthesized-missing';

interface ReadinessItem {
  path: string;
  severity: ReadinessSeverity;
  source: ReadinessSource;
  message: string;
  artifactRef?: string;
  artifactExists?: boolean;
}

interface ReadinessReport {
  projectId: string;
  tier: ReadinessTier;
  items: ReadinessItem[];
  blockers: ReadinessItem[];
}

type ReadinessReportFactory = (bundle: BlueprintProjectBundle) => ReadinessReport;

interface PrimitiveStateWithTokenRoles {
  tokenRoles?: Record<string, string>;
}

interface EnrichedDeepHandoffPacket extends DeepHandoffPacket {
  tokenUsage: TokenUsage[];
  declaredModes?: unknown[];
}

type PrimitiveWithUses = PrimitiveDefinition & {
  uses?: BoundaryDependency[];
};

const validateProject = validateCore.validateProject as (
  bundle: BlueprintProjectBundle,
  options?: { mode?: 'baseline' | 'strict' }
) => ValidationResult;

describe('Blueprint handoff readiness semantics', () => {
  it('reports ready, pending, declared unresolved, and synthesized missing readiness states without conflating them', async () => {
    const createReadinessReport = readinessReportFactory();
    const ready = fullyResolveStyleEvidence(await loadProjectFromFs(meridianRoot));
    const readyReport = createReadinessReport(ready);
    assert.equal(readyReport.projectId, 'meridian-finance');
    assert.equal(readyReport.tier, 'ready');
    assert.deepEqual(readyReport.blockers, []);

    const declared = cloneBundle(ready);
    requirePrimitive(declared, 'button').implementationTargets?.[0].unresolvedDecisions.push('Choose final press feedback timing after native prototype review.');
    const declaredReport = createReadinessReport(declared);
    assert.equal(declaredReport.tier, 'unresolved');
    assert.ok(
      declaredReport.items.some(
        item =>
          item.severity === 'unresolved' &&
          item.source === 'declared' &&
          item.path.includes('implementationTargets.0.unresolvedDecisions')
      ),
      'declared unresolved decisions should stay visible as honest unresolved work'
    );
    assert.equal(validateProject(declared).ok, true, 'declared unresolved decisions should not break baseline schema validity');

    const synthesizedMissing = cloneBundle(ready);
    delete requirePrimitive(synthesizedMissing, 'button').styleEvidence;
    const synthesizedReport = createReadinessReport(synthesizedMissing);
    assert.equal(synthesizedReport.tier, 'blocked');
    assert.ok(
      synthesizedReport.blockers.some(
        item => item.source === 'synthesized-missing' && item.path === 'primitive.button.styleEvidence'
      ),
      'missing style evidence should be distinct from declared unresolved evidence'
    );

    const unsupported = fullyResolveStyleEvidence(ready);
    const unsupportedEvidence = requirePrimitive(unsupported, 'button').styleEvidence?.[0] as { status: string };
    unsupportedEvidence.status = 'mystery-status';
    const unsupportedReport = createReadinessReport(unsupported);
    assert.equal(unsupportedReport.tier, 'blocked');
    assert.ok(
      unsupportedReport.blockers.some(
        item =>
          item.severity === 'blocker' &&
          item.source === 'declared' &&
          item.path === 'primitive.button.styleEvidence' &&
          item.message.includes('mystery-status')
      ),
      'unsupported declared style evidence statuses should block readiness instead of disappearing'
    );
  });

  it('checks linked/pending artifact evidence against real artifact expectations', async () => {
    const createReadinessReport = readinessReportFactory();
    const tempProjectRoot = await copyProjectToTemp('blueprint-readiness-artifact-');
    const ready = fullyResolveStyleEvidence(await loadProjectFromFs(tempProjectRoot));
    const missing = cloneBundle(ready);
    const missingRef = 'artifacts/does-not-exist/button.json';
    requirePrimitive(missing, 'button').styleEvidence = [
      {
        styleRef: 'primitive.button',
        status: 'linked-artifact-pending',
        artifactRef: missingRef,
        notes: ['Declared artifact path for a future review artifact.']
      }
    ];

    const missingReport = createReadinessReport(missing);
    assert.equal(missingReport.tier, 'blocked');
    assert.ok(
      missingReport.blockers.some(
        item =>
          item.source === 'declared-missing-artifact' &&
          item.severity === 'blocker' &&
          item.artifactRef === missingRef &&
          item.artifactExists === false
      ),
      'missing linked artifacts should be surfaced as evidence blockers'
    );

    const artifactRef = 'artifacts/button-style.json';
    const artifactPath = path.join(tempProjectRoot, artifactRef);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, '{"status":"captured"}\n', 'utf8');
    const linked = cloneBundle(ready);
    requirePrimitive(linked, 'button').styleEvidence = [
      {
        styleRef: 'primitive.button',
        status: 'linked-artifact-pending',
        artifactRef,
        notes: ['Review artifact captured outside the sidecar.']
      }
    ];
    const linkedReport = createReadinessReport(linked);
    assert.equal(linkedReport.tier, 'pending');
    assert.equal(linkedReport.blockers.some(item => item.artifactRef === artifactRef), false);
    assert.ok(
      linkedReport.items.some(
        item =>
          item.source === 'declared' &&
          item.severity === 'pending' &&
          item.artifactRef === artifactRef &&
          item.artifactExists === true
      ),
      'existing linked artifacts should remain visible as pending evidence, not disappear as ready'
    );
  });

  it('adds role-aware token usage to deep packets without inventing mode data', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    const button = requirePrimitive(bundle, 'button');
    assert.equal(button.prototype?.tokenRoles['color.primary'], 'background');
    const destructive = button.stateSets
      .find(stateSet => stateSet.id === 'variant')
      ?.states.find(state => state.id === 'destructive') as
      | (typeof button.stateSets[0]['states'][number] & PrimitiveStateWithTokenRoles)
      | undefined;
    assert.ok(destructive);
    destructive.tokenRoles = {
      'color.destructive': 'destructive-background',
      'color.on-destructive': 'destructive-foreground'
    };
    assert.equal(validateProject(bundle).ok, true);

    const packet = createExtractionPacket(bundle, 'screen:transfer', { mode: 'deep' }) as EnrichedDeepHandoffPacket;
    assert.equal(packet.extraction.mode, 'deep');
    assert.equal(Array.isArray(packet.tokenUsage), true, 'deep packet should expose role-aware token usage');

    const primaryUsage = packet.tokenUsage.find(
      usage => usage.tokenId === 'color.primary' && usage.boundaryId === 'meridian-finance/primitive/button'
    );
    assert.ok(primaryUsage, 'button should name the color.primary token usage');
    assert.equal(primaryUsage.role, 'background');
    assert.equal(primaryUsage.boundaryKind, 'primitive');
    assert.equal(primaryUsage.styleRef, '--app-color-primary');
    const destructiveUsage = packet.tokenUsage.find(
      usage => usage.tokenId === 'color.destructive' && usage.boundaryId === 'meridian-finance/primitive/button'
    );
    assert.ok(destructiveUsage, 'button should name the state-level color.destructive token usage');
    assert.equal(destructiveUsage.role, 'destructive-background');
    assert.equal(destructiveUsage.boundaryKind, 'primitive');
    assert.equal(destructiveUsage.styleRef, '--app-color-destructive');
    assert.equal('declaredModes' in packet, false, 'packet must not invent mode/theme data when sidecars declare none');
  });

  it('validates, traverses, and reverses primitive-to-primitive dependencies', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    const composed = cloneBundle(bundle);
    const card = requirePrimitive(composed, 'card');
    card.uses = [
      {
        kind: 'primitive',
        id: 'button',
        reason: 'Cards can expose the same primary action in compact summaries.'
      }
    ];
    assert.ok(card.prototype);
    composed.prototypeSourceContents[card.prototype.source] = composed.prototypeSourceContents[
      card.prototype.source
    ].replace(
      '</slot>',
      '<blueprint-use kind="primitive" ref="button" state="normal"><span slot="label">Review</span></blueprint-use></slot>'
    );

    assert.equal(validateProject(composed).ok, true);
    const primitivePacket = showBoundary(composed, 'primitive:card') as BoundaryPacket<PrimitiveWithUses>;
    assert.ok(
      primitivePacket.dependencies.uses.some(ref => ref.id === 'meridian-finance/primitive/button'),
      'primitive packets should include primitive-to-primitive uses'
    );

    const usedBy = queryUsedBy(composed, 'primitive:button');
    assert.ok(
      (usedBy.results as BoundaryReference[]).some(ref => ref.id === 'meridian-finance/primitive/card'),
      'used-by should include primitive-to-primitive reverse dependencies'
    );

    const deep = createExtractionPacket(composed, 'primitive:card', { mode: 'deep' }) as DeepHandoffPacket;
    assert.ok(deep.boundaries.some(boundary => boundary.id === 'meridian-finance/primitive/button'));

    const broken = cloneBundle(composed);
    requirePrimitive(broken, 'card').uses = [
      {
        kind: 'primitive',
        id: 'missing-primitive',
        reason: 'Regression fixture for missing primitive dependency validation.'
      }
    ];
    const brokenResult = validateProject(broken);
    assert.equal(brokenResult.ok, false);
    assert.match(brokenResult.errors.join('\n'), /missing-primitive/);
  });

  it('keeps representative fixtures baseline-valid while readiness semantics evolve', async () => {
    for (const root of [starterRoot, miraRoot, umbraRoot, meridianRoot]) {
      const bundle = await loadProjectFromFs(root);
      assert.equal(validateProject(bundle).ok, true, `${root} should remain baseline-valid`);
    }
  });

  it('keeps schema, TypeScript contract, and representative fixtures aligned for new handoff semantics', async () => {
    const schema = JSON.parse(await readFile('schema/blueprint-project.schema.json', 'utf8')) as {
      $defs: Record<string, { properties?: Record<string, unknown> }>;
    };
    assert.ok(schema.$defs.primitive?.properties?.uses, 'schema should expose primitive-to-primitive uses');
    assert.ok(schema.$defs.primitiveState?.properties?.tokenRoles, 'schema should expose app-owned state token roles');
    assert.ok(schema.$defs.boundaryDependency, 'schema should share the boundary dependency shape');
    assert.ok(schema.$defs.readinessReport, 'schema should document readiness report output');
    assert.ok(schema.$defs.deepHandoffPacket?.properties?.tokenUsage, 'schema should document deep packet token usage');
  });

  it('keeps tool artifact defaults under a neutral artifact root', async () => {
    const browserSmoke = await readFile('src/scripts/browser-smoke.ts', 'utf8');
    const extractionArtifacts = await readFile('src/scripts/create-extraction-artifacts.ts', 'utf8');

    for (const source of [browserSmoke, extractionArtifacts]) {
      assert.match(source, /BLUEPRINT_ARTIFACT_ROOT/);
      assert.match(source, /\.blueprint-artifacts/);
    }
  });
});

function readinessReportFactory(): ReadinessReportFactory {
  const moduleWithReadiness = validateCore as typeof validateCore & {
    createReadinessReport?: ReadinessReportFactory;
  };
  const factory = moduleWithReadiness.createReadinessReport;
  if (typeof factory !== 'function') {
    assert.fail('createReadinessReport should be exported');
  }
  return factory;
}

function requirePrimitive(bundle: BlueprintProjectBundle, primitiveId: string): PrimitiveWithUses {
  const primitive = bundle.primitives.primitives.find(item => item.id === primitiveId);
  assert.ok(primitive, `expected primitive ${primitiveId}`);
  return primitive;
}

function fullyResolveStyleEvidence(bundle: BlueprintProjectBundle): BlueprintProjectBundle {
  const resolved = cloneBundle(bundle);
  for (const primitive of resolved.primitives.primitives) {
    primitive.styleEvidence = primitive.styleRefs.map(styleRef => ({
      styleRef,
      status: 'source',
      sourceAnchor: `${resolved.sourceFiles.primitives}#${primitive.id}.${styleRef}`
    }));
    for (const stateSet of primitive.stateSets) {
      stateSet.styleEvidence = stateSet.styleRefs.map(styleRef => ({
        styleRef,
        status: 'source',
        sourceAnchor: `${resolved.sourceFiles.primitives}#${primitive.id}.${stateSet.id}.${styleRef}`
      }));
    }
  }

  for (const screen of resolved.screens.screens) {
    screen.styleEvidence = screen.styleRefs.map(styleRef => ({
      styleRef,
      status: 'source',
      sourceAnchor: `${resolved.sourceFiles.screens}#${screen.id}.${styleRef}`
    }));
    for (const section of screen.sections) {
      section.styleEvidence = section.styleRefs.map(styleRef => ({
        styleRef,
        status: 'source',
        sourceAnchor: `${resolved.sourceFiles.screens}#${screen.id}.${section.id}.${styleRef}`
      }));
    }
  }

  return resolved;
}

async function copyProjectToTemp(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), prefix));
  const projectRoot = path.join(tempDir, 'design', 'blueprint');
  await cp(meridianRoot, projectRoot, { recursive: true });
  return projectRoot;
}

function cloneBundle(bundle: BlueprintProjectBundle): BlueprintProjectBundle {
  return structuredClone(bundle);
}

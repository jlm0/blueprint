import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { createExtractionPacket, listBoundaryReferences, showBoundary } from '../src/core/query';
import type {
  BlueprintProjectBundle,
  BoundaryDependency,
  DeepHandoffPacket,
  PrimitiveDefinition,
  ReadinessReport,
  ScreenDefinition
} from '../src/core/types';
import { createReadinessReport, validateProject } from '../src/core/validate';
import { compilePrototypeDocument, PROTOTYPE_CONTENT_SECURITY_POLICY } from '../src/prototype/compiler';
import { applyPrototypeIframeIsolation } from '../src/prototype/host-policy';
import { createBlueprintResponseHeaders } from '../src/prototype/host-policy';
import { captureInputSchema } from '../src/mcp/schemas';

const fixtureRoot = 'fixtures/red/high-fidelity-prototype/design/blueprint';

interface PrototypeSource {
  source: string;
  styles: string[];
  states: string[];
}

interface RedPrimitive extends PrimitiveDefinition {
  prototype: PrototypeSource & {
    slots: string[];
    variants: string[];
    accessibilityIntent: string;
    tokenRoles: Record<string, string>;
  };
}

interface RedComponentDefinition {
  id: string;
  name: string;
  description: string;
  uses: BoundaryDependency[];
  tokenGroupIds: string[];
  prototype: PrototypeSource & { slots: string[] };
}

interface RedComponentFile {
  schemaVersion: string;
  projectId: string;
  components: RedComponentDefinition[];
}

interface RedScreen extends ScreenDefinition {
  prototype: PrototypeSource & {
    assetRefs: string[];
    reviewConditions: Array<{ id: string; framePresetId: string; state: string }>;
  };
}

interface HighFidelityBundle extends BlueprintProjectBundle {
  components: RedComponentFile;
  sourceFiles: BlueprintProjectBundle['sourceFiles'] & {
    components: string;
    prototypeSources: string[];
  };
}

interface FidelityReadinessReport extends ReadinessReport {
  fidelityTier: 'baseline-compatible' | 'high-fidelity';
  prototypeSources: string[];
}

interface CanonicalPrimitivePacket {
  data: RedPrimitive;
  rendering: {
    mode: 'canonical-app-owned';
    source: string;
    fallbackUsed: false;
  };
}

describe('Blueprint high-fidelity prototype red contract', () => {
  it('T1/R1-R3/R8 loads components and prototype sources as governed bundle inputs', async () => {
    const bundle = (await loadProjectFromFs(fixtureRoot)) as HighFidelityBundle;

    assert.ok(
      bundle.components,
      'T1 contract gap: loadProjectFromFs must load components.json instead of stopping at tokens, primitives, and screens'
    );
    assert.equal(bundle.components.projectId, bundle.manifest.project.id);
    assert.ok(bundle.sourceFiles.components.endsWith('/components.json'));
    assert.ok(
      bundle.sourceFiles.prototypeSources.includes(`${fixtureRoot}/prototype/screens/waitlist.html`),
      'T1 contract gap: governed browser-native prototype sources must be part of bundle provenance'
    );
  });

  it('T1/R1-R2 rejects primitive prototype sources that escape the app-owned sidecar', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const primitive = (bundle.primitives.primitives as RedPrimitive[])[0];
    assert.ok(primitive?.prototype, 'red fixture must declare a canonical primitive prototype source');
    primitive.prototype.source = '../../outside-sidecar/action-button.html';

    const result = validateProject(bundle);
    assert.equal(
      result.ok,
      false,
      'T1 contract gap: baseline validation must fail closed when a declared prototype source escapes the sidecar root'
    );
    assert.match(result.errors.join('\n'), /prototype.*source.*(?:escape|outside|root)/i);
  });

  it('T1/R3/R8 rejects duplicate component IDs and unknown screen component dependencies', async () => {
    const bundle = await withComponents(await loadProjectFromFs(fixtureRoot));
    bundle.components.components.push(structuredClone(bundle.components.components[0]));
    const screen = (bundle.screens.screens as RedScreen[]).find(candidate => candidate.id === 'waitlist');
    assert.ok(screen);
    screen.sections[0].uses[0].id = 'missing-email-signup';

    const result = validateProject(bundle);
    assert.equal(
      result.ok,
      false,
      'T1 contract gap: validation must index component IDs, reject duplicates, and reject unknown component dependencies'
    );
    assert.match(result.errors.join('\n'), /Duplicate.*component|missing.*component/i);
  });

  it('T1/R4/R8 blocks high-fidelity readiness when a declared screen prototype source is missing', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const screen = (bundle.screens.screens as RedScreen[]).find(candidate => candidate.id === 'waitlist');
    assert.ok(screen?.prototype);
    screen.prototype.source = 'prototype/screens/missing-waitlist.html';

    const strict = validateProject(bundle, { mode: 'strict' });
    assert.equal(
      strict.ok,
      false,
      'T1 contract gap: strict readiness must not pass a high-fidelity screen whose declared visual source is missing'
    );
    assert.match(strict.errors.join('\n'), /waitlist.*prototype.*source.*(?:missing|exist)/i);
  });

  it('T2/R1-R2 selects the app-owned source ahead of the labeled legacy fallback for prototype-backed primitives', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const packet = showBoundary(bundle, 'primitive:action-button') as CanonicalPrimitivePacket;

    assert.deepEqual(
      packet.rendering,
      {
        mode: 'canonical-app-owned',
        source: 'prototype/primitives/action-button.html',
        fallbackUsed: false
      },
      'T2 runtime gap: a prototype-backed primitive must select its app-owned canonical source; legacy fallback remains allowed only when no canonical source is declared'
    );
  });

  it('T3/R3-R4/R7 traverses the exact screen to component to primitive to token graph', async () => {
    const bundle = await withComponents(await loadProjectFromFs(fixtureRoot));

    assert.doesNotThrow(
      () => {
        const packet = createExtractionPacket(bundle, 'screen:waitlist', { mode: 'deep' }) as DeepHandoffPacket;
        assert.deepEqual(
          packet.extraction.includedBoundaryIds,
          [
            'high-fidelity-red/screen/waitlist',
            'high-fidelity-red/section/waitlist/hero',
            'high-fidelity-red/component/email-signup',
            'high-fidelity-red/primitive/action-button',
            'high-fidelity-red/token-group/color',
            'high-fidelity-red/token-group/shape',
            'high-fidelity-red/token-group/space',
            'high-fidelity-red/token-group/typography',
            'high-fidelity-red/state-set/action-button/interaction'
          ],
          'T3 contract gap: deep extraction must expose the complete declared composition graph in stable order'
        );
      },
      'T3 contract gap: component dependencies must be supported by deep extraction rather than rejected as an unknown kind'
    );

    assert.ok(
      listBoundaryReferences(bundle).some(reference => reference.id === 'high-fidelity-red/component/email-signup'),
      'T3 contract gap: component boundaries must be indexed and queryable'
    );
  });

  it('T4/R4-R5 requires an isolated no-script prototype host instead of main-document section projection', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const compiled = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'waitlist' }, state: 'initial' });
    const iframeAttributes = new Map<string, string>();
    applyPrototypeIframeIsolation({ setAttribute: (name, value) => iframeAttributes.set(name, value) });

    assert.deepEqual([...iframeAttributes], [['sandbox', '']]);
    assert.match(PROTOTYPE_CONTENT_SECURITY_POLICY, /script-src 'none'/);
    assert.match(PROTOTYPE_CONTENT_SECURITY_POLICY, /connect-src 'none'/);
    assert.equal(
      createBlueprintResponseHeaders({
        contentType: 'text/html; charset=utf-8',
        contentSecurityPolicy: PROTOTYPE_CONTENT_SECURITY_POLICY
      })['Content-Security-Policy'],
      PROTOTYPE_CONTENT_SECURITY_POLICY
    );
    assert.match(
      compiled.html,
      /http-equiv="Content-Security-Policy"[^>]*script-src &#39;none&#39;[^>]*connect-src &#39;none&#39;/,
      'T4 isolation gap: compiled prototype documents must receive the shared no-script, no-network policy'
    );
  });

  it('T5/R5 exposes deterministic state and viewport selection on the public capture tool', () => {
    assert.equal(captureInputSchema.safeParse({
      project: fixtureRoot,
      boundary: 'screen:waitlist',
      state: 'initial',
      viewport: 'desktop-reference',
      out: '.blueprint-artifacts/waitlist.png'
    }).success, true);
  });

  it('T6/R6 keeps the Blueprint runtime free of NowWhat-specific rendering branches', async () => {
    const runtimeFiles = [
      'src/app/main.ts',
      'src/app/fixture-projects.ts',
      'src/core/load.ts',
      'src/core/query.ts',
      'src/core/review.ts',
      'src/core/validate.ts',
      'src/mcp/create-server.ts',
      'src/mcp/operations.ts',
      'src/mcp/schemas.ts',
      'src/mcp/server.ts',
      'src/prototype/compiler.ts',
      'src/prototype/browser-preflight.ts',
      'src/prototype/host-policy.ts'
    ];
    const runtimeSource = (await Promise.all(runtimeFiles.map(file => readFile(file, 'utf8')))).join('\n');

    assert.doesNotMatch(
      runtimeSource,
      /nowwhat|waitlist-pass1|screens\/waitlist/i,
      'T6 portability guard: Blueprint runtime code must not branch on NowWhat fixture identity or paths'
    );
  });

  it('T7/R7 carries prototype provenance and review conditions in focused handoff packets', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const screen = (bundle.screens.screens as RedScreen[]).find(candidate => candidate.id === 'waitlist');
    assert.ok(screen);
    screen.sections[0].uses = [
      {
        kind: 'primitive',
        id: 'action-button',
        reason: 'Supported dependency used to isolate prototype provenance from component traversal.',
        binding: { slot: 'signup', state: 'default' }
      }
    ];

    const packet = showBoundary(bundle, 'screen:waitlist');
    assert.ok(
      packet.sourceFiles.includes(`${fixtureRoot}/prototype/screens/waitlist.html`),
      'T7 handoff gap: a focused screen packet must include the browser-native source that produced the reviewed screen'
    );
    assert.deepEqual(
      (packet.data as RedScreen).prototype.reviewConditions.map(condition => condition.id),
      ['desktop-initial', 'phone-initial']
    );
  });

  it('T8/R8 initializes the governed token to primitive to component to screen foundation', () => {
    assert.equal(
      existsSync(path.join('starter', 'design', 'blueprint', 'components.json')),
      true,
      'T8 starter gap: the init tool cannot produce the new composition contract until the starter includes components.json'
    );
    assert.equal(
      existsSync(path.join('starter', 'design', 'blueprint', 'prototype')),
      true,
      'T8 starter gap: the init tool must include governed canonical and screen prototype source roots'
    );
  });

  it('T8/R8 classifies legacy fixtures honestly without claiming high-fidelity readiness', async () => {
    const legacy = createReadinessReport(
      await loadProjectFromFs('fixtures/app-owned/nova-care/design/blueprint')
    ) as FidelityReadinessReport;
    assert.equal(
      legacy.fidelityTier,
      'baseline-compatible',
      'T8 compatibility gap: legacy structured fixtures need an explicit baseline-compatible fidelity classification'
    );
    assert.deepEqual(legacy.prototypeSources, []);

    const highFidelity = createReadinessReport(await loadProjectFromFs(fixtureRoot)) as FidelityReadinessReport;
    assert.equal(highFidelity.fidelityTier, 'high-fidelity');
    assert.ok(highFidelity.prototypeSources.includes('prototype/screens/waitlist.html'));
  });

  it('T9/R1-R8 retains the complete repository QA command contract', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const script of ['typecheck', 'check:fixtures', 'test', 'extract:artifacts', 'scan:scope', 'build', 'smoke:browser', 'qa']) {
      assert.equal(
        typeof packageJson.scripts[script],
        'string',
        `T9 harness gap: package.json must retain the required ${script} validation command`
      );
    }
  });
});

async function withComponents(bundle: BlueprintProjectBundle): Promise<HighFidelityBundle> {
  const components = JSON.parse(
    await readFile(path.join(fixtureRoot, 'components.json'), 'utf8')
  ) as RedComponentFile;
  return Object.assign(bundle, {
    components,
    sourceFiles: {
      ...bundle.sourceFiles,
      components: `${fixtureRoot}/components.json`,
      prototypeSources: []
    }
  });
}

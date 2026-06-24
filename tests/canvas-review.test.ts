import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import {
  createCanvasStyleEvidence,
  createReviewManifest,
  summarizeScreenSections,
  validateVisibleBoundaryRecords
} from '../src/core/review';
import { createConfiguredProjectBundle } from '../src/app/fixture-projects';
import type { VisibleBoundaryRecord } from '../src/core/review';

const novaRoot = 'fixtures/app-owned/nova-care/design/blueprint';

describe('Blueprint canvas-to-contract review loop', () => {
  it('summarizes screen sections from structured data without requiring visible phone content', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const sections = summarizeScreenSections(bundle, 'home');

    assert.equal(sections.length, 3);
    assert.deepEqual(
      sections.map(section => section.boundaryId),
      ['nova-care/section/home/summary', 'nova-care/section/home/next-action', 'nova-care/section/home/insight-lab']
    );

    const nextAction = sections.find(section => section.localId === 'home/next-action');
    assert.ok(nextAction);
    assert.equal(nextAction.name, 'Next Action');
    assert.match(nextAction.description, /Primary patient action/);
    assert.equal(nextAction.prototypeOnly, false);
    assert.equal(nextAction.dependencyCount, 2);
    assert.deepEqual(nextAction.dependencySummary, ['primitive:action-button', 'state-set:action-button/intent']);

    const prototypeOnly = sections.find(section => section.localId === 'home/insight-lab');
    assert.ok(prototypeOnly?.prototypeOnly);
  });

  it('validates visible boundaries and rejects stale structured records when supplied', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const valid: VisibleBoundaryRecord[] = [
      { id: 'nova-care/primitive/action-button', kind: 'primitive', board: 'primitives', label: 'Action Button' },
      { id: 'nova-care/screen/home', kind: 'screen', board: 'screens', label: 'Care Home', screenId: 'home' },
      { id: 'nova-care/section/home/next-action', kind: 'section', board: 'screens', label: 'Next Action', screenId: 'home' }
    ];

    const result = validateVisibleBoundaryRecords(bundle, valid);
    assert.equal(result.ok, true, result.errors.join('\n'));

    const stale = validateVisibleBoundaryRecords(bundle, [
      ...valid,
      { id: 'nova-care/section/home/missing', kind: 'section', board: 'screens', label: 'Missing', screenId: 'home' }
    ]);
    assert.equal(stale.ok, false);
    assert.match(stale.errors.join('\n'), /nova-care\/section\/home\/missing/);
  });

  it('creates machine-readable review manifests with optional handoff command linkage', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const records: VisibleBoundaryRecord[] = [
      { id: 'nova-care/screen/home', kind: 'screen', board: 'screens', label: 'Care Home', screenId: 'home' },
      { id: 'nova-care/section/home/next-action', kind: 'section', board: 'screens', label: 'Next Action', screenId: 'home' }
    ];

    const manifest = createReviewManifest(bundle, records, {
      generatedAt: '2026-06-23T20:00:00.000Z',
      board: 'screens',
      screenId: 'home',
      screenshotPath: '.agent-workstream/2026-06-23-04-blueprint-canvas-contract-review-loop/artifacts/screenshots/blueprint-screens-desktop.png',
      packetCommandBase: 'blueprint extract'
    });

    assert.equal(manifest.projectId, 'nova-care');
    assert.equal(manifest.board, 'screens');
    assert.equal(manifest.screenId, 'home');
    assert.equal(manifest.screenshot.status, 'captured');
    assert.equal(manifest.boundaries.length, 2);
    assert.equal(manifest.boundaries[1]?.boundaryId, 'nova-care/section/home/next-action');
    assert.match(manifest.boundaries[1]?.packet.command ?? '', /blueprint extract --project fixtures\/app-owned\/nova-care\/design\/blueprint --boundary section:home\/next-action --mode deep/);
  });

  it('creates boundary-scoped canvas-side style evidence artifacts', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const evidence = createCanvasStyleEvidence(bundle, [
      {
        id: 'nova-care/screen/home',
        kind: 'screen',
        board: 'screens',
        label: 'Care Home',
        screenId: 'home',
        renderedSnippet: '<article class="frame">Care Home</article>',
        computedStyles: {
          backgroundColor: 'rgba(0, 0, 0, 0)',
          borderRadius: '34px'
        }
      }
    ], {
      generatedAt: '2026-06-23T20:00:00.000Z',
      screenshotPath: '.agent-workstream/2026-06-23-04-blueprint-canvas-contract-review-loop/artifacts/screenshots/blueprint-screens-desktop.png'
    });

    assert.equal(evidence.projectId, 'nova-care');
    assert.equal(evidence.boundaries[0]?.boundaryId, 'nova-care/screen/home');
    assert.equal(evidence.boundaries[0]?.status, 'captured');
    assert.equal(evidence.boundaries[0]?.evidenceType, 'canvas-dom');
    assert.match(evidence.boundaries[0]?.renderedSnippet ?? '', /class="frame"/);
    assert.equal(evidence.boundaries[0]?.computedStyles?.borderRadius, '34px');
  });

  it('accepts one generated project bundle at a time without adding project manager state', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const configured = createConfiguredProjectBundle(bundle);

    assert.equal(configured.manifest.project.id, 'nova-care');
    assert.equal(configured.manifest.project.sourceRoot, novaRoot);
    assert.equal(configured.screens.screens[0]?.sections.length, 3);
  });
});

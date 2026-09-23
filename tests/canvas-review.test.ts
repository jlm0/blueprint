import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import {
  createCanvasStyleEvidence,
  createReviewManifest,
  summarizeScreenSections,
  validateVisibleBoundaryRecords
} from '../src/core/review';
import { createConfiguredProjectBundle } from '../src/core/bundle';
import type { VisibleBoundaryRecord } from '../src/core/review';

const stillRoot = 'fixtures/app-owned/still-meditation/design/blueprint';

describe('Blueprint canvas-to-contract review loop', () => {
  it('summarizes screen sections from structured data without requiring visible phone content', async () => {
    const bundle = structuredClone(await loadProjectFromFs(stillRoot));
    const recommendation = bundle.screens.screens
      .find(screen => screen.id === 'home')
      ?.sections.find(section => section.id === 'recommendation');
    assert.ok(recommendation);
    recommendation.prototypeOnly = true;
    const sections = summarizeScreenSections(bundle, 'home');

    assert.equal(sections.length, 5);
    assert.deepEqual(
      sections.map(section => section.boundaryId),
      [
        'still-meditation/section/home/welcome',
        'still-meditation/section/home/featured-practice',
        'still-meditation/section/home/daily-rhythm',
        'still-meditation/section/home/recommendation',
        'still-meditation/section/home/navigation'
      ]
    );

    const featured = sections.find(section => section.localId === 'home/featured-practice');
    assert.ok(featured);
    assert.equal(featured.name, 'Featured Practice');
    assert.match(featured.description, /Primary morning meditation card/);
    assert.equal(featured.prototypeOnly, false);
    assert.equal(featured.dependencyCount, 2);
    assert.deepEqual(featured.dependencySummary, ['primitive:badge', 'primitive:button']);

    const prototypeOnly = sections.find(section => section.localId === 'home/recommendation');
    assert.ok(prototypeOnly?.prototypeOnly);
  });

  it('validates visible boundaries and rejects stale structured records when supplied', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    const valid: VisibleBoundaryRecord[] = [
      { id: 'still-meditation/primitive/button', kind: 'primitive', board: 'primitives', label: 'Button' },
      { id: 'still-meditation/screen/home', kind: 'screen', board: 'screens', label: 'Today', screenId: 'home' },
      {
        id: 'still-meditation/section/home/featured-practice',
        kind: 'section',
        board: 'screens',
        label: 'Featured Practice',
        screenId: 'home'
      }
    ];

    const result = validateVisibleBoundaryRecords(bundle, valid);
    assert.equal(result.ok, true, result.errors.join('\n'));

    const stale = validateVisibleBoundaryRecords(bundle, [
      ...valid,
      { id: 'still-meditation/section/home/missing', kind: 'section', board: 'screens', label: 'Missing', screenId: 'home' }
    ]);
    assert.equal(stale.ok, false);
    assert.match(stale.errors.join('\n'), /still-meditation\/section\/home\/missing/);
  });

  it('creates machine-readable review manifests with optional MCP handoff linkage', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    const records: VisibleBoundaryRecord[] = [
      { id: 'still-meditation/screen/home', kind: 'screen', board: 'screens', label: 'Today', screenId: 'home' },
      {
        id: 'still-meditation/section/home/featured-practice',
        kind: 'section',
        board: 'screens',
        label: 'Featured Practice',
        screenId: 'home'
      }
    ];

    const manifest = createReviewManifest(bundle, records, {
      generatedAt: '2026-06-23T20:00:00.000Z',
      board: 'screens',
      screenId: 'home',
      screenshotPath: '.blueprint-artifacts/browser-smoke/screenshots/blueprint-screens-mobile.png',
      packetToolName: 'extract'
    });

    assert.equal(manifest.projectId, 'still-meditation');
    assert.equal(manifest.board, 'screens');
    assert.equal(manifest.screenId, 'home');
    assert.equal(manifest.capture.status, 'captured');
    assert.equal(manifest.screenshot.status, 'captured');
    assert.equal(manifest.boundaries.length, 2);
    assert.equal(manifest.boundaries[1]?.boundaryId, 'still-meditation/section/home/featured-practice');
    assert.deepEqual(manifest.boundaries[1]?.packet.tool, {
      name: 'extract',
      arguments: {
        project: stillRoot,
        boundary: 'section:home/featured-practice',
        mode: 'deep'
      }
    });
  });

  it('records an unresolved prototype capture with exact source, state, and viewport context', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    const records: VisibleBoundaryRecord[] = [
      { id: 'still-meditation/screen/home', kind: 'screen', board: 'screens', label: 'Today', screenId: 'home' }
    ];
    const manifest = createReviewManifest(bundle, records, {
      generatedAt: '2026-07-15T06:41:07.000Z',
      board: 'screens',
      screenId: 'home',
      captureStatus: 'unresolved',
      captureReason: 'No current browser capture exists.',
      prototypeReview: {
        source: 'prototype/screens/home.html',
        state: 'default',
        framePresetId: 'phone',
        conditionId: 'phone-default'
      },
      packetToolName: 'extract'
    });

    assert.deepEqual(manifest.capture, {
      status: 'unresolved',
      reason: 'No current browser capture exists.'
    });
    assert.deepEqual(manifest.screenshot, manifest.capture);
    assert.deepEqual(manifest.boundaries[0]?.capture, manifest.capture);
    assert.equal(manifest.prototypeReview?.source, 'prototype/screens/home.html');
    assert.equal(manifest.prototypeReview?.state, 'default');
    assert.equal(manifest.prototypeReview?.framePresetId, 'phone');
    assert.equal(manifest.prototypeReview?.conditionId, 'phone-default');
    assert.throws(
      () => createReviewManifest(bundle, records, { board: 'screens', captureStatus: 'unresolved' }),
      /require a capture reason/
    );
  });

  it('creates boundary-scoped canvas-side style evidence artifacts', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    const evidence = createCanvasStyleEvidence(bundle, [
      {
        id: 'still-meditation/screen/home',
        kind: 'screen',
        board: 'screens',
        label: 'Today',
        screenId: 'home',
        renderedSnippet: '<article class="frame">Today</article>',
        computedStyles: {
          backgroundColor: 'rgba(0, 0, 0, 0)',
          borderRadius: '34px'
        }
      }
    ], {
      generatedAt: '2026-06-23T20:00:00.000Z',
      screenshotPath: '.blueprint-artifacts/browser-smoke/screenshots/blueprint-screens-mobile.png'
    });

    assert.equal(evidence.projectId, 'still-meditation');
    assert.equal(evidence.boundaries[0]?.boundaryId, 'still-meditation/screen/home');
    assert.equal(evidence.boundaries[0]?.status, 'captured');
    assert.equal(evidence.boundaries[0]?.evidenceType, 'canvas-dom');
    assert.match(evidence.boundaries[0]?.renderedSnippet ?? '', /class="frame"/);
    assert.equal(evidence.boundaries[0]?.computedStyles?.borderRadius, '34px');
  });

  it('accepts one generated project bundle at a time without adding project manager state', async () => {
    const bundle = await loadProjectFromFs(stillRoot);
    const configured = createConfiguredProjectBundle(bundle);

    assert.equal(configured.manifest.project.id, 'still-meditation');
    assert.equal(configured.manifest.project.sourceRoot, stillRoot);
    assert.equal(configured.screens.screens[0]?.sections.length, 5);
  });
});

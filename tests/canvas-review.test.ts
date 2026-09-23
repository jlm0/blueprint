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

const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';

describe('Blueprint canvas-to-contract review loop', () => {
  it('summarizes screen sections from structured data without requiring visible phone content', async () => {
    const bundle = structuredClone(await loadProjectFromFs(miraRoot));
    const welcome = bundle.screens.screens
      .find(screen => screen.id === 'chat')
      ?.sections.find(section => section.id === 'welcome');
    assert.ok(welcome);
    welcome.prototypeOnly = true;
    const sections = summarizeScreenSections(bundle, 'chat');

    assert.equal(sections.length, 4);
    assert.deepEqual(
      sections.map(section => section.boundaryId),
      [
        'mira-ai/section/chat/header',
        'mira-ai/section/chat/conversation',
        'mira-ai/section/chat/welcome',
        'mira-ai/section/chat/composer'
      ]
    );

    const conversation = sections.find(section => section.localId === 'chat/conversation');
    assert.ok(conversation);
    assert.equal(conversation.name, 'Conversation');
    assert.match(conversation.description, /compact figure, and citation chips/);
    assert.equal(conversation.prototypeOnly, false);
    assert.equal(conversation.dependencyCount, 2);
    assert.deepEqual(conversation.dependencySummary, ['component:insight-chart', 'primitive:badge']);

    const prototypeOnly = sections.find(section => section.localId === 'chat/welcome');
    assert.ok(prototypeOnly?.prototypeOnly);
  });

  it('validates visible boundaries and rejects stale structured records when supplied', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const valid: VisibleBoundaryRecord[] = [
      { id: 'mira-ai/primitive/button', kind: 'primitive', board: 'primitives', label: 'Button' },
      { id: 'mira-ai/screen/chat', kind: 'screen', board: 'screens', label: 'Chat', screenId: 'chat' },
      {
        id: 'mira-ai/section/chat/conversation',
        kind: 'section',
        board: 'screens',
        label: 'Conversation',
        screenId: 'chat'
      }
    ];

    const result = validateVisibleBoundaryRecords(bundle, valid);
    assert.equal(result.ok, true, result.errors.join('\n'));

    const stale = validateVisibleBoundaryRecords(bundle, [
      ...valid,
      { id: 'mira-ai/section/chat/missing', kind: 'section', board: 'screens', label: 'Missing', screenId: 'chat' }
    ]);
    assert.equal(stale.ok, false);
    assert.match(stale.errors.join('\n'), /mira-ai\/section\/chat\/missing/);
  });

  it('creates machine-readable review manifests with optional MCP handoff linkage', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const records: VisibleBoundaryRecord[] = [
      { id: 'mira-ai/screen/chat', kind: 'screen', board: 'screens', label: 'Chat', screenId: 'chat' },
      {
        id: 'mira-ai/section/chat/conversation',
        kind: 'section',
        board: 'screens',
        label: 'Conversation',
        screenId: 'chat'
      }
    ];

    const manifest = createReviewManifest(bundle, records, {
      generatedAt: '2026-06-23T20:00:00.000Z',
      board: 'screens',
      screenId: 'chat',
      screenshotPath: '.blueprint-artifacts/browser-smoke/screenshots/blueprint-screens-mobile.png',
      packetToolName: 'extract'
    });

    assert.equal(manifest.projectId, 'mira-ai');
    assert.equal(manifest.board, 'screens');
    assert.equal(manifest.screenId, 'chat');
    assert.equal(manifest.capture.status, 'captured');
    assert.equal(manifest.screenshot.status, 'captured');
    assert.equal(manifest.boundaries.length, 2);
    assert.equal(manifest.boundaries[1]?.boundaryId, 'mira-ai/section/chat/conversation');
    assert.deepEqual(manifest.boundaries[1]?.packet.tool, {
      name: 'extract',
      arguments: {
        project: miraRoot,
        boundary: 'section:chat/conversation',
        mode: 'deep'
      }
    });
  });

  it('records an unresolved prototype capture with exact source, state, and viewport context', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const records: VisibleBoundaryRecord[] = [
      { id: 'mira-ai/screen/chat', kind: 'screen', board: 'screens', label: 'Chat', screenId: 'chat' }
    ];
    const manifest = createReviewManifest(bundle, records, {
      generatedAt: '2026-07-15T06:41:07.000Z',
      board: 'screens',
      screenId: 'chat',
      captureStatus: 'unresolved',
      captureReason: 'No current browser capture exists.',
      prototypeReview: {
        source: 'prototype/screens/chat.html',
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
    assert.equal(manifest.prototypeReview?.source, 'prototype/screens/chat.html');
    assert.equal(manifest.prototypeReview?.state, 'default');
    assert.equal(manifest.prototypeReview?.framePresetId, 'phone');
    assert.equal(manifest.prototypeReview?.conditionId, 'phone-default');
    assert.throws(
      () => createReviewManifest(bundle, records, { board: 'screens', captureStatus: 'unresolved' }),
      /require a capture reason/
    );
  });

  it('creates boundary-scoped canvas-side style evidence artifacts', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const evidence = createCanvasStyleEvidence(bundle, [
      {
        id: 'mira-ai/screen/chat',
        kind: 'screen',
        board: 'screens',
        label: 'Chat',
        screenId: 'chat',
        renderedSnippet: '<article class="frame">Chat</article>',
        computedStyles: {
          backgroundColor: 'rgba(0, 0, 0, 0)',
          borderRadius: '34px'
        }
      }
    ], {
      generatedAt: '2026-06-23T20:00:00.000Z',
      screenshotPath: '.blueprint-artifacts/browser-smoke/screenshots/blueprint-screens-mobile.png'
    });

    assert.equal(evidence.projectId, 'mira-ai');
    assert.equal(evidence.boundaries[0]?.boundaryId, 'mira-ai/screen/chat');
    assert.equal(evidence.boundaries[0]?.status, 'captured');
    assert.equal(evidence.boundaries[0]?.evidenceType, 'canvas-dom');
    assert.match(evidence.boundaries[0]?.renderedSnippet ?? '', /class="frame"/);
    assert.equal(evidence.boundaries[0]?.computedStyles?.borderRadius, '34px');
  });

  it('accepts one generated project bundle at a time without adding project manager state', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const configured = createConfiguredProjectBundle(bundle);

    assert.equal(configured.manifest.project.id, 'mira-ai');
    assert.equal(configured.manifest.project.sourceRoot, 'design/blueprint');
    assert.equal(configured.screens.screens[0]?.sections.length, 6);
  });
});

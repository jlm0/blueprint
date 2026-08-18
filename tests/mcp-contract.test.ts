import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  captureInputSchema,
  exploreInputSchema,
  extractInputSchema,
  initInputSchema,
  promoteInputSchema,
  queryInputSchema,
  serveInputSchema,
  validateInputSchema
} from '../src/mcp/schemas';
import { BLUEPRINT_MCP_TOOL_NAMES, createBlueprintMcpServer } from '../src/mcp/create-server';

describe('Blueprint MCP typed contract', () => {
  it('publishes the seven parity tools plus bounded exploration mutations', async () => {
    assert.deepEqual(BLUEPRINT_MCP_TOOL_NAMES, [
      'init',
      'validate',
      'index',
      'query',
      'extract',
      'capture',
      'serve',
      'explore',
      'promote'
    ]);
    const server = createBlueprintMcpServer();
    await server.close();
  });

  it('applies defaults without accepting unknown fields', () => {
    assert.deepEqual(initInputSchema.parse({ projectId: 'app', name: 'App', out: 'design/blueprint' }), {
      projectId: 'app',
      name: 'App',
      out: 'design/blueprint',
      force: false
    });
    assert.equal(validateInputSchema.parse({ project: 'design/blueprint' }).mode, 'baseline');
    assert.equal(extractInputSchema.parse({ project: 'design/blueprint', boundary: 'screen:home' }).mode, 'focused');
    assert.deepEqual(serveInputSchema.parse({}), { project: 'design/blueprint', port: 4173 });
    assert.equal(validateInputSchema.safeParse({ project: 'design/blueprint', surprise: true }).success, false);
  });

  it('models query variants as a strict discriminated union', () => {
    for (const query of [
      { type: 'show', boundary: 'screen:home' },
      { type: 'uses', boundary: 'screen:home' },
      { type: 'used-by', boundary: 'primitive:button' },
      { type: 'sections', screen: 'home' },
      { type: 'prototype-only' },
      { type: 'explorations', screenId: 'home', lifecycle: 'active' },
      { type: 'exploration', explorationId: 'home-layout' }
    ]) {
      assert.equal(queryInputSchema.safeParse({ project: 'design/blueprint', query }).success, true);
    }
    assert.equal(queryInputSchema.safeParse({ project: 'design/blueprint', query: { type: 'sections', boundary: 'screen:home' } }).success, false);
    assert.equal(queryInputSchema.safeParse({ project: 'design/blueprint', query: { type: 'show', boundary: 'home' } }).success, false);
    assert.equal(queryInputSchema.safeParse({ project: 'design/blueprint', query: { type: 'prototype-only', boundary: 'screen:home' } }).success, false);
  });

  it('keeps exploration effects in strict create/archive and compare-and-swap contracts', () => {
    assert.equal(exploreInputSchema.safeParse({
      project: 'design/blueprint',
      operation: {
        type: 'create',
        screenId: 'home',
        state: 'initial',
        framePresetId: 'phone',
        title: 'Home layout',
        intent: 'Compare the hero treatment',
        candidateLabels: ['A', 'B', 'C']
      }
    }).success, true);
    assert.equal(exploreInputSchema.safeParse({
      project: 'design/blueprint',
      operation: { type: 'archive', explorationId: 'home-layout' }
    }).success, true);
    assert.equal(exploreInputSchema.safeParse({
      project: 'design/blueprint',
      operation: { type: 'archive', explorationId: 'home-layout', deleteSources: true }
    }).success, false);

    const digest = 'a'.repeat(64);
    assert.equal(promoteInputSchema.safeParse({
      project: 'design/blueprint',
      explorationId: 'home-layout',
      candidateId: 'b',
      expectedBaseDigest: digest,
      expectedCurrentDigest: digest,
      expectedCandidateDigest: digest
    }).success, true);
    assert.equal(promoteInputSchema.safeParse({
      project: 'design/blueprint',
      explorationId: 'home-layout',
      candidateId: 'b',
      expectedBaseDigest: 'stale',
      expectedCurrentDigest: digest,
      expectedCandidateDigest: digest
    }).success, false);
  });

  it('requires capture to target a typed screen boundary and explicit output path', () => {
    assert.equal(captureInputSchema.safeParse({
      project: 'design/blueprint',
      boundary: 'screen:home',
      state: 'initial',
      viewport: 'phone',
      out: '.blueprint-artifacts/home.png'
    }).success, true);
    assert.equal(captureInputSchema.safeParse({
      project: 'design/blueprint',
      boundary: 'primitive:button',
      out: '.blueprint-artifacts/button.png'
    }).success, false);
    assert.equal(captureInputSchema.safeParse({ project: 'design/blueprint', boundary: 'screen:home' }).success, false);
  });
});

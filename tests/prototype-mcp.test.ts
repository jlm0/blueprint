import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  assertChromiumExecutableAvailable,
  CHROMIUM_INSTALL_COMMAND
} from '../src/prototype/browser-preflight';
import {
  compilePrototypeReview,
  parsePrototypeReviewRequest,
  resolvePrototypeReviewSelection
} from '../src/prototype/review';
import { loadProjectFromFs } from '../src/core/load';
import { captureInputSchema } from '../src/mcp/schemas';

const fixtureRoot = 'fixtures/valid/mira-ai/design/blueprint';

describe('source-focused prototype MCP contract', () => {
  it('resolves only declared state and viewport combinations at exact CSS-pixel dimensions', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const desktop = resolvePrototypeReviewSelection(bundle, {
      screenId: 'workspace',
      state: 'default',
      viewport: 'desktop-web'
    });
    const phone = resolvePrototypeReviewSelection(bundle, {
      screenId: 'chat',
      viewport: 'phone-empty'
    });

    assert.deepEqual(desktop, {
      screenId: 'workspace',
      boundaryId: 'mira-ai/screen/workspace',
      conditionId: 'desktop-web-default',
      framePresetId: 'desktop-web',
      state: 'default',
      width: 1440,
      height: 900
    });
    assert.equal(phone.conditionId, 'phone-empty');
    assert.equal(phone.framePresetId, 'phone');
    assert.equal(phone.state, 'empty');
    assert.equal(phone.width, 393);
    assert.equal(phone.height, 852);

    assert.throws(
      () => resolvePrototypeReviewSelection(bundle, { screenId: 'chat', viewport: 'tablet' }),
      /does not declare a review condition/
    );
    assert.throws(
      () => resolvePrototypeReviewSelection(bundle, { screenId: 'chat', state: 'submitted' }),
      /does not declare a review condition/
    );
  });

  it('compiles the selected screen itself without editor chrome or unexpanded uses', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const selection = resolvePrototypeReviewSelection(bundle, {
      screenId: 'chat',
      state: 'default',
      viewport: 'phone'
    });
    const compiled = compilePrototypeReview(bundle, selection);

    assert.match(compiled.html, /^<!doctype html>/);
    assert.match(compiled.html, /data-blueprint-boundary-id="mira-ai\/screen\/chat"/);
    assert.doesNotMatch(compiled.html, /<blueprint-use\b/i);
    assert.doesNotMatch(compiled.html, /canvas-toolbar|board-switcher|frame-save/);
    assert.deepEqual(compiled.observedBoundaryIds, [
      'mira-ai/primitive/nav-bar',
      'mira-ai/component/insight-chart',
      'mira-ai/primitive/segmented-control',
      'mira-ai/primitive/badge',
      'mira-ai/component/prompt-card',
      'mira-ai/component/composer',
      'mira-ai/primitive/button'
    ]);
  });

  it('fails closed on malformed review route input', () => {
    assert.deepEqual(
      parsePrototypeReviewRequest(
        new URL('http://127.0.0.1/__blueprint/prototype?screen=chat&state=default&viewport=phone')
      ),
      { screenId: 'chat', state: 'default', viewport: 'phone' }
    );
    assert.throws(
      () => parsePrototypeReviewRequest(new URL('http://127.0.0.1/__blueprint/prototype?state=initial')),
      /Missing prototype review parameter "screen"/
    );
    assert.throws(
      () => parsePrototypeReviewRequest(new URL('http://127.0.0.1/__blueprint/prototype?screen=chat&screen=other')),
      /must appear exactly once/
    );
    assert.throws(
      () => parsePrototypeReviewRequest(new URL('http://127.0.0.1/__blueprint/prototype?screen=chat&debug=true')),
      /Unsupported prototype review parameter "debug"/
    );
  });

  it('preflights missing Chromium with actionable install guidance before capture', () => {
    assert.throws(
      () => assertChromiumExecutableAvailable('/missing/chromium', () => false),
      new RegExp(CHROMIUM_INSTALL_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  });

  it('publishes typed state and viewport capture inputs plus the source-focused capture path', async () => {
    assert.equal(captureInputSchema.safeParse({
      project: fixtureRoot,
      boundary: 'screen:chat',
      state: 'default',
      viewport: 'phone',
      out: '.blueprint-artifacts/chat.png'
    }).success, true);

    const operationsSource = await readFile('src/mcp/operations.ts', 'utf8');
    assert.match(operationsSource, /\/__blueprint\/prototype/);
    assert.match(operationsSource, /page\.setContent\(compiled\.html/);
    assert.match(operationsSource, /editorChrome:\s*false/);
  });
});

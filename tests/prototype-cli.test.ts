import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  assertChromiumExecutableAvailable,
  CHROMIUM_INSTALL_COMMAND
} from '../src/cli/browser-preflight';
import {
  compilePrototypeReview,
  parsePrototypeReviewRequest,
  resolvePrototypeReviewSelection
} from '../src/cli/prototype-review';
import { loadProjectFromFs } from '../src/core/load';

const fixtureRoot = 'fixtures/red/high-fidelity-prototype/design/blueprint';

describe('source-focused prototype CLI contract', () => {
  it('resolves only declared state and viewport combinations at exact CSS-pixel dimensions', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const desktop = resolvePrototypeReviewSelection(bundle, {
      screenId: 'waitlist',
      state: 'initial',
      viewport: 'desktop-reference'
    });
    const phone = resolvePrototypeReviewSelection(bundle, {
      screenId: 'waitlist',
      viewport: 'phone-initial'
    });

    assert.deepEqual(desktop, {
      screenId: 'waitlist',
      boundaryId: 'high-fidelity-red/screen/waitlist',
      conditionId: 'desktop-initial',
      framePresetId: 'desktop-reference',
      state: 'initial',
      width: 1280,
      height: 800
    });
    assert.equal(phone.conditionId, 'phone-initial');
    assert.equal(phone.framePresetId, 'phone-review');
    assert.equal(phone.width, 390);
    assert.equal(phone.height, 844);

    assert.throws(
      () => resolvePrototypeReviewSelection(bundle, { screenId: 'waitlist', viewport: 'tablet' }),
      /does not declare a review condition/
    );
    assert.throws(
      () => resolvePrototypeReviewSelection(bundle, { screenId: 'waitlist', state: 'submitted' }),
      /does not declare a review condition/
    );
  });

  it('compiles the selected screen itself without editor chrome or unexpanded uses', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const selection = resolvePrototypeReviewSelection(bundle, {
      screenId: 'waitlist',
      state: 'initial',
      viewport: 'phone-review'
    });
    const compiled = compilePrototypeReview(bundle, selection);

    assert.match(compiled.html, /^<!doctype html>/);
    assert.match(compiled.html, /data-blueprint-boundary-id="high-fidelity-red\/screen\/waitlist"/);
    assert.doesNotMatch(compiled.html, /<blueprint-use\b/i);
    assert.doesNotMatch(compiled.html, /canvas-toolbar|board-switcher|frame-save/);
    assert.deepEqual(compiled.observedBoundaryIds, [
      'high-fidelity-red/component/email-signup',
      'high-fidelity-red/primitive/action-button'
    ]);
  });

  it('fails closed on malformed review route input', () => {
    assert.deepEqual(
      parsePrototypeReviewRequest(
        new URL('http://127.0.0.1/__blueprint/prototype?screen=waitlist&state=initial&viewport=phone-review')
      ),
      { screenId: 'waitlist', state: 'initial', viewport: 'phone-review' }
    );
    assert.throws(
      () => parsePrototypeReviewRequest(new URL('http://127.0.0.1/__blueprint/prototype?state=initial')),
      /Missing prototype review parameter "screen"/
    );
    assert.throws(
      () => parsePrototypeReviewRequest(new URL('http://127.0.0.1/__blueprint/prototype?screen=waitlist&screen=other')),
      /must appear exactly once/
    );
    assert.throws(
      () => parsePrototypeReviewRequest(new URL('http://127.0.0.1/__blueprint/prototype?screen=waitlist&debug=true')),
      /Unsupported prototype review parameter "debug"/
    );
  });

  it('preflights missing Chromium with actionable install guidance before capture', () => {
    assert.throws(
      () => assertChromiumExecutableAvailable('/missing/chromium', () => false),
      new RegExp(CHROMIUM_INSTALL_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  });

  it('publishes state and viewport capture options plus the source-focused capture path', async () => {
    const help = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /capture[^\n]*--state[^\n]*--viewport/);

    const cliSource = await readFile('src/cli.ts', 'utf8');
    assert.match(cliSource, /\/__blueprint\/prototype/);
    assert.match(cliSource, /page\.setContent\(compiled\.html/);
    assert.match(cliSource, /editorChrome:\s*false/);
  });
});

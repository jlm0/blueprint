import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { loadProjectFromFs } from '../src/core/load';
import type { BlueprintProjectBundle, ExplorationPrototypeSource, ScreenDefinition } from '../src/core/types';

const fixtureRoot = 'fixtures/red/high-fidelity-prototype/design/blueprint';

let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;

describe('Blueprint focused exploration canvas', () => {
  before(async () => {
    server = await createServer({
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 }
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') {
      throw new Error('Vite test server did not expose a port.');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  it('leaves canonical route rows intact and adds one quiet exact-target entry point', async () => {
    const bundle = await bundleWithExploration();
    const page = await openBundle(bundle, '?board=screens');

    try {
      const frames = page.locator('.board-screens .frame');
      assert.equal(await frames.count(), 2, 'The default marketing page should keep the canonical screen review conditions only.');
      assert.equal(await page.locator('[data-exploration-role]').count(), 0, 'Candidates must not leak into canonical route rows.');
      assert.equal(await page.locator('.board-screens .frame-chip').count(), 2);
      assert.equal(await page.locator('.board-screens .frame-shot').count(), 2);
      assert.equal(await page.locator('.board-screens .frame-save').count(), 2);

      const entryPoints = page.locator('.bp-chrome-frame-exploration');
      assert.equal(await entryPoints.count(), 1, 'Only the matching state and preset should link to the active exploration.');
      assert.equal(await entryPoints.first().getAttribute('data-exploration-id'), 'hero-directions');
      assert.equal((await entryPoints.first().textContent())?.trim(), 'Variations');
    } finally {
      await page.close();
    }
  });

  it('isolates Current and candidate frames at one exact state and viewport', async () => {
    const bundle = await bundleWithExploration();
    const page = await openBundle(
      bundle,
      '?board=screens&flow=ops&state=not-declared&viewport=not-declared&exploration=hero-directions'
    );

    try {
      const root = page.locator('[data-board-root="screens"][data-canvas-mode="exploration"]');
      await root.waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await root.getAttribute('data-exploration-id'), 'hero-directions');
      assert.equal(await root.getAttribute('data-screen-id'), 'waitlist');

      const frames = root.locator('.frame');
      assert.equal(await frames.count(), 4);
      assert.deepEqual(
        (await root.locator('.bp-chrome-frame-note .frame-name').allTextContents()).map(label => label.trim()),
        ['Current', 'A', 'B', 'C']
      );
      assert.equal(await root.locator('.frame-chip, .frame-shot, .frame-save').count(), 0);
      assert.equal(await root.locator('.frame[data-boundary-kind="screen"]').count(), 1, 'Only Current may remain a canonical screen boundary.');
      assert.equal(
        await root.locator('.frame[data-exploration-role="baseline"]').getAttribute('data-boundary-id'),
        'high-fidelity-red/screen/waitlist'
      );
      for (const candidate of await root.locator('.frame[data-exploration-role="candidate"]').all()) {
        assert.equal(await candidate.getAttribute('data-boundary-id'), null);
        assert.equal(await candidate.getAttribute('data-boundary-kind'), null);
      }

      const contexts = await frames.evaluateAll(elements => elements.map(element => {
        const frame = element as HTMLElement;
        const screen = frame.querySelector<HTMLElement>('.screen');
        const style = screen ? window.getComputedStyle(screen) : undefined;
        return {
          state: frame.dataset.reviewState,
          preset: frame.dataset.framePresetId,
          width: style ? Number.parseFloat(style.width) : 0,
          height: style ? Number.parseFloat(style.height) : 0
        };
      }));
      assert.ok(contexts.every(context => context.state === 'initial'));
      assert.ok(contexts.every(context => context.preset === 'desktop-reference'));
      assert.ok(contexts.every(context => context.width === 1280 && context.height === 800));

      const directionA = page.frameLocator('.frame[data-exploration-candidate-id="direction-a"] iframe');
      const directionB = page.frameLocator('.frame[data-exploration-candidate-id="direction-b"] iframe');
      assert.match(await directionA.locator('body').innerText(), /Direction A for modern sellers/);
      assert.match(await directionB.locator('body').innerText(), /Direction B for modern sellers/);

      const unavailable = root.locator('.frame[data-exploration-candidate-id="direction-c"]');
      assert.equal(await unavailable.getAttribute('data-exploration-status'), 'unavailable');
      const unavailableText = await unavailable.innerText();
      assert.match(unavailableText, /Variation unavailable/);
      assert.doesNotMatch(unavailableText, /missing-candidate|prototype\/explorations/);

      assert.equal(await page.locator('.bp-chrome-flow-switcher').isVisible(), false);
      assert.equal(await page.locator('.bp-chrome-exploration-nav').isVisible(), true);
      assert.equal(await page.locator('.bp-chrome-board-switcher').isVisible(), true);
      assert.equal(await page.locator('.bp-chrome-fit').isVisible(), true);
      assert.equal(await page.getByRole('button', { name: /create|promote|delete|archive|comment/i }).count(), 0);

      await page.locator('.bp-chrome-fit').click();
      const transform = await page.locator('#world').getAttribute('style');
      const scale = Number(/scale\(([\d.]+)\)/.exec(transform ?? '')?.[1]);
      assert.ok(scale > 0.08 && scale < 0.4, `Fit should include the wide comparison row, received scale ${scale}.`);

      await page.locator('.bp-chrome-exploration-back').click();
      await page.waitForSelector('.board-screens .frame-chip', { timeout: 5000 });
      assert.equal(new URL(page.url()).searchParams.has('exploration'), false);
      assert.equal(new URL(page.url()).searchParams.get('flow'), 'marketing');
      assert.equal(await page.locator('.bp-chrome-flow-switcher').isVisible(), true);
    } finally {
      await page.close();
    }
  });

  it('shows a focused unavailable state for an unknown id without falling back to route rows', async () => {
    const bundle = await bundleWithExploration();
    const page = await openBundle(bundle, '?board=screens&exploration=unknown');

    try {
      const root = page.locator('[data-board-root="screens"][data-canvas-mode="exploration"]');
      await root.waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await root.locator('.frame').count(), 0);
      assert.equal(await root.locator('.bp-chrome-exploration-unavailable').count(), 1);
      assert.match(await root.innerText(), /Exploration unavailable/);
      assert.equal(await page.locator('.bp-chrome-exploration-nav').isVisible(), true);

      await page.locator('.bp-chrome-exploration-back').click();
      await page.waitForSelector('.board-screens .frame-chip', { timeout: 5000 });
      assert.equal(new URL(page.url()).searchParams.has('exploration'), false);
    } finally {
      await page.close();
    }
  });

  it('keeps promoted work discoverable through a screen-local History view', async () => {
    const bundle = await bundleWithHistory();
    const page = await openBundle(bundle, '?board=screens&flow=marketing');

    try {
      assert.equal(await page.getByRole('button', { name: 'Variations', exact: true }).count(), 0);
      const historyButton = page.getByRole('button', { name: 'History', exact: true });
      assert.equal(await historyButton.count(), 1);
      await historyButton.click();

      const root = page.locator('[data-board-root="screens"][data-canvas-mode="history"]');
      await root.waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(new URL(page.url()).searchParams.get('history'), 'waitlist');
      assert.deepEqual(
        (await root.locator('.bp-chrome-history-row-label').allTextContents()).map(label => label.trim()),
        ['Versions', 'Hero directions · Promoted']
      );
      assert.deepEqual(
        (await root.locator('.bp-chrome-frame-note .frame-name').allTextContents()).map(label => label.trim()),
        ['Current', 'V1', 'Starting point', 'A', 'B · Chosen', 'C']
      );
      assert.equal(await root.locator('.frame').count(), 6);
      assert.equal(await root.locator('.frame[data-boundary-kind="screen"]').count(), 1);
      assert.equal(await root.locator('.frame[data-history-version="1"]').count(), 1);
      assert.equal(await root.locator('.frame[data-exploration-candidate-id="direction-b"]').count(), 1);
      assert.equal(await page.locator('.bp-chrome-flow-switcher').isVisible(), false);

      await page.locator('.bp-chrome-exploration-back').click();
      await page.waitForSelector('.board-screens .frame-chip', { timeout: 5000 });
      assert.equal(new URL(page.url()).searchParams.has('history'), false);
      assert.equal(await page.getByRole('button', { name: 'History', exact: true }).count(), 1);
    } finally {
      await page.close();
    }
  });
});

async function openBundle(bundle: BlueprintProjectBundle, query: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(projectBundle => {
    Object.defineProperty(window, '__BLUEPRINT_PROJECT_BUNDLE__', {
      configurable: true,
      value: projectBundle
    });
  }, bundle);
  await page.goto(`${baseUrl}/${query}`);
  await page.waitForSelector('[data-board-root="screens"]:not([hidden])', { timeout: 5000 });
  return page;
}

async function bundleWithExploration(): Promise<BlueprintProjectBundle> {
  const bundle = structuredClone(await loadProjectFromFs(fixtureRoot));
  const screen = bundle.screens.screens.find(candidate => candidate.id === 'waitlist');
  const other = bundle.screens.screens.find(candidate => candidate.id === 'dense-dashboard');
  if (!screen?.prototype || !other) {
    throw new Error('Expected the high-fidelity screen fixture.');
  }
  screen.flow = 'marketing';
  other.flow = 'ops';
  const baselineScreen = structuredClone(screen) as ScreenDefinition;
  const baselinePrototype: ExplorationPrototypeSource = {
    source: screen.prototype.source,
    styles: [...screen.prototype.styles],
    assetRefs: [...screen.prototype.assetRefs]
  };
  const source = bundle.prototypeSourceContents[screen.prototype.source];
  const styles = bundle.prototypeSourceContents[screen.prototype.styles[0] ?? ''];
  if (!source || !styles) {
    throw new Error('Expected canonical fixture source contents.');
  }
  const candidateA = 'prototype/explorations/direction-a.html';
  const candidateB = 'prototype/explorations/direction-b.html';
  const candidateStyles = 'prototype/explorations/directions.css';
  bundle.prototypeSourceContents[candidateA] = source.replace(
    'The control room for modern sellers.',
    'Direction A for modern sellers.'
  );
  bundle.prototypeSourceContents[candidateB] = source.replace(
    'The control room for modern sellers.',
    'Direction B for modern sellers.'
  );
  bundle.prototypeSourceContents[candidateStyles] = styles;
  bundle.explorations = {
    schemaVersion: '1.0.0',
    projectId: bundle.manifest.project.id,
    explorations: [
      {
        id: 'hero-directions',
        title: 'Hero directions',
        intent: 'Compare three focused hero directions.',
        lifecycle: 'active',
        target: {
          screenId: screen.id,
          state: 'initial',
          framePresetId: 'desktop-reference',
          baseDigest: 'a'.repeat(64),
          baseline: {
            screen: baselineScreen,
            prototype: baselinePrototype
          }
        },
        candidates: [
          {
            id: 'direction-a',
            label: 'A',
            prototype: { source: candidateA, styles: [candidateStyles], assetRefs: [...screen.prototype.assetRefs] }
          },
          {
            id: 'direction-b',
            label: 'B',
            prototype: { source: candidateB, styles: [candidateStyles], assetRefs: [...screen.prototype.assetRefs] }
          },
          {
            id: 'direction-c',
            label: 'C',
            prototype: {
              source: 'prototype/explorations/missing-candidate.html',
              styles: [candidateStyles],
              assetRefs: [...screen.prototype.assetRefs]
            }
          }
        ]
      }
    ]
  };
  bundle.sourceFiles.explorationSources = [
    `${fixtureRoot}/${candidateA}`,
    `${fixtureRoot}/${candidateB}`,
    `${fixtureRoot}/${candidateStyles}`
  ];
  return bundle;
}

async function bundleWithHistory(): Promise<BlueprintProjectBundle> {
  const bundle = await bundleWithExploration();
  const exploration = bundle.explorations.explorations[0];
  const screen = bundle.screens.screens.find(candidate => candidate.id === 'waitlist');
  if (!exploration || !screen?.prototype) {
    throw new Error('Expected exploration history fixture inputs.');
  }
  exploration.lifecycle = 'promoted';
  exploration.selectedCandidateId = 'direction-b';
  exploration.promotedScreenId = screen.id;

  const historicalScreen = structuredClone(exploration.target.baseline.screen);
  if (!historicalScreen.prototype) {
    throw new Error('Expected historical screen prototype.');
  }
  const historicalSource = 'prototype/screens/waitlist.history-waitlist-v1.html';
  const historicalStyle = 'prototype/screens/waitlist.history-waitlist-v1.css';
  bundle.prototypeSourceContents[historicalSource] = bundle.prototypeSourceContents[historicalScreen.prototype.source] ?? '';
  bundle.prototypeSourceContents[historicalStyle] = bundle.prototypeSourceContents[historicalScreen.prototype.styles[0] ?? ''] ?? '';
  historicalScreen.prototype.source = historicalSource;
  historicalScreen.prototype.styles = [historicalStyle];
  historicalScreen.styleRefs = [historicalStyle];
  bundle.history.entries = [
    {
      screenId: screen.id,
      version: 1,
      state: 'initial',
      framePresetId: 'desktop-reference',
      screen: historicalScreen,
      replacedBy: {
        type: 'exploration-candidate',
        explorationId: exploration.id,
        candidateId: 'direction-b'
      }
    }
  ];
  return bundle;
}

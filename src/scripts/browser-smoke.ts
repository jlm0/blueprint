import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { loadProjectFromFs } from '../core/load';
import { screenFrameLabel } from '../core/screen-naming';
import { validateVisibleBoundaryRecords, type VisibleBoundaryRecord } from '../core/review';
import type { BlueprintProjectBundle } from '../core/types';

const artifactRoot =
  process.env.BLUEPRINT_ARTIFACT_ROOT ??
  '.blueprint-artifacts/browser-smoke';
const screenshotRoot = path.join(artifactRoot, 'screenshots');
const reviewManifestRoot = path.join(artifactRoot, 'review-manifests');
const styleEvidenceRoot = path.join(artifactRoot, 'style-evidence');
const chromeEvidenceRoot = path.join(artifactRoot, 'chrome-evidence');
const chromeBaselineRoot = process.env.BLUEPRINT_CHROME_BASELINE_ROOT;

async function main(): Promise<void> {
  await mkdir(screenshotRoot, { recursive: true });
  await mkdir(reviewManifestRoot, { recursive: true });
  await mkdir(styleEvidenceRoot, { recursive: true });
  await mkdir(chromeEvidenceRoot, { recursive: true });
  const server = await createServer({
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 0
    }
  });

  let browser: import('playwright').Browser | undefined;

  try {
    await server.listen();
    const address = server.httpServer?.address();
    const port = typeof address === 'object' && address ? address.port : 5173;
    const url = `http://127.0.0.1:${port}`;
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    await page.goto(url);
    await page.waitForSelector('.board-primitives .bp-chrome-doc-page[data-boundary-kind]', { timeout: 10000 });
    await assertDashboardChromeRemoved(page);
    await assertProjectThemedChrome(page);
    await assertProductScopeStructure(page);
    const starterBundle = await loadProjectFromFs('starter/design/blueprint');
    await assertDocumentSections(page, starterBundle);
    await assertVisibleBoundarySynchronization(page, 'primitives');
    await assertNoViewportTextOverlap(page, 'starter-primitives-desktop');
    await assertAppSampleStyleStability(page, 'starter-primitives', async () => {
      await page.locator('[data-board="screens"]').click();
      await page.waitForSelector('.board-screens .frame[data-boundary-kind="screen"]', { timeout: 10000 });
      await page.locator('[data-board="primitives"]').click();
      await page.waitForSelector('.board-primitives .canonical-primitive-specimen', { timeout: 10000 });
    }, 1);
    await page.screenshot({ path: path.join(screenshotRoot, 'blueprint-primitives-desktop.png'), fullPage: true });
    await assertProofFixtureDocumentPages(browser, url);

    await page.locator('[data-board="screens"]').click();
    await page.waitForSelector('.board-screens .frame[data-boundary-kind="screen"]', { timeout: 10000 });
    const beforeWheel = await readWorldTransform(page);
    await dispatchWheel(page, { deltaX: 0, deltaY: 160, ctrlKey: false, metaKey: false });
    await waitForTransformChange(page, 'y', beforeWheel.y);
    const afterPan = await readWorldTransform(page);
    if (Math.abs(afterPan.scale - beforeWheel.scale) > 0.001 || afterPan.y === beforeWheel.y) {
      throw new Error('Ordinary wheel input should pan the canvas without changing scale.');
    }

    await dispatchWheel(page, { deltaX: 0, deltaY: -160, ctrlKey: true, metaKey: false });
    await waitForTransformChange(page, 'scale', afterPan.scale);
    const afterZoom = await readWorldTransform(page);
    if (afterZoom.scale <= afterPan.scale) {
      throw new Error('Control wheel input should zoom the canvas.');
    }

    await page.locator('.bp-chrome-fit').click();
    await assertReferenceScreenBoard(page, starterBundle);
    await assertPhoneFrame(page);
    await assertDesktopFrame(page, starterBundle);
    await assertScreenCompositionRendered(page, starterBundle);
    await assertVisibleBoundarySynchronization(page, 'screens');
    const starterScreensScreenshot = path.join(screenshotRoot, 'blueprint-screens-desktop.png');
    await page.screenshot({ path: starterScreensScreenshot, fullPage: true });
    await writeScreenReviewArtifacts(page, starterBundle.manifest.project.id, 'screens', starterScreensScreenshot);
    await assertBoundaryAffordances(page);
    await assertFrameTools(page);
    await assertNoViewportTextOverlap(page, 'starter-screens-desktop');
    await assertAppSampleStyleStability(page, 'starter-screens', async () => {
      await page.locator('.board-screens .frame-shot').first().focus();
      await page.locator('.board-screens .frame-save').first().focus();
    }, 1);

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(`${url}?board=screens`);
    await mobile.waitForSelector('.board-screens .frame[data-boundary-kind="screen"]', { timeout: 10000 });
    await assertSubnav(mobile, true);
    await assertScreenCompositionRendered(mobile, starterBundle);
    await assertNoViewportTextOverlap(mobile, 'starter-screens-mobile');
    await mobile.screenshot({ path: path.join(screenshotRoot, 'blueprint-screens-mobile.png'), fullPage: true });

    const appOwned = await loadProjectFromFs('fixtures/valid/mira-ai/design/blueprint');
    const configured = await browser.newPage({ viewport: { width: 1024, height: 780 } });
    await configured.addInitScript(bundle => {
      Object.defineProperty(window, '__BLUEPRINT_PROJECT_BUNDLE__', {
        configurable: true,
        value: bundle
      });
    }, appOwned);
    await configured.goto(`${url}?board=screens`);
    await configured.waitForSelector('.board-screens .frame[data-boundary-id="mira-ai/screen/workspace"]', { timeout: 10000 });
    await assertScreenCompositionRendered(configured, appOwned);
    await assertNoProjectManagerChrome(configured);
    const configuredScreensScreenshot = path.join(screenshotRoot, 'mira-ai-screens.png');
    await configured.screenshot({ path: configuredScreensScreenshot, fullPage: true });
    await writeScreenReviewArtifacts(configured, appOwned.manifest.project.id, 'mira-ai-screens', configuredScreensScreenshot);
    await assertAppSampleStyleStability(configured, 'mira-ai-screens', async () => {
      await configured.locator('.board-screens .frame-chip').first().focus();
      await configured.locator('.board-screens .frame-shot').first().focus();
    });
    await assertCanonicalFrameExports(browser, url);
    await assertLargeMinimumFont(url);

    await assertSubnav(page, false);
    await assertSectionRailChrome(page);
    await assertScreenChromeFocus(page);
    await assertSectionRailChrome(mobile);
    await assertScreenChromeFocus(mobile);
    await assertSectionRailChrome(configured);
    await assertScreenChromeFocus(configured);

    console.log(`Browser smoke passed at ${url}. Screenshots written to ${screenshotRoot}.`);
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

async function assertDashboardChromeRemoved(page: import('playwright').Page): Promise<void> {
  for (const selector of ['.topbar', '.sidebar', '.inspector', '.search', '.project-select', '.isolation-panel']) {
    const count = await page.locator(selector).count();
    if (count !== 0) {
      throw new Error(`Dashboard chrome should not render: ${selector}`);
    }
  }

  const buttons = await page.locator('.board-switcher [data-section]').evaluateAll(elements => elements.map(element => element.textContent?.trim()));
  if (buttons.join(',') !== 'Foundations,Primitives,Components,Screens') {
    throw new Error(`Expected the Foundations, Primitives, Components and Screens sections, received: ${buttons.join(',')}`);
  }

  const activeButtonStyles = await page.locator('.board-switcher [aria-pressed="true"]').evaluate(element => {
    const computed = window.getComputedStyle(element);
    return {
      backgroundColor: computed.backgroundColor,
      backgroundImage: computed.backgroundImage
    };
  });
  if (activeButtonStyles.backgroundColor === 'rgb(200, 255, 58)' || activeButtonStyles.backgroundImage !== 'none') {
    throw new Error('Section rail should use a token color and no gradient treatment.');
  }
}

async function assertProjectThemedChrome(page: import('playwright').Page): Promise<void> {
  const styles = await page.evaluate(() => {
    const document_ = window.getComputedStyle(document.querySelector('#document')!);
    const viewport = window.getComputedStyle(document.querySelector('#viewport')!);
    return {
      surround: document.documentElement.dataset.surround,
      theme: document.documentElement.dataset.chromeTheme,
      pageBackground: document_.backgroundColor,
      pageText: document_.color,
      canvasBackground: viewport.backgroundColor,
      gridLines: viewport.backgroundImage.match(/linear-gradient/g)?.length ?? 0,
      shadows: [...document.querySelectorAll<HTMLElement>('[class*="bp-chrome-"]')]
        .filter(element => window.getComputedStyle(element).boxShadow !== 'none' && !element.matches(':focus-visible'))
        .map(element => element.className)
    };
  });

  const expected = { surround: 'light', theme: 'app', pageBackground: 'rgb(250, 250, 250)', pageText: 'rgb(24, 24, 27)', canvasBackground: 'rgb(250, 250, 250)', gridLines: 4 };
  for (const [key, value] of Object.entries(expected)) {
    if (styles[key as keyof typeof expected] !== value) {
      throw new Error(`Chrome should follow the starter tokens on a light grid surround, received ${JSON.stringify(styles)}.`);
    }
  }
  if (styles.shadows.length > 0) {
    throw new Error(`Blueprint chrome should stay flat without elevation, received shadows on: ${styles.shadows.join(', ')}`);
  }
}

async function assertSubnav(page: import('playwright').Page, narrow: boolean): Promise<void> {
  const shell = page.locator('#app-shell');
  const toggle = page.locator('.bp-chrome-subnav-toggle');
  const expectedInitial = narrow ? 'collapsed' : 'open';
  if (await shell.getAttribute('data-subnav') !== expectedInitial) {
    throw new Error(`The sidebar should start ${expectedInitial} at this width.`);
  }
  if (!(await toggle.getAttribute('aria-label'))) {
    throw new Error('The sidebar toggle should expose an accessible label.');
  }

  const railWidth = () => page.locator('.bp-chrome-rail').evaluate(element => element.getBoundingClientRect().width);
  const initialRailWidth = await railWidth();
  await toggle.click();
  const toggled = narrow ? 'open' : 'collapsed';
  const toggledRailWidth = await railWidth();
  if (narrow ? toggledRailWidth <= initialRailWidth : toggledRailWidth >= initialRailWidth) {
    throw new Error(`Collapsing the sidebar should shrink the rail to icons, received ${initialRailWidth}px then ${toggledRailWidth}px.`);
  }
  if (await shell.getAttribute('data-subnav') !== toggled || await toggle.getAttribute('aria-expanded') !== String(toggled === 'open')) {
    throw new Error(`The sidebar toggle should switch the sidebar ${toggled}.`);
  }
  if (narrow) {
    const stageLeft = await page.locator('.bp-chrome-stage').evaluate(element => element.getBoundingClientRect().left);
    const railWidth = await page.locator('.bp-chrome-rail').evaluate(element => element.getBoundingClientRect().width);
    if (Math.abs(stageLeft - railWidth) > 1) {
      throw new Error('On narrow screens the open sidebar should overlay the stage instead of squeezing it.');
    }
    await page.locator('.bp-chrome-item-nav .bp-chrome-item').first().click();
    if (await shell.getAttribute('data-subnav') !== 'collapsed') {
      throw new Error('Picking an item on a narrow screen should close the overlaid sidebar.');
    }
    return;
  }
  await toggle.click();
  if (await shell.getAttribute('data-subnav') !== 'open') {
    throw new Error('The sidebar toggle should reopen the sidebar.');
  }
}

async function assertProductScopeStructure(page: import('playwright').Page): Promise<void> {
  const forbiddenSelectors = [
    '.dashboard',
    '.inspector',
    '.project-manager',
    '.marketing',
    '.hero',
    '[data-ui-surface="dashboard"]',
    '[data-ui-surface="inspector"]',
    '[data-ui-surface="project-manager"]'
  ];
  for (const selector of forbiddenSelectors) {
    const count = await page.locator(selector).count();
    if (count !== 0) {
      throw new Error(`Blueprint should stay a canvas/review surface and not render ${selector}.`);
    }
  }

  const visibleText = (
    await page.locator('.board-switcher, .frame-head').evaluateAll(elements =>
      elements
        .filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && window.getComputedStyle(element).visibility !== 'hidden';
        })
        .map(element => element.textContent ?? '')
        .join(' ')
    )
  ).toLowerCase();
  const forbiddenTerms = ['dashboard', 'inspector', 'marketing', 'project manager', 'figma clone'];
  const leakedTerms = forbiddenTerms.filter(term => visibleText.includes(term));
  if (leakedTerms.length > 0) {
    throw new Error(`Visible Blueprint UI overclaims the product scope: ${leakedTerms.join(', ')}`);
  }
}

async function assertSectionRailChrome(page: import('playwright').Page): Promise<void> {
  const switcher = page.locator('.board-switcher');
  await switcher.waitFor({ timeout: 5000 });
  const chrome = await switcher.evaluate(element => {
    const node = element as HTMLElement;
    const rect = node.getBoundingClientRect();
    const computed = window.getComputedStyle(node);
    const buttons = [...node.querySelectorAll<HTMLButtonElement>('[data-section]')].map(button => {
      const buttonRect = button.getBoundingClientRect();
      return {
        text: button.textContent?.trim() ?? '',
        ariaPressed: button.getAttribute('aria-pressed'),
        type: button.type,
        width: buttonRect.width,
        height: buttonRect.height,
        right: buttonRect.right,
        overflowX: button.scrollWidth - button.clientWidth,
        overflowY: button.scrollHeight - button.clientHeight
      };
    });
    return {
      className: node.className,
      ariaLabel: node.getAttribute('aria-label'),
      railRight: node.closest('.bp-chrome-rail')?.getBoundingClientRect().right ?? 0,
      left: rect.left,
      right: rect.right,
      backgroundImage: computed.backgroundImage,
      buttons
    };
  });

  if (chrome.ariaLabel !== 'Blueprint sections') {
    throw new Error(`Section rail should keep an accessible label, received ${chrome.ariaLabel}.`);
  }
  if (chrome.left < 0 || chrome.right > page.viewportSize()!.width) {
    throw new Error(`Section rail should stay inside the viewport, received ${JSON.stringify(chrome)}`);
  }
  if (chrome.backgroundImage !== 'none') {
    throw new Error('Section rail should stay quiet and avoid gradient treatment.');
  }
  const activeCount = chrome.buttons.filter(button => button.ariaPressed === 'true').length;
  if (chrome.buttons.length !== 4 || activeCount !== 1) {
    throw new Error(`Section rail should expose four section buttons and one active section, received ${JSON.stringify(chrome.buttons)}`);
  }
  const unstable = chrome.buttons.filter(button => button.overflowX > 1 || button.overflowY > 1 || button.width < 44 || button.height < 44 || button.right > chrome.railRight + 1);
  if (unstable.length > 0) {
    throw new Error(`Section buttons should be stable, non-overflowing touch targets inside the rail: ${JSON.stringify(unstable)}`);
  }

  const focusStyle = await page.locator('.board-switcher [data-section="components"]').evaluate(element => {
    // Keyboard users get :focus-visible; request that state explicitly here.
    (element as HTMLElement).focus({ focusVisible: true } as FocusOptions);
    const computed = window.getComputedStyle(element);
    return {
      outlineStyle: computed.outlineStyle,
      outlineWidth: computed.outlineWidth,
      boxShadow: computed.boxShadow
    };
  });
  if (focusStyle.outlineStyle === 'none' && focusStyle.boxShadow === 'none') {
    throw new Error(`Section rail should expose a visible focus state, received ${JSON.stringify(focusStyle)}.`);
  }

  await page.keyboard.press('Tab');
  const tabTarget = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.section ?? '');
  if (tabTarget !== 'screens') {
    throw new Error(`Keyboard Tab should move between section buttons, received active section target ${tabTarget || 'none'}.`);
  }
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-board-root="screens"]:not([hidden])', { timeout: 5000 });
  const keyboardActivated = await page.locator('.board-switcher [data-section="screens"]').getAttribute('aria-pressed');
  if (keyboardActivated !== 'true') {
    throw new Error('Keyboard Enter should activate the focused Screens section button.');
  }

  if (!chrome.className.split(/\s+/).includes('bp-chrome-board-switcher')) {
    throw new Error(`Section rail should expose a namespaced chrome class, received ${chrome.className}.`);
  }
}

async function assertLargeMinimumFont(url: string): Promise<void> {
  // Browsers let people raise the minimum font size (Brave and Chrome settings); chrome must reflow, not clip.
  const profile = await mkdtemp(path.join(tmpdir(), 'blueprint-min-font-'));
  await mkdir(path.join(profile, 'Default'), { recursive: true });
  await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ webkit: { webprefs: { minimum_font_size: 16, minimum_logical_font_size: 16 } } }));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', viewport: { width: 1280, height: 860 } });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${url}?board=primitives&section=primitives&item=button`);
    await page.waitForSelector('.board-primitives .canonical-primitive-specimen', { timeout: 10000 });
    const report = await page.evaluate(() => {
      const label = document.querySelector<HTMLElement>('.bp-chrome-section-label');
      const rail = document.querySelector<HTMLElement>('.bp-chrome-rail')!.getBoundingClientRect();
      const clipped = [...document.querySelectorAll<HTMLElement>('.bp-chrome-section-button, .bp-chrome-section-label')]
        .filter(element => {
          const rect = element.getBoundingClientRect();
          return element.scrollWidth > element.clientWidth + 1 || rect.left < rail.left - 1 || rect.right > rail.right + 1;
        })
        .map(element => element.textContent?.trim() ?? element.className);
      const wrapped = [...document.querySelectorAll<HTMLElement>('.bp-chrome-specimen-title, .bp-chrome-specimen-caption')]
        .filter(element => element.getBoundingClientRect().height > parseFloat(getComputedStyle(element).fontSize) * 1.8)
        .map(element => element.textContent?.trim() ?? '');
      const document_ = document.querySelector<HTMLElement>('#document')!;
      return { labelSize: label ? getComputedStyle(label).fontSize : '', clipped, wrapped, sideways: document_.scrollWidth - document_.clientWidth };
    });
    if (report.labelSize !== '16px') {
      throw new Error(`Minimum font size preference should apply to the rail labels, received ${report.labelSize}.`);
    }
    if (report.clipped.length > 0 || report.wrapped.length > 0 || report.sideways > 1) {
      throw new Error(`Chrome should reflow under a 16px minimum font size: ${JSON.stringify(report)}`);
    }
    await page.screenshot({ path: path.join(screenshotRoot, 'blueprint-minimum-font.png') });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

async function assertProofFixtureDocumentPages(browser: import('playwright').Browser, url: string): Promise<void> {
  const proofRoots = [
    'starter/design/blueprint',
    'fixtures/valid/mira-ai/design/blueprint',
    'fixtures/valid/umbra-gaming/design/blueprint',
    'fixtures/valid/meridian-finance/design/blueprint'
  ];

  for (const projectRoot of proofRoots) {
    const bundle = await loadProjectFromFs(projectRoot);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(projectBundle => {
      Object.defineProperty(window, '__BLUEPRINT_PROJECT_BUNDLE__', {
        configurable: true,
        value: projectBundle
      });
    }, bundle);
    await page.goto(`${url}?board=primitives`);
    await page.waitForSelector('.board-primitives .bp-chrome-doc-page[data-boundary-kind]', { timeout: 10000 });
    await assertDocumentSections(page, bundle);
    const screenshotPath = path.join(screenshotRoot, `${bundle.manifest.project.id}-primitives.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await writePrimitiveReviewArtifacts(page, bundle.manifest.project.id, screenshotPath);
    await page.close();
  }
}

async function assertDocumentSections(page: import('playwright').Page, bundle: BlueprintProjectBundle): Promise<void> {
  const projectId = bundle.manifest.project.id;
  const records: VisibleBoundaryRecord[] = [];
  const families = new Set<string>();
  const sections = [
    { section: 'foundations', ids: bundle.tokens.tokenGroups.map(group => group.id) },
    { section: 'components', ids: bundle.components.components.map(component => component.id) },
    { section: 'primitives', ids: bundle.primitives.primitives.map(primitive => primitive.id) }
  ];

  for (const { section, ids } of sections) {
    await page.locator(`.board-switcher [data-section="${section}"]`).click();
    await page.waitForSelector(`.board-primitives[data-section="${section}"] .bp-chrome-doc-page`, { timeout: 10000 });
    const listed = await page.locator('.bp-chrome-item-nav [data-item]').evaluateAll(buttons => buttons.map(button => (button as HTMLElement).dataset.item ?? ''));
    if ([...listed].sort().join(',') !== [...ids].sort().join(',')) {
      throw new Error(`${projectId} ${section} sub-navigation should list ${ids.join(', ')}, received ${listed.join(', ')}`);
    }

    for (const id of ids) {
      await page.locator(`.bp-chrome-item-nav [data-item="${id}"]`).click();
      const item = page.locator(`.board-primitives .bp-chrome-doc-page[data-boundary-local-id="${id}"]`);
      await item.waitFor({ state: 'visible', timeout: 10000 });
      records.push(...await collectPrimitiveBoundaryRecords(page));
      const evidence = await item.evaluate(element => ({
        family: (element as HTMLElement).dataset.primitiveFamily ?? '',
        iframes: element.querySelectorAll('.canonical-primitive-iframe').length,
        compileErrors: element.querySelectorAll('.prototype-compile-error').length,
        probes: element.querySelectorAll('.token-probe').length,
        overflow: document.querySelector('#document')!.scrollWidth - document.querySelector('#document')!.clientWidth
      }));
      if (evidence.compileErrors > 0 || evidence.probes > 0 || evidence.overflow > 1) {
        throw new Error(`${projectId} ${section}/${id} page should compile, hide token probes and fit its column: ${JSON.stringify(evidence)}`);
      }
      if (section === 'primitives') {
        const primitive = bundle.primitives.primitives.find(candidate => candidate.id === id)!;
        if (!primitive.prototype) {
          throw new Error(`${projectId} primitive ${id} should declare a canonical prototype.`);
        }
        const expectedFrames = primitive.prototype.states.length * (Math.max(primitive.prototype.variants.length, 1) + (primitive.prototype.sizes?.length ?? 0));
        if (evidence.iframes !== expectedFrames) {
          throw new Error(`${projectId} primitive ${id} should render one specimen per declared variant or size × state combination, received ${evidence.iframes}.`);
        }
        families.add(evidence.family);
      }
    }
  }

  const sync = validateVisibleBoundaryRecords(bundle, records);
  if (!sync.ok) {
    throw new Error(`Document page boundaries do not match ${projectId} structured data:\n${sync.errors.join('\n')}`);
  }
  if (families.has('') || families.has('generic') || families.size < Math.min(2, bundle.primitives.primitives.length)) {
    throw new Error(`${projectId} primitives should classify into named families, received: ${[...families].join(', ')}`);
  }
}

async function collectPrimitiveBoundaryRecords(page: import('playwright').Page): Promise<VisibleBoundaryRecord[]> {
  return page.locator('.board-primitives [data-boundary-id][data-boundary-kind]').evaluateAll(elements =>
    elements.map(element => {
      const node = element as HTMLElement;
      return {
        id: node.dataset.boundaryId ?? '',
        kind: node.dataset.boundaryKind ?? 'project',
        board: 'primitives',
        label: node.dataset.boundaryLabel ?? node.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '',
        renderedSnippet: node.outerHTML.slice(0, 900)
      };
    })
  ) as Promise<VisibleBoundaryRecord[]>;
}

async function collectScreenBoundaryRecords(page: import('playwright').Page): Promise<VisibleBoundaryRecord[]> {
  return page.locator('.board-screens [data-boundary-id][data-boundary-kind]').evaluateAll(elements =>
    elements.map(element => {
      const node = element as HTMLElement;
      return {
        id: node.dataset.boundaryId ?? '',
        kind: node.dataset.boundaryKind ?? 'project',
        board: 'screens',
        label: node.dataset.boundaryLabel ?? node.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '',
        screenId: node.dataset.screenId,
        renderedSnippet: node.outerHTML.slice(0, 900)
      };
    })
  ) as Promise<VisibleBoundaryRecord[]>;
}

async function writePrimitiveReviewArtifacts(
  page: import('playwright').Page,
  projectId: string,
  screenshotPath: string
): Promise<void> {
  const manifest = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.manifest);
  const styleEvidence = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.styleEvidence);

  if (!manifest || !styleEvidence) {
    throw new Error(`Primitive board should expose review artifacts for ${projectId}.`);
  }

  const { writeFile } = await import('node:fs/promises');
  const capturedManifest = {
    ...manifest,
    capture: {
      status: 'captured',
      path: screenshotPath
    },
    screenshot: {
      status: 'captured',
      path: screenshotPath
    },
    boundaries: manifest.boundaries.map(boundary => ({
      ...boundary,
      capture: {
        status: 'captured',
        path: screenshotPath
      },
      screenshot: {
        status: 'captured',
        path: screenshotPath
      }
    }))
  };
  const capturedStyleEvidence = {
    ...styleEvidence,
    boundaries: styleEvidence.boundaries.map(boundary => ({
      ...boundary,
      screenshotPath
    }))
  };

  await writeFile(path.join(reviewManifestRoot, `${projectId}-primitives-review-manifest.json`), `${JSON.stringify(capturedManifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(styleEvidenceRoot, `${projectId}-primitives-style-evidence.json`), `${JSON.stringify(capturedStyleEvidence, null, 2)}\n`, 'utf8');
}

async function assertReferenceScreenBoard(page: import('playwright').Page, bundle: BlueprintProjectBundle): Promise<void> {
  const frames = await page.locator('.board-screens .frame').count();
  if (frames !== bundle.screens.screens.length) {
    throw new Error(`${bundle.manifest.project.id} Screens board should render every structured screen, received ${frames}.`);
  }

  const labels = await page.locator('.board-screens .frame-chip .frame-name').evaluateAll(elements =>
    elements.map(element => element.textContent?.trim()).filter(Boolean)
  );
  const expected = bundle.screens.screens.map(screenFrameLabel);

  if (labels.join(',') !== expected.join(',')) {
    throw new Error(`Screen frame labels drifted from the reference canvas shape, received: ${labels.join(',')}`);
  }
}

async function assertScreenCompositionRendered(page: import('playwright').Page, bundle: BlueprintProjectBundle): Promise<void> {
  const records = await collectScreenBoundaryRecords(page);
  const sync = validateVisibleBoundaryRecords(bundle, records);
  if (!sync.ok) {
    throw new Error(`Screens board visible boundaries do not match ${bundle.manifest.project.id} structured data:\n${sync.errors.join('\n')}`);
  }

  const expectedScreenIds = bundle.screens.screens
    .flatMap(screen => screen.prototype.reviewConditions.map(() => `${bundle.manifest.project.id}/screen/${screen.id}`))
    .sort();
  const visibleScreenIds = records.filter(record => record.kind === 'screen').map(record => record.id).sort();
  if (visibleScreenIds.join(',') !== expectedScreenIds.join(',')) {
    throw new Error(`${bundle.manifest.project.id} Screens board missing screen frames: expected ${expectedScreenIds.join(',')}, received ${visibleScreenIds.join(',')}`);
  }

  for (const screen of bundle.screens.screens) {
    const screenBoundaryId = `${bundle.manifest.project.id}/screen/${screen.id}`;
    const prototype = page.frameLocator(`.board-screens .frame[data-boundary-id="${screenBoundaryId}"] .canonical-prototype-iframe >> nth=0`);
    const expectedSectionIds = screen.sections.map(section => `${bundle.manifest.project.id}/section/${screen.id}/${section.id}`).sort();
    const sectionMarkers = await prototype.locator('[data-blueprint-section-boundary-id]').evaluateAll(elements =>
      elements.map(element => ({
        id: (element as HTMLElement).dataset.blueprintSectionBoundaryId ?? '',
        text: element.textContent?.trim() ?? ''
      }))
    );
    const markedSectionIds = sectionMarkers.map(marker => marker.id).sort();
    if (markedSectionIds.join(',') !== expectedSectionIds.join(',')) {
      throw new Error(`${screenBoundaryId} prototype should mark every declared section: expected ${expectedSectionIds.join(',')}, received ${markedSectionIds.join(',')}`);
    }
    const emptySections = sectionMarkers.filter(marker => marker.text.length === 0).map(marker => marker.id);
    if (emptySections.length > 0) {
      throw new Error(`${screenBoundaryId} sections should render visible content: ${emptySections.join(', ')}`);
    }
  }
}

async function assertVisibleBoundarySynchronization(page: import('playwright').Page, expectedBoard: string): Promise<void> {
  const report = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.boundarySync);
  if (!report) {
    throw new Error('Canvas should expose visible boundary synchronization state.');
  }
  if (report.ok !== true) {
    throw new Error(`Visible boundary synchronization failed:\n${report.errors?.join('\n') ?? 'unknown error'}`);
  }

  const visibleBoundaries = await page.locator('[data-boundary-id][data-boundary-kind]:visible').count();
  if (visibleBoundaries !== report.records.length) {
    throw new Error(`Expected sync records for every visible boundary, saw ${visibleBoundaries} DOM nodes and ${report.records.length} records.`);
  }
  if (!report.records.every(record => record.board === expectedBoard)) {
    throw new Error(`Expected visible boundary sync records for ${expectedBoard}, received: ${report.records.map(record => record.board).join(',')}`);
  }
}

async function assertBoundaryAffordances(page: import('playwright').Page): Promise<void> {
  const frame = page.locator('.board-screens .frame').first();
  const chip = frame.locator('xpath=..').locator('[data-boundary-action="copy-id"]').first();
  await chip.waitFor({ timeout: 5000 });

  const encodedTool = await frame.getAttribute('data-handoff-tool');
  const tool = encodedTool ? JSON.parse(encodedTool) as { name?: string; arguments?: { boundary?: string } } : undefined;
  if (tool?.name !== 'extract' || !tool.arguments?.boundary?.startsWith('screen:')) {
    throw new Error(`Screen frame should expose an honest MCP extraction tool call, received ${encodedTool}.`);
  }

  await chip.click();
  await page.locator('.board-screens .frame-chip.copied').waitFor({ timeout: 5000 });
}

async function writeScreenReviewArtifacts(page: import('playwright').Page, projectId: string, slug: string, screenshotPath: string): Promise<void> {
  const manifest = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.manifest);
  const styleEvidence = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.styleEvidence);

  if (!manifest || !styleEvidence) {
    throw new Error('Canvas should expose review manifest and style evidence artifacts.');
  }
  if (manifest.projectId !== projectId || manifest.boundaries.length < 1) {
    throw new Error(`Review manifest should include project and visible boundary metadata, received ${JSON.stringify(manifest)}`);
  }
  if (styleEvidence.projectId !== projectId || styleEvidence.boundaries.length < 1) {
    throw new Error(`Style evidence should include boundary-scoped canvas evidence, received ${JSON.stringify(styleEvidence)}`);
  }

  const { writeFile } = await import('node:fs/promises');
  const capturedManifest = {
    ...manifest,
    capture: {
      status: 'captured',
      path: screenshotPath
    },
    screenshot: {
      status: 'captured',
      path: screenshotPath
    },
    boundaries: manifest.boundaries.map(boundary => ({
      ...boundary,
      capture: {
        status: 'captured',
        path: screenshotPath
      },
      screenshot: {
        status: 'captured',
        path: screenshotPath
      }
    }))
  };
  const capturedStyleEvidence = {
    ...styleEvidence,
    boundaries: styleEvidence.boundaries.map(boundary => ({
      ...boundary,
      screenshotPath
    }))
  };

  await writeFile(path.join(reviewManifestRoot, `${slug}-review-manifest.json`), `${JSON.stringify(capturedManifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(styleEvidenceRoot, `${slug}-style-evidence.json`), `${JSON.stringify(capturedStyleEvidence, null, 2)}\n`, 'utf8');
}

async function assertNoProjectManagerChrome(page: import('playwright').Page): Promise<void> {
  await assertDashboardChromeRemoved(page);
  const projectId = await page.locator('.board-screens .frame').first().getAttribute('data-boundary-id');
  if (projectId !== 'mira-ai/screen/workspace') {
    throw new Error(`Configured single-project bundle should render mira-ai without source edits, received ${projectId}.`);
  }
}

async function assertPhoneFrame(page: import('playwright').Page): Promise<void> {
  const frame = page.locator('.frame[data-frame-type="mobile"]').first();
  const size = await frame.locator('.screen').evaluate(element => {
    const computed = window.getComputedStyle(element);
    return {
      width: parseFloat(computed.width),
      height: parseFloat(computed.height)
    };
  });

  if (Math.abs(size.width - 393) > 0.5 || Math.abs(size.height - 852) > 0.5) {
    throw new Error(`Expected reference phone screen to be 393x852, received ${size.width}x${size.height}.`);
  }

  await frame.locator('.status-bar').waitFor({ timeout: 5000 });
  await frame.locator('.home-indicator').waitFor({ timeout: 5000 });
  const browserBars = await frame.locator('.browser-bar').count();
  if (browserBars !== 0) {
    throw new Error(`Mobile frame should not render browser chrome; received ${browserBars} browser bars.`);
  }
}

async function assertDesktopFrame(page: import('playwright').Page, bundle: BlueprintProjectBundle): Promise<void> {
  const frame = page.locator('.frame[data-frame-type="desktop"]').first();
  await frame.waitFor({ timeout: 5000 });
  const presetId = await frame.getAttribute('data-frame-preset-id');
  const preset = bundle.manifest.framePresets.find(candidate => candidate.id === presetId);
  if (!preset || preset.type !== 'desktop') {
    throw new Error(`Expected rendered desktop frame to reference a declared desktop preset, received ${presetId ?? 'none'}.`);
  }
  const size = await frame.locator('.screen').evaluate(element => {
    const computed = window.getComputedStyle(element);
    return {
      width: parseFloat(computed.width),
      height: parseFloat(computed.height)
    };
  });

  if (Math.abs(size.width - preset.width) > 0.5 || Math.abs(size.height - preset.height) > 0.5) {
    throw new Error(`Expected reference desktop screen to match ${preset.id} at ${preset.width}x${preset.height}, received ${size.width}x${size.height}.`);
  }

  await frame.locator('.browser-bar').waitFor({ timeout: 5000 });
  const phoneChrome = await frame.locator('.status-bar, .home-indicator').count();
  if (phoneChrome !== 0) {
    throw new Error(`Desktop frame should not render phone chrome; received ${phoneChrome} phone chrome nodes.`);
  }
}

async function assertFrameTools(page: import('playwright').Page): Promise<void> {
  const chip = page.locator('.board-screens .frame-chip').first();
  const shot = page.locator('.board-screens .frame-shot').first();
  const save = page.locator('.board-screens .frame-save').first();
  await shot.waitFor({ timeout: 5000 });
  await save.waitFor({ timeout: 5000 });

  const titles = await Promise.all([shot.getAttribute('title'), save.getAttribute('title')]);
  if (titles.join(',') !== 'Copy screen as PNG,Save screen as PNG') {
    throw new Error(`Expected reference frame capture tools, received titles: ${titles.join(',')}`);
  }

  await chip.click();
  await page.locator('.board-screens .frame-chip.copied').waitFor({ timeout: 5000 });
  const copiedLabel = await page.locator('.board-screens .frame-chip .frame-name').first().textContent();
  if (copiedLabel?.trim() !== 'home copied') {
    throw new Error(`Expected frame chip to flash copied screen id, received: ${copiedLabel}`);
  }

  await page.waitForTimeout(950);
  const saveDownload = page.waitForEvent('download', { timeout: 10000 });
  await save.click();
  const download = await saveDownload;
  if (download.suggestedFilename() !== 'home.png') {
    throw new Error(`Expected save control to download home.png, received ${download.suggestedFilename()}.`);
  }
  await page.locator('.board-screens .frame-save.done').waitFor({ timeout: 5000 });

  await shot.click();
  await page.locator('.board-screens .frame-shot.done').waitFor({ timeout: 10000 });
}

async function assertCanonicalFrameExports(browser: import('playwright').Browser, url: string): Promise<void> {
  const bundle = await loadProjectFromFs('fixtures/valid/mira-ai/design/blueprint');
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
  await page.addInitScript(projectBundle => {
    Object.defineProperty(window, '__BLUEPRINT_PROJECT_BUNDLE__', {
      configurable: true,
      value: projectBundle
    });
  }, bundle);

  try {
    await page.goto(`${url}?board=screens`);
    const frame = page.locator('.board-screens .frame.frame-canonical').first();
    const screen = frame.locator('.canonical-prototype-screen');
    await screen.waitFor({ state: 'visible', timeout: 10000 });
    await frame.locator('.canonical-prototype-iframe').contentFrame().locator('body').waitFor({ state: 'visible', timeout: 10000 });
    const expected = await screen.evaluate(element => ({
      width: (element as HTMLElement).clientWidth * 2,
      height: (element as HTMLElement).clientHeight * 2
    }));

    const save = frame.locator('xpath=..').locator('.frame-save');
    const savedPath = path.join(screenshotRoot, 'canonical-frame-save.png');
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await save.click();
    const download = await downloadPromise;
    await download.saveAs(savedPath);
    const savedPng = await readFile(savedPath);
    const saved = await inspectPng(page, `data:image/png;base64,${savedPng.toString('base64')}`);
    assertCapturedFrameContent(saved, expected, 'Saved canonical frame');

    const copy = frame.locator('xpath=..').locator('.frame-shot');
    await page.bringToFront();
    await copy.click();
    await page.locator('.board-screens .frame-shot.done').first().waitFor({ timeout: 15000 });
    const copiedPng = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const pngItem = items.find(item => item.types.includes('image/png'));
      if (!pngItem) {
        throw new Error('Clipboard did not contain an image/png item.');
      }
      const bytes = new Uint8Array(await (await pngItem.getType('image/png')).arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      }
      return `data:image/png;base64,${btoa(binary)}`;
    });
    const copied = await inspectPng(page, copiedPng);
    assertCapturedFrameContent(copied, expected, 'Copied canonical frame');
  } finally {
    await page.close();
  }
}

interface CapturedPngSummary {
  width: number;
  height: number;
  nonWhiteRatio: number;
  distinctColors: number;
}

async function inspectPng(page: import('playwright').Page, dataUrl: string): Promise<CapturedPngSummary> {
  return page.evaluate(async source => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Could not create a canvas context for PNG inspection.');
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhite = 0;
    const colors = new Set<string>();
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      const alpha = pixels[index + 3] ?? 0;
      if (alpha > 8 && (red < 248 || green < 248 || blue < 248)) {
        nonWhite += 1;
      }
      colors.add(`${Math.round(red / 32)}:${Math.round(green / 32)}:${Math.round(blue / 32)}:${Math.round(alpha / 32)}`);
    }
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      nonWhiteRatio: nonWhite / (canvas.width * canvas.height),
      distinctColors: colors.size
    };
  }, dataUrl);
}

function assertCapturedFrameContent(
  capture: CapturedPngSummary,
  expected: { width: number; height: number },
  label: string
): void {
  if (capture.width !== expected.width || capture.height !== expected.height) {
    throw new Error(`${label} should be ${expected.width}x${expected.height}, received ${capture.width}x${capture.height}.`);
  }
  if (capture.nonWhiteRatio < 0.1 || capture.distinctColors < 8) {
    throw new Error(`${label} should contain the rendered design instead of a white image, received ${JSON.stringify(capture)}.`);
  }
}

async function assertScreenChromeFocus(page: import('playwright').Page): Promise<void> {
  const controls = [
    { selector: '.board-screens .frame-chip', label: 'frame chip' },
    { selector: '.board-screens .frame-shot', label: 'frame capture' },
    { selector: '.board-screens .frame-save', label: 'frame save' }
  ];

  for (const control of controls) {
    const focusStyle = await page.locator(control.selector).first().evaluate(element => {
      const node = element as HTMLElement;
      // Chrome controls ring focus for keyboard users (:focus-visible);
      // request the same state explicitly for the programmatic check.
      node.focus({ focusVisible: true } as FocusOptions);
      const computed = window.getComputedStyle(node);
      return {
        className: node.className,
        ariaLabel: node.getAttribute('aria-label') ?? node.getAttribute('title') ?? '',
        outlineStyle: computed.outlineStyle,
        outlineWidth: computed.outlineWidth,
        boxShadow: computed.boxShadow,
        width: node.offsetWidth,
        height: node.offsetHeight,
        overflowX: node.scrollWidth - node.clientWidth,
        overflowY: node.scrollHeight - node.clientHeight
      };
    });

    if (!focusStyle.className.includes('bp-chrome-')) {
      throw new Error(`${control.label} should expose a namespaced chrome class, received ${focusStyle.className}.`);
    }
    if (focusStyle.ariaLabel.length === 0) {
      throw new Error(`${control.label} should expose an accessible label or title.`);
    }
    if (focusStyle.outlineStyle === 'none' && focusStyle.boxShadow === 'none') {
      throw new Error(`${control.label} should expose a visible focus state, received ${JSON.stringify(focusStyle)}.`);
    }
    if (focusStyle.overflowX > 1 || focusStyle.overflowY > 1 || focusStyle.width < 32 || focusStyle.height < 32) {
      throw new Error(`${control.label} should keep stable, non-overflowing dimensions: ${JSON.stringify(focusStyle)}.`);
    }
  }
}

async function assertNoViewportTextOverlap(page: import('playwright').Page, slug: string): Promise<void> {
  const issues = await page.locator([
    '.board-switcher',
    '.board-switcher [data-section]',
    '.frame-head',
    '.frame-chip',
    '.frame-shot',
    '.frame-save',
    '.screen-section-head',
    '.screen-dependency'
  ].join(',')).evaluateAll(elements =>
    elements
      .filter(element => {
        const node = element as HTMLElement;
        const rect = node.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(node).visibility !== 'hidden';
        return visible && (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1);
      })
      .map(element => {
        const node = element as HTMLElement;
        return {
          selector: node.className || node.tagName.toLowerCase(),
          text: node.textContent?.trim().replace(/\s+/g, ' ').slice(0, 120) ?? '',
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight
        };
      })
  );

  const intersections = await page.locator('.board-switcher, .frame-chip, .frame-shot, .frame-save').evaluateAll(elements => {
    const boxes = elements
      .map((element, index) => {
        const node = element as HTMLElement;
        const rect = node.getBoundingClientRect();
        return {
          index,
          label: node.className || node.tagName.toLowerCase(),
          text: node.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '',
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          visible: rect.width > 0 && rect.height > 0 && window.getComputedStyle(node).visibility !== 'hidden'
        };
      })
      .filter(box => box.visible);

    const collisions: Array<{ one: string; two: string }> = [];
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const one = boxes[a]!;
        const two = boxes[b]!;
        if (one.left < two.right && one.right > two.left && one.top < two.bottom && one.bottom > two.top) {
          collisions.push({
            one: `${one.label} ${one.text}`.trim(),
            two: `${two.label} ${two.text}`.trim()
          });
        }
      }
    }
    return collisions;
  });

  await writeFile(path.join(chromeEvidenceRoot, `${slug}-overlap.json`), `${JSON.stringify({ issues, intersections }, null, 2)}\n`, 'utf8');
  if (issues.length > 0) {
    throw new Error(`Chrome and app-sample text should not overflow in ${slug}: ${JSON.stringify(issues)}`);
  }
  if (intersections.length > 0) {
    throw new Error(`Chrome controls should not overlap each other in ${slug}: ${JSON.stringify(intersections)}`);
  }
}

async function assertAppSampleStyleStability(
  page: import('playwright').Page,
  slug: string,
  interact: () => Promise<void>,
  minimumSamples = 2
): Promise<void> {
  const before = await collectAppSampleStyleSnapshot(page);
  if (before.samples.length < minimumSamples) {
    throw new Error(`Expected at least ${minimumSamples} app-sample style probes for ${slug}, received ${before.samples.length}.`);
  }

  await writeFile(path.join(chromeEvidenceRoot, `${slug}-baseline.json`), `${JSON.stringify(before, null, 2)}\n`, 'utf8');
  if (chromeBaselineRoot) {
    const persistedBaseline = JSON.parse(
      await readFile(path.join(chromeBaselineRoot, `${slug}-baseline.json`), 'utf8')
    ) as Awaited<ReturnType<typeof collectAppSampleStyleSnapshot>>;
    const persistedDiff = diffStyleSnapshots(persistedBaseline, before);
    await writeFile(path.join(chromeEvidenceRoot, `${slug}-red-baseline-diff.json`), `${JSON.stringify(persistedDiff, null, 2)}\n`, 'utf8');
    if (persistedDiff.changed.length > 0 || persistedDiff.missing.length > 0 || persistedDiff.added.length > 0) {
      throw new Error(`Current app-sample styles drifted from the red baseline for ${slug}: ${JSON.stringify(persistedDiff)}`);
    }
  }

  await interact();
  const after = await collectAppSampleStyleSnapshot(page);
  await writeFile(path.join(chromeEvidenceRoot, `${slug}-after-chrome-interaction.json`), `${JSON.stringify(after, null, 2)}\n`, 'utf8');

  const diff = diffStyleSnapshots(before, after);
  await writeFile(path.join(chromeEvidenceRoot, `${slug}-style-diff.json`), `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
  if (diff.changed.length > 0 || diff.missing.length > 0 || diff.added.length > 0) {
    throw new Error(`Chrome interactions should not alter app-sample styles for ${slug}: ${JSON.stringify(diff)}`);
  }
}

async function collectAppSampleStyleSnapshot(page: import('playwright').Page): Promise<{
  collectedAt: string;
  url: string;
  properties: string[];
  samples: Array<{ key: string; selector: string; boundaryId: string; text: string; styles: Record<string, string> }>;
}> {
  return page.evaluate(() => {
    const properties = [
      'box-sizing',
      'color-scheme',
      'font-family',
      'font-size',
      'font-weight',
      'line-height',
      'color',
      'background-color',
      'border-top-left-radius',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'margin-top',
      'margin-right',
      'margin-bottom',
      'margin-left'
    ];
    const probes = [
      { selector: '.board-primitives .canonical-primitive-specimen', limit: 3 },
      { selector: '.board-primitives .token-specimen', limit: 2 },
      { selector: '.board-screens .canonical-prototype-screen', limit: 3 }
    ];
    const samples: Array<{ key: string; selector: string; boundaryId: string; text: string; styles: Record<string, string> }> = [];
    for (const probe of probes) {
      const elements = [...document.querySelectorAll<HTMLElement>(probe.selector)]
        .filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .slice(0, probe.limit);
      elements.forEach((element, index) => {
        const computed = window.getComputedStyle(element);
        const styles = Object.fromEntries(properties.map(property => [property, computed.getPropertyValue(property)]));
        const boundary = element.closest<HTMLElement>('[data-boundary-id]');
        samples.push({
          key: `${probe.selector}:${index}:${boundary?.dataset.boundaryId ?? 'none'}`,
          selector: probe.selector,
          boundaryId: boundary?.dataset.boundaryId ?? '',
          text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 100) ?? '',
          styles
        });
      });
    }
    return {
      collectedAt: new Date().toISOString(),
      url: window.location.href,
      properties,
      samples
    };
  });
}

function diffStyleSnapshots(
  before: Awaited<ReturnType<typeof collectAppSampleStyleSnapshot>>,
  after: Awaited<ReturnType<typeof collectAppSampleStyleSnapshot>>
): {
  checkedProperties: string[];
  changed: Array<{ key: string; property: string; before: string; after: string }>;
  missing: string[];
  added: string[];
} {
  const beforeByKey = new Map(before.samples.map(sample => [sample.key, sample]));
  const afterByKey = new Map(after.samples.map(sample => [sample.key, sample]));
  const changed: Array<{ key: string; property: string; before: string; after: string }> = [];
  for (const [key, beforeSample] of beforeByKey) {
    const afterSample = afterByKey.get(key);
    if (!afterSample) {
      continue;
    }
    for (const property of before.properties) {
      const beforeValue = beforeSample.styles[property] ?? '';
      const afterValue = afterSample.styles[property] ?? '';
      if (beforeValue !== afterValue) {
        changed.push({ key, property, before: beforeValue, after: afterValue });
      }
    }
  }
  return {
    checkedProperties: before.properties,
    changed,
    missing: [...beforeByKey.keys()].filter(key => !afterByKey.has(key)),
    added: [...afterByKey.keys()].filter(key => !beforeByKey.has(key))
  };
}

async function readWorldTransform(page: import('playwright').Page): Promise<{ scale: number; x: number; y: number }> {
  return page.locator('#world').evaluate(element => {
    const transform = window.getComputedStyle(element).transform;
    if (!transform || transform === 'none') {
      return { scale: 1, x: 0, y: 0 };
    }

    const values = transform
      .replace('matrix(', '')
      .replace(')', '')
      .split(',')
      .map(value => Number(value.trim()));

    return {
      scale: values[0] ?? 1,
      x: values[4] ?? 0,
      y: values[5] ?? 0
    };
  });
}

async function dispatchWheel(
  page: import('playwright').Page,
  init: { deltaX: number; deltaY: number; ctrlKey: boolean; metaKey: boolean }
): Promise<void> {
  await page.locator('#viewport').evaluate((element, wheelInit) => {
    element.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: wheelInit.deltaX,
        deltaY: wheelInit.deltaY,
        ctrlKey: wheelInit.ctrlKey,
        metaKey: wheelInit.metaKey,
        bubbles: true,
        cancelable: true
      })
    );
  }, init);
}

async function waitForTransformChange(page: import('playwright').Page, field: 'scale' | 'x' | 'y', previous: number): Promise<void> {
  await page.waitForFunction(
    ({ field: targetField, previous: previousValue }) => {
      const element = document.querySelector<HTMLElement>('#world');
      if (!element) {
        return false;
      }
      const transform = window.getComputedStyle(element).transform;
      if (!transform || transform === 'none') {
        return false;
      }
      const values = transform
        .replace('matrix(', '')
        .replace(')', '')
        .split(',')
        .map(value => Number(value.trim()));
      const current = targetField === 'scale' ? values[0] : targetField === 'x' ? values[4] : values[5];
      return typeof current === 'number' && Math.abs(current - previousValue) > 0.001;
    },
    { field, previous },
    { timeout: 1000 }
  );
}

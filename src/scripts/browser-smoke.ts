import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { loadProjectFromFs } from '../core/load';
import { validateVisibleBoundaryRecords, type VisibleBoundaryRecord } from '../core/review';
import type { BlueprintProjectBundle } from '../core/types';

const artifactRoot =
  process.env.BLUEPRINT_ARTIFACT_ROOT ??
  '.blueprint-artifacts/browser-smoke';
const screenshotRoot = path.join(artifactRoot, 'screenshots');
const reviewManifestRoot = path.join(artifactRoot, 'review-manifests');
const styleEvidenceRoot = path.join(artifactRoot, 'style-evidence');

async function main(): Promise<void> {
  await mkdir(screenshotRoot, { recursive: true });
  await mkdir(reviewManifestRoot, { recursive: true });
  await mkdir(styleEvidenceRoot, { recursive: true });
  const server = await createServer({
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 0
    }
  });

  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5173;
  const url = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    await page.goto(url);
    await page.waitForSelector('.board-primitives .spec[data-boundary-kind="primitive"]', { timeout: 10000 });
    await assertDashboardChromeRemoved(page);
    await assertDarkBlueprintCanvas(page);
    const starterBundle = await loadProjectFromFs('starter/design/blueprint');
    await assertDataDrivenPrimitiveBoard(page, starterBundle);
    await assertPrimitiveCanvasPlacement(page);
    await assertVisibleBoundarySynchronization(page, 'primitives');
    await page.screenshot({ path: path.join(screenshotRoot, 'blueprint-primitives-desktop.png'), fullPage: true });
    await assertProofFixturePrimitiveBoards(browser, url);

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

    await page.locator('[data-board="screens"]').click();
    await page.waitForSelector('.board-screens .frame[data-boundary-kind="screen"]', { timeout: 10000 });
    await assertReferenceScreenBoard(page, starterBundle);
    await assertPhoneFrame(page);
    await assertScreenCompositionRendered(page, starterBundle);
    await assertVisibleBoundarySynchronization(page, 'screens');
    const starterScreensScreenshot = path.join(screenshotRoot, 'blueprint-screens-desktop.png');
    await page.screenshot({ path: starterScreensScreenshot, fullPage: true });
    await writeScreenReviewArtifacts(page, starterBundle.manifest.project.id, 'screens', starterScreensScreenshot);
    await assertBoundaryAffordances(page);
    await assertFrameTools(page);

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(`${url}?board=screens`);
    await mobile.waitForSelector('.board-screens .frame[data-boundary-kind="screen"]', { timeout: 10000 });
    await assertScreenCompositionRendered(mobile, starterBundle);
    await mobile.screenshot({ path: path.join(screenshotRoot, 'blueprint-screens-mobile.png'), fullPage: true });

    const appOwned = await loadProjectFromFs('fixtures/app-owned/nova-care/design/blueprint');
    const configured = await browser.newPage({ viewport: { width: 1024, height: 780 } });
    await configured.addInitScript(bundle => {
      Object.defineProperty(window, '__BLUEPRINT_PROJECT_BUNDLE__', {
        configurable: true,
        value: bundle
      });
    }, appOwned);
    await configured.goto(`${url}?board=screens`);
    await configured.waitForSelector('.board-screens .frame[data-boundary-id="nova-care/screen/home"]', { timeout: 10000 });
    await assertScreenCompositionRendered(configured, appOwned);
    await assertNoProjectManagerChrome(configured);
    const novaScreensScreenshot = path.join(screenshotRoot, 'nova-care-screens.png');
    await configured.screenshot({ path: novaScreensScreenshot, fullPage: true });
    await writeScreenReviewArtifacts(configured, appOwned.manifest.project.id, 'nova-care-screens', novaScreensScreenshot);

    console.log(`Browser smoke passed at ${url}. Screenshots written to ${screenshotRoot}.`);
  } finally {
    await browser.close();
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

  const buttons = await page.locator('.board-switcher [data-board]').evaluateAll(elements => elements.map(element => element.textContent?.trim()));
  if (buttons.join(',') !== 'Primitives,Screens') {
    throw new Error(`Expected only Primitives and Screens board buttons, received: ${buttons.join(',')}`);
  }

  const activeButtonStyles = await page.locator('.board-switcher [aria-pressed="true"]').evaluate(element => {
    const computed = window.getComputedStyle(element);
    return {
      backgroundColor: computed.backgroundColor,
      backgroundImage: computed.backgroundImage
    };
  });
  if (activeButtonStyles.backgroundColor === 'rgb(200, 255, 58)' || activeButtonStyles.backgroundImage !== 'none') {
    throw new Error('Board switcher should use a neutral token color and no gradient treatment.');
  }
}

async function assertDarkBlueprintCanvas(page: import('playwright').Page): Promise<void> {
  const styles = await page.locator('#viewport').evaluate(element => {
    const computed = window.getComputedStyle(element);
    return {
      backgroundImage: computed.backgroundImage,
      backgroundColor: computed.backgroundColor
    };
  });

  const radialCount = styles.backgroundImage.match(/radial-gradient/g)?.length ?? 0;
  if (radialCount !== 1 || styles.backgroundColor !== 'rgb(11, 17, 24)') {
    throw new Error('Canvas should render the dark dotted Blueprint reference background.');
  }
}

async function assertProofFixturePrimitiveBoards(browser: import('playwright').Browser, url: string): Promise<void> {
  const proofRoots = [
    'starter/design/blueprint',
    'fixtures/app-owned/nova-care/design/blueprint',
    'fixtures/app-owned/atlas-pay/design/blueprint'
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
    await page.waitForSelector('.board-primitives [data-boundary-id][data-boundary-kind]', { timeout: 10000 });
    await assertDataDrivenPrimitiveBoard(page, bundle);
    const screenshotPath = path.join(screenshotRoot, `${bundle.manifest.project.id}-primitives.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await writePrimitiveReviewArtifacts(page, bundle.manifest.project.id, screenshotPath);
    await page.close();
  }
}

async function assertDataDrivenPrimitiveBoard(page: import('playwright').Page, bundle: BlueprintProjectBundle): Promise<void> {
  const records = await collectPrimitiveBoundaryRecords(page);
  const sync = validateVisibleBoundaryRecords(bundle, records);
  if (!sync.ok) {
    throw new Error(`Primitive board visible boundaries do not match ${bundle.manifest.project.id} structured data:\n${sync.errors.join('\n')}`);
  }

  const expectedBoundaryIds = [
    ...bundle.tokens.tokenGroups.map(group => `${bundle.manifest.project.id}/token-group/${group.id}`),
    ...bundle.primitives.primitives.flatMap(primitive => [
      `${bundle.manifest.project.id}/primitive/${primitive.id}`,
      ...primitive.stateSets.map(stateSet => `${bundle.manifest.project.id}/state-set/${primitive.id}/${stateSet.id}`)
    ])
  ];
  const visibleBoundaryIds = records.map(record => record.id);
  const missingBoundaries = expectedBoundaryIds.filter(id => !visibleBoundaryIds.includes(id));
  if (missingBoundaries.length > 0) {
    throw new Error(`${bundle.manifest.project.id} primitive board is missing app-owned boundaries: ${missingBoundaries.join(', ')}`);
  }

  const duplicateBoundaries = visibleBoundaryIds.filter((id, index) => visibleBoundaryIds.indexOf(id) !== index);
  if (duplicateBoundaries.length > 0) {
    throw new Error(`${bundle.manifest.project.id} primitive board rendered duplicate boundaries: ${[...new Set(duplicateBoundaries)].join(', ')}`);
  }

  const primitiveIds = new Set(bundle.primitives.primitives.map(primitive => primitive.id));
  const visiblePrimitiveIds = records
    .filter(record => record.kind === 'primitive')
    .map(record => record.id.split('/').slice(2).join('/'));
  const stale = visiblePrimitiveIds.filter(id => !primitiveIds.has(id));
  if (stale.length > 0) {
    throw new Error(`${bundle.manifest.project.id} primitive board rendered stale demo-only primitives: ${stale.join(', ')}`);
  }

  const primitiveCards = await page.locator('.board-primitives [data-boundary-kind="primitive"]').evaluateAll(elements =>
    elements.map(element => ({
      id: (element as HTMLElement).dataset.boundaryId ?? '',
      family: (element as HTMLElement).dataset.primitiveFamily ?? '',
      text: element.textContent?.trim() ?? ''
    }))
  );
  const missingFamily = primitiveCards.filter(card => card.family.length === 0);
  if (missingFamily.length > 0) {
    throw new Error(`${bundle.manifest.project.id} primitive cards should name renderer families: ${JSON.stringify(missingFamily)}`);
  }
  const families = new Set(primitiveCards.map(card => card.family));
  if (families.size < Math.min(2, bundle.primitives.primitives.length) || ![...families].some(family => family !== 'generic')) {
    throw new Error(`${bundle.manifest.project.id} primitive board should prove bounded family templates, received: ${[...families].join(', ')}`);
  }

  for (const primitive of bundle.primitives.primitives) {
    for (const stateSet of primitive.stateSets) {
      const stateSetBoundary = `${bundle.manifest.project.id}/state-set/${primitive.id}/${stateSet.id}`;
      for (const state of stateSet.states) {
        const count = await page
          .locator(`[data-boundary-id="${stateSetBoundary}"] [data-primitive-state-id="${state.id}"]`)
          .count();
        if (count !== 1) {
          throw new Error(`${bundle.manifest.project.id} primitive board missing state sample ${primitive.id}/${stateSet.id}/${state.id}`);
        }
      }
    }
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
    screenshot: {
      status: 'captured',
      path: screenshotPath
    },
    boundaries: manifest.boundaries.map(boundary => ({
      ...boundary,
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

async function assertPrimitiveCanvasPlacement(page: import('playwright').Page): Promise<void> {
  const overlaps = await page.locator('.board-primitives').evaluate(root => {
    const elements = [...root.querySelectorAll<HTMLElement>('.group-head, .spec')];
    const boxes = elements.map(element => {
      const left = parseFloat(element.style.left || '0');
      const top = parseFloat(element.style.top || '0');
      const chip = element.querySelector<HTMLElement>('.spec-chip');
      const chipTop = chip ? top + chip.offsetTop : top;
      const chipLeft = chip ? left + chip.offsetLeft : left;
      return {
        label: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || element.className,
        left: Math.min(left, chipLeft),
        right: Math.max(left + element.offsetWidth, chipLeft + (chip?.offsetWidth ?? 0)),
        top: Math.min(top, chipTop),
        bottom: Math.max(top + element.offsetHeight, chipTop + (chip?.offsetHeight ?? 0))
      };
    });

    const collisions: string[] = [];
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const one = boxes[a];
        const two = boxes[b];
        if (one.left < two.right && one.right > two.left && one.top < two.bottom && one.bottom > two.top) {
          collisions.push(`${one.label} overlaps ${two.label}`);
        }
      }
    }
    return collisions;
  });

  if (overlaps.length > 0) {
    throw new Error(`Primitive canvas items should not overlap:\n${overlaps.join('\n')}`);
  }

  const overflow = await page.locator('.board-primitives .spec-body').evaluateAll(elements =>
    elements
      .filter(element => element.scrollWidth > element.clientWidth + 1)
      .map(element => element.closest('.spec')?.querySelector('.spec-chip')?.textContent?.trim() ?? 'unknown spec')
  );
  if (overflow.length > 0) {
    throw new Error(`Primitive sample content should fit within its card: ${overflow.join(', ')}`);
  }
}

async function assertReferenceScreenBoard(page: import('playwright').Page, bundle: BlueprintProjectBundle): Promise<void> {
  const frames = await page.locator('.board-screens .frame').count();
  if (frames !== bundle.screens.screens.length) {
    throw new Error(`${bundle.manifest.project.id} Screens board should render every structured screen, received ${frames}.`);
  }

  const labels = await page.locator('.board-screens .frame-chip .frame-name').evaluateAll(elements =>
    elements.map(element => element.textContent?.trim()).filter(Boolean)
  );
  const expected = bundle.screens.screens.map(screen => `${screen.id.toUpperCase()} · ${screen.name}`);

  if (labels.join(',') !== expected.join(',')) {
    throw new Error(`Screen frame labels drifted from the reference canvas shape, received: ${labels.join(',')}`);
  }
}

async function assertScreenCompositionRendered(page: import('playwright').Page, bundle: BlueprintProjectBundle): Promise<void> {
  const rejectedProjectionCount = await page.locator('.board-screens .screen-section-projection').count();
  if (rejectedProjectionCount !== 0) {
    throw new Error(`Screens board must not reintroduce rejected metadata-card section projections; received ${rejectedProjectionCount}.`);
  }

  const records = await collectScreenBoundaryRecords(page);
  const sync = validateVisibleBoundaryRecords(bundle, records);
  if (!sync.ok) {
    throw new Error(`Screens board visible boundaries do not match ${bundle.manifest.project.id} structured data:\n${sync.errors.join('\n')}`);
  }

  const expectedScreenIds = bundle.screens.screens.map(screen => `${bundle.manifest.project.id}/screen/${screen.id}`).sort();
  const visibleScreenIds = records.filter(record => record.kind === 'screen').map(record => record.id).sort();
  if (visibleScreenIds.join(',') !== expectedScreenIds.join(',')) {
    throw new Error(`${bundle.manifest.project.id} Screens board missing screen frames: expected ${expectedScreenIds.join(',')}, received ${visibleScreenIds.join(',')}`);
  }

  const expectedSectionIds = bundle.screens.screens
    .flatMap(screen => screen.sections.map(section => `${bundle.manifest.project.id}/section/${screen.id}/${section.id}`))
    .sort();
  const visibleSectionIds = records.filter(record => record.kind === 'section').map(record => record.id).sort();
  if (visibleSectionIds.join(',') !== expectedSectionIds.join(',')) {
    throw new Error(`${bundle.manifest.project.id} Screens board missing rendered section boundaries: expected ${expectedSectionIds.join(',')}, received ${visibleSectionIds.join(',')}`);
  }

  const invalidSectionContexts = await page.locator('.board-screens [data-boundary-kind="section"]').evaluateAll(elements =>
    elements
      .map(element => {
        const node = element as HTMLElement;
        const frame = node.closest<HTMLElement>('.frame');
        return {
          id: node.dataset.boundaryId ?? '',
          screenId: node.dataset.screenId ?? '',
          frameScreenId: frame?.dataset.screenId ?? '',
          text: node.textContent?.trim().replace(/\s+/g, ' ') ?? ''
        };
      })
      .filter(record => record.screenId.length === 0 || record.frameScreenId.length === 0 || record.screenId !== record.frameScreenId || record.text.length === 0)
  );
  if (invalidSectionContexts.length > 0) {
    throw new Error(`Rendered sections should have visible content and stay inside their owning frame: ${JSON.stringify(invalidSectionContexts)}`);
  }

  const metadataRelapses = await page.locator('.board-screens .screen-template-body').evaluateAll((elements, projectBundle) => {
    const bundle = projectBundle as BlueprintProjectBundle;
    const primitiveNames = bundle.primitives.primitives.map(primitive => primitive.name).filter(Boolean);
    const primitiveDescriptions = bundle.primitives.primitives.map(primitive => primitive.description).filter(Boolean);
    const forbidden = [...primitiveNames, ...primitiveDescriptions].filter(Boolean);
    return elements.flatMap(element => {
      const text = (element as HTMLElement).innerText;
      return forbidden.filter(term => term.length > 0 && text.includes(term));
    });
  }, bundle);
  if (metadataRelapses.length > 0) {
    throw new Error(`Screens board should render prototype content, not primitive metadata labels/descriptions: ${[...new Set(metadataRelapses)].join(', ')}`);
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
  const chip = frame.locator('[data-boundary-action="copy-id"]').first();
  await chip.waitFor({ timeout: 5000 });

  const command = await frame.getAttribute('data-handoff-command');
  if (!command?.includes('blueprint extract') || !command.includes('--boundary screen:')) {
    throw new Error(`Screen frame should expose an honest extraction command, received ${command}.`);
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
    screenshot: {
      status: 'captured',
      path: screenshotPath
    },
    boundaries: manifest.boundaries.map(boundary => ({
      ...boundary,
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
  if (projectId !== 'nova-care/screen/home') {
    throw new Error(`Configured single-project bundle should render nova-care without source edits, received ${projectId}.`);
  }
}

async function assertPhoneFrame(page: import('playwright').Page): Promise<void> {
  const size = await page.locator('.screen').first().evaluate(element => {
    const computed = window.getComputedStyle(element);
    return {
      width: parseFloat(computed.width),
      height: parseFloat(computed.height)
    };
  });

  if (Math.abs(size.width - 393) > 0.5 || Math.abs(size.height - 852) > 0.5) {
    throw new Error(`Expected reference phone screen to be 393x852, received ${size.width}x${size.height}.`);
  }

  await page.locator('.status-bar').first().waitFor({ timeout: 5000 });
  await page.locator('.home-indicator').first().waitFor({ timeout: 5000 });
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

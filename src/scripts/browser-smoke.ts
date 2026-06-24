import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { loadProjectFromFs } from '../core/load';

const artifactRoot = '.agent-workstream/2026-06-23-04-blueprint-canvas-contract-review-loop/artifacts';
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
    await assertReferencePrimitiveBoard(page);
    await assertPrimitiveCanvasPlacement(page);
    await assertVisibleBoundarySynchronization(page, 'primitives');
    await page.screenshot({ path: path.join(screenshotRoot, 'blueprint-primitives-desktop.png'), fullPage: true });

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
    await assertReferenceScreenBoard(page);
    await assertPhoneFrame(page);
    await assertScreenPlaceholderEmpty(page);
    await assertVisibleBoundarySynchronization(page, 'screens');
    await assertBoundaryAffordances(page);
    await page.screenshot({ path: path.join(screenshotRoot, 'blueprint-screens-desktop.png'), fullPage: true });
    await writeReviewArtifacts(page);
    await assertFrameTools(page);

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(`${url}?board=screens`);
    await mobile.waitForSelector('.board-screens .frame[data-boundary-kind="screen"]', { timeout: 10000 });
    await assertScreenPlaceholderEmpty(mobile);
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
    await assertScreenPlaceholderEmpty(configured);
    await assertNoProjectManagerChrome(configured);

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

async function assertReferencePrimitiveBoard(page: import('playwright').Page): Promise<void> {
  const headings = await page.locator('.board-primitives .group-head h1').evaluateAll(elements =>
    elements.map(element => element.textContent?.trim()).filter(Boolean)
  );
  const expected = ['Tokens', 'Text', 'Actions', 'Inputs', 'Surfaces', 'Rows', 'Feedback', 'Overlays'];

  if (headings.join(',') !== expected.join(',')) {
    throw new Error(`Primitive board should use reference-style groups, received: ${headings.join(',')}`);
  }

  if (headings.some(heading => /^state sets?$/i.test(heading ?? ''))) {
    throw new Error('Primitive state sets should stay embedded in samples, not render as a visible canvas group.');
  }

  const specCount = await page.locator('.board-primitives .spec').count();
  if (specCount < 24) {
    throw new Error(`Primitive board should render the generalized reference primitive gallery, received only ${specCount} spec cards.`);
  }

  const requiredSpecLabels = [
    'COLOR · brand and semantic',
    'TEXT · all variants',
    'BUTTON · variant x state matrix',
    'INPUT · variant x state matrix',
    'SURFACE · nested 2-8',
    'LIST · grouped items + dividers',
    'BADGE · variants',
    'BOTTOM SHEET · nav + content + footer'
  ];
  const labels = await page.locator('.board-primitives .spec-chip').evaluateAll(elements =>
    elements.map(element => element.textContent?.trim()).filter(Boolean)
  );
  for (const label of requiredSpecLabels) {
    if (!labels.includes(label)) {
      throw new Error(`Primitive board is missing generalized reference spec "${label}".`);
    }
  }

  const buttonRows = await page.locator('.button-state-matrix .mx-row').count();
  if (buttonRows < 12) {
    throw new Error(`Button primitive should show variant x state rows, received ${buttonRows}.`);
  }
  const primitiveActionChrome = await page
    .locator('.board-primitives .boundary-actions, .board-primitives [data-boundary-action="copy-extract-command"]')
    .count();
  if (primitiveActionChrome !== 0) {
    throw new Error(`Primitive cards should not render copy/extract action chrome, received ${primitiveActionChrome} controls.`);
  }
  await assertButtonMatrixLayout(page);
  await assertTextVariantLayout(page);

  const inputRows = await page.locator('.input-state-matrix .mx-row').count();
  if (inputRows < 6) {
    throw new Error(`Input primitive should show variant x state rows, received ${inputRows}.`);
  }
  await assertCheckboxLayout(page);
  await assertSwitchThumbLayout(page);
  await assertSliderThumbLayout(page);
}

async function assertButtonMatrixLayout(page: import('playwright').Page): Promise<void> {
  const report = await page.locator('.button-state-matrix').evaluate(root => {
    const matrix = root as HTMLElement;
    const loadingDots = [...matrix.querySelectorAll<HTMLElement>('.loading-dot')].map(dot => {
      const computed = window.getComputedStyle(dot);
      const rect = dot.getBoundingClientRect();
      const parentRect = dot.parentElement?.getBoundingClientRect();
      return {
        position: computed.position,
        width: rect.width,
        height: rect.height,
        parentWidth: parentRect?.width ?? 0
      };
    });

    const buttonOverflow = [...matrix.querySelectorAll<HTMLElement>('.mx-row:not(.icon-row) .btn')].map(button => ({
      label: button.textContent?.trim() ?? button.className,
      className: button.className,
      scrollWidth: button.scrollWidth,
      clientWidth: button.clientWidth,
      row: button.closest('.mx-row')?.textContent?.trim().replace(/\s+/g, ' ') ?? ''
    })).filter(button => button.scrollWidth > button.clientWidth + 1);

    const gradientButtons = [...matrix.querySelectorAll<HTMLElement>('.mx-row .btn-gradient')].map(button => {
      const label = button.querySelector<HTMLElement>('.btn-label');
      const rect = button.getBoundingClientRect();
      const labelRect = label?.getBoundingClientRect();
      return {
        text: button.textContent?.trim() ?? '',
        buttonWidth: rect.width,
        labelWidth: labelRect?.width ?? 0,
        labelFits: label ? labelRect!.left >= rect.left - 0.5 && labelRect!.right <= rect.right + 0.5 : false
      };
    });

    const rowLabelOverflow = [...matrix.querySelectorAll<HTMLElement>('.mx-label')].map(label => ({
      text: label.textContent?.trim() ?? '',
      scrollWidth: label.scrollWidth,
      clientWidth: label.clientWidth
    })).filter(label => label.scrollWidth > label.clientWidth + 1);

    return {
      loadingDots,
      buttonOverflow,
      gradientButtons,
      rowLabelOverflow
    };
  });

  const absoluteDots = report.loadingDots.filter(dot => dot.position === 'absolute');
  if (absoluteDots.length > 0) {
    throw new Error(`Loading indicators should not overlay button labels: ${JSON.stringify(absoluteDots)}`);
  }

  if (report.buttonOverflow.length > 0) {
    throw new Error(`Button matrix content should fit inside every button: ${JSON.stringify(report.buttonOverflow)}`);
  }

  if (report.rowLabelOverflow.length > 0) {
    throw new Error(`Button matrix row labels should fit inside their label column: ${JSON.stringify(report.rowLabelOverflow)}`);
  }

  if (report.gradientButtons.length !== 3 || !report.gradientButtons.every(button => button.labelFits && button.labelWidth < button.buttonWidth)) {
    throw new Error(`Gradient buttons should keep icon/text content inside their row cells: ${JSON.stringify(report.gradientButtons)}`);
  }
}

async function assertTextVariantLayout(page: import('playwright').Page): Promise<void> {
  const overflow = await page.locator('.tspec [class^="t-"]').evaluateAll(elements =>
    elements
      .map(element => {
        const node = element as HTMLElement;
        return {
          className: node.className,
          text: node.textContent?.trim() ?? '',
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth
        };
      })
      .filter(node => node.scrollWidth > node.clientWidth + 1)
  );

  if (overflow.length > 0) {
    throw new Error(`Text primitive samples should wrap within their card: ${JSON.stringify(overflow)}`);
  }
}

async function assertCheckboxLayout(page: import('playwright').Page): Promise<void> {
  const report = await page.locator('.cbx').evaluateAll(elements => elements.map((element, index) => {
    const checkbox = element as HTMLElement;
    const icon = checkbox.querySelector<SVGElement>('svg');
    const boxRect = checkbox.getBoundingClientRect();
    const iconRect = icon?.getBoundingClientRect();
    return {
      index,
      className: checkbox.className,
      width: boxRect.width,
      height: boxRect.height,
      iconInside: Boolean(
        iconRect &&
          iconRect.left >= boxRect.left - 0.5 &&
          iconRect.right <= boxRect.right + 0.5 &&
          iconRect.top >= boxRect.top - 0.5 &&
          iconRect.bottom <= boxRect.bottom + 0.5
      )
    };
  }));

  const broken = report.filter(item => Math.abs(item.width - item.height) > 0.5 || !item.iconInside);
  if (broken.length > 0) {
    throw new Error(`Checkbox primitives should keep check icons centered inside square boxes: ${JSON.stringify(broken)}`);
  }
}

async function assertSwitchThumbLayout(page: import('playwright').Page): Promise<void> {
  const report = await page.locator('.sw').evaluateAll(elements => elements.map((element, index) => {
    const switchEl = element as HTMLElement;
    const thumb = switchEl.querySelector<HTMLElement>('.sw-thumb');
    const trackRect = switchEl.getBoundingClientRect();
    const thumbRect = thumb?.getBoundingClientRect();
    const thumbStyle = thumb ? window.getComputedStyle(thumb) : null;
    const trackStyle = window.getComputedStyle(switchEl);
    return {
      index,
      className: switchEl.className,
      trackWidth: trackRect.width,
      trackHeight: trackRect.height,
      thumbWidth: thumbRect?.width ?? 0,
      thumbHeight: thumbRect?.height ?? 0,
      thumbPosition: thumbStyle?.position ?? '',
      thumbTransform: thumbStyle?.transform ?? '',
      trackPosition: trackStyle.position,
      inside: Boolean(
        thumbRect &&
          thumbRect.left >= trackRect.left - 0.5 &&
          thumbRect.right <= trackRect.right + 0.5 &&
          thumbRect.top >= trackRect.top - 0.5 &&
          thumbRect.bottom <= trackRect.bottom + 0.5
      )
    };
  }));

  const broken = report.filter(item => !item.inside || item.thumbPosition !== 'absolute' || item.thumbTransform !== 'none');
  if (broken.length > 0) {
    throw new Error(`Switch thumbs should stay inside their tracks without slider transforms: ${JSON.stringify(broken)}`);
  }

  const genericThumbs = await page.locator('.sw > .thumb').count();
  if (genericThumbs !== 0) {
    throw new Error(`Switch controls should not use generic slider thumb class, received ${genericThumbs}.`);
  }
}

async function assertSliderThumbLayout(page: import('playwright').Page): Promise<void> {
  const report = await page.locator('.slider').evaluateAll(elements => elements.map((element, index) => {
    const slider = element as HTMLElement;
    const thumb = slider.querySelector<HTMLElement>('.thumb');
    const track = slider.querySelector<HTMLElement>('.track');
    const fill = slider.querySelector<HTMLElement>('.fill');
    const sliderRect = slider.getBoundingClientRect();
    const thumbRect = thumb?.getBoundingClientRect();
    const trackRect = track?.getBoundingClientRect();
    const fillRect = fill?.getBoundingClientRect();
    const thumbStyle = thumb ? window.getComputedStyle(thumb) : null;
    return {
      index,
      className: slider.className,
      thumbPosition: thumbStyle?.position ?? '',
      thumbTransform: thumbStyle?.transform ?? '',
      thumbInside: Boolean(
        thumbRect &&
          thumbRect.left >= sliderRect.left - 0.5 &&
          thumbRect.right <= sliderRect.right + 0.5 &&
          thumbRect.top >= sliderRect.top - 0.5 &&
          thumbRect.bottom <= sliderRect.bottom + 0.5
      ),
      trackInside: Boolean(
        trackRect &&
          trackRect.left >= sliderRect.left - 0.5 &&
          trackRect.right <= sliderRect.right + 0.5 &&
          trackRect.top >= sliderRect.top - 0.5 &&
          trackRect.bottom <= sliderRect.bottom + 0.5
      ),
      fillInside: Boolean(
        fillRect &&
          fillRect.left >= sliderRect.left - 0.5 &&
          fillRect.right <= sliderRect.right + 0.5 &&
          fillRect.top >= sliderRect.top - 0.5 &&
          fillRect.bottom <= sliderRect.bottom + 0.5
      )
    };
  }));

  const broken = report.filter(
    item =>
      !item.thumbInside ||
      !item.trackInside ||
      !item.fillInside ||
      item.thumbPosition !== 'absolute' ||
      item.thumbTransform === 'none'
  );
  if (broken.length > 0) {
    throw new Error(`Slider primitives should keep track, fill, and thumb geometry inside each slider: ${JSON.stringify(broken)}`);
  }
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

async function assertReferenceScreenBoard(page: import('playwright').Page): Promise<void> {
  const frames = await page.locator('.board-screens .frame').count();
  if (frames !== 1) {
    throw new Error(`Default Screens board should render one reusable baseline phone frame, received ${frames}.`);
  }

  const labels = await page.locator('.board-screens .frame-chip .frame-name').evaluateAll(elements =>
    elements.map(element => element.textContent?.trim()).filter(Boolean)
  );
  const expected = ['HOME · Home'];

  if (labels.join(',') !== expected.join(',')) {
    throw new Error(`Screen frame labels drifted from the reference canvas shape, received: ${labels.join(',')}`);
  }

  const sampleContent = await page
    .locator('.board-screens .phone-section, .board-screens .mood-scale, .board-screens .appointment-card, .board-screens .insight-card, .board-screens .bottom-sheet')
    .count();
  if (sampleContent !== 0) {
    throw new Error('Default template screen should be the empty baseline frame, not populated sample app content.');
  }
}

async function assertScreenPlaceholderEmpty(page: import('playwright').Page): Promise<void> {
  const projectedSections = await page.locator('.board-screens .screen-section-projection').count();
  if (projectedSections !== 0) {
    throw new Error(`Default template screen should stay visually empty; received ${projectedSections} rendered section projections.`);
  }

  const bodyChildCount = await page.locator('.board-screens .screen-template-body').first().evaluate(element => element.children.length);
  if (bodyChildCount !== 0) {
    throw new Error(`Default template screen body should stay empty, received ${bodyChildCount} child nodes.`);
  }

  const fullAppContent = await page
    .locator('.board-screens .mood-scale, .board-screens .appointment-card, .board-screens .insight-card, .board-screens .bottom-sheet')
    .count();
  if (fullAppContent !== 0) {
    throw new Error('Default template screen should stay empty and avoid full app content rendering.');
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

async function writeReviewArtifacts(page: import('playwright').Page): Promise<void> {
  const manifest = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.manifest);
  const styleEvidence = await page.evaluate(() => window.__BLUEPRINT_REVIEW__?.styleEvidence);

  if (!manifest || !styleEvidence) {
    throw new Error('Canvas should expose review manifest and style evidence artifacts.');
  }
  if (manifest.projectId !== 'starter-app' || manifest.boundaries.length < 1) {
    throw new Error(`Review manifest should include project and visible boundary metadata, received ${JSON.stringify(manifest)}`);
  }
  if (styleEvidence.projectId !== 'starter-app' || styleEvidence.boundaries.length < 1) {
    throw new Error(`Style evidence should include boundary-scoped canvas evidence, received ${JSON.stringify(styleEvidence)}`);
  }

  const { writeFile } = await import('node:fs/promises');
  const screenshotPath = path.join(screenshotRoot, 'blueprint-screens-desktop.png');
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

  await writeFile(path.join(reviewManifestRoot, 'screens-review-manifest.json'), `${JSON.stringify(capturedManifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(styleEvidenceRoot, 'screens-style-evidence.json'), `${JSON.stringify(capturedStyleEvidence, null, 2)}\n`, 'utf8');
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

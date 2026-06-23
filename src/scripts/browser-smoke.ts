import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const screenshotRoot = '.agent-workstream/2026-06-23-01-blueprint-platform-foundation/artifacts/screenshots';

async function main(): Promise<void> {
  await mkdir(screenshotRoot, { recursive: true });
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
    await page.screenshot({ path: path.join(screenshotRoot, 'blueprint-screens-desktop.png'), fullPage: true });
    await assertFrameTools(page);

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(`${url}?board=screens`);
    await mobile.waitForSelector('.board-screens .frame[data-boundary-kind="screen"]', { timeout: 10000 });
    await mobile.screenshot({ path: path.join(screenshotRoot, 'blueprint-screens-mobile.png'), fullPage: true });

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

  const inputRows = await page.locator('.input-state-matrix .mx-row').count();
  if (inputRows < 6) {
    throw new Error(`Input primitive should show variant x state rows, received ${inputRows}.`);
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

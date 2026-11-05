import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright';
import { loadProjectFromFs } from '../../src/core/load';
import { type BlueprintServeHandle, serveBlueprint } from '../../src/mcp/operations';
import { compilePrototypeDocument } from '../../src/prototype/compiler';

const PAGE_ID = 'mobile';
const HOOK_PATH = path.resolve('dist/mcp/codex-activity-hook.js');
// A box in the change layer draws 5 px outside its edges, 2 px of outline and a 3 px offset, so a pixel within 5 px is inside what a person sees.
const OUTLINE_TOLERANCE_PX = 5;
const SETTLE_MS = 1500;

interface Outline {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FrameMarks {
  frameMark: boolean;
  outlines: Outline[];
  rebuilt: boolean;
}

interface PixelDiff {
  changed: number;
  outside: number;
  untouched: number[];
}

interface Row {
  id: string;
  title: string;
  file: string;
  edit: (text: string) => string;
  pixels: string[];
  agent?: boolean;
  label?: string;
  outlineOn?: { screenId: string; selector: string };
  /** The frames whose whole area changed, so that the frame mark is the only mark. */
  frameOnly?: string[];
  /** The frames whose hash changes without a change in pixels, which rebuild and show no mark. */
  unpainted?: string[];
  kept?: string[];
  appearance?: string;
}

const BASE_SCREEN_CSS = `padding: var(--app-space-6);
  min-height: 100vh;
  box-sizing: border-box;
  background: var(--app-color-background);
  color: var(--app-color-foreground);
  font: var(--app-type-body);
`;

const GUARD_SCREENS: Array<{ id: string; name: string; section: string; uses: Array<{ kind: 'primitive' | 'component'; id: string }>; html: string; css?: string; plain?: boolean; assetRefs?: string[] }> = [
  {
    id: 'audit-copy',
    name: 'Copy only',
    section: 'intro',
    uses: [],
    html: '<h1 class="audit-copy__title">Welcome back</h1>\n    <p class="audit-copy__body">Your plan renews next week.</p>',
    css: '.audit-copy__title {\n  font: var(--app-type-title);\n}\n'
  },
  {
    id: 'audit-button',
    name: 'One button',
    section: 'actions',
    uses: [{ kind: 'primitive', id: 'button' }],
    html: '<blueprint-use kind="primitive" ref="button" state="normal"><span slot="label">Save</span></blueprint-use>'
  },
  {
    id: 'audit-disabled',
    name: 'Disabled button',
    section: 'actions',
    uses: [{ kind: 'primitive', id: 'button' }],
    html: '<blueprint-use kind="primitive" ref="button" state="disabled"><span slot="label">Save</span></blueprint-use>'
  },
  {
    id: 'audit-cluster',
    name: 'Action cluster',
    section: 'footer',
    uses: [{ kind: 'component', id: 'action-cluster' }],
    html: '<blueprint-use kind="component" ref="action-cluster"></blueprint-use>'
  },
  {
    id: 'audit-separator',
    name: 'Separator',
    section: 'divider',
    uses: [{ kind: 'primitive', id: 'separator' }],
    html: '<blueprint-use kind="primitive" ref="separator"></blueprint-use>'
  },
  {
    id: 'audit-outer',
    name: 'Outer token',
    section: 'card',
    uses: [],
    html: '<div class="audit-outer__card">Card</div>',
    css: '.audit-outer__card {\n  height: 80px;\n  box-shadow: var(--app-shadow-audit-outer);\n}\n'
  },
  {
    id: 'audit-svg',
    name: 'SVG attribute',
    section: 'art',
    uses: [],
    html: '<svg class="audit-svg__art" viewBox="0 0 100 100" width="100" height="100" aria-hidden="true"><rect x="10" y="10" width="80" height="80" fill="var(--app-color-audit-art)"></rect></svg>'
  },
  {
    id: 'audit-before',
    name: 'Before rule',
    section: 'badge',
    uses: [],
    html: '<div class="audit-before__host">Badge</div>',
    css: '.audit-before__host {\n  position: relative;\n  height: 80px;\n}\n\n.audit-before__host::before {\n  content: "";\n  position: absolute;\n  inset: 8px;\n  background: var(--app-color-secondary);\n}\n'
  },
  {
    id: 'audit-hover',
    name: 'Hover rule',
    section: 'hover',
    uses: [],
    html: '<div class="audit-hover__card">Card</div>',
    css: '.audit-hover__card {\n  height: 80px;\n}\n\n.audit-hover__card:hover {\n  background: var(--app-color-audit-hover);\n}\n'
  },
  {
    id: 'audit-letter',
    name: 'First letter',
    section: 'letter',
    uses: [],
    html: '<p class="audit-letter__copy">Letter</p>',
    css: '.audit-letter__copy::first-letter {\n  color: var(--app-color-audit-letter);\n}\n'
  },
  {
    id: 'audit-move',
    name: 'Moved box',
    section: 'move',
    uses: [],
    html: '<div class="audit-move__stage"><div class="audit-move__box"></div></div>',
    css: '.audit-move__stage {\n  position: relative;\n  height: 120px;\n}\n\n.audit-move__box {\n  position: absolute;\n  left: 10px;\n  top: 10px;\n  width: 40px;\n  height: 40px;\n  background: #7c3aed;\n}\n'
  },
  {
    id: 'audit-safe',
    name: 'Safe area',
    section: 'safe',
    uses: [],
    html: '<div class="audit-safe__bar"></div>',
    css: '.audit-safe__bar {\n  height: 20px;\n  margin-top: var(--blueprint-safe-area-top);\n  background: #7c3aed;\n}\n'
  },
  {
    id: 'audit-gone',
    name: 'Removed token',
    section: 'gone',
    uses: [],
    html: '<div class="audit-gone__card"></div>',
    css: '.audit-gone__card {\n  height: 80px;\n  background: var(--app-audit-gone, #be123c);\n}\n'
  },
  {
    id: 'audit-asset',
    name: 'Asset image',
    section: 'asset',
    uses: [],
    html: '<img class="audit-asset__art" src="../assets/audit.svg" alt="" width="40" height="40">',
    assetRefs: ['prototype/assets/audit.svg']
  },
  {
    id: 'audit-plain',
    name: 'Plain text',
    section: 'plain',
    uses: [],
    html: '<p>Plain</p>',
    plain: true
  }
];

const ROWS: Row[] = [
  {
    id: 'E1',
    title: 'a token that some frames read marks only the frames whose pixels change',
    file: 'tokens.json',
    edit: text => setToken(text, 'primary', '#1d4ed8'),
    pixels: ['audit-button', 'audit-cluster', 'audit-disabled'],
    label: 'Color roles'
  },
  {
    id: 'E2',
    title: 'component CSS marks only the frames of that component',
    file: 'prototype/components/action-cluster.css',
    edit: text => mustReplace(text, '  align-items: center;\n', '  align-items: center;\n  justify-content: center;\n'),
    pixels: ['audit-cluster']
  },
  {
    id: 'E3',
    title: 'screen copy marks only that frame',
    file: 'prototype/screens/audit-copy.html',
    edit: text => mustReplace(text, 'Welcome back', 'Welcome home'),
    pixels: ['audit-copy']
  },
  {
    id: 'E4',
    title: 'primitive state CSS marks only the frame that shows that state',
    file: 'prototype/primitives/button.css',
    edit: text => mustReplace(text, '  cursor: not-allowed;\n  opacity: 0.5;\n', '  cursor: not-allowed;\n  opacity: 0.3;\n'),
    pixels: ['audit-disabled']
  },
  {
    id: 'E5',
    title: 'a token edit through the agent hook keeps the board, shows no glow, and marks as E1 does',
    file: 'tokens.json',
    edit: text => setToken(text, 'primary', '#b91c1c'),
    pixels: ['audit-button', 'audit-cluster', 'audit-disabled'],
    agent: true,
    label: 'Color roles'
  },
  {
    id: 'E6',
    title: 'a primitive hint marks and rebuilds no frame, and the change label stays',
    file: 'primitives.json',
    edit: text => {
      const primitives = JSON.parse(text);
      const button = primitives.primitives.find((candidate: { id: string }) => candidate.id === 'button');
      button.implementationHints = [...button.implementationHints, 'Use one primary button in each region.'];
      return `${JSON.stringify(primitives, null, 2)}\n`;
    },
    pixels: [],
    label: 'Button'
  },
  {
    id: 'E7',
    title: 'a token that only another token reads marks only the frames that read the outer token',
    file: 'tokens.json',
    edit: text => setToken(text, 'audit-inner', '#0f766e'),
    pixels: ['audit-outer'],
    label: 'Color roles'
  },
  {
    id: 'E8',
    title: 'a token that no frame reads marks and rebuilds no frame',
    file: 'tokens.json',
    edit: text => setToken(text, 'audit-unused', '#0f766e'),
    pixels: [],
    label: 'Color roles'
  },
  {
    id: 'E9',
    title: 'a token that only an SVG attribute reads marks only that frame',
    file: 'tokens.json',
    edit: text => setToken(text, 'audit-art', '#0f766e'),
    pixels: ['audit-svg'],
    label: 'Color roles'
  },
  {
    id: 'E10',
    title: 'CSS that changes only a ::before rule marks that frame with an outline on the host element',
    file: 'prototype/screens/audit-before.css',
    edit: text => mustReplace(text, 'background: var(--app-color-secondary);', 'background: var(--app-color-destructive);'),
    pixels: ['audit-before'],
    outlineOn: { screenId: 'audit-before', selector: '.audit-before__host' }
  },
  {
    id: 'X1',
    title: 'a token that a screen root passes to its text marks the text, and not the root',
    file: 'tokens.json',
    edit: text => setToken(text, 'foreground', '#7c2d12'),
    pixels: ['audit-before', 'audit-copy', 'audit-hover', 'audit-letter', 'audit-outer'],
    unpainted: ['audit-asset', 'audit-button', 'audit-cluster', 'audit-disabled', 'audit-gone', 'audit-move', 'audit-safe', 'audit-separator', 'audit-svg'],
    label: 'Color roles'
  },
  {
    id: 'X2',
    title: 'a token that paints the whole frame marks the frame, and a frame that does not read it keeps its document and shows the new appearance',
    file: 'tokens.json',
    edit: text => setToken(text, 'background', '#0b1220'),
    pixels: ['audit-asset', 'audit-before', 'audit-button', 'audit-cluster', 'audit-copy', 'audit-disabled', 'audit-gone', 'audit-hover', 'audit-letter', 'audit-move', 'audit-outer', 'audit-safe', 'audit-separator', 'audit-svg', 'home'],
    frameOnly: ['audit-asset', 'audit-before', 'audit-button', 'audit-cluster', 'audit-copy', 'audit-disabled', 'audit-gone', 'audit-hover', 'audit-letter', 'audit-move', 'audit-outer', 'audit-safe', 'audit-separator', 'audit-svg', 'home'],
    kept: ['audit-plain'],
    appearance: 'dark',
    label: 'Color roles'
  },
  {
    id: 'X3',
    title: 'a token that only a :hover rule reads rebuilds that frame and marks no frame',
    file: 'tokens.json',
    edit: text => setToken(text, 'audit-hover', '#be123c'),
    pixels: [],
    unpainted: ['audit-hover'],
    label: 'Color roles'
  },
  {
    id: 'X4',
    title: 'new bytes under one asset path mark the frame that shows the asset',
    file: 'prototype/assets/audit.svg',
    edit: text => mustReplace(text, '#7c3aed', '#be123c'),
    pixels: ['audit-asset'],
    label: 'Asset image'
  },
  {
    id: 'X5',
    title: 'a token that paints only through a part that the element diff cannot read keeps the mark of the hash',
    file: 'tokens.json',
    edit: text => setToken(text, 'audit-letter', '#be123c'),
    pixels: ['audit-letter'],
    frameOnly: ['audit-letter'],
    label: 'Color roles'
  },
  {
    id: 'X6',
    title: 'a box that moves is outlined at the place that it leaves and at the place that it reaches',
    file: 'prototype/screens/audit-move.css',
    edit: text => mustReplace(mustReplace(text, 'left: 10px;', 'left: 200px;'), 'top: 10px;', 'top: 60px;'),
    pixels: ['audit-move'],
    label: 'Moved box'
  },
  {
    id: 'X7',
    title: 'a removed token group that a frame reads through a fallback shows the bar and marks that frame',
    file: 'tokens.json',
    edit: text => {
      const tokens = JSON.parse(text) as { tokenGroups: Array<{ id: string }> };
      tokens.tokenGroups = tokens.tokenGroups.filter(group => group.id !== 'audit-gone');
      return `${JSON.stringify(tokens, null, 2)}\n`;
    },
    pixels: ['audit-gone'],
    label: 'audit-gone'
  }
];

const AUDIT_ASSET = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#7c3aed"/></svg>\n';

function mustReplace(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), `The edit anchor is missing: ${from}`);
  return text.replace(from, to);
}

function setToken(text: string, tokenId: string, value: string): string {
  const tokens = JSON.parse(text);
  const token = tokens.tokenGroups.flatMap((group: { tokens: Array<{ id: string; value: string }> }) => group.tokens)
    .find((candidate: { id: string }) => candidate.id === tokenId);
  assert.ok(token, `The token ${tokenId} is missing.`);
  token.value = value;
  return `${JSON.stringify(tokens, null, 2)}\n`;
}

async function writeGuardProject(project: string): Promise<void> {
  await cp(path.resolve('starter/design/blueprint'), project, { recursive: true });
  const screensPath = path.join(project, 'screens.json');
  const screens = JSON.parse(await readFile(screensPath, 'utf8'));
  for (const screen of GUARD_SCREENS) {
    screens.screens.push({
      id: screen.id,
      name: screen.name,
      description: `${screen.name}.`,
      framePresetId: 'phone',
      page: PAGE_ID,
      styleRefs: [],
      styleEvidence: [],
      notes: [],
      prototypeOnly: true,
      implementationHints: [],
      implementationTargets: [],
      prototype: {
        source: `prototype/screens/${screen.id}.html`,
        styles: [`prototype/screens/${screen.id}.css`],
        assetRefs: screen.assetRefs ?? [],
        states: ['default'],
        reviewConditions: [{ id: 'phone-default', framePresetId: 'phone', state: 'default' }],
        renderedUses: screen.uses
      },
      sections: [{
        id: screen.section,
        name: screen.section,
        description: `The ${screen.section}.`,
        styleRefs: [],
        styleEvidence: [],
        uses: screen.uses.map(use => ({ ...use, reason: 'The guard needs it.' })),
        prototypeOnly: false,
        notes: [],
        implementationHints: [],
        implementationTargets: []
      }]
    });
    await writeFile(path.join(project, 'prototype/screens', `${screen.id}.html`),
      `<main data-blueprint-screen="${screen.id}" data-blueprint-state="default">\n  <section data-blueprint-section="${screen.section}">\n    ${screen.html}\n  </section>\n</main>\n`);
    await writeFile(path.join(project, 'prototype/screens', `${screen.id}.css`),
      screen.plain ? '' : `[data-blueprint-screen="${screen.id}"] {\n  ${BASE_SCREEN_CSS}}\n\n${screen.css ?? ''}`);
  }
  await writeFile(screensPath, `${JSON.stringify(screens, null, 2)}\n`);
  await mkdir(path.join(project, 'prototype/assets'), { recursive: true });
  await writeFile(path.join(project, 'prototype/assets/audit.svg'), AUDIT_ASSET);

  const tokensPath = path.join(project, 'tokens.json');
  const tokens = JSON.parse(await readFile(tokensPath, 'utf8'));
  const group = (id: string): { tokens: unknown[] } => tokens.tokenGroups.find((candidate: { id: string }) => candidate.id === id);
  const token = (id: string, type: string, value: string, styleRef: string): unknown => ({ id, name: id, type, value, description: `The ${id} token of the guard.`, styleRef });
  group('color').tokens.push(
    token('audit-inner', 'color', '#7c3aed', '--app-color-audit-inner'),
    token('audit-unused', 'color', '#7c3aed', '--app-color-audit-unused'),
    token('audit-art', 'color', '#7c3aed', '--app-color-audit-art'),
    token('audit-hover', 'color', '#7c3aed', '--app-color-audit-hover'),
    token('audit-letter', 'color', '#7c3aed', '--app-color-audit-letter')
  );
  group('shape').tokens.push(token('shadow-audit-outer', 'shadow', '0 2px 0 var(--app-color-audit-inner)', '--app-shadow-audit-outer'));
  tokens.tokenGroups.push({ ...group('color'), id: 'audit-gone', name: 'audit-gone', tokens: [token('audit-gone', 'color', '#0f766e', '--app-audit-gone')] });
  await writeFile(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`);
}

async function captureDocument(page: Page, html: string, width: number, height: number): Promise<string> {
  await page.setViewportSize({ width, height });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return (await page.screenshot({ animations: 'disabled' })).toString('base64');
}

async function pixelDiff(page: Page, before: string, next: string, outlines: Outline[] = []): Promise<PixelDiff> {
  return page.evaluate(async ({ before: first, next: second, outlines: boxes, tolerance }) => {
    const pixels = async (base64: string): Promise<ImageData> => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const a = await pixels(first);
    const b = await pixels(second);
    if (a.width !== b.width || a.height !== b.height) return { changed: a.width * a.height, outside: a.width * a.height, untouched: boxes.map((_box, index) => index) };
    const touched = boxes.map(() => false);
    let changed = 0;
    let outside = 0;
    for (let index = 0; index < a.data.length; index += 4) {
      if (a.data[index] === b.data[index] && a.data[index + 1] === b.data[index + 1] && a.data[index + 2] === b.data[index + 2] && a.data[index + 3] === b.data[index + 3]) continue;
      changed += 1;
      const x = (index / 4) % a.width;
      const y = Math.floor(index / 4 / a.width);
      let inside = false;
      boxes.forEach((box, boxIndex) => {
        if (x + 1 >= box.left - tolerance && x <= box.left + box.width + tolerance && y + 1 >= box.top - tolerance && y <= box.top + box.height + tolerance) {
          inside = true;
          touched[boxIndex] = true;
        }
      });
      if (!inside) outside += 1;
    }
    return { changed, outside, untouched: touched.flatMap((seen, boxIndex) => seen ? [] : [boxIndex]) };
  }, { before, next, outlines, tolerance: OUTLINE_TOLERANCE_PX });
}

describe('the change highlight of the canvas', () => {
  let root: string;
  let project: string;
  let served: BlueprintServeHandle;
  let browser: Browser;
  let canvas: Page;
  let render: Page;
  let compare: Page;
  let generation = 0;

  async function captureTruth(): Promise<Map<string, { png: string; width: number; height: number }>> {
    const bundle = await loadProjectFromFs(project);
    const frames = new Map<string, { png: string; width: number; height: number }>();
    for (const screen of bundle.screens.screens.filter(candidate => candidate.page === PAGE_ID)) {
      const condition = screen.prototype.reviewConditions[0];
      const preset = bundle.manifest.framePresets.find(candidate => candidate.id === condition.framePresetId);
      assert.ok(preset);
      const html = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: screen.id }, state: condition.state, framePreset: preset }).html;
      frames.set(screen.id, { png: await captureDocument(render, html, preset.width, preset.height), width: preset.width, height: preset.height });
    }
    return frames;
  }

  /** The review server refuses a linked asset to a page of another origin, and a document with an old asset URL keeps that URL here and fails the compare. */
  async function withCurrentAssetInline(html: string): Promise<string> {
    const bytes = await readFile(path.join(project, 'prototype/assets/audit.svg'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return html.replaceAll(`${new URL(served.url).origin}/__blueprint/assets/${sha256}`, `data:image/svg+xml;base64,${bytes.toString('base64')}`);
  }

  function stampFrames(stamp: number): Promise<void> {
    return canvas.evaluate(value => {
      for (const slot of document.querySelectorAll<HTMLElement>('.frame-slot[data-live-frame-key]')) {
        slot.dataset.guardStamp = String(value);
        const iframe = slot.querySelector<HTMLIFrameElement>('iframe.canonical-prototype-iframe');
        if (iframe) iframe.dataset.guardStamp = String(value);
      }
    }, stamp);
  }

  function readMarks(stamp: number): Promise<Record<string, FrameMarks>> {
    return canvas.evaluate(value => {
      const marks: Record<string, { frameMark: boolean; outlines: Array<{ left: number; top: number; width: number; height: number }>; rebuilt: boolean }> = {};
      for (const slot of document.querySelectorAll<HTMLElement>('.frame-slot[data-live-frame-key]')) {
        const frame = slot.querySelector<HTMLElement>('.frame');
        if (!frame?.dataset.screenId) continue;
        const iframe = slot.querySelector<HTMLIFrameElement>('iframe.canonical-prototype-iframe');
        marks[frame.dataset.screenId] = {
          frameMark: frame.classList.contains('bp-chrome-changed'),
          outlines: [...slot.querySelectorAll<HTMLElement>('.bp-chrome-change-layer .bp-chrome-change-box')].map(box => ({
            left: Number.parseFloat(box.style.left),
            top: Number.parseFloat(box.style.top),
            width: Number.parseFloat(box.style.width),
            height: Number.parseFloat(box.style.height)
          })),
          rebuilt: slot.dataset.guardStamp !== String(value) || iframe?.dataset.guardStamp !== String(value)
        };
      }
      return marks;
    }, stamp);
  }

  async function canvasDocuments(): Promise<Map<string, string>> {
    const documents = await canvas.evaluate(() => [...document.querySelectorAll<HTMLElement>('.frame-slot[data-live-frame-key]')].map(slot => [
      slot.querySelector<HTMLElement>('.frame')?.dataset.screenId ?? '',
      slot.querySelector<HTMLIFrameElement>('iframe.canonical-prototype-iframe')?.srcdoc ?? ''
    ] as const));
    return new Map(documents);
  }

  function runHook(input: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK_PATH], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr || `The hook exited with ${code}.`)));
      child.stdin.end(JSON.stringify(input));
    });
  }

  /** Playwright opens no CDP session on a worker, so this call reaches the worker target through the browser session. */
  async function frameOutputWorkerHeap(): Promise<string> {
    const session = await browser.newBrowserCDPSession();
    try {
      const { targetInfos } = await session.send('Target.getTargets');
      const canvasPageUrl = canvas.url();
      const owners = targetInfos.filter(target => target.type === 'page' && target.url === canvasPageUrl).map(target => target.targetId);
      const worker = targetInfos.find(target => target.type === 'worker' && target.url.includes('frame-output-worker') && (target.openerId === undefined || owners.includes(target.openerId)));
      assert.ok(worker, 'The frame output worker must run, or this check proves nothing.');
      const { sessionId } = await session.send('Target.attachToTarget', { targetId: worker.targetId, flatten: false });
      let heap = '';
      let nextId = 1;
      const waiting = new Map<number, () => void>();
      session.on('Target.receivedMessageFromTarget', ({ message }) => {
        const parsed = JSON.parse(message) as { id?: number; method?: string; params?: { chunk: string } };
        if (parsed.method === 'HeapProfiler.addHeapSnapshotChunk') heap += parsed.params?.chunk ?? '';
        if (parsed.id !== undefined) {
          waiting.get(parsed.id)?.();
          waiting.delete(parsed.id);
        }
      });
      const send = (method: string, params: Record<string, unknown> = {}): Promise<void> => new Promise(resolve => {
        const id = nextId;
        nextId += 1;
        waiting.set(id, resolve);
        void session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
      });
      await send('HeapProfiler.enable');
      await send('HeapProfiler.collectGarbage');
      await send('HeapProfiler.collectGarbage');
      await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      return heap;
    } finally {
      await session.detach();
    }
  }

  async function dismissChanges(): Promise<void> {
    const dismiss = canvas.locator('.bp-chrome-changes-dismiss');
    if (await dismiss.isVisible()) {
      await dismiss.click();
      await canvas.locator('.bp-chrome-changes').waitFor({ state: 'hidden' });
    }
  }

  async function waitForAppliedChange(): Promise<void> {
    await canvas.waitForFunction(() => {
      const bar = document.querySelector<HTMLElement>('.bp-chrome-changes');
      return Boolean(bar && !bar.hidden && bar.dataset.marks !== 'pending')
        && document.querySelectorAll('.bp-chrome-live-frame-updating').length === 0;
    }, undefined, { timeout: 60_000 });
    await canvas.waitForTimeout(SETTLE_MS);
    await canvas.waitForFunction(() => document.querySelector<HTMLElement>('.bp-chrome-changes')?.dataset.marks !== 'pending', undefined, { timeout: 60_000 });
  }

  async function applyRow(row: Row): Promise<void> {
    const filePath = path.join(project, row.file);
    const nextText = row.edit(await readFile(filePath, 'utf8'));
    if (!row.agent) {
      await writeFile(filePath, nextText, 'utf8');
      return;
    }
    const base = { session_id: 'guard-session', turn_id: `turn-${row.id}`, tool_name: 'functions.exec', tool_use_id: `tool-${row.id}`, cwd: root };
    const toolInput = { project, patch: `*** Update File: design/blueprint/${row.file}` };
    await runHook({ ...base, hook_event_name: 'PreToolUse', tool_input: toolInput });
    await writeFile(filePath, nextText, 'utf8');
    await canvas.waitForTimeout(300);
    await runHook({ ...base, hook_event_name: 'PostToolUse', tool_input: toolInput, tool_response: { isError: false } });
  }

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'blueprint-change-highlight-'));
    project = path.join(root, 'design/blueprint');
    await writeGuardProject(project);
    served = await serveBlueprint({ project, port: 0 });
    // A heap snapshot cuts each string at 1024 characters by default, and that limit hides a marker deep in a document.
    browser = await chromium.launch({ args: ['--js-flags=--heap-snapshot-string-limit=100000000', '--disable-gpu-rasterization', '--disable-partial-raster', '--num-raster-threads=1', '--disable-lcd-text', '--disable-skia-runtime-opts'] });
    canvas = await browser.newPage({ viewport: { width: 1200, height: 9000 } });
    render = await browser.newPage();
    compare = await browser.newPage();
    for (const page of [canvas, render, compare]) await page.addInitScript({ content: 'globalThis.__name = target => target;' });
    await compare.evaluate('globalThis.__name = target => target');
    await canvas.goto(`${served.url}?board=screens&page=${PAGE_ID}`);
    const frames = GUARD_SCREENS.length + 1;
    await canvas.waitForFunction(count => document.querySelectorAll('.frame-slot iframe.canonical-prototype-iframe').length === count, frames, { timeout: 30_000 });
    await canvas.evaluate(() => {
      const seen = { glow: false, sections: new Set<string>() };
      (globalThis as unknown as { guardSeen: typeof seen }).guardSeen = seen;
      const scan = (): void => {
        if (document.querySelector('.bp-agent-project-focus, [data-board-root].bp-chrome-agent-focus, .bp-chrome-viewport.bp-chrome-agent-focus')) seen.glow = true;
        const section = document.querySelector<HTMLElement>('.bp-chrome-section-button[aria-pressed="true"]')?.dataset.section;
        if (section) seen.sections.add(section);
      };
      new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-pressed'] });
      scan();
    });
    await canvas.waitForTimeout(SETTLE_MS);
  });

  after(async () => {
    await browser?.close();
    await served?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('captures each frame with stable pixels', async () => {
    const first = await captureTruth();
    const second = await captureTruth();
    for (const [screenId, frame] of first) {
      const diff = await pixelDiff(compare, frame.png, second.get(screenId)?.png ?? '');
      assert.equal(diff.changed, 0, `${screenId} changed between 2 captures of one source.`);
    }
  });

  for (const row of ROWS) {
    it(`${row.id}: ${row.title}`, async () => {
      await dismissChanges();
      generation += 1;
      const stamp = generation;
      const before = await captureTruth();
      await stampFrames(stamp);
      await canvas.evaluate(() => (globalThis as unknown as { guardSeen: { glow: boolean; sections: Set<string> } }).guardSeen.sections.clear());
      await applyRow(row);
      await waitForAppliedChange();
      const next = await captureTruth();
      const marks = await readMarks(stamp);
      const shown = await canvasDocuments();

      const diffs = new Map<string, PixelDiff>();
      for (const [screenId, frame] of next) {
        diffs.set(screenId, await pixelDiff(compare, before.get(screenId)?.png ?? '', frame.png, marks[screenId]?.outlines ?? []));
      }
      const changedFrames = [...diffs].filter(([, diff]) => diff.changed > 0).map(([screenId]) => screenId).sort();
      assert.deepEqual(changedFrames, [...row.pixels].sort(), `The edit of ${row.id} changed other pixels than the row expects.`);

      const markedFrames = Object.entries(marks).filter(([, mark]) => mark.frameMark || mark.outlines.length > 0).map(([screenId]) => screenId).sort();
      assert.deepEqual(markedFrames, changedFrames, 'The marked frames differ from the frames whose pixels changed.');

      const rebuiltOutside = Object.entries(marks).filter(([screenId, mark]) => mark.rebuilt && !markedFrames.includes(screenId) && !row.unpainted?.includes(screenId)).map(([screenId]) => screenId);
      assert.deepEqual(rebuiltOutside, [], 'A frame outside the marked set rebuilt.');

      for (const screenId of row.unpainted ?? []) {
        assert.equal(marks[screenId]?.rebuilt, true, `${screenId} reads the edit, so it must rebuild.`);
      }

      for (const screenId of changedFrames) {
        const diff = diffs.get(screenId) as PixelDiff;
        if (row.frameOnly?.includes(screenId)) {
          assert.deepEqual(marks[screenId]?.outlines, [], `${screenId} must show only the frame mark.`);
          assert.equal(marks[screenId]?.frameMark, true, `${screenId} must show the frame mark.`);
          continue;
        }
        assert.equal(marks[screenId]?.frameMark, false, `${screenId} has outlines, so it must not show the frame mark.`);
        assert.ok((marks[screenId]?.outlines.length ?? 0) > 0, `${screenId} changed, but it has no outline.`);
        assert.equal(diff.outside, 0, `${screenId} has ${diff.outside} of ${diff.changed} changed pixels outside each outline.`);
        assert.deepEqual(diff.untouched, [], `${screenId} has an outline that touches no changed pixel.`);
      }

      for (const [screenId, frame] of next) {
        const stale = await pixelDiff(compare, frame.png, await captureDocument(render, await withCurrentAssetInline(shown.get(screenId) ?? ''), frame.width, frame.height));
        assert.equal(stale.changed, 0, `${screenId} shows a stale document on the canvas.`);
      }

      for (const screenId of row.kept ?? []) {
        assert.equal(marks[screenId]?.rebuilt, false, `${screenId} must keep its document.`);
      }

      if (row.appearance) {
        const appearances = await canvas.evaluate(() => [...document.querySelectorAll<HTMLElement>('.frame[data-screen-id]')].map(frame => frame.dataset.appearance));
        assert.ok(appearances.every(appearance => appearance === row.appearance), `The frame appearances are ${appearances.join(', ')}.`);
      }

      if (row.label) {
        const label = await canvas.locator('.bp-chrome-changes-label').textContent();
        assert.ok(label?.includes(row.label), `The change label is "${label}".`);
      }

      if (row.outlineOn) {
        const { screenId, selector } = row.outlineOn;
        const frame = next.get(screenId);
        assert.ok(frame);
        const bundle = await loadProjectFromFs(project);
        const screen = bundle.screens.screens.find(candidate => candidate.id === screenId);
        assert.ok(screen);
        const preset = bundle.manifest.framePresets.find(candidate => candidate.id === screen.framePresetId);
        await captureDocument(render, compilePrototypeDocument({ bundle, target: { kind: 'screen', id: screenId }, state: 'default', framePreset: preset }).html, frame.width, frame.height);
        const host = await render.evaluate(target => {
          const box = document.querySelector(target)?.getBoundingClientRect();
          return box ? { left: box.left, top: box.top, width: box.width, height: box.height } : undefined;
        }, selector);
        assert.deepEqual(marks[screenId]?.outlines, [host], 'The outline is not on the host element.');
      }

      if (row.agent) {
        const seen = await canvas.evaluate(() => {
          const { glow, sections } = (globalThis as unknown as { guardSeen: { glow: boolean; sections: Set<string> } }).guardSeen;
          return { glow, sections: [...sections] };
        });
        assert.equal(seen.glow, false, 'The agent focus showed a glow on the board.');
        assert.ok(seen.sections.every(section => section === 'screens'), `The canvas left the Screens board: ${seen.sections.join(', ')}`);
        assert.equal(new URL(canvas.url()).searchParams.get('board'), 'screens');
      }
    });
  }

  it('rebuilds a frame when a later edit takes it back to the text of the baseline', async () => {
    await dismissChanges();
    const file = path.join(project, 'prototype/screens/audit-copy.html');
    const original = await readFile(file, 'utf8');
    const copyShown = (text: string): Promise<unknown> => canvas.waitForFunction(expected => (
      document.querySelector<HTMLIFrameElement>('.frame[data-screen-id="audit-copy"] iframe.canonical-prototype-iframe')?.srcdoc.includes(expected)
    ), text, { timeout: 20_000 });
    await writeFile(file, original.replace('Your plan renews', 'Your plan ends'), 'utf8');
    await copyShown('Your plan ends');
    await writeFile(file, original, 'utf8');
    await copyShown('Your plan renews');
    await canvas.locator('.bp-chrome-changes').waitFor({ state: 'hidden' });
  });

  it('marks a frame off screen, and computes its outlines when it mounts', async () => {
    await dismissChanges();
    const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
    try {
      await page.addInitScript({ content: 'globalThis.__name = target => target;' });
      await page.goto(`${served.url}?board=screens&page=${PAGE_ID}`);
      const slot = '.frame-slot:has(.frame[data-screen-id="audit-svg"])';
      await page.locator(`${slot} .bp-chrome-frame-placeholder`).waitFor({ state: 'attached', timeout: 30_000 });
      await page.waitForTimeout(SETTLE_MS);
      assert.equal(await page.locator(`${slot} iframe.canonical-prototype-iframe`).count(), 0);
      const tokens = path.join(project, 'tokens.json');
      await writeFile(tokens, setToken(await readFile(tokens, 'utf8'), 'audit-art', '#be123c'), 'utf8');
      await page.locator(`${slot} .frame.bp-chrome-changed`).waitFor({ state: 'attached', timeout: 20_000 });
      assert.equal(await page.locator(`${slot} .bp-chrome-change-box`).count(), 0);
      await page.setViewportSize({ width: 1200, height: 6000 });
      await page.locator(`${slot} .bp-chrome-change-box`).first().waitFor({ state: 'attached', timeout: 20_000 });
      await page.waitForFunction(selector => !document.querySelector(`${selector} .frame.bp-chrome-changed`), slot);
    } finally {
      await page.close();
    }
    await waitForAppliedChange();
    await dismissChanges();
  });

  it('shows no mark on a frame off screen whose pixels do not change', async () => {
    await dismissChanges();
    const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
    try {
      await page.addInitScript({ content: 'globalThis.__name = target => target;' });
      await page.goto(`${served.url}?board=screens&page=${PAGE_ID}`);
      const slot = '.frame-slot:has(.frame[data-screen-id="audit-hover"])';
      await page.locator(`${slot} .bp-chrome-frame-placeholder`).waitFor({ state: 'attached', timeout: 30_000 });
      await page.waitForTimeout(SETTLE_MS);
      assert.equal(await page.locator(`${slot} iframe.canonical-prototype-iframe`).count(), 0);
      const tokens = path.join(project, 'tokens.json');
      const current = JSON.parse(await readFile(tokens, 'utf8')).tokenGroups.flatMap((group: { tokens: Array<{ id: string; value: string }> }) => group.tokens).find((token: { id: string }) => token.id === 'audit-hover').value;
      await writeFile(tokens, setToken(await readFile(tokens, 'utf8'), 'audit-hover', current === '#0f766e' ? '#b45309' : '#0f766e'), 'utf8');
      await page.locator('.bp-chrome-changes').waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.bp-chrome-changes')?.dataset.marks === 'settled', undefined, { timeout: 60_000 });
      assert.equal(await page.locator('.frame.bp-chrome-changed').count(), 0);
      assert.equal(await page.locator('.bp-chrome-change-box').count(), 0);
    } finally {
      await page.close();
    }
    await waitForAppliedChange();
    await dismissChanges();
  });

  const SAMPLE_MARKS = `
    globalThis.guardFewestMarks = Infinity;
    globalThis.guardMarksSample = setInterval(() => {
      const marks = document.querySelectorAll('.frame.bp-chrome-changed, .bp-chrome-change-box').length;
      globalThis.guardFewestMarks = Math.min(globalThis.guardFewestMarks, marks);
    }, 5);
  `;

  async function openGuardPage(viewportHeight = 9000): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1200, height: viewportHeight } });
    await page.addInitScript({ content: 'globalThis.__name = target => target;' });
    await page.goto(`${served.url}?board=screens&page=${PAGE_ID}`);
    await page.locator('.frame[data-screen-id="audit-outer"] iframe.canonical-prototype-iframe').waitFor({ state: 'attached', timeout: 30_000 });
    return page;
  }

  const marksAre = (page: Page, state: string): Promise<unknown> => page.waitForFunction(wanted => document.querySelector<HTMLElement>('.bp-chrome-changes')?.dataset.marks === wanted, state, { timeout: 20_000 });

  async function assertEventually(check: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(check(), message);
  }

  let tokenEdits = 0;

  /** Each value is new, because a value that returns to the baseline ends the change and hides the bar. */
  async function editToken(id: string): Promise<void> {
    tokenEdits += 1;
    const tokens = path.join(project, 'tokens.json');
    await writeFile(tokens, setToken(await readFile(tokens, 'utf8'), id, `#0f${tokenEdits.toString(16).padStart(4, '0')}`), 'utf8');
  }

  it('keeps each mark through a second edit until a new answer removes it', { timeout: 120_000 }, async () => {
    await dismissChanges();
    const page = await openGuardPage();
    try {
      await editToken('audit-inner');
      await page.locator('.bp-chrome-changes').waitFor({ state: 'visible', timeout: 20_000 });
      await marksAre(page, 'settled');
      assert.ok(await page.locator('.frame.bp-chrome-changed, .bp-chrome-change-box').count() > 0, 'The first edit must mark a frame, or this test proves nothing.');
      await page.evaluate(SAMPLE_MARKS);
      await editToken('audit-inner');
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.bp-chrome-changes')?.dataset.marks === 'pending', undefined, { timeout: 20_000 });
      await marksAre(page, 'settled');
      const fewest = await page.evaluate(() => (globalThis as unknown as { guardFewestMarks: number }).guardFewestMarks);
      assert.ok(fewest > 0, 'The marks disappeared during the second edit.');
    } finally {
      await page.close();
    }
    await waitForAppliedChange();
    await dismissChanges();
  });

  it('stays pending while a second edit waits in the live queue', { timeout: 120_000 }, async () => {
    await dismissChanges();
    const page = await browser.newPage({ viewport: { width: 1200, height: 9000 } });
    await page.addInitScript({ content: `
      globalThis.__name = target => target;
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...rest) {
        if (message?.kind === 'document') setTimeout(() => post.call(this, message, ...rest), 3000);
        else post.call(this, message, ...rest);
      };
    ` });
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let snapshots = 0;
    try {
      await page.route('**/__blueprint/project**', async route => {
        snapshots += 1;
        if (snapshots === 2) await held;
        await route.continue();
      });
      await page.goto(`${served.url}?board=screens&page=${PAGE_ID}`);
      await page.locator('.frame[data-screen-id="audit-outer"] iframe.canonical-prototype-iframe').waitFor({ state: 'attached', timeout: 30_000 });
      snapshots = 0;
      await editToken('audit-inner');
      await page.locator('.bp-chrome-changes').waitFor({ state: 'visible', timeout: 20_000 });
      await editToken('audit-inner');
      await assertEventually(() => snapshots === 2, 'The second edit must wait at the snapshot request, or this test proves nothing.');
      await page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>('.bp-chrome-changes') as HTMLElement;
        const seen = [bar.dataset.marks];
        (globalThis as unknown as { guardMarkStates: unknown[] }).guardMarkStates = seen;
        new MutationObserver(() => seen.push(bar.dataset.marks)).observe(bar, { attributes: true, attributeFilter: ['data-marks'] });
      });
      await page.waitForTimeout(9000);
      const states = await page.evaluate(() => (globalThis as unknown as { guardMarkStates: unknown[] }).guardMarkStates);
      assert.ok(states.every(state => state === 'pending'), `The state left pending during the wait: ${states.join(', ')}.`);
      release();
      await marksAre(page, 'settled');
    } finally {
      release();
      await page.close();
    }
    await waitForAppliedChange();
    await dismissChanges();
  });

  it('keeps the mark and settles when the diff throws', { timeout: 120_000 }, async () => {
    await dismissChanges();
    const page = await openGuardPage();
    try {
      await page.evaluate(() => {
        const append = document.body.append;
        document.body.append = function (...nodes: Array<Node | string>) {
          if (nodes[0] instanceof HTMLIFrameElement && nodes[0].getAttribute('sandbox') === 'allow-same-origin') throw new Error('The test stops this twin.');
          return append.apply(this, nodes);
        };
      });
      await editToken('audit-inner');
      await page.locator('.bp-chrome-changes').waitFor({ state: 'visible', timeout: 20_000 });
      await marksAre(page, 'settled');
      assert.ok(await page.locator('.frame.bp-chrome-changed').count() > 0, 'A frame with no diff answer must keep its mark.');
    } finally {
      await page.close();
    }
    await waitForAppliedChange();
    await dismissChanges();
  });

  it('settles when the frame swap throws', { timeout: 120_000 }, async () => {
    await dismissChanges();
    const page = await openGuardPage();
    try {
      await page.evaluate(() => {
        const removeProperty = CSSStyleDeclaration.prototype.removeProperty;
        let armed = true;
        CSSStyleDeclaration.prototype.removeProperty = function (name: string) {
          if (armed && name === 'visibility') {
            armed = false;
            throw new Error('The test stops this swap.');
          }
          return removeProperty.call(this, name);
        };
      });
      await editToken('audit-inner');
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.bp-chrome-changes')?.dataset.marks === 'pending', undefined, { timeout: 20_000 });
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.bp-chrome-changes')?.dataset.marks !== 'pending', undefined, { timeout: 60_000 });
    } finally {
      await page.close();
    }
    await waitForAppliedChange();
    await dismissChanges();
  });

  it('marks each frame whose preset size changes, and names the frame sizes in the bar', async () => {
    await dismissChanges();
    const manifest = path.join(project, 'manifest.json');
    const original = await readFile(manifest, 'utf8');
    const page = await openGuardPage();
    try {
      const parsed = JSON.parse(original) as { framePresets: Array<{ width: number }> };
      for (const preset of parsed.framePresets) preset.width += 20;
      await writeFile(manifest, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      await page.locator('.bp-chrome-changes').waitFor({ state: 'visible', timeout: 20_000 });
      await marksAre(page, 'settled');
      assert.match(await page.locator('.bp-chrome-changes-label').innerText(), /Frame sizes/);
      const unmarked = await page.locator('.frame[data-screen-id]:not(.bp-chrome-changed)').evaluateAll(frames => frames.map(frame => (frame as HTMLElement).dataset.screenId));
      assert.deepEqual(unmarked, []);
    } finally {
      await page.close();
      await writeFile(manifest, original, 'utf8');
    }
    await waitForAppliedChange();
    await dismissChanges();
  });

  it('marks only the frame that reads a safe area that changes', async () => {
    await dismissChanges();
    const manifest = path.join(project, 'manifest.json');
    const original = await readFile(manifest, 'utf8');
    const page = await openGuardPage();
    try {
      const parsed = JSON.parse(original) as { framePresets: Array<{ safeArea?: Record<string, number> }> };
      for (const preset of parsed.framePresets) preset.safeArea = { top: 30, right: 0, bottom: 0, left: 0 };
      await writeFile(manifest, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      await page.locator('.bp-chrome-changes').waitFor({ state: 'visible', timeout: 20_000 });
      await marksAre(page, 'settled');
      const marked = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.frame[data-screen-id]')]
        .filter(frame => frame.classList.contains('bp-chrome-changed') || frame.querySelector('.bp-chrome-change-box'))
        .map(frame => frame.dataset.screenId));
      assert.deepEqual(marked, ['audit-safe']);
    } finally {
      await page.close();
      await writeFile(manifest, original, 'utf8');
    }
    await waitForAppliedChange();
    await dismissChanges();
  });

  it('marks a frame of a page that opens after the edit', async () => {
    await dismissChanges();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1800 } });
    try {
      await page.addInitScript({ content: 'globalThis.__name = target => target;' });
      await page.goto(`${served.url}?board=screens&page=${PAGE_ID}`);
      await page.locator('.frame[data-screen-id="home"] iframe.canonical-prototype-iframe').waitFor({ state: 'attached', timeout: 30_000 });
      const css = path.join(project, 'prototype/screens/web-home.css');
      const original = await readFile(css, 'utf8');
      await writeFile(css, `${original}\n[data-blueprint-screen="web-home"] { color: #be123c; background: #fde68a; padding: 40px; }\n`, 'utf8');
      await page.locator('.bp-chrome-changes:not([hidden])').waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator('[data-page="web"]').click();
      const marked = '.frame[data-screen-id="web-home"].bp-chrome-changed, .frame-slot:has(.frame[data-screen-id="web-home"]) .bp-chrome-change-box';
      await page.locator(marked).first().waitFor({ state: 'attached', timeout: 20_000 });
      await writeFile(css, original, 'utf8');
    } finally {
      await page.close();
    }
    await canvas.locator('.bp-chrome-changes').waitFor({ state: 'hidden', timeout: 20_000 });
  });

  it('rebuilds each frame in scope when the worker cannot load', async () => {
    await dismissChanges();
    const page = await browser.newPage({ viewport: { width: 1200, height: 9000 } });
    try {
      await page.addInitScript({ content: 'globalThis.__name = target => target;' });
      await page.route('**/*frame-output-worker*', route => route.abort());
      await page.goto(`${served.url}?board=screens&page=${PAGE_ID}`);
      await page.locator('.frame[data-screen-id="audit-plain"] iframe.canonical-prototype-iframe').waitFor({ state: 'attached', timeout: 30_000 });
      const tokens = path.join(project, 'tokens.json');
      await writeFile(tokens, setToken(await readFile(tokens, 'utf8'), 'audit-art', '#0369a1'), 'utf8');
      await page.waitForFunction(() => {
        const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe.canonical-prototype-iframe')];
        return frames.length > 0 && frames.every(frame => frame.srcdoc.includes('#0369a1'));
      }, undefined, { timeout: 30_000 });
      await page.locator('.frame.bp-chrome-changed').first().waitFor({ state: 'attached', timeout: 20_000 });
    } finally {
      await page.close();
    }
    await waitForAppliedChange();
    await dismissChanges();
  });

  it('holds no old document in the page after the dismiss', async () => {
    await dismissChanges();
    const marker = 'GuardOldCopyMarker';
    const file = path.join(project, 'prototype/screens/audit-outer.html');
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('Card', marker), 'utf8');
    await waitForAppliedChange();
    await dismissChanges();
    await writeFile(file, original, 'utf8');
    await waitForAppliedChange();
    assert.ok(await canvas.locator('.frame-slot:has(.frame[data-screen-id="audit-outer"]) .bp-chrome-change-box').count() > 0);
    await dismissChanges();
    await canvas.waitForTimeout(SETTLE_MS);
    const cdp = await canvas.context().newCDPSession(canvas);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    let heap = '';
    cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => {
      heap += chunk;
    });
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    await cdp.detach();
    assert.ok(heap.includes('canonical-prototype-iframe'), 'The heap snapshot is empty.');
    assert.ok(!heap.includes(marker), 'The page still holds the old document.');
    const workerHeap = await frameOutputWorkerHeap();
    assert.ok(workerHeap.length > 0, 'The worker heap snapshot is empty.');
    assert.ok(!workerHeap.includes(marker), 'The worker still holds the old snapshot.');
  });
});

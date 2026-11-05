import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { parseBoundarySelector } from '../core/address';
import { showBoundary } from '../core/query';
import { assertChromiumExecutableAvailable, createChromiumDependencyError } from '../prototype/browser-preflight';
import { compilePrototypeDocument } from '../prototype/compiler';
import { installPrototypeNetworkGuard } from '../prototype/network-guard';
import { compilePrototypeReview, resolvePrototypeReviewSelection } from '../prototype/review';
import { normalize, throwIfAborted, withAbort } from './operation-support';
import { loadCurrentProject } from './project-files';
import { captureOutputSchema, type CaptureInput, type CaptureOutput } from './schemas';

export async function captureBlueprint(input: CaptureInput, signal?: AbortSignal): Promise<CaptureOutput> {
  throwIfAborted(signal);
  const { project, boundary, out } = input;
  const selector = parseBoundarySelector(boundary);
  const bundle = await loadCurrentProject(project);
  showBoundary(bundle, selector);
  const resolvedOut = path.resolve(out);
  const base = {
    command: 'capture' as const,
    project: normalize(path.resolve(project)),
    projectId: bundle.manifest.project.id,
    out: normalize(resolvedOut),
    mediaType: 'image/png' as const
  };

  if (selector.kind === 'screen') {
    if (input.variant || input.size) {
      throw new Error('Screen captures take a state and viewport. Variant and size apply to primitives and components. Fix: remove variant and size from this call, or pass a primitive or component boundary.');
    }
    const selection = resolvePrototypeReviewSelection(bundle, {
      screenId: selector.id,
      state: input.state,
      viewport: input.viewport
    });
    const compiled = compilePrototypeReview(bundle, selection);
    await capturePrototypeDocument(compiled.html, { width: selection.width, height: selection.height }, resolvedOut, undefined, signal);
    return captureOutputSchema.parse({
      ...base,
      boundary: selection.boundaryId,
      state: selection.state,
      viewport: selection.framePresetId,
      reviewCondition: selection.conditionId,
      dimensions: { width: selection.width, height: selection.height },
      source: captureSource(compiled.observedBoundaryIds)
    });
  }

  if (selector.kind !== 'component' && selector.kind !== 'primitive') {
    throw new Error(`The capture tool supports screen, component, and primitive boundaries. Received ${selector.kind}:${selector.id}. Fix: pass a boundary that starts with screen:, component:, or primitive:.`);
  }
  const preset = input.viewport ? bundle.manifest.framePresets.find(candidate => candidate.id === input.viewport) : undefined;
  if (input.viewport && !preset) {
    throw new Error(`Frame preset "${input.viewport}" is not declared in manifest.json. Fix: pass one of these viewport ids: ${bundle.manifest.framePresets.map(candidate => candidate.id).join(', ')}. Or add "${input.viewport}" to framePresets in manifest.json.`);
  }
  const compiled = compilePrototypeDocument({
    bundle,
    target: { kind: selector.kind, id: selector.id },
    state: input.state,
    variant: input.variant,
    size: input.size
  });
  const width = preset?.width ?? REUSABLE_CAPTURE_WIDTH;
  const dimensions = await capturePrototypeDocument(
    compiled.html,
    { width, height: preset?.height ?? REUSABLE_CAPTURE_HEIGHT },
    resolvedOut,
    compiled.targetBoundaryId,
    signal
  );
  return captureOutputSchema.parse({
    ...base,
    boundary: compiled.targetBoundaryId,
    state: compiled.state,
    ...(input.variant ? { variant: input.variant } : {}),
    ...(input.size ? { size: input.size } : {}),
    ...(preset ? { viewport: preset.id } : {}),
    dimensions,
    source: captureSource([...new Set(compiled.observedUses.map(use => use.targetBoundaryId))])
  });
}

const REUSABLE_CAPTURE_WIDTH = 1280;
const REUSABLE_CAPTURE_HEIGHT = 800;
const SPECIMEN_CAPTURE_PADDING = 12;

function captureSource(observedBoundaryIds: string[]) {
  return {
    context: 'source-focused' as const,
    captureTarget: 'compiled-prototype-document' as const,
    method: 'browser-page-screenshot' as const,
    editorChrome: false as const,
    readiness: { fonts: 'ready' as const, images: 'decoded' as const, layout: 'stable' as const },
    observedBoundaryIds
  };
}

async function capturePrototypeDocument(
  html: string,
  viewport: { width: number; height: number },
  out: string,
  cropToBoundaryId: string | undefined,
  signal?: AbortSignal
): Promise<{ width: number; height: number }> {
  const chromium = await preflightChromium();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await withAbort(chromium.launch(), signal);
    const page = await browser.newPage({
      viewport,
      deviceScaleFactor: 1,
      // Ambient app animation is authored under prefers-reduced-motion: no-preference,
      // so emulating reduce keeps capture bytes deterministic across runs.
      reducedMotion: 'reduce'
    });
    const networkGuard = await installPrototypeNetworkGuard({
      route: async handler => {
        await page.route('**/*', route => handler({
          url: route.request().url(),
          continue: () => route.continue(),
          abort: () => route.abort('blockedbyclient')
        }));
      },
      onFrameNavigated: handler => {
        page.on('framenavigated', frame => handler(frame.url(), frame === page.mainFrame()));
      },
      currentUrl: () => page.url()
    });
    await withAbort(page.setContent(html, { waitUntil: 'load' }), signal);
    networkGuard.assertClean();
    await withAbort(waitForPrototypeCaptureReadiness(page), signal);
    networkGuard.assertClean();

    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (cropToBoundaryId) {
      const bounds = await page.locator(`[data-blueprint-boundary-id="${cropToBoundaryId}"]`).first().boundingBox();
      if (!bounds || bounds.width === 0 || bounds.height === 0) {
        throw new Error(`${cropToBoundaryId} rendered no visible box to capture. Fix: give the root element of ${cropToBoundaryId} a visible width and height in this state, or pass another state.`);
      }
      const x = Math.max(0, Math.floor(bounds.x - SPECIMEN_CAPTURE_PADDING));
      const y = Math.max(0, Math.floor(bounds.y - SPECIMEN_CAPTURE_PADDING));
      clip = {
        x,
        y,
        width: Math.ceil(bounds.x + bounds.width + SPECIMEN_CAPTURE_PADDING) - x,
        height: Math.ceil(bounds.y + bounds.height + SPECIMEN_CAPTURE_PADDING) - y
      };
    }

    await mkdir(path.dirname(out), { recursive: true });
    await withAbort(page.screenshot({
      path: out,
      type: 'png',
      fullPage: Boolean(clip),
      ...(clip ? { clip } : {}),
      animations: 'disabled',
      caret: 'hide',
      scale: 'css'
    }), signal);
    return clip ? { width: clip.width, height: clip.height } : viewport;
  } finally {
    await browser?.close();
  }
}

async function preflightChromium(): Promise<(typeof import('playwright'))['chromium']> {
  let chromium: (typeof import('playwright'))['chromium'];
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw createChromiumDependencyError();
  }

  assertChromiumExecutableAvailable(chromium.executablePath());
  return chromium;
}

async function waitForPrototypeCaptureReadiness(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map(async image => {
        if (!image.complete) {
          await new Promise<void>((resolve, reject) => {
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener('error', () => reject(new Error(`Prototype image failed to load: ${image.currentSrc || image.src}. Fix: change this image path to a file inside a prototypeHost.assetRoots directory.`)), {
              once: true
            });
          });
        }
        if (image.naturalWidth === 0) {
          throw new Error(`Prototype image has no decoded pixels: ${image.currentSrc || image.src}. Fix: replace this file with a valid image.`);
        }
        await image.decode();
      })
    );

    const layoutFingerprint = (): string => {
      const root = document.documentElement;
      const body = document.body;
      const bounds = body.getBoundingClientRect();
      return [
        root.scrollWidth,
        root.scrollHeight,
        body.scrollWidth,
        body.scrollHeight,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height
      ].join('|');
    };
    let previous = layoutFingerprint();
    let stableFrames = 0;
    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const current = layoutFingerprint();
      if (current === previous) {
        stableFrames += 1;
        if (stableFrames >= 2) {
          return;
        }
      } else {
        stableFrames = 0;
      }
      previous = current;
    }
    throw new Error('Prototype layout did not stabilize before capture. Fix: remove the animation or transition that changes the layout of this boundary, then capture again.');
  });
}

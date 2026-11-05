import type { PrototypeReviewSelectionRequest } from '../prototype/compiler';
import { frameMounterByRoot } from './boards';
import type { CanvasController } from './canvas-controller';
import { type BoardContext, type BoardMount, activeScreenPage } from './canvas-state';
import { canvas, viewport } from './chrome';
import { el } from './dom';
import { mountExplorationScreens, mountHistoryScreens } from './focused-review';
import { type FrameMounter, createFrameMounter } from './frame-mounting';
import { createPrototypeFrame } from './prototype-frame';
import { frameExtentHeight, layoutScreenFrames } from './screen-layout';
import { createTokenIndex } from './tokens';

export function mountScreens({ root, canvas: boardCanvas, project: bundle }: BoardContext): BoardMount {
  const params = new URLSearchParams(location.search);
  if (params.has('exploration')) {
    return mountExplorationScreens(root, boardCanvas, bundle, params.get('exploration') ?? '');
  }
  if (params.has('history')) {
    return mountHistoryScreens(root, boardCanvas, bundle, params.get('history') ?? '', {
      state: params.get('state') ?? undefined,
      viewport: params.get('viewport') ?? undefined
    });
  }
  const request: PrototypeReviewSelectionRequest = {
    state: params.get('state') ?? undefined,
    viewport: params.get('viewport') ?? undefined
  };
  // Pages filter the board view only; deep links (state/viewport) always
  // resolve their frames regardless of the active page.
  const pageFilter = request.state || request.viewport ? undefined : (activeScreenPage ?? undefined);
  const frameLayouts = layoutScreenFrames(bundle, request, pageFilter);
  const fallbackWidth = frameLayouts.length > 0 ? Math.max(393, ...frameLayouts.map(layout => layout.preset.width)) : 1440;
  const fallbackHeight = frameLayouts.length > 0
    ? Math.max(852, ...frameLayouts.map(layout => frameExtentHeight(layout.preset)))
    : 900;
  const configure = (): CanvasController =>
    boardCanvas.configure({
      minScale: 0.15,
      readableScale: 0.55,
      fallbackWidth,
      fallbackHeight
    });
  const controller = configure();
  const tokenIndex = createTokenIndex(bundle);
  const mounter = createScreenFrameMounter(root);
  frameLayouts.forEach(layout => {
    if (layout.pageLabel) {
      const label = el('div', 'screen-page-label bp-chrome-world-label', layout.pageLabel.text);
      label.style.left = `${layout.pageLabel.x}px`;
      label.style.top = `${layout.pageLabel.y}px`;
      root.append(label);
    }
    root.append(createPrototypeFrame(bundle, tokenIndex, layout, mounter));
  });

  return {
    configure,
    fit: () => controller.fitTo([...root.querySelectorAll<HTMLElement>('.frame-slot')])
  };
}

function createScreenFrameMounter(root: HTMLElement): FrameMounter {
  const schedule = (): void => mounter.schedule();
  let stopViewChanges = (): void => undefined;
  const mounter = createFrameMounter({
    view: () => canvas.view,
    viewport: () => ({ width: viewport.clientWidth || window.innerWidth, height: viewport.clientHeight || window.innerHeight }),
    state: () => !root.isConnected ? 'disposed' : root.hidden || viewport.hidden ? 'hidden' : canvas.gesturing() ? 'paused' : 'active',
    onDisposed: () => {
      stopViewChanges();
      window.removeEventListener('resize', schedule);
    }
  });
  stopViewChanges = canvas.onViewSettled(() => canvas.gesturing() ? mounter.mountOne() : mounter.schedule());
  window.addEventListener('resize', schedule);
  // A new board fits its view in the next animation frame, so the first batch waits for that view.
  const release = mounter.hold();
  requestAnimationFrame(() => window.setTimeout(release));
  window.setTimeout(release, 100);
  frameMounterByRoot.set(root, mounter);
  return mounter;
}

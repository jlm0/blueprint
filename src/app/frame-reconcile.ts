import type { PrototypeReviewSelectionRequest } from '../prototype/compiler';
import { frameMounterByRoot, waitForPrototypeFrames } from './boards';
import { renderCanvasAnnotations } from './canvas-annotations';
import { activeBoardId, activeScreenPage, boardState, focusedReviewIsRequested, project } from './canvas-state';
import { rememberFrameThumbnail, slotScreenFrame } from './frame-host';
import { frameNeedsRebuild, rebuildScope } from './frame-rebuild';
import { prototypeUsesByHost } from './frame-uses';
import { frameViewBySlot } from './frame-viewer';
import { createPrototypeFrame } from './prototype-frame';
import { refreshCanvasReviewState } from './review-state';
import { layoutScreenFrames, liveFrameKey } from './screen-layout';
import { createTokenIndex } from './tokens';

export async function reconcileScreenFrames(changedPaths: string[]): Promise<boolean> {
  if (focusedReviewIsRequested()) return false;
  const state = boardState.get('screens');
  if (!state) return true;
  const oldFrames = new Map(
    [...state.root.querySelectorAll<HTMLElement>('.frame-slot[data-live-frame-key]')]
      .map(frame => [frame.dataset.liveFrameKey ?? '', frame] as const)
  );
  const previousBundle = [...oldFrames.values()].map(slotScreenFrame).find(frame => frame)?.source.bundle;
  const scope = rebuildScope(changedPaths, previousBundle, project);
  if (!scope || (!scope.all && scope.screenIds.size === 0 && scope.boundaryIds.size === 0)) return false;
  const everyScreen = scope.all || scope.boundaryIds.size > 0;
  const params = new URLSearchParams(location.search);
  const request: PrototypeReviewSelectionRequest = {
    state: params.get('state') ?? undefined,
    viewport: params.get('viewport') ?? undefined
  };
  const pageFilter = request.state || request.viewport ? undefined : (activeScreenPage ?? undefined);
  const layouts = layoutScreenFrames(project, request, pageFilter).filter(layout => everyScreen || scope.screenIds.has(layout.screen.id));
  const nextKeys = layouts.map(layout => liveFrameKey(layout.screen.id, layout.preset.id, layout.prototypeSelection));
  if (nextKeys.some(key => !oldFrames.has(key))) return false;
  const currentKeys = [...oldFrames.entries()]
    .filter(([, frame]) => everyScreen || scope.screenIds.has(frame.querySelector<HTMLElement>('.frame')?.dataset.screenId ?? ''))
    .map(([key]) => key);
  if (currentKeys.length !== nextKeys.length) return false;

  const mounter = frameMounterByRoot.get(state.root);
  if (!mounter) return false;
  const tokenIndex = createTokenIndex(project);
  const release = mounter.hold();
  try {
    const swaps: Promise<void>[] = [];
    for (const layout of layouts) {
      const previous = oldFrames.get(liveFrameKey(layout.screen.id, layout.preset.id, layout.prototypeSelection));
      if (!previous) continue;
      const replaced = slotScreenFrame(previous);
      if (replaced && !frameNeedsRebuild(scope, layout.screen.id, replaced.failed ? undefined : prototypeUsesByHost.get(replaced.host)?.usedBoundaryIds)) {
        replaced.source.bundle = project;
        rememberFrameThumbnail(replaced);
        const view = frameViewBySlot.get(previous);
        if (view) view.bundle = project;
        continue;
      }
      const next = createPrototypeFrame(project, tokenIndex, layout, mounter);
      if (!replaced?.mounted) {
        if (replaced) mounter.remove(replaced);
        previous.replaceWith(next);
        continue;
      }
      previous.classList.add('bp-chrome-live-frame-updating');
      previous.setAttribute('aria-busy', 'true');
      next.style.visibility = 'hidden';
      state.root.append(next);
      slotScreenFrame(next)?.mount();
      swaps.push(waitForPrototypeFrames(next).then(() => {
        next.style.removeProperty('visibility');
        next.classList.add('bp-chrome-live-frame-enter');
        mounter.remove(replaced);
        previous.replaceWith(next);
      }));
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    await Promise.all(swaps);
  } finally {
    release();
  }
  if (activeBoardId === 'screens') {
    refreshCanvasReviewState('screens');
    renderCanvasAnnotations();
  }
  return true;
}

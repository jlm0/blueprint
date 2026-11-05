import type { CanvasProjectBundle } from '../core/types';
import type { PrototypeReviewSelectionRequest } from '../prototype/compiler';
import { frameMounterByRoot, waitForPrototypeFrames } from './boards';
import { renderCanvasAnnotations } from './canvas-annotations';
import { activeBoardId, activeScreenPage, boardState, focusedReviewIsRequested, project } from './canvas-state';
import { type ScreenFrame, rememberFrameThumbnail, slotScreenFrame } from './frame-host';
import { yieldToMain } from './frame-mounting';
import { changedFrameOutputs } from './frame-output-client';
import { framesInChangeScope } from './frame-output-service';
import { rebuildScope } from './frame-rebuild';
import { frameViewBySlot } from './frame-viewer';
import { createPrototypeFrame } from './prototype-frame';
import { refreshCanvasReviewState } from './review-state';
import { layoutScreenFrames, liveFrameKey } from './screen-layout';
import { createTokenIndex } from './tokens';

const RECONCILE_SLICE_MS = 16;

function keepFrame(frame: ScreenFrame, slot: HTMLElement): void {
  frame.source.bundle = project;
  rememberFrameThumbnail(frame);
  const view = frameViewBySlot.get(slot);
  if (view) view.bundle = project;
  frame.onBundleChanged?.(project);
}

export async function reconcileScreenFrames(changedPaths: string[], previousBundle: CanvasProjectBundle): Promise<boolean> {
  if (focusedReviewIsRequested()) return false;
  const state = boardState.get('screens');
  if (!state) return true;
  const oldFrames = new Map(
    [...state.root.querySelectorAll<HTMLElement>('.frame-slot[data-live-frame-key]')]
      .map(frame => [frame.dataset.liveFrameKey ?? '', frame] as const)
  );
  const scope = rebuildScope(changedPaths, previousBundle, project);
  const tokensChanged = changedPaths.includes('tokens.json');
  if (!scope || (!scope.all && !tokensChanged && scope.screenIds.size === 0 && scope.boundaryIds.size === 0)) return false;
  const everyScreen = scope.all || tokensChanged || scope.boundaryIds.size > 0;
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
  const targets = layouts.flatMap(layout => {
    const key = liveFrameKey(layout.screen.id, layout.preset.id, layout.prototypeSelection);
    const previous = oldFrames.get(key);
    const frame = previous && slotScreenFrame(previous);
    return frame ? [{ key, screenId: frame.source.screen.id, state: frame.source.selection.state, preset: frame.source.preset }] : [];
  });
  const changed = (await changedFrameOutputs(previousBundle, project, targets))?.changed
    ?? new Set(framesInChangeScope(previousBundle, project, targets, false).map(target => target.key));
  if ([...oldFrames.values()].some(slot => !slot.isConnected)) return false;
  const tokenIndex = createTokenIndex(project);
  const release = mounter.hold();
  try {
    const swaps: Promise<void>[] = [];
    let sliceStart = performance.now();
    for (const layout of layouts) {
      if (performance.now() - sliceStart > RECONCILE_SLICE_MS) {
        await yieldToMain();
        sliceStart = performance.now();
      }
      const previous = oldFrames.get(liveFrameKey(layout.screen.id, layout.preset.id, layout.prototypeSelection));
      if (!previous) continue;
      const replaced = slotScreenFrame(previous);
      if (replaced && !replaced.failed && !changed.has(liveFrameKey(layout.screen.id, layout.preset.id, layout.prototypeSelection))) {
        keepFrame(replaced, previous);
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
      if (performance.now() - sliceStart > RECONCILE_SLICE_MS) await yieldToMain();
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
    if (!everyScreen) {
      for (const [key, slot] of oldFrames) {
        const frame = nextKeys.includes(key) ? undefined : slotScreenFrame(slot);
        if (frame) keepFrame(frame, slot);
      }
    }
  } finally {
    release();
  }
  if (activeBoardId === 'screens') {
    refreshCanvasReviewState('screens');
    renderCanvasAnnotations();
  }
  return true;
}

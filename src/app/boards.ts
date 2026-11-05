import {
  type BoardConfig,
  type BoardId,
  type MountedBoard,
  activeBoardId,
  boardState,
  focusedReviewIsRequested,
  project,
  setActiveBoardId
} from './canvas-state';
import { canvas, documentView, explorationNavigator, viewport, world } from './chrome';
import { el } from './dom';
import { waitForFrameLoads } from './frame-loads';
import type { FrameMounter } from './frame-mounting';
import { fitIcon } from './icons';
import { refreshCanvasReviewState } from './review-state';
import { activeItem, activeSection } from './sections';

export const frameMounterByRoot = new WeakMap<HTMLElement, FrameMounter>();

export let boardConfigs: Record<BoardId, BoardConfig>;
let refreshNavigationState: () => void;
let renderCanvasAnnotations: () => void;

// A board mount and the annotations call navigation, and navigation shows boards, so main.ts passes them in to keep the imports acyclic.
export function wireBoards(wiring: {
  configs: Record<BoardId, BoardConfig>;
  refreshNavigationState: () => void;
  renderCanvasAnnotations: () => void;
}): void {
  boardConfigs = wiring.configs;
  refreshNavigationState = wiring.refreshNavigationState;
  renderCanvasAnnotations = wiring.renderCanvasAnnotations;
}

let fitButton: HTMLButtonElement;

export function createFitButton(): HTMLElement {
  // Quiet chrome verb: jump back out to a fitted view of the active board.
  fitButton = el('button', 'bp-chrome-fit') as HTMLButtonElement;
  fitButton.type = 'button';
  fitButton.title = 'Zoom to fit the canvas';
  fitButton.setAttribute('aria-label', 'Zoom to fit the canvas');
  fitButton.innerHTML = `${fitIcon()}<span>Fit</span>`;
  fitButton.addEventListener('click', () => {
    if (activeBoardId) {
      boardState.get(activeBoardId)?.mounted.fit();
    }
  });
  return fitButton;
}

export function showBoard(id: BoardId): void {
  const config = boardConfigs[id];
  if (!config) {
    return;
  }

  if (activeBoardId) {
    const current = boardState.get(activeBoardId);
    if (current) {
      rememberBoardView(activeBoardId, current);
      current.root.hidden = true;
    }
  }

  const state = ensureBoard(id, config);
  state.root.hidden = false;
  const onCanvas = config.surface === 'canvas';
  viewport.hidden = !onCanvas;
  documentView.hidden = onCanvas;
  fitButton.hidden = !onCanvas;
  state.mounted.configure();
  setActiveBoardId(id);

  const showingFocusedReview = id === 'screens' && focusedReviewIsRequested();
  explorationNavigator.hidden = !showingFocusedReview;
  refreshNavigationState();

  const url = new URL(window.location.href);
  url.searchParams.set('board', id);
  if (onCanvas) {
    url.searchParams.delete('section');
    url.searchParams.delete('item');
  } else {
    url.searchParams.set('section', activeSection);
    const item = activeItem(project, activeSection);
    if (item) url.searchParams.set('item', item.id);
    else url.searchParams.delete('item');
  }
  history.replaceState(null, '', url);

  if (!onCanvas) {
    documentView.scrollTop = state.scrollTop ?? 0;
  } else if (state.view) {
    canvas.setView(state.view);
  } else {
    requestAnimationFrame(() => state.mounted.fit());
  }

  refreshCanvasReviewState(id);
  renderCanvasAnnotations();
}

function rememberBoardView(id: BoardId, state: MountedBoard): void {
  if (boardConfigs[id].surface === 'canvas') {
    state.view = canvas.snapshot();
  } else {
    state.scrollTop = documentView.scrollTop;
  }
}

function boardContainer(id: BoardId): HTMLElement {
  return boardConfigs[id].surface === 'canvas' ? world : documentView;
}

function ensureBoard(id: BoardId, config: BoardConfig): MountedBoard {
  const existing = boardState.get(id);
  if (existing) {
    return existing;
  }

  const root = el('section', config.className);
  root.dataset.boardRoot = id;
  root.hidden = true;
  root.setAttribute('aria-label', config.label);
  boardContainer(id).append(root);

  const mounted = config.mount({ root, canvas, project });
  const state: MountedBoard = { root, mounted, view: null };
  boardState.set(id, state);
  return state;
}

export function discardBoard(id: BoardId): void {
  boardState.get(id)?.root.remove();
  boardState.delete(id);
}

// Rebuilds a board from scratch (used when the screens page or the
// document item changes); the fresh mount refits instead of restoring a stale view.
export function remountBoard(id: BoardId): void {
  discardBoard(id);
  if (activeBoardId === id) {
    setActiveBoardId(null);
    showBoard(id);
  }
}

export async function replaceMountedBoard(id: BoardId): Promise<void> {
  const current = boardState.get(id);
  if (!current) return;
  const config = boardConfigs[id];
  const isActive = activeBoardId === id;
  const onCanvas = config.surface === 'canvas';
  const view = isActive && onCanvas ? canvas.snapshot() : current.view;
  const scrollTop = isActive && !onCanvas ? documentView.scrollTop : current.scrollTop;
  const nextRoot = el('section', `${config.className} bp-chrome-live-board-next`);
  nextRoot.dataset.boardRoot = id;
  nextRoot.hidden = !isActive;
  nextRoot.setAttribute('aria-label', config.label);
  nextRoot.setAttribute('aria-busy', 'true');
  nextRoot.style.visibility = 'hidden';
  if (!onCanvas) nextRoot.style.position = 'absolute';
  boardContainer(id).append(nextRoot);
  const mounted = config.mount({ root: nextRoot, canvas, project });
  if (isActive) await waitForBoardFrames(nextRoot);
  if (boardState.get(id) !== current) {
    nextRoot.remove();
    return;
  }

  current.root.remove();
  nextRoot.style.removeProperty('visibility');
  nextRoot.style.removeProperty('position');
  nextRoot.removeAttribute('aria-busy');
  nextRoot.classList.remove('bp-chrome-live-board-next');
  nextRoot.classList.add('bp-chrome-live-board-enter');
  const nextState: MountedBoard = { root: nextRoot, mounted, view, ...(scrollTop === undefined ? {} : { scrollTop }) };
  boardState.set(id, nextState);
  if (isActive) {
    mounted.configure();
    if (onCanvas && view) canvas.setView(view);
    if (!onCanvas) documentView.scrollTop = scrollTop ?? 0;
    refreshNavigationState();
    refreshCanvasReviewState(id);
    renderCanvasAnnotations();
  }
}

async function waitForBoardFrames(root: HTMLElement): Promise<void> {
  await frameMounterByRoot.get(root)?.visibleMounted();
  await waitForPrototypeFrames(root);
}

export async function waitForPrototypeFrames(root: HTMLElement): Promise<void> {
  const frames = [...root.querySelectorAll<HTMLIFrameElement>('iframe.canonical-prototype-iframe, iframe.canonical-primitive-iframe')];
  await waitForFrameLoads(frames, 500);
}

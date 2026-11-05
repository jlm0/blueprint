import { boundaryDisplayName } from '../core/activity';
import {
  type BlueprintCanvasSelection,
  type BlueprintSelectedBoundary,
  isSelectableBoundaryKind,
  selectionReference
} from '../core/selection';
import { type BoundaryExtent, boundaryHitsAtPoint, measureBoundaryInstance } from './boundary-extent';
import { activeBoardId, boardState, project } from './canvas-state';
import { documentView, viewport } from './chrome';
import { closeFindingsPanel, findingsPanelState } from './design-findings';
import { copyText, el, findBoundaryElement } from './dom';
import { requestFrameMount, screenFrameByHost } from './frame-host';
import { mountedPrototypeIframe, prototypeDocument, readPrototypeTwin } from './frame-overlay';
import { stepDocumentItem } from './navigation';

interface SelectionNode extends BlueprintSelectedBoundary {
  instance?: number;
  extent?: BoundaryExtent;
}

interface CanvasSelectionState {
  chain: SelectionNode[];
  index: number;
  frameKey?: string;
  measuredHost?: HTMLElement;
  frame: Omit<BlueprintCanvasSelection, keyof BlueprintSelectedBoundary | 'context'>;
}

export let canvasSelectionState: CanvasSelectionState | undefined;

let selectionPointerStart: { x: number; y: number } | undefined;

let selectionHitGeneration = 0;

let selectionRenderGeneration = 0;

let selectionHintTimer: number | undefined;

let selectionPublishQueue = Promise.resolve();
let selectionBar: HTMLElement;
let selectionPath: HTMLElement;
let selectionHint: HTMLElement;

export function createSelectionBar(): HTMLElement {
  selectionBar = el('div', 'bp-chrome-selection');
  selectionBar.hidden = true;
  selectionBar.setAttribute('role', 'group');
  selectionBar.setAttribute('aria-label', 'Canvas selection');
  selectionPath = el('div', 'bp-chrome-selection-path');
  selectionHint = el('span', 'bp-chrome-selection-hint');
  selectionHint.setAttribute('aria-live', 'polite');
  const selectionClear = el('button', 'bp-chrome-selection-clear', '×') as HTMLButtonElement;
  selectionClear.type = 'button';
  selectionClear.title = 'Clear selection';
  selectionClear.setAttribute('aria-label', 'Clear selection');
  selectionClear.addEventListener('click', () => setCanvasSelection(undefined));
  selectionBar.append(selectionPath, selectionHint, selectionClear);
  return selectionBar;
}

export function wireCanvasSelection(): void {
  for (const surface of [viewport, documentView]) {
    surface.addEventListener('pointerdown', event => {
      selectionPointerStart = { x: event.clientX, y: event.clientY };
    }, { capture: true });
    surface.addEventListener('click', event => {
      void selectAtPointer(event);
    });
  }
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (findingsPanelState) {
        closeFindingsPanel();
      } else if (canvasSelectionState) {
        setCanvasSelection(undefined);
      }
      return;
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && activeBoardId === 'primitives' && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (event.target instanceof Element && event.target.closest('input, select, textarea, [contenteditable]')) return;
      event.preventDefault();
      stepDocumentItem(event.key === 'ArrowRight' ? 1 : -1);
    }
  });
}

async function selectAtPointer(event: MouseEvent): Promise<void> {
  const start = selectionPointerStart;
  if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('button, a, input, select, textarea, label')) return;
  const activeRoot = activeBoardId ? boardState.get(activeBoardId)?.root : undefined;
  if (!target || !activeRoot?.contains(target)) {
    setCanvasSelection(undefined);
    return;
  }
  const host = target.closest<HTMLElement>('.canonical-prototype-screen');
  if (host && mountedPrototypeIframe(host)) {
    await selectInPrototypeFrame(host, event.clientX, event.clientY);
    return;
  }
  const screenFrame = host ? screenFrameByHost.get(host) : undefined;
  if (screenFrame && !screenFrame.failed) requestFrameMount(screenFrame);
  const element = target.closest<HTMLElement>('[data-boundary-id]');
  setCanvasSelection(element ? domSelectionState(element) : undefined, element !== null);
}

async function selectInPrototypeFrame(host: HTMLElement, clientX: number, clientY: number): Promise<void> {
  const iframe = mountedPrototypeIframe(host);
  const html = iframe ? prototypeDocument(iframe) : undefined;
  const frameElement = host.closest<HTMLElement>('.frame');
  if (!frameElement) return;
  if (!html) {
    setCanvasSelection(domSelectionState(frameElement), true);
    return;
  }
  const rect = host.getBoundingClientRect();
  const scale = host.clientWidth > 0 ? rect.width / host.clientWidth : 1;
  const x = (clientX - rect.left) / scale;
  const y = (clientY - rect.top) / scale;
  const generation = ++selectionHitGeneration;
  const hits = await readPrototypeTwin(html, host.clientWidth, host.clientHeight, twinDocument => boundaryHitsAtPoint(twinDocument, x, y), []);
  if (generation !== selectionHitGeneration || !host.isConnected) return;
  const chain = hits.flatMap(hit => {
    const node = selectionNodeForBoundaryId(hit.boundaryId);
    if (!node) return [];
    return [node.kind === 'screen' ? node : { ...node, instance: hit.instance, extent: hit.extent }];
  });
  if (chain.length === 0 || (chain[0].kind === 'screen' && frameElement.dataset.boundaryId)) {
    setCanvasSelection(domSelectionState(frameElement), true);
    return;
  }
  const frameLabel = frameElement.dataset.explorationRole
    ? host.closest('.frame-slot')?.querySelector('.frame-note .frame-name')?.textContent
    : undefined;
  setCanvasSelection({
    chain: frameLabel
      ? chain.map(node => node.kind === 'screen' ? { ...node, label: `${node.label} · ${frameLabel}` } : node)
      : chain,
    index: 0,
    frameKey: selectionFrameKey(host),
    measuredHost: host,
    frame: frameSelectionContext(frameElement)
  }, true);
}

export function selectionFrameKey(element: Element): string | undefined {
  const slot = element.closest<HTMLElement>('.frame-slot');
  return slot?.dataset.liveFrameKey ?? slot?.dataset.selectionFrameKey;
}

export function domSelectionState(element: HTMLElement): CanvasSelectionState {
  const chain: SelectionNode[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement?.closest<HTMLElement>('[data-boundary-id]') ?? null) {
    const kind = node.dataset.boundaryKind ?? '';
    const localId = node.dataset.boundaryLocalId;
    if (!node.dataset.boundaryId || !localId || !isSelectableBoundaryKind(kind)) continue;
    chain.push({ boundaryId: node.dataset.boundaryId, kind, localId, label: node.dataset.boundaryLabel ?? localId });
  }
  return {
    chain,
    index: 0,
    frameKey: selectionFrameKey(element),
    frame: frameSelectionContext(element)
  };
}

function frameSelectionContext(element: HTMLElement): CanvasSelectionState['frame'] {
  const frame = element.closest<HTMLElement>('.frame');
  const role = frame?.dataset.explorationRole;
  const historyVersion = Number(frame?.dataset.historyVersion);
  return {
    ...(frame?.dataset.screenId ? { screenId: frame.dataset.screenId } : {}),
    ...(frame?.dataset.reviewState ? { state: frame.dataset.reviewState } : {}),
    ...(frame?.dataset.framePresetId ? { framePresetId: frame.dataset.framePresetId } : {}),
    ...(frame?.dataset.explorationId ? { explorationId: frame.dataset.explorationId } : {}),
    ...(role === 'current' || role === 'version' || role === 'baseline' || role === 'candidate' ? { explorationRole: role } : {}),
    ...(frame?.dataset.explorationCandidateId ? { candidateId: frame.dataset.explorationCandidateId } : {}),
    ...(Number.isSafeInteger(historyVersion) && historyVersion > 0 ? { historyVersion } : {})
  };
}

function selectionNodeForBoundaryId(id: string): SelectionNode | undefined {
  const prefix = `${project.manifest.project.id}/`;
  if (!id.startsWith(prefix)) return undefined;
  const [kind, ...localIdParts] = id.slice(prefix.length).split('/');
  const localId = localIdParts.join('/');
  if (!localId || !isSelectableBoundaryKind(kind)) return undefined;
  return { boundaryId: id, kind, localId, label: boundaryDisplayName(project, kind, localId) };
}

export function setCanvasSelection(state: CanvasSelectionState | undefined, copyReference = false): void {
  canvasSelectionState = state && state.chain.length > 0 ? state : undefined;
  const selection = canvasSelectionState ? canvasSelectionPayload(canvasSelectionState) : undefined;
  renderCanvasSelection();
  publishCanvasSelection(selection);
  if (selection && copyReference) {
    void copyText(selectionReference(selection)).then(() => flashSelectionHint('Reference copied'));
  }
}

function canvasSelectionPayload(state: CanvasSelectionState): BlueprintCanvasSelection {
  const [target, ...context] = state.chain.slice(state.index).map(({ boundaryId: id, kind, localId, label }) => ({
    boundaryId: id,
    kind,
    localId,
    label
  }));
  return { ...target, context, ...state.frame };
}

function publishCanvasSelection(selection: BlueprintCanvasSelection | undefined): void {
  const runtime = window.__BLUEPRINT_LIVE_RUNTIME__;
  if (!runtime?.selectionPath || !runtime.canvasToken) return;
  const request = {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Blueprint-Canvas-Token': runtime.canvasToken },
    body: JSON.stringify({ selection: selection ?? null })
  };
  selectionPublishQueue = selectionPublishQueue
    .then(() => fetch(runtime.selectionPath!, request))
    .then(() => undefined, () => undefined);
}

function flashSelectionHint(text: string): void {
  selectionHint.textContent = text;
  if (selectionHintTimer !== undefined) window.clearTimeout(selectionHintTimer);
  selectionHintTimer = window.setTimeout(() => {
    selectionHint.textContent = '';
  }, 1_400);
}

export function renderCanvasSelection(): void {
  const generation = ++selectionRenderGeneration;
  for (const layer of document.querySelectorAll('.bp-chrome-selection-layer')) layer.remove();
  for (const element of document.querySelectorAll('.bp-chrome-selected')) element.classList.remove('bp-chrome-selected');
  renderSelectionBar();
  const state = canvasSelectionState;
  const root = activeBoardId ? boardState.get(activeBoardId)?.root : undefined;
  if (!state || !root) return;
  const node = state.chain[state.index];
  const scope = state.frameKey
    ? [...root.querySelectorAll<HTMLElement>('.frame-slot')].find(slot => selectionFrameKey(slot) === state.frameKey)
    : root;
  if (!scope) return;
  if (node.instance === undefined) {
    const element = findBoundaryElement(scope, node.boundaryId) ?? (node.kind === 'screen' ? scope.querySelector<HTMLElement>('.frame') : null);
    element?.classList.add('bp-chrome-selected');
    return;
  }
  const host = scope.querySelector<HTMLElement>('.canonical-prototype-screen');
  if (!host) return;
  const draw = (extent: BoundaryExtent | undefined): void => {
    if (generation !== selectionRenderGeneration || !extent || !host.isConnected) return;
    const layer = el('div', 'bp-chrome-selection-layer');
    layer.setAttribute('aria-hidden', 'true');
    layer.dataset.selectionBoundaryId = node.boundaryId;
    const box = el('div', 'bp-chrome-selection-box');
    box.style.left = `${extent.left}px`;
    box.style.top = `${extent.top}px`;
    box.style.width = `${extent.right - extent.left}px`;
    box.style.height = `${extent.bottom - extent.top}px`;
    layer.append(box);
    host.append(layer);
  };
  const instance = node.instance;
  const iframe = mountedPrototypeIframe(host);
  const html = iframe ? prototypeDocument(iframe) : undefined;
  if (state.measuredHost === host && node.extent) {
    draw(node.extent);
  } else if (html) {
    void readPrototypeTwin(html, host.clientWidth, host.clientHeight, twinDocument => (
      measureBoundaryInstance(twinDocument, node.boundaryId, instance)
    ), undefined).then(draw);
  }
}

function renderSelectionBar(): void {
  const state = canvasSelectionState;
  selectionBar.hidden = !state;
  selectionPath.replaceChildren();
  if (!state) return;
  for (let index = state.chain.length - 1; index >= 0; index -= 1) {
    const node = state.chain[index];
    const crumb = el('button', 'bp-chrome-selection-crumb', node.label) as HTMLButtonElement;
    crumb.type = 'button';
    crumb.title = `${node.kind}:${node.localId}`;
    crumb.dataset.selectionBoundaryId = node.boundaryId;
    crumb.setAttribute('aria-pressed', String(index === state.index));
    crumb.addEventListener('click', () => setCanvasSelection({ ...state, index }, true));
    selectionPath.append(crumb);
  }
}

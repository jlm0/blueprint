import './styles.css';
import { toBlob } from 'html-to-image';
import { boundaryId } from '../core/address';
import {
  activityFocusForBoundary,
  activityFocusesForChangedPaths,
  boundaryDisplayName,
  type BlueprintAgentActivityEvent,
  type BlueprintAgentActivityFocus,
  type BlueprintProjectChangedEvent,
  type BlueprintProjectErrorEvent,
  type BlueprintProjectSnapshot
} from '../core/activity';
import { changedBoundaries } from '../core/change';
import { collectDesignFindings, designFindingReference, type DesignFinding } from '../core/findings';
import { screenFrameLabel, screenRoutePath } from '../core/screen-naming';
import {
  isSelectableBoundaryKind,
  selectionReference,
  type BlueprintCanvasSelection,
  type BlueprintSelectedBoundary
} from '../core/selection';
import {
  createCanvasStyleEvidence,
  createReviewManifest,
  validateVisibleBoundaryRecords
} from '../core/review';
import type {
  BlueprintProjectBundle,
  BoardDefinition,
  BoundaryDependency,
  BoundaryKind,
  DesignToken,
  ExplorationDefinition,
  ExplorationPrototypeSource,
  FramePreset,
  PrimitiveDefinition,
  PrimitiveState,
  PrimitiveStateSet,
  ScreenDefinition,
  TokenGroup
} from '../core/types';
import type { VisibleBoundaryRecord } from '../core/review';
import { createCanvasController, type CanvasController, type CanvasView } from './canvas-controller';
import { createCanvasItemLayout } from './canvas-layout';
import {
  boundaryHitsAtPoint,
  measureBoundaryExtents,
  measureBoundaryInstance,
  type BoundaryExtent
} from './boundary-extent';
import { loadConfiguredProject } from './fixture-projects';
import { createConfiguredProjectBundle } from '../core/bundle';
import {
  compilePrototypeDocument,
  selectPrototypeReviewCondition,
  type PrototypeReviewSelectionRequest,
  type SelectedPrototypeReviewCondition
} from '../prototype/compiler';
import { applyPrototypeIframeIsolation } from '../prototype/host-policy';

type BoardId = 'primitives' | 'screens';

interface MountedBoard {
  root: HTMLElement;
  mounted: BoardMount;
  view: CanvasView | null;
}

interface BoardMount {
  configure: () => CanvasController;
  fit: () => void;
}

interface BoardConfig {
  label: string;
  className: string;
  mount: (context: BoardContext) => BoardMount;
}

interface BoardContext {
  root: HTMLElement;
  canvas: CanvasController;
  project: BlueprintProjectBundle;
}

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Blueprint app root is missing.');
}

let project = loadConfiguredProject();
const shell = el('div');
shell.id = 'app-shell';
shell.className = 'bp-chrome-shell';

const switcher = el('nav', 'board-switcher bp-chrome-board-switcher');
switcher.setAttribute('aria-label', 'Blueprint boards');

const flowSwitcher = el('nav', 'flow-switcher bp-chrome-flow-switcher');
flowSwitcher.setAttribute('aria-label', 'Screen flows');
flowSwitcher.hidden = true;

const explorationNavigator = el('nav', 'bp-chrome-exploration-nav');
explorationNavigator.setAttribute('aria-label', 'Exploration navigation');
explorationNavigator.hidden = true;
const explorationBackButton = el('button', 'bp-chrome-exploration-back', '← Screens') as HTMLButtonElement;
explorationBackButton.type = 'button';
explorationBackButton.addEventListener('click', exitFocusedReview);
const explorationTitle = el('span', 'bp-chrome-exploration-title');
explorationNavigator.append(explorationBackButton, explorationTitle);

const viewport = el('main');
viewport.id = 'viewport';
viewport.className = 'bp-chrome-viewport';
viewport.setAttribute('aria-label', 'Blueprint canvas');

const world = el('div');
world.id = 'world';
viewport.append(world);
shell.append(switcher, flowSwitcher, explorationNavigator, viewport);
app.append(shell);

const canvas = createCanvasController({
  viewport,
  world,
  minScale: 0.08,
  fallbackWidth: 320,
  fallbackHeight: 260
});
const prototypeDocumentByFrame = new WeakMap<HTMLIFrameElement, string>();

// Quiet chrome verb: jump back out to a fitted view of the active board.
const fitButton = el('button', 'bp-chrome-fit') as HTMLButtonElement;
fitButton.type = 'button';
fitButton.title = 'Zoom to fit the canvas';
fitButton.setAttribute('aria-label', 'Zoom to fit the canvas');
fitButton.innerHTML = `${fitIcon()}<span>Fit</span>`;
fitButton.addEventListener('click', () => {
  if (activeBoardId) {
    boardState.get(activeBoardId)?.mounted.fit();
  }
});
shell.append(fitButton);

const agentStatus = el('div', 'bp-chrome-agent-status');
agentStatus.hidden = true;
agentStatus.setAttribute('role', 'status');
agentStatus.setAttribute('aria-live', 'polite');
const agentStatusMark = el('span', 'bp-chrome-agent-status-mark');
agentStatusMark.setAttribute('aria-hidden', 'true');
for (let index = 0; index < 9; index += 1) {
  const dot = el('span', 'bp-chrome-agent-status-dot');
  dot.style.setProperty('--bp-agent-dot-index', String(index));
  dot.style.setProperty('--bp-agent-dot-hue', String(206 + (index * 7)));
  agentStatusMark.append(dot);
}
const agentStatusLabel = el('span', 'bp-chrome-agent-status-label');
agentStatus.append(agentStatusMark, agentStatusLabel);
shell.append(agentStatus);

const selectionBar = el('div', 'bp-chrome-selection');
selectionBar.hidden = true;
selectionBar.setAttribute('role', 'group');
selectionBar.setAttribute('aria-label', 'Canvas selection');
const selectionPath = el('div', 'bp-chrome-selection-path');
const selectionHint = el('span', 'bp-chrome-selection-hint');
selectionHint.setAttribute('aria-live', 'polite');
const selectionClear = el('button', 'bp-chrome-selection-clear', '×') as HTMLButtonElement;
selectionClear.type = 'button';
selectionClear.title = 'Clear selection';
selectionClear.setAttribute('aria-label', 'Clear selection');
selectionClear.addEventListener('click', () => setCanvasSelection(undefined));
selectionBar.append(selectionPath, selectionHint, selectionClear);
shell.append(selectionBar);

const changeBar = el('div', 'bp-chrome-changes');
changeBar.hidden = true;
changeBar.setAttribute('role', 'group');
changeBar.setAttribute('aria-label', 'Latest changes');
const changeLabel = el('span', 'bp-chrome-changes-label');
const changeToggle = el('button', 'bp-chrome-changes-toggle', 'Before') as HTMLButtonElement;
changeToggle.type = 'button';
changeToggle.title = 'Show the canvas before these changes';
changeToggle.setAttribute('aria-pressed', 'false');
changeToggle.addEventListener('click', () => queueChangeBaselineView(!viewingChangeBaseline));
const changeDismiss = el('button', 'bp-chrome-changes-dismiss', '×') as HTMLButtonElement;
changeDismiss.type = 'button';
changeDismiss.title = 'Dismiss change markers';
changeDismiss.setAttribute('aria-label', 'Dismiss change markers');
changeDismiss.addEventListener('click', dismissChanges);
changeBar.append(el('span', 'bp-chrome-changes-mark'), changeLabel, changeToggle, changeDismiss);
shell.append(changeBar);

const findingsPanel = el('aside', 'bp-chrome-findings');
findingsPanel.hidden = true;
findingsPanel.setAttribute('aria-label', 'Design findings');
shell.append(findingsPanel);

const boardConfigs: Record<BoardId, BoardConfig> = {
  primitives: {
    label: 'Primitives',
    className: 'board-root board-primitives',
    mount: mountPrimitives
  },
  screens: {
    label: 'Screens',
    className: 'board-root board-screens',
    mount: mountScreens
  }
};

const boardState = new Map<BoardId, MountedBoard>();
let activeBoardId: BoardId | null = null;

// Screens board flow subpages: one pill per declared flow; each subpage is a
// fresh canvas showing only that flow's frames. The first flow is the default
// canvas — grouping is intentional, there is no catch-all page.
let screenFlows = projectScreenFlows(project);
let activeScreenFlow: string | null = null;

function projectScreenFlows(bundle: BlueprintProjectBundle): string[] {
  return [...new Set(
    bundle.screens.screens
      .map(screen => screen.flow)
      .filter((flow): flow is string => typeof flow === 'string' && flow.length > 0)
  )];
}

function refreshBoardSwitcher(): void {
  switcher.replaceChildren();
  for (const board of project.manifest.boards.filter(isVisibleBoard)) {
    const button = el('button', '', board.name) as HTMLButtonElement;
    button.type = 'button';
    button.dataset.board = board.id;
    button.setAttribute('aria-pressed', String(board.id === activeBoardId));
    button.addEventListener('click', () => showBoard(board.id));
    switcher.append(button);
  }
}

function refreshFlowSwitcher(): void {
  flowSwitcher.replaceChildren();
  if (screenFlows.length === 0) return;
  flowSwitcher.append(el('span', 'bp-chrome-flow-label', 'Pages'));
  for (const flow of screenFlows) {
    const button = el('button', '', flow) as HTMLButtonElement;
    button.type = 'button';
    button.dataset.flow = flow;
    button.addEventListener('click', () => setScreenFlow(flow));
    flowSwitcher.append(button);
  }
  refreshFlowPills();
}

function requestedScreenFlow(): string | null {
  const param = new URLSearchParams(location.search).get('flow');
  return param && screenFlows.includes(param) ? param : null;
}

function refreshFlowPills(): void {
  flowSwitcher.querySelectorAll<HTMLButtonElement>('[data-flow]').forEach(button => {
    button.setAttribute('aria-pressed', String((button.dataset.flow || null) === activeScreenFlow));
  });
}

function setScreenFlow(flow: string): void {
  activeScreenFlow = flow;
  const url = new URL(window.location.href);
  url.searchParams.set('flow', flow);
  history.replaceState(null, '', url);
  refreshFlowPills();
  remountBoard('screens');
}

function explorationIsRequested(): boolean {
  return new URLSearchParams(location.search).has('exploration');
}

function historyIsRequested(): boolean {
  return new URLSearchParams(location.search).has('history');
}

function focusedReviewIsRequested(): boolean {
  return explorationIsRequested() || historyIsRequested();
}

function requestedExplorationId(): string {
  return new URLSearchParams(location.search).get('exploration') ?? '';
}

function exitFocusedReview(): void {
  const exploration = project.explorations.explorations.find(candidate => candidate.id === requestedExplorationId());
  const historyScreen = project.screens.screens.find(candidate => (
    candidate.id === (new URLSearchParams(location.search).get('history') ?? '')
  ));
  const targetFlow = exploration?.target.baseline.screen.flow ?? historyScreen?.flow;
  const url = new URL(window.location.href);
  url.searchParams.delete('exploration');
  url.searchParams.delete('history');
  url.searchParams.delete('state');
  url.searchParams.delete('viewport');
  if (targetFlow && screenFlows.includes(targetFlow)) {
    activeScreenFlow = targetFlow;
    url.searchParams.set('flow', targetFlow);
  } else {
    activeScreenFlow = screenFlows[0] ?? null;
    url.searchParams.delete('flow');
  }
  history.replaceState(null, '', url);
  refreshFlowPills();
  remountBoard('screens');
}

function openExploration(explorationId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('board', 'screens');
  url.searchParams.set('exploration', explorationId);
  url.searchParams.delete('history');
  url.searchParams.delete('state');
  url.searchParams.delete('viewport');
  history.replaceState(null, '', url);
  remountBoard('screens');
}

function openHistory(screenId: string, state: string, framePresetId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('board', 'screens');
  url.searchParams.set('history', screenId);
  url.searchParams.set('state', state);
  url.searchParams.set('viewport', framePresetId);
  url.searchParams.delete('exploration');
  history.replaceState(null, '', url);
  remountBoard('screens');
}

activeScreenFlow = requestedScreenFlow() ?? screenFlows[0] ?? null;
refreshBoardSwitcher();
refreshFlowSwitcher();

const requestedBoard = new URLSearchParams(location.search).get('board');
const defaultBoard = isBoardId(project.manifest.defaultBoardId) ? project.manifest.defaultBoardId : 'primitives';

function showBoard(id: BoardId): void {
  const config = boardConfigs[id];
  if (!config) {
    return;
  }

  if (activeBoardId) {
    const current = boardState.get(activeBoardId);
    if (current) {
      current.view = canvas.snapshot();
      current.root.hidden = true;
    }
  }

  const state = ensureBoard(id, config);
  state.root.hidden = false;
  state.mounted.configure();
  activeBoardId = id;

  switcher.querySelectorAll<HTMLButtonElement>('[data-board]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.board === id));
  });
  const showingFocusedReview = id === 'screens' && focusedReviewIsRequested();
  flowSwitcher.hidden = id !== 'screens' || screenFlows.length === 0 || showingFocusedReview;
  explorationNavigator.hidden = !showingFocusedReview;

  const url = new URL(window.location.href);
  url.searchParams.set('board', id);
  history.replaceState(null, '', url);

  if (state.view) {
    canvas.setView(state.view);
  } else {
    requestAnimationFrame(() => state.mounted.fit());
  }

  refreshCanvasReviewState(id);
  renderCanvasAnnotations();
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
  world.append(root);

  const mounted = config.mount({ root, canvas, project });
  const state: MountedBoard = { root, mounted, view: null };
  boardState.set(id, state);
  return state;
}

// Rebuilds a board from scratch (used when the screens flow subpage changes);
// the fresh mount refits instead of restoring a stale canvas view.
function remountBoard(id: BoardId): void {
  const existing = boardState.get(id);
  if (existing) {
    existing.root.remove();
    boardState.delete(id);
  }
  if (activeBoardId === id) {
    activeBoardId = null;
    showBoard(id);
  }
}

async function replaceMountedBoard(id: BoardId): Promise<void> {
  const current = boardState.get(id);
  if (!current) return;
  const config = boardConfigs[id];
  const isActive = activeBoardId === id;
  const view = isActive ? canvas.snapshot() : current.view;
  const nextRoot = el('section', `${config.className} bp-chrome-live-board-next`);
  nextRoot.dataset.boardRoot = id;
  nextRoot.hidden = !isActive;
  nextRoot.setAttribute('aria-label', config.label);
  nextRoot.setAttribute('aria-busy', 'true');
  nextRoot.style.visibility = 'hidden';
  world.append(nextRoot);
  const mounted = config.mount({ root: nextRoot, canvas, project });
  if (isActive) await waitForPrototypeFrames(nextRoot);

  current.root.remove();
  nextRoot.style.removeProperty('visibility');
  nextRoot.removeAttribute('aria-busy');
  nextRoot.classList.remove('bp-chrome-live-board-next');
  nextRoot.classList.add('bp-chrome-live-board-enter');
  const nextState: MountedBoard = { root: nextRoot, mounted, view };
  boardState.set(id, nextState);
  if (isActive) {
    mounted.configure();
    if (view) canvas.setView(view);
    refreshCanvasReviewState(id);
    renderCanvasAnnotations();
  }
}

async function waitForPrototypeFrames(root: HTMLElement): Promise<void> {
  const frames = [...root.querySelectorAll<HTMLIFrameElement>('iframe.canonical-prototype-iframe')];
  if (frames.length === 0) return;
  await Promise.race([
    Promise.all(frames.map(frame => new Promise<void>(resolve => {
      frame.addEventListener('load', () => resolve(), { once: true });
    }))),
    new Promise<void>(resolve => window.setTimeout(resolve, 500))
  ]);
}

function mountPrimitives({ root, canvas: boardCanvas, project: bundle }: BoardContext): BoardMount {
  const configure = (): CanvasController =>
    boardCanvas.configure({
      minScale: 0.08,
      readableScale: 0.55,
      fallbackWidth: 400,
      fallbackHeight: 240
    });
  const controller = configure();
  const layout = createCanvasItemLayout(root, {
    selector: '.group-head, .spec',
    chipClearance: 38,
    stackGap: 34,
    horizontalGap: 24,
    fallbackWidth: 400,
    fallbackHeight: 220
  });
  const tokenIndex = createTokenIndex(bundle);

  addGroupHeading(root, controller, {
    title: 'Tokens',
    subtitle: `${bundle.tokens.tokenGroups.length} app-owned groups`,
    x: 70,
    y: 300,
    accent: 'var(--bp-sample-accent-token)'
  });
  bundle.tokens.tokenGroups.forEach((group, index) => {
    addTokenGroupCard(root, controller, bundle, tokenIndex, group, {
      x: 70,
      y: 380 + index * 250,
      width: 460
    });
  });

  const groupedPrimitives = groupPrimitivesByFamily(bundle.primitives.primitives);
  // Related families share one column and stack vertically (all form controls
  // together, feedback together, overlays together) instead of one endless
  // horizontal row of single-family columns. Per-primitive chips carry the
  // identity, so columns need no group headings.
  const byFamily = new Map(groupedPrimitives.map(group => [group.family, group.primitives]));
  const claimedFamilies = new Set<string>();
  const familyColumns: string[][] = [];
  for (const planned of FAMILY_COLUMN_GROUPS) {
    const present = planned.filter(family => byFamily.has(family));
    if (present.length > 0) {
      familyColumns.push(present);
      present.forEach(family => claimedFamilies.add(family));
    }
  }
  for (const group of groupedPrimitives) {
    if (!claimedFamilies.has(group.family)) {
      familyColumns.push([group.family]);
    }
  }
  // Height autofits arrive per iframe; reflow synchronously with each one so
  // positions are never stale between a resize and its repack. Column x
  // positions are recomputed from measured card widths so cards that grew to
  // fit their content never clip or overlap a neighboring group.
  const columnCards: HTMLElement[][] = [];
  const refit = (): void => {
    if (root.hidden) {
      return;
    }
    let columnX = 650;
    for (const cards of columnCards) {
      const width = Math.max(...cards.map(card => card.offsetWidth || 400));
      for (const card of cards) {
        card.dataset.layoutX = String(columnX);
        card.style.left = `${columnX}px`;
      }
      columnX += width + 64;
    }
    controller.fitTo(layout.reflow());
  };
  let columnX = 650;
  for (const columnFamilies of familyColumns) {
    const width = Math.max(
      ...columnFamilies.flatMap(family =>
        (byFamily.get(family) ?? []).map(primitive =>
          primitive.prototype ? canonicalSpecimenCardWidth(family, primitive) : familyWidth(family)
        )
      )
    );
    const x = columnX;
    columnX += width + 64;
    let stackY = 380;
    const cardsInColumn: HTMLElement[] = [];
    columnCards.push(cardsInColumn);
    for (const family of columnFamilies) {
      for (const primitive of byFamily.get(family) ?? []) {
        const cardWidth = primitive.prototype ? canonicalSpecimenCardWidth(family, primitive) : width;
        const card = addPrimitiveDefinitionCard(root, controller, bundle, tokenIndex, primitive, family, {
          x,
          y: stackY,
          width: cardWidth
        }, refit);
        cardsInColumn.push(card);
        stackY += 280;
      }
    }
  }

  if (document.fonts?.ready) {
    void document.fonts.ready.then(() => {
      refit();
    });
  }

  return {
    configure,
    fit: () => controller.fitTo(layout.reflow())
  };
}

interface TokenRecord {
  ref: string;
  group: TokenGroup;
  token: DesignToken;
}

interface TokenIndex {
  byRef: Map<string, TokenRecord>;
  byGroup: Map<string, TokenGroup>;
}

interface PositionedCard {
  x: number;
  y: number;
  width: number;
}

interface FamilyGroup {
  family: string;
  primitives: PrimitiveDefinition[];
}

interface PrimitiveRenderContext {
  bundle: BlueprintProjectBundle;
  tokenIndex: TokenIndex;
  primitive: PrimitiveDefinition;
  family: string;
  onSpecimenResize?: () => void;
}

interface TokenApplicationOptions {
  colorHook?: string;
  colorProperty?: 'background' | 'border' | 'text';
  colorFromStateOnly?: boolean;
  spaceHook?: string;
  radiusHook?: string;
  typographyHook?: string;
  shadowHook?: string;
  shadowFromStateOnly?: boolean;
  foregroundFallbackFromGroups?: boolean;
  motionHook?: string;
}

const FAMILY_ORDER = [
  'button',
  'input',
  'select',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'text',
  'surface',
  'card',
  'media',
  'navigation',
  'tabs',
  'separator',
  'list',
  'row',
  'loading',
  'badge',
  'icon',
  'avatar',
  'skeleton',
  'toast',
  'tooltip',
  'alert',
  'dialog',
  'menu',
  'sheet',
  'generic'
];

/**
 * Board column grouping: related families stack vertically in one shared
 * column so the primitives board reads as a handful of organized groups
 * instead of one long horizontal strip. Families not listed here (app-added)
 * fall through to their own trailing columns in FAMILY_ORDER order.
 */
const FAMILY_COLUMN_GROUPS: string[][] = [
  ['button'],
  ['input', 'select', 'checkbox', 'radio', 'switch', 'slider'],
  ['text'],
  ['surface', 'card', 'media'],
  ['navigation', 'tabs'],
  ['separator', 'list', 'row'],
  ['loading', 'badge', 'icon', 'avatar', 'skeleton', 'toast', 'tooltip', 'alert'],
  ['dialog', 'menu', 'sheet']
];

function createTokenIndex(bundle: BlueprintProjectBundle): TokenIndex {
  const byRef = new Map<string, TokenRecord>();
  const byGroup = new Map<string, TokenGroup>();
  for (const group of bundle.tokens.tokenGroups) {
    byGroup.set(group.id, group);
    for (const token of group.tokens) {
      byRef.set(`${group.id}.${token.id}`, {
        ref: `${group.id}.${token.id}`,
        group,
        token
      });
    }
  }
  return { byRef, byGroup };
}

function addTokenGroupCard(
  root: HTMLElement,
  controller: CanvasController,
  bundle: BlueprintProjectBundle,
  tokenIndex: TokenIndex,
  group: TokenGroup,
  position: PositionedCard
): HTMLElement {
  const card = createSpecCard({
    label: `TOKEN · ${group.name}`,
    x: position.x,
    y: position.y,
    width: position.width,
    accent: familyAccent('token'),
    boundary: ['token-group', group.id, bundle.manifest.project.id]
  });
  card.dataset.boundarySummary = group.description;
  card.dataset.tokenGroup = group.id;

  const body = appendSpecBody(card);
  const header = el('div', 'generated-card-head');
  header.append(el('strong', '', group.name), el('span', '', group.description));
  body.append(header);

  const grid = el('div', 'token-grid');
  for (const token of group.tokens) {
    grid.append(createTokenRow(tokenIndex, group, token));
  }
  body.append(grid);

  if (group.notes.length > 0) {
    body.append(el('p', 'spec-note', group.notes[0] ?? ''));
  }

  root.append(card);
  controller.makeDraggable(card, card.querySelector<HTMLElement>('.spec-chip') ?? card);
  return card;
}

function createTokenRow(tokenIndex: TokenIndex, group: TokenGroup, token: DesignToken): HTMLElement {
  const row = el('div', `token-row token-row-${token.type}`);
  row.dataset.tokenType = token.type;
  const tokenRef = `${group.id}.${token.id}`;
  setTokenHook(row, tokenIndex.byRef.get(tokenRef), `${token.type}-token-row`);

  const sample = el('span', 'token-sample');
  applyTokenPreview(sample, token, tokenIndex);
  const meta = el('span', 'token-meta');
  meta.append(el('b', '', token.name), el('span', '', `${tokenRef} · ${token.value}`));
  row.append(sample, meta);
  return row;
}

function addPrimitiveDefinitionCard(
  root: HTMLElement,
  controller: CanvasController,
  bundle: BlueprintProjectBundle,
  tokenIndex: TokenIndex,
  primitive: PrimitiveDefinition,
  family: string,
  position: PositionedCard,
  onSpecimenResize?: () => void
): HTMLElement {
  const card = createSpecCard({
    label: primitive.name,
    x: position.x,
    y: position.y,
    width: position.width,
    accent: familyAccent(family),
    boundary: ['primitive', primitive.id, bundle.manifest.project.id]
  });
  card.dataset.boundarySummary = primitive.description;
  card.dataset.primitiveFamily = family;

  const body = appendSpecBody(card);
  body.classList.add('primitive-specimen-body');
  if (primitive.prototype) {
    body.classList.add('primitive-specimen-body-canonical');
    // Canonical cards hug their measured grid; column positions are recomputed
    // from real widths on every refit.
    card.style.width = 'max-content';
  }
  body.append(renderPrimitiveSpecimen({ bundle, tokenIndex, primitive, family, ...(onSpecimenResize ? { onSpecimenResize } : {}) }));

  root.append(card);
  controller.makeDraggable(card, card.querySelector<HTMLElement>('.spec-chip') ?? card);
  return card;
}

const primitiveFamilyRenderers: Record<string, (context: PrimitiveRenderContext) => HTMLElement> = {
  button: renderButtonPrimitive,
  input: renderInputPrimitive,
  checkbox: renderCheckboxPrimitive,
  switch: renderSwitchPrimitive,
  slider: renderSliderPrimitive,
  surface: renderSurfacePrimitive,
  card: renderCardPrimitive,
  media: renderMediaPrimitive,
  navigation: renderNavigationPrimitive,
  separator: renderSeparatorPrimitive,
  list: renderListPrimitive,
  row: renderRowPrimitive,
  loading: renderLoadingPrimitive,
  badge: renderBadgePrimitive,
  icon: renderIconPrimitive,
  skeleton: renderSkeletonPrimitive,
  dialog: renderDialogPrimitive,
  menu: renderMenuPrimitive,
  sheet: renderSheetPrimitive
};

function renderPrimitiveSpecimen(context: PrimitiveRenderContext): HTMLElement {
  if (context.primitive.prototype) {
    return renderCanonicalPrimitiveSpecimen(context);
  }
  const fallback = primitiveFamilyRenderers[context.family]?.(context) ?? renderGenericPrimitiveCard(context);
  fallback.dataset.prototypeRenderMode = 'legacy-fallback';
  fallback.dataset.prototypeRenderLabel = 'Legacy family fallback';
  return fallback;
}

function renderCanonicalPrimitiveSpecimen(context: PrimitiveRenderContext): HTMLElement {
  const root = el('div', 'canonical-primitive-specimen');
  root.dataset.prototypeRenderMode = 'canonical-app-owned';
  const states = context.primitive.prototype?.states ?? [];
  const variants = context.primitive.prototype?.variants ?? [];
  // Specimens review on the app's own canvas color, not on a Blueprint-drawn
  // surface: the stage is the only surface, cells stay transparent.
  const stage = el('div', 'canonical-primitive-stage');
  const canvasColor = findTokenValue(context.bundle, ['background']);
  const labelColor = findTokenValue(context.bundle, ['text-muted', 'muted', 'text-secondary']);
  if (canvasColor) {
    stage.style.setProperty('--stage-bg', canvasColor);
  }
  if (labelColor) {
    stage.style.setProperty('--stage-fg', labelColor);
  }
  // Every canonical primitive renders as the same review grid: one header row
  // naming the states, then one content row per variant. Cells keep their
  // natural family size and the container hugs the grid — never the reverse.
  const rowLabels = variants.length > 0 ? variants : ['default'];
  const matrix = el('div', 'canonical-primitive-matrix');
  matrix.style.setProperty('--matrix-cols', String(states.length));
  matrix.style.setProperty('--cell-w', `${primitiveCellWidth(context.family, context.primitive.id)}px`);
  matrix.append(el('p', 'canonical-prototype-state-label canonical-primitive-matrix-corner', 'type'));
  for (const state of states) {
    matrix.append(el('p', 'canonical-prototype-state-label canonical-primitive-col-label', state));
  }
  for (const variant of rowLabels) {
    matrix.append(el('p', 'canonical-primitive-variant-label', variant));
    for (const state of states) {
      matrix.append(createCanonicalPrimitiveCell(context, state, variants.length > 0 ? variant : undefined));
    }
  }
  for (const size of context.primitive.prototype?.sizes ?? []) {
    matrix.append(el('p', 'canonical-primitive-variant-label', `size ${size}`));
    for (const state of states) {
      matrix.append(createCanonicalPrimitiveCell(context, state, undefined, size));
    }
  }
  stage.append(matrix);
  root.append(stage);
  return root;
}

function findTokenValue(bundle: BlueprintProjectBundle, tokenIds: string[]): string | undefined {
  const colorGroup = bundle.tokens.tokenGroups.find(group => group.id === 'color');
  for (const id of tokenIds) {
    const token = colorGroup?.tokens.find(candidate => candidate.id === id);
    if (token) {
      return token.value;
    }
  }
  return undefined;
}

function createCanonicalPrimitiveCell(context: PrimitiveRenderContext, state: string, variant?: string, size?: string): HTMLElement {
  const item = el('section', 'canonical-primitive-state canonical-primitive-cell');
  try {
    const compiled = compilePrototypeDocument({
      bundle: context.bundle,
      target: { kind: 'primitive', id: context.primitive.id },
      state,
      ...(variant ? { variant } : {}),
      ...(size ? { size } : {})
    });
    const iframe = document.createElement('iframe');
    iframe.className = 'canonical-primitive-iframe';
    applyPrototypeIframeIsolation(iframe);
    iframe.title = `${context.primitive.name} · ${variant ? `${variant} · ` : ''}${size ? `size ${size} · ` : ''}${state}`;
    iframe.srcdoc = compiled.html;
    prototypeDocumentByFrame.set(iframe, compiled.html);
    iframe.dataset.prototypeTargetBoundary = compiled.targetBoundaryId;
    iframe.dataset.prototypeObservedUses = JSON.stringify(compiled.observedUses);
    item.append(iframe);
    // The visible frame keeps its empty-permission sandbox, so its content is
    // measured through an ephemeral offscreen twin instead; the twin renders
    // the same CSP-locked no-script document and is removed immediately.
    measureCanonicalCellSize(compiled.html, primitiveCellWidth(context.family, context.primitive.id), size => {
      iframe.style.width = `${size.width}px`;
      iframe.style.height = `${size.height}px`;
      context.onSpecimenResize?.();
    });
  } catch (error) {
    item.append(createPrototypeCompileError(error));
  }
  return item;
}

/**
 * Fits a specimen cell to its rendered control so the review cell hugs the
 * content instead of clipping or stretching it. The family width is the floor
 * (keeps grid columns uniform); content that runs wider grows its own cell.
 * Full-bleed controls (width:100% roots) measure at the floor and keep it.
 */
function measureCanonicalCellSize(
  html: string,
  fallbackWidth: number,
  done: (size: { width: number; height: number }) => void
): void {
  const probe = document.createElement('iframe');
  probe.style.cssText = `position:absolute;left:-10000px;top:0;width:${fallbackWidth}px;height:88px;border:0;visibility:hidden;`;
  probe.setAttribute('aria-hidden', 'true');
  probe.addEventListener('load', () => {
    try {
      const control = probe.contentDocument?.querySelector<HTMLElement>('[data-blueprint-primitive]') ?? probe.contentDocument?.body;
      const rect = control?.getBoundingClientRect();
      const measuredWidth = rect ? Math.ceil(rect.width) + 24 : fallbackWidth;
      const measuredHeight = rect ? Math.ceil(rect.height) + 24 : 88;
      done({
        width: Math.max(fallbackWidth, Math.min(520, measuredWidth)),
        height: Math.min(280, Math.max(40, measuredHeight))
      });
    } catch {
      // Keep the default cell size when the document cannot be measured.
    } finally {
      probe.remove();
    }
  });
  probe.srcdoc = html;
  document.body.append(probe);
}

/**
 * Natural review-cell width per primitive family, mirroring the reference
 * canvas: small centered cells for compact controls, wider cells for fields,
 * rows, and panels. Column headers align over these cells.
 */
function familyCellWidth(family: string): number {
  const widths: Record<string, number> = {
    button: 160,
    input: 190,
    select: 190,
    checkbox: 120,
    radio: 120,
    switch: 120,
    slider: 180,
    text: 240,
    surface: 240,
    card: 240,
    media: 240,
    navigation: 280,
    tabs: 300,
    separator: 200,
    list: 260,
    row: 260,
    loading: 120,
    badge: 96,
    icon: 96,
    avatar: 96,
    skeleton: 220,
    toast: 240,
    tooltip: 160,
    alert: 300,
    dialog: 240,
    menu: 240,
    sheet: 240
  };
  return widths[family] ?? 200;
}

/** Primitives whose natural footprint exceeds their family's default cell. */
const PRIMITIVE_CELL_WIDTH_OVERRIDES: Record<string, number> = {
  'otp-input': 344,
  'table-row': 440,
  progress: 240
};

function primitiveCellWidth(family: string, primitiveId: string): number {
  return PRIMITIVE_CELL_WIDTH_OVERRIDES[primitiveId] ?? familyCellWidth(family);
}

/** Width a canonical specimen card needs to hug its review grid. */
function canonicalSpecimenCardWidth(family: string, primitive: PrimitiveDefinition): number {
  const cols = Math.max(1, primitive.prototype?.states.length ?? 1);
  return 28 + 104 + 8 + cols * (primitiveCellWidth(family, primitive.id) + 8) + 4;
}

function renderVisualStateSets(
  context: PrimitiveRenderContext,
  renderStateSet: (stateSet: PrimitiveStateSet) => HTMLElement
): HTMLElement {
  const root = el('div', `primitive-visual primitive-visual-${context.family}`);
  root.dataset.primitiveRenderer = context.family;

  if (context.primitive.stateSets.length === 0) {
    root.append(renderStateSetContentWithoutBoundary(renderStateSet, syntheticDefaultStateSet(context)));
    return root;
  }

  for (const stateSet of context.primitive.stateSets) {
    root.append(createVisualStateSetSection(context, stateSet, renderStateSet(stateSet)));
  }
  return root;
}

function createVisualStateSetSection(context: PrimitiveRenderContext, stateSet: PrimitiveStateSet, content: HTMLElement): HTMLElement {
  const section = el('section', 'primitive-state-set visual-state-set');
  setBoundary(section, 'state-set', `${context.primitive.id}/${stateSet.id}`, context.bundle.manifest.project.id, stateSet.name);
  section.dataset.boundarySummary = stateSet.description;
  section.append(el('div', 'visual-state-caption', stateSet.name), content);
  return section;
}

function renderStateSetContentWithoutBoundary(
  renderStateSet: (stateSet: PrimitiveStateSet) => HTMLElement,
  stateSet: PrimitiveStateSet
): HTMLElement {
  const wrapper = el('div', 'visual-state-set visual-state-set-unbound');
  wrapper.append(renderStateSet(stateSet));
  return wrapper;
}

function createButtonStateStrip(context: PrimitiveRenderContext, stateSet: PrimitiveStateSet): HTMLElement {
  const grid = el('div', 'state-specimen-grid button-specimen-grid');
  for (const state of stateSet.states) {
    grid.append(createButtonSpecimen(context, state, state.name));
  }
  return grid;
}

function createButtonStateMatrix(
  context: PrimitiveRenderContext,
  variantSet: PrimitiveStateSet,
  interactionSet: PrimitiveStateSet
): HTMLElement {
  const matrix = el('div', 'mx button-state-matrix visual-state-matrix');
  matrix.append(createMatrixHeader('Type', interactionSet.states.map(state => state.name)));

  for (const variant of variantSet.states) {
    const row = el('div', 'mx-row');
    row.dataset.primitiveStateId = variant.id;
    row.dataset.prototypeOnly = String(variant.prototypeOnly);
    row.append(el('div', 'mx-label', variant.name));
    for (const interaction of interactionSet.states) {
      const cell = el('div', 'mx-c');
      cell.append(createButtonMatrixCell(context, variant, interaction));
      row.append(cell);
    }
    matrix.append(row);
  }

  return matrix;
}

function createButtonMatrixCell(context: PrimitiveRenderContext, variant: PrimitiveState, interaction: PrimitiveState): HTMLButtonElement {
  const mergedState = mergeVisualStates(variant, interaction);
  const button = createButtonSpecimen(context, mergedState, 'Action');
  delete button.dataset.primitiveStateId;
  delete button.dataset.prototypeOnly;
  button.disabled = isDisabledState(interaction);
  if (variant.id.includes('gradient')) {
    const label = button.querySelector<HTMLElement>('.btn-label');
    if (label) {
      label.insertAdjacentHTML('afterbegin', sampleIcon('sparkles'));
    }
  }
  return button;
}

function createInputStateStrip(context: PrimitiveRenderContext, stateSet: PrimitiveStateSet): HTMLElement {
  const grid = el('div', 'state-specimen-grid input-specimen-grid');
  for (const state of stateSet.states) {
    grid.append(createInputSpecimen(context, state, inputStateText(state), true));
  }
  return grid;
}

function createInputStateMatrix(
  context: PrimitiveRenderContext,
  variantSet: PrimitiveStateSet,
  interactionSet: PrimitiveStateSet
): HTMLElement {
  const matrix = el('div', 'mx input-state-matrix visual-state-matrix');
  matrix.append(createMatrixHeader('Type', interactionSet.states.map(state => state.name)));

  for (const variant of variantSet.states) {
    const row = el('div', 'mx-row');
    row.dataset.primitiveStateId = variant.id;
    row.dataset.prototypeOnly = String(variant.prototypeOnly);
    row.append(el('div', 'mx-label', variant.name));
    for (const interaction of interactionSet.states) {
      const cell = el('div', 'mx-c');
      const sample = createInputSpecimen(context, mergeVisualStates(variant, interaction), inputStateText(interaction), false);
      cell.append(sample);
      row.append(cell);
    }
    matrix.append(row);
  }

  return matrix;
}

function createMatrixHeader(label: string, columns: string[]): HTMLElement {
  const row = el('div', 'mx-row mx-head-row');
  row.append(el('div', 'mx-label', label));
  for (const column of columns) {
    row.append(el('div', 'mx-h', column));
  }
  return row;
}

function createInputSpecimen(
  context: PrimitiveRenderContext,
  state: PrimitiveState,
  text: string,
  includeStateMarker: boolean
): HTMLElement {
  const sample = el('div', `inp ${inputStateClass(state)}`);
  if (includeStateMarker) {
    sample.dataset.primitiveStateId = state.id;
    sample.dataset.prototypeOnly = String(state.prototypeOnly);
  }
  const label = inputPlaceholderState(state) ? el('span', 'ph', text) : document.createTextNode(text);
  sample.append(label);
  applyPrimitiveTokenStyles(sample, context, state, {
    colorHook: 'input-border-color',
    colorProperty: 'border',
    spaceHook: 'input-padding-inline',
    radiusHook: 'input-radius',
    typographyHook: 'input-type',
    motionHook: 'input-motion'
  });
  return sample;
}

function createSurfaceLadder(context: PrimitiveRenderContext, stateSet: PrimitiveStateSet): HTMLElement {
  const stateByLevel = new Map<number, PrimitiveState>();
  for (const state of stateSet.states) {
    const level = Number.parseInt(state.id, 10);
    if (Number.isFinite(level)) {
      stateByLevel.set(level, state);
    }
  }

  const root = el('div', 'surface-ladder-specimen');
  const maxLevel = Math.max(5, ...stateByLevel.keys());
  root.append(createSurfaceLevel(context, stateSet, stateByLevel, 1, maxLevel));

  const comparison = el('div', 'surface-card-comparison');
  comparison.append(createSurfaceCardExample(context, stateSet, stateByLevel, 2), createSurfaceCardExample(context, stateSet, stateByLevel, maxLevel));
  root.append(comparison);
  return root;
}

function createSurfaceLevel(
  context: PrimitiveRenderContext,
  stateSet: PrimitiveStateSet,
  stateByLevel: Map<number, PrimitiveState>,
  level: number,
  maxLevel: number
): HTMLElement {
  const surface = el('div', 'surf surface-level');
  surface.dataset.surfaceLevel = String(level);
  surface.style.setProperty('--surface-level-bg', surfaceLevelColor(context, stateSet, stateByLevel, level));
  const state = stateByLevel.get(level);
  if (state) {
    surface.dataset.primitiveStateId = state.id;
    surface.dataset.prototypeOnly = String(state.prototypeOnly);
    applyPrimitiveTokenStyles(surface, context, state, {
      colorHook: 'surface-fill',
      colorProperty: 'background',
      radiusHook: 'surface-radius',
      shadowHook: 'surface-shadow'
    });
  }
  surface.append(createSurfaceHead(level));
  if (level < maxLevel) {
    surface.append(createSurfaceLevel(context, stateSet, stateByLevel, level + 1, maxLevel));
  }
  return surface;
}

function createSurfaceHead(level: number): HTMLElement {
  const head = el('div', 'surf-head');
  head.append(el('b', '', `Surface ${level}`), el('span', '', level === 1 ? 'base' : '+1'));
  return head;
}

function createSurfaceCardExample(
  context: PrimitiveRenderContext,
  stateSet: PrimitiveStateSet,
  stateByLevel: Map<number, PrimitiveState>,
  level: number
): HTMLElement {
  const card = el('article', 'card surface-card-example');
  card.style.setProperty('--surface-level-bg', surfaceLevelColor(context, stateSet, stateByLevel, level));
  card.append(el('strong', '', `Card on +${Math.max(1, level - 1)}`), el('p', '', `Same card, surface ${level}`));
  return card;
}

function surfaceLevelColor(
  context: PrimitiveRenderContext,
  stateSet: PrimitiveStateSet,
  stateByLevel: Map<number, PrimitiveState>,
  level: number
): string {
  const state = stateByLevel.get(level) ?? stateSet.states[stateSet.states.length - 1];
  const token = state ? firstStateToken(context.tokenIndex, state, 'color') : undefined;
  if (token) {
    const whiteMix = Math.min(28, Math.max(0, (level - 1) * 5));
    return `color-mix(in srgb, ${token.token.value} ${100 - whiteMix}%, white ${whiteMix}%)`;
  }
  return `var(--bp-sample-surface-${Math.min(8, Math.max(1, level))})`;
}

function renderButtonPrimitive(context: PrimitiveRenderContext): HTMLElement {
  if (primitiveHasTerm(context.primitive, 'back')) {
    return renderVisualStateSets(context, stateSet => {
      const grid = el('div', 'state-specimen-grid back-button-specimen-grid');
      for (const state of stateSet.states) {
        grid.append(createBackButtonSpecimen(context, state));
      }
      return grid;
    });
  }

  const variantSet = context.primitive.stateSets.find(isCommandVariantStateSet);
  const interactionSet = context.primitive.stateSets.find(isInteractionStateSet);
  if (variantSet && interactionSet && variantSet.states.length > 1 && interactionSet.states.length > 1) {
    const root = el('div', `primitive-visual primitive-visual-${context.family}`);
    root.dataset.primitiveRenderer = context.family;
    for (const stateSet of context.primitive.stateSets) {
      const content =
        stateSet === variantSet
          ? createButtonStateMatrix(context, variantSet, interactionSet)
          : createButtonStateStrip(context, stateSet);
      root.append(createVisualStateSetSection(context, stateSet, content));
    }
    return root;
  }

  return renderVisualStateSets(context, stateSet => createButtonStateStrip(context, stateSet));
}

function renderInputPrimitive(context: PrimitiveRenderContext): HTMLElement {
  if (primitiveHasTerm(context.primitive, 'otp')) {
    return renderOtpPrimitive(context);
  }

  const variantSet = context.primitive.stateSets.find(isInputVariantStateSet);
  const interactionSet = context.primitive.stateSets.find(isInteractionStateSet);
  if (variantSet && interactionSet && variantSet.states.length > 1 && interactionSet.states.length > 1) {
    const root = el('div', `primitive-visual primitive-visual-${context.family}`);
    root.dataset.primitiveRenderer = context.family;
    for (const stateSet of context.primitive.stateSets) {
      const content =
        stateSet === variantSet
          ? createInputStateMatrix(context, variantSet, interactionSet)
          : createInputStateStrip(context, stateSet);
      root.append(createVisualStateSetSection(context, stateSet, content));
    }
    return root;
  }

  return renderVisualStateSets(context, stateSet => createInputStateStrip(context, stateSet));
}

function renderOtpPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const grid = el('div', 'state-specimen-grid otp-specimen-grid');
    for (const state of stateSet.states) {
      const sample = el('div', 'otp');
      sample.dataset.primitiveStateId = state.id;
      sample.dataset.prototypeOnly = String(state.prototypeOnly);
      for (let index = 0; index < 6; index += 1) {
        const cell = el('span', `cell ${state.id === 'focused' && index === 2 ? 'is-focused' : ''}`, state.id === 'filled' ? String((index + 1) % 10) : '');
        sample.append(cell);
      }
      applyPrimitiveTokenStyles(sample, context, state, {
        colorHook: 'otp-accent',
        colorProperty: 'border',
        spaceHook: 'otp-gap',
        radiusHook: 'otp-cell-radius',
        typographyHook: 'otp-type',
        motionHook: 'otp-motion'
      });
      grid.append(sample);
    }
    return grid;
  });
}

function renderCheckboxPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderChoicePrimitive(context, 'checkbox');
}

function renderSwitchPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderChoicePrimitive(context, 'switch');
}

function renderChoicePrimitive(context: PrimitiveRenderContext, kind: 'checkbox' | 'switch'): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const grid = el('div', `state-specimen-grid ${kind}-specimen-grid`);
    for (const state of stateSet.states) {
      const sample = el('div', 'choice-specimen');
      const control = kind === 'checkbox' ? el('span', `cbx ${stateOnClass(state)} ${disabledClass(state)}`) : el('span', `sw ${stateOnClass(state)} ${disabledClass(state)}`);
      control.dataset.primitiveStateId = state.id;
      control.dataset.prototypeOnly = String(state.prototypeOnly);
      if (kind === 'switch') {
        control.append(el('span', 'sw-thumb'));
      }
      applyPrimitiveTokenStyles(control, context, state, {
        colorHook: `${kind}-accent`,
        colorProperty: 'background',
        radiusHook: `${kind}-radius`,
        motionHook: `${kind}-motion`
      });
      sample.append(control, el('span', 'choice-label', state.name));
      grid.append(sample);
    }
    return grid;
  });
}

function renderSliderPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const stack = el('div', 'slider-samples');
    stateSet.states.forEach((state, index) => {
      const row = el('div', 'slider-row');
      row.dataset.primitiveStateId = state.id;
      row.dataset.prototypeOnly = String(state.prototypeOnly);
      row.append(el('span', 'slider-label', state.name));
      const slider = el('span', `slider ${disabledClass(state)}`);
      const track = el('span', 'track');
      const fill = el('span', 'fill');
      const percentage = Math.max(18, Math.min(88, 34 + index * 16));
      fill.style.width = `${percentage}%`;
      const thumb = el('span', 'thumb');
      thumb.style.left = `${percentage}%`;
      slider.append(track, fill, thumb);
      applyPrimitiveTokenStyles(fill, context, state, {
        colorHook: 'slider-fill',
        colorProperty: 'background',
        motionHook: 'slider-motion'
      });
      applyPrimitiveTokenStyles(thumb, context, state, {
        radiusHook: 'slider-thumb-radius'
      });
      row.append(slider);
      stack.append(row);
    });
    return stack;
  });
}

function renderSurfacePrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => createSurfaceLadder(context, stateSet));
}

function renderCardPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const grid = el('div', 'state-specimen-grid card-specimen-grid');
    for (const state of stateSet.states) {
      grid.append(createCardSpecimen(context, state, state.name));
    }
    return grid;
  });
}

function renderMediaPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const grid = el('div', 'state-specimen-grid media-specimen-grid');
    for (const state of stateSet.states) {
      const sample = el('article', 'media');
      sample.dataset.primitiveStateId = state.id;
      sample.dataset.prototypeOnly = String(state.prototypeOnly);
      sample.append(el('div', 'media-img'), el('div', 'media-body', state.name));
      applyPrimitiveTokenStyles(sample, context, state, {
        colorHook: 'media-surface',
        colorProperty: 'background',
        radiusHook: 'media-radius',
        shadowHook: 'media-shadow'
      });
      grid.append(sample);
    }
    return grid;
  });
}

function renderNavigationPrimitive(context: PrimitiveRenderContext): HTMLElement {
  if (primitiveHasTerm(context.primitive, 'back')) {
    return renderVisualStateSets(context, stateSet => {
      const grid = el('div', 'state-specimen-grid back-button-specimen-grid');
      for (const state of stateSet.states) {
        grid.append(createBackButtonSpecimen(context, state));
      }
      return grid;
    });
  }

  return renderVisualStateSets(context, stateSet => {
    const stack = el('div', 'navigation-specimen-stack');
    for (const state of stateSet.states) {
      const nav = createNavigationSpecimen(state, state.name);
      nav.dataset.primitiveStateId = state.id;
      nav.dataset.prototypeOnly = String(state.prototypeOnly);
      applyPrimitiveTokenStyles(nav, context, state, {
        colorHook: 'navigation-surface',
        colorProperty: 'background',
        radiusHook: 'navigation-radius',
        shadowHook: 'navigation-shadow'
      });
      stack.append(nav);
    }
    return stack;
  });
}

function renderSeparatorPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const stack = el('div', 'separator-specimen-stack');
    for (const state of stateSet.states) {
      const row = el('div', 'separator-specimen');
      row.dataset.primitiveStateId = state.id;
      row.dataset.prototypeOnly = String(state.prototypeOnly);
      row.append(el('span', 'separator-label', state.name));
      const line = el('span', `separator ${state.id}`);
      applyPrimitiveTokenStyles(line, context, state, {
        colorHook: 'separator-color',
        colorProperty: 'background'
      });
      row.append(line);
      stack.append(row);
    }
    return stack;
  });
}

function renderListPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const grid = el('div', 'state-specimen-grid list-specimen-grid');
    for (const state of stateSet.states) {
      const list = el('div', 'list');
      list.dataset.primitiveStateId = state.id;
      list.dataset.prototypeOnly = String(state.prototypeOnly);
      list.append(createListRow('Inbox', '12'), createListRow(state.name, 'New'), createListRow('Archive', ''));
      applyPrimitiveTokenStyles(list, context, state, {
        colorHook: 'list-surface',
        colorProperty: 'background',
        radiusHook: 'list-radius',
        shadowHook: 'list-shadow'
      });
      grid.append(list);
    }
    return grid;
  });
}

function renderRowPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const stack = el('div', 'row-specimen-stack');
    for (const state of stateSet.states) {
      const row = createListRow(state.name, 'Detail');
      row.dataset.primitiveStateId = state.id;
      row.dataset.prototypeOnly = String(state.prototypeOnly);
      applyPrimitiveTokenStyles(row, context, state, {
        colorHook: 'row-surface',
        colorProperty: 'background',
        spaceHook: 'row-padding-inline',
        radiusHook: 'row-radius'
      });
      stack.append(row);
    }
    return stack;
  });
}

function renderLoadingPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const grid = el('div', 'state-specimen-grid loading-specimen-grid');
    for (const state of stateSet.states) {
      const panel = el('div', 'loading-panel');
      panel.dataset.primitiveStateId = state.id;
      panel.dataset.prototypeOnly = String(state.prototypeOnly);
      panel.append(el('span', 'loading-dot'), el('span', 'loading-dot'), el('span', 'loading-dot'));
      applyPrimitiveTokenStyles(panel, context, state, {
        colorHook: 'loading-surface',
        colorProperty: 'background',
        radiusHook: 'loading-radius',
        motionHook: 'loading-motion'
      });
      grid.append(panel);
    }
    return grid;
  });
}

function renderBadgePrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const grid = el('div', 'state-specimen-grid badge-specimen-grid');
    for (const state of stateSet.states) {
      const badge = el('span', `badge ${badgeClass(state)}`, state.name);
      badge.dataset.primitiveStateId = state.id;
      badge.dataset.prototypeOnly = String(state.prototypeOnly);
      applyPrimitiveTokenStyles(badge, context, state, {
        colorHook: 'badge-fill',
        colorProperty: 'background'
      });
      grid.append(badge);
    }
    return grid;
  });
}

function renderIconPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const grid = el('div', 'state-specimen-grid icon-specimen-grid');
    for (const state of stateSet.states) {
      const sample = el('span', 'icon-sample');
      sample.dataset.primitiveStateId = state.id;
      sample.dataset.prototypeOnly = String(state.prototypeOnly);
      sample.innerHTML = sampleIcon('sparkles');
      applyPrimitiveTokenStyles(sample, context, state, {
        colorHook: 'icon-color',
        colorProperty: 'text'
      });
      grid.append(sample);
    }
    return grid;
  });
}

function renderSkeletonPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const grid = el('div', 'state-specimen-grid skeleton-specimen-grid');
    for (const state of stateSet.states) {
      const skeleton = el('div', 'skel');
      skeleton.dataset.primitiveStateId = state.id;
      skeleton.dataset.prototypeOnly = String(state.prototypeOnly);
      skeleton.append(el('span', 'skel-line'), el('span', 'skel-line short'), el('span', 'skel-block'));
      applyPrimitiveTokenStyles(skeleton, context, state, {
        colorHook: 'skeleton-surface',
        colorProperty: 'background',
        radiusHook: 'skeleton-radius',
        motionHook: 'skeleton-motion'
      });
      grid.append(skeleton);
    }
    return grid;
  });
}

function renderDialogPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const grid = el('div', 'state-specimen-grid dialog-specimen-grid');
    for (const state of stateSet.states) {
      const dialog = el('div', 'dialog');
      dialog.dataset.primitiveStateId = state.id;
      dialog.dataset.prototypeOnly = String(state.prototypeOnly);
      dialog.append(el('b', '', state.name), el('p', '', 'Message body'), el('div', 'dialog-actions'));
      const action = createButtonSpecimen(context, state, state.id.includes('destructive') ? 'Delete' : 'Cancel');
      delete action.dataset.primitiveStateId;
      delete action.dataset.prototypeOnly;
      dialog.querySelector('.dialog-actions')?.append(action);
      applyPrimitiveTokenStyles(dialog, context, state, {
        colorHook: 'dialog-surface',
        colorProperty: 'background',
        radiusHook: 'dialog-radius',
        shadowHook: 'dialog-shadow'
      });
      grid.append(dialog);
    }
    return grid;
  });
}

function renderMenuPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const menu = el('div', 'menu');
    for (const state of stateSet.states) {
      const item = el('div', `m-item ${state.id.includes('destructive') ? 'destructive' : ''}`);
      item.dataset.primitiveStateId = state.id;
      item.dataset.prototypeOnly = String(state.prototypeOnly);
      item.append(el('span', '', state.name), state.id.includes('checked') ? el('span', '', '✓') : el('span', '', ''));
      applyPrimitiveTokenStyles(item, context, state, {
        colorHook: 'menu-item-color',
        colorProperty: state.id.includes('destructive') ? 'text' : 'background',
        radiusHook: 'menu-item-radius'
      });
      menu.append(item);
    }
    return menu;
  });
}

function renderSheetPrimitive(context: PrimitiveRenderContext): HTMLElement {
  return renderVisualStateSets(context, stateSet => {
    const sheet = el('div', 'sheet-sample');
    for (const state of stateSet.states) {
      const slot = el('div', `sheet-slot sheet-slot-${cssClassName(state.id)}`, state.name);
      slot.dataset.primitiveStateId = state.id;
      slot.dataset.prototypeOnly = String(state.prototypeOnly);
      applyPrimitiveTokenStyles(slot, context, state, {
        colorHook: 'sheet-slot-surface',
        colorProperty: 'background',
        radiusHook: 'sheet-slot-radius'
      });
      sheet.append(slot);
    }
    return sheet;
  });
}

function renderGenericPrimitiveCard(context: PrimitiveRenderContext): HTMLElement {
  const root = el('div', 'primitive-visual primitive-visual-generic');
  root.dataset.primitiveRenderer = 'generic';

  if (context.primitive.stateSets.length === 0) {
    root.append(createGenericPrimitiveSample(context.primitive, context.tokenIndex, context.family));
    return root;
  }

  for (const stateSet of context.primitive.stateSets) {
    root.append(createGenericStateSetSection(context, stateSet));
  }
  return root;
}

function createGenericStateSetSection(context: PrimitiveRenderContext, stateSet: PrimitiveStateSet): HTMLElement {
  const section = el('section', 'primitive-state-set visual-state-set generic-state-set');
  setBoundary(section, 'state-set', `${context.primitive.id}/${stateSet.id}`, context.bundle.manifest.project.id, stateSet.name);
  section.dataset.boundarySummary = stateSet.description;
  section.append(el('div', 'visual-state-caption', stateSet.name));

  const grid = el('div', 'state-sample-grid');
  for (const state of stateSet.states) {
    grid.append(createPrimitiveStateSample(context.tokenIndex, context.primitive, state, context.family));
  }
  section.append(grid);
  return section;
}

function createButtonSpecimen(context: PrimitiveRenderContext, state: PrimitiveState, label: string): HTMLButtonElement {
  const button = el('button', `btn ${buttonClass(state)} ${buttonStateClass(state)}`) as HTMLButtonElement;
  button.type = 'button';
  button.dataset.primitiveStateId = state.id;
  button.dataset.prototypeOnly = String(state.prototypeOnly);
  button.disabled = isDisabledState(state);
  button.append(el('span', 'btn-label', label));
  if (isLoadingState(state)) {
    button.append(el('span', 'loading-dot'));
  }
  applyPrimitiveTokenStyles(button, context, state, {
    colorHook: 'button-background',
    colorProperty: 'background',
    spaceHook: 'button-padding-inline',
    radiusHook: 'button-radius',
    typographyHook: 'button-type',
    motionHook: 'button-motion'
  });
  return button;
}

function createBackButtonSpecimen(context: PrimitiveRenderContext, state: PrimitiveState): HTMLButtonElement {
  const button = el('button', `btn btn-secondary btn-round ${buttonStateClass(state)}`) as HTMLButtonElement;
  button.type = 'button';
  button.setAttribute('aria-label', 'Back');
  button.dataset.primitiveStateId = state.id;
  button.dataset.prototypeOnly = String(state.prototypeOnly);
  button.disabled = isDisabledState(state);
  button.innerHTML = sampleIcon('chevron-left');
  if (state.id.includes('sm') || state.id.includes('small')) {
    button.classList.add('sm');
  }
  applyPrimitiveTokenStyles(button, context, state, {
    colorHook: 'back-button-background',
    colorProperty: 'background',
    colorFromStateOnly: true,
    radiusHook: 'back-button-radius',
    motionHook: 'back-button-motion'
  });
  return button;
}

function createSmallIconButton(iconName: keyof typeof ICON_PATHS): HTMLElement {
  const button = el('button', 'btn btn-secondary btn-icon-sm') as HTMLButtonElement;
  button.type = 'button';
  button.setAttribute('aria-label', iconName);
  button.innerHTML = sampleIcon(iconName);
  return button;
}

function createNavigationSpecimen(state: PrimitiveState, title: string): HTMLElement {
  const nav = el('div', 'navbar');
  const left = el('div', 'side');
  const center = el('div', 'center');
  const right = el('div', 'side right');
  if (navigationShowsLeft(state)) {
    left.append(createSmallIconButton('chevron-left'));
  }
  center.append(el('div', 'title', title));
  if (navigationShowsRight(state)) {
    right.append(createSmallIconButton('more-horizontal'));
  }
  nav.append(left, center, right);
  return nav;
}

function navigationShowsLeft(state: PrimitiveState): boolean {
  const id = state.id.toLowerCase();
  return !id.includes('right-only') && !id.includes('center-only');
}

function navigationShowsRight(state: PrimitiveState): boolean {
  const id = state.id.toLowerCase();
  return !id.includes('back-only') && !id.includes('left-only');
}

function createListRow(title: string, meta: string): HTMLElement {
  const row = el('div', 'lrow');
  row.append(el('span', 'row-avatar'), el('span', 'row-title', title), el('span', 'row-meta', meta));
  return row;
}

function createCardSpecimen(context: PrimitiveRenderContext, state: PrimitiveState, title: string): HTMLElement {
  const card = el('article', `card ${cardClass(state)}`);
  card.dataset.primitiveStateId = state.id;
  card.dataset.prototypeOnly = String(state.prototypeOnly);
  card.append(el('div', 'card-kicker', title), el('strong', '', 'Card title'), el('p', '', 'Supporting content'));
  applyPrimitiveTokenStyles(card, context, state, {
    colorHook: 'card-surface',
    colorProperty: cardClass(state).includes('status-accent') ? 'border' : 'background',
    spaceHook: 'card-padding-inline',
    radiusHook: 'card-radius',
    typographyHook: 'card-type',
    shadowHook: 'card-shadow',
    shadowFromStateOnly: true,
    foregroundFallbackFromGroups: true,
    motionHook: 'card-motion'
  });
  return card;
}

function createScreenCardSpecimen(
  context: PrimitiveRenderContext,
  state: PrimitiveState,
  copy: string,
  keywords: Set<string> = new Set()
): HTMLElement {
  const card = el('article', `card ${cardClass(state)} screen-card-specimen`);
  card.dataset.primitiveStateId = state.id;
  card.dataset.prototypeOnly = String(state.prototypeOnly);
  if (keywords.has('text') || keywords.has('eyebrow')) {
    card.classList.add('card-text');
  }
  appendScreenCardContent(card, copy, keywords);
  applyPrimitiveTokenStyles(card, context, state, {
    colorHook: 'screen-card-surface',
    colorProperty: cardClass(state).includes('status-accent') ? 'border' : 'background',
    spaceHook: 'screen-card-padding-inline',
    radiusHook: 'screen-card-radius',
    typographyHook: 'screen-card-type',
    shadowHook: 'screen-card-shadow',
    shadowFromStateOnly: true,
    foregroundFallbackFromGroups: true,
    motionHook: 'screen-card-motion'
  });
  return card;
}

function appendScreenCardContent(card: HTMLElement, copy: string, keywords: Set<string>): void {
  const parts = splitCopyParts(copy);

  if (keywords.has('stat')) {
    card.classList.add('card-stat');
    card.append(el('span', 'card-kicker', parts[0] ?? copy));
    card.append(el('strong', 'card-stat-value', parts[1] ?? ''));
    if (parts[2]) {
      card.append(el('p', 'card-body', parts[2]));
    }
    return;
  }

  if (keywords.has('eyebrow')) {
    card.append(el('span', 'card-kicker', parts.join(' · ') || copy));
    return;
  }

  if (keywords.has('quote')) {
    card.classList.add('card-quote');
    card.append(el('p', 'card-quote-text', parts[0] ?? copy));
    if (parts[1]) {
      card.append(el('span', 'card-kicker', parts[1]));
    }
    return;
  }

  const display = keywords.has('display');
  let kicker: string | undefined;
  let title: string | undefined;
  let body: string | undefined;
  if (parts.length >= 3) {
    [kicker, title, body] = parts;
  } else if (parts.length === 2) {
    if (display) {
      [kicker, title] = parts;
    } else {
      [title, body] = parts;
    }
  } else {
    title = parts[0] ?? copy;
  }

  if (kicker) {
    card.append(el('span', 'card-kicker', kicker));
  }
  const titleEl = el('strong', 'card-title', title ?? '');
  if (display) {
    titleEl.classList.add('card-display-title');
  }
  card.append(titleEl);
  if (body) {
    card.append(el('p', 'card-body', body));
  }
}

function createScreenMediaSpecimen(context: PrimitiveRenderContext, state: PrimitiveState, copy: string): HTMLElement {
  const media = el('article', 'media screen-media-specimen');
  media.dataset.primitiveStateId = state.id;
  media.dataset.prototypeOnly = String(state.prototypeOnly);
  const parts = splitCopyParts(copy);
  media.append(el('div', 'media-img'));
  const body = el('div', 'media-body');
  body.append(el('strong', '', parts[0] ?? copy));
  if (parts[1]) {
    body.append(el('span', 'media-caption', parts[1]));
  }
  media.append(body);
  applyPrimitiveTokenStyles(media, context, state, {
    colorHook: 'screen-media-surface',
    colorProperty: 'background',
    radiusHook: 'screen-media-radius',
    shadowHook: 'screen-media-shadow'
  });
  return media;
}

function splitCopyParts(copy: string): string[] {
  return copy
    .split('|')
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

const SECTION_LAYOUT_KEYWORDS = new Set([
  'row',
  'spread',
  'center',
  'end',
  'grid-2',
  'grid-3',
  'grid-4',
  'hero',
  'narrow',
  'wide',
  'footer'
]);

const DEPENDENCY_LAYOUT_KEYWORDS = new Set(['grow', 'fit', 'span-2', 'stat', 'text', 'eyebrow', 'display', 'quote']);

function layoutTerms(layout: string | undefined): string[] {
  if (!layout) {
    return [];
  }
  return layout
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);
}

function sectionLayoutClasses(section: ScreenDefinition['sections'][number]): string[] {
  const keywords = new Set<string>();
  for (const dependency of section.uses) {
    for (const term of layoutTerms(dependency.binding?.layout)) {
      if (SECTION_LAYOUT_KEYWORDS.has(term)) {
        keywords.add(term);
      }
    }
  }
  return [...keywords].map(keyword => `layout-${keyword}`);
}

function dependencyLayoutKeywords(dependency: BoundaryDependency): Set<string> {
  const keywords = new Set<string>();
  for (const term of layoutTerms(dependency.binding?.layout)) {
    if (DEPENDENCY_LAYOUT_KEYWORDS.has(term)) {
      keywords.add(term);
    }
  }
  return keywords;
}

function applyScreenCanvasTokens(target: HTMLElement, tokenIndex: TokenIndex): void {
  const records = [...tokenIndex.byRef.values()];
  const pick = (type: DesignToken['type'], preferred: string[]): TokenRecord | undefined => {
    const pool = records.filter(record => record.token.type === type);
    for (const id of preferred) {
      const hit = pool.find(record => record.token.id === id) ?? pool.find(record => record.token.id.includes(id));
      if (hit) {
        return hit;
      }
    }
    return pool[0];
  };
  const assign = (name: string, record: TokenRecord | undefined): void => {
    if (record) {
      target.style.setProperty(name, record.token.value);
    }
  };

  assign('--proto-bg', pick('color', ['background', 'canvas', 'bg']));
  assign('--proto-surface', pick('color', ['surface', 'panel', 'card']));
  assign('--proto-fg', pick('color', ['foreground', 'text', 'ink']));
  assign('--proto-muted', pick('color', ['muted', 'subtle', 'tertiary', 'secondary']));
  assign('--proto-type-display', pick('typography', ['display', 'headline', 'title']));
  assign('--proto-type-body', pick('typography', ['body', 'text']));
  assign('--proto-type-label', pick('typography', ['label', 'caption', 'eyebrow']));
  assign('--proto-section-gap', pick('space', ['section', 'stack', 'gap']));
  assign('--proto-radius', pick('radius', ['radius-lg', 'lg', 'panel', 'radius-md', 'md']));
  assign('--proto-shadow', pick('shadow', ['panel', 'card']));
}

function applyPrimitiveTokenStyles(
  target: HTMLElement,
  context: PrimitiveRenderContext,
  state: PrimitiveState,
  options: TokenApplicationOptions
): void {
  const color =
    stateTokenForColorProperty(context.tokenIndex, state, options.colorProperty ?? 'background') ??
    firstStateToken(context.tokenIndex, state, 'color') ??
    (options.colorFromStateOnly ? undefined : firstTokenFromGroups(context.tokenIndex, context.primitive.tokenGroupIds, 'color'));
  const foregroundColor =
    stateTokenForColorRole(context.tokenIndex, state, ['foreground', 'text', 'label']) ??
    (options.foregroundFallbackFromGroups ? preferredColorTokenFromGroups(context.tokenIndex, context.primitive.tokenGroupIds, ['foreground', 'ink', 'text', 'fg']) : undefined);
  const space = firstStateToken(context.tokenIndex, state, 'space') ?? firstTokenFromGroups(context.tokenIndex, context.primitive.tokenGroupIds, 'space');
  const radius = firstStateToken(context.tokenIndex, state, 'radius') ?? firstTokenFromGroups(context.tokenIndex, context.primitive.tokenGroupIds, 'radius');
  const typography = firstStateToken(context.tokenIndex, state, 'typography') ?? firstTokenFromGroups(context.tokenIndex, context.primitive.tokenGroupIds, 'typography', 'body');
  const shadow = firstStateToken(context.tokenIndex, state, 'shadow') ?? (options.shadowFromStateOnly ? undefined : firstTokenFromGroups(context.tokenIndex, context.primitive.tokenGroupIds, 'shadow'));
  const motion = firstStateToken(context.tokenIndex, state, 'motion') ?? firstTokenFromGroups(context.tokenIndex, context.primitive.tokenGroupIds, 'motion');

  if (color && options.colorHook) {
    applyColorVariable(target, color.token.value, options.colorProperty ?? 'background');
    appendAgentTokenHook(target, color, options.colorHook, hook => applyColorStyle(hook, color.token.value, options.colorProperty ?? 'background'));
  }
  if (foregroundColor && options.colorHook && options.colorProperty !== 'text') {
    target.style.setProperty('--specimen-fg', foregroundColor.token.value);
    appendAgentTokenHook(target, foregroundColor, `${options.colorHook}-foreground`, hook => applyColorStyle(hook, foregroundColor.token.value, 'text'));
  }
  if (space && options.spaceHook) {
    target.style.setProperty('--specimen-padding-inline', space.token.value);
    appendAgentTokenHook(target, space, options.spaceHook, hook => {
      hook.style.paddingLeft = space.token.value;
      hook.style.paddingRight = space.token.value;
    });
  }
  if (radius && options.radiusHook) {
    target.style.setProperty('--specimen-radius', radius.token.value);
    appendAgentTokenHook(target, radius, options.radiusHook, hook => {
      hook.style.borderRadius = radius.token.value;
    });
  }
  if (typography && options.typographyHook) {
    target.style.setProperty('--specimen-font', typography.token.value);
    appendAgentTokenHook(target, typography, options.typographyHook, hook => {
      hook.style.font = typography.token.value;
    });
  }
  if (shadow && options.shadowHook) {
    target.style.setProperty('--specimen-shadow', shadow.token.value);
    appendAgentTokenHook(target, shadow, options.shadowHook, hook => {
      hook.style.boxShadow = shadow.token.value;
    });
  }
  if (motion && options.motionHook) {
    target.style.setProperty('--specimen-motion', motion.token.value);
    appendAgentTokenHook(target, motion, options.motionHook, hook => {
      hook.style.transition = `transform ${motion.token.value}`;
    });
  }
}

function appendAgentTokenHook(target: HTMLElement, record: TokenRecord, templateHook: string, applyStyle: (hook: HTMLElement) => void): void {
  const hook = el('span', 'agent-token-hook');
  hook.setAttribute('aria-hidden', 'true');
  setTokenHook(hook, record, templateHook);
  applyStyle(hook);
  target.append(hook);
}

function applyColorStyle(target: HTMLElement, value: string, property: 'background' | 'border' | 'text'): void {
  if (property === 'border') {
    target.style.borderColor = value;
  } else if (property === 'text') {
    target.style.color = value;
  } else {
    target.style.backgroundColor = value;
  }
}

function applyColorVariable(target: HTMLElement, value: string, property: 'background' | 'border' | 'text'): void {
  if (property === 'border') {
    target.style.setProperty('--specimen-border', value);
  } else if (property === 'text') {
    target.style.setProperty('--specimen-fg', value);
  } else {
    target.style.setProperty('--specimen-bg', value);
  }
}

function stateTokenForColorProperty(
  tokenIndex: TokenIndex,
  state: PrimitiveState,
  property: 'background' | 'border' | 'text'
): TokenRecord | undefined {
  if (property === 'border') {
    return stateTokenForColorRole(tokenIndex, state, ['border', 'stroke', 'outline']);
  }
  if (property === 'text') {
    return stateTokenForColorRole(tokenIndex, state, ['foreground', 'text', 'label']);
  }
  return stateTokenForColorRole(tokenIndex, state, ['background', 'surface', 'fill']);
}

function stateTokenForColorRole(tokenIndex: TokenIndex, state: PrimitiveState, roles: string[]): TokenRecord | undefined {
  const normalizedRoles = new Set(roles.map(role => role.toLowerCase()));
  for (const [tokenRef, role] of Object.entries(state.tokenRoles ?? {})) {
    if (!normalizedRoles.has(role.toLowerCase())) {
      continue;
    }
    const record = tokenIndex.byRef.get(tokenRef);
    if (record?.token.type === 'color') {
      return record;
    }
  }
  return undefined;
}

function preferredColorTokenFromGroups(tokenIndex: TokenIndex, groupIds: string[], preferredTokenIds: string[]): TokenRecord | undefined {
  for (const preferredTokenId of preferredTokenIds) {
    for (const groupId of groupIds) {
      const group = tokenIndex.byGroup.get(groupId);
      const token = group?.tokens.find(candidate => candidate.type === 'color' && candidate.id === preferredTokenId);
      if (group && token) {
        return tokenIndex.byRef.get(`${group.id}.${token.id}`);
      }
    }
  }
  return undefined;
}

function createPrimitiveStateSample(
  tokenIndex: TokenIndex,
  primitive: PrimitiveDefinition,
  state: PrimitiveState,
  family: string
): HTMLElement {
  const sample = el('div', `primitive-sample primitive-sample-${family}`);
  sample.dataset.primitiveSample = family;
  sample.dataset.primitiveStateId = state.id;
  sample.dataset.prototypeOnly = String(state.prototypeOnly);

  const color = firstStateToken(tokenIndex, state, 'color') ?? firstTokenFromGroups(tokenIndex, primitive.tokenGroupIds, 'color');
  const space = firstStateToken(tokenIndex, state, 'space') ?? firstTokenFromGroups(tokenIndex, primitive.tokenGroupIds, 'space');
  const radius = firstStateToken(tokenIndex, state, 'radius') ?? firstTokenFromGroups(tokenIndex, primitive.tokenGroupIds, 'radius');
  const shadow = firstStateToken(tokenIndex, state, 'shadow') ?? firstTokenFromGroups(tokenIndex, primitive.tokenGroupIds, 'shadow');
  const motion = firstStateToken(tokenIndex, state, 'motion') ?? firstTokenFromGroups(tokenIndex, primitive.tokenGroupIds, 'motion');

  if (color) {
    applyColorStyle(sample, color.token.value, 'background');
    appendAgentTokenHook(sample, color, 'generic-sample-background', hook => applyColorStyle(hook, color.token.value, 'background'));
  }
  if (space) {
    sample.style.paddingLeft = space.token.value;
    sample.style.paddingRight = space.token.value;
    appendAgentTokenHook(sample, space, 'generic-sample-padding-inline', hook => {
      hook.style.paddingLeft = space.token.value;
      hook.style.paddingRight = space.token.value;
    });
  }
  if (radius) {
    sample.style.borderRadius = radius.token.value;
    appendAgentTokenHook(sample, radius, 'generic-sample-radius', hook => {
      hook.style.borderRadius = radius.token.value;
    });
  }
  if (shadow) {
    sample.style.boxShadow = shadow.token.value;
    appendAgentTokenHook(sample, shadow, 'generic-sample-shadow', hook => {
      hook.style.boxShadow = shadow.token.value;
    });
  }
  if (motion) {
    sample.style.transition = `transform ${motion.token.value}`;
    appendAgentTokenHook(sample, motion, 'generic-sample-motion', hook => {
      hook.style.transition = `transform ${motion.token.value}`;
    });
  }

  const label = el('span', 'primitive-sample-label', state.name);
  sample.append(label);

  if (state.prototypeOnly) {
    sample.append(el('span', 'prototype-flag', 'prototype'));
  }

  return sample;
}

function createGenericPrimitiveSample(primitive: PrimitiveDefinition, tokenIndex: TokenIndex, family: string): HTMLElement {
  const state = syntheticDefaultState(primitive, tokenIndex);
  return createPrimitiveStateSample(tokenIndex, primitive, state, family);
}

function syntheticDefaultStateSet(context: PrimitiveRenderContext): PrimitiveStateSet {
  return {
    id: 'default',
    name: context.primitive.name,
    description: context.primitive.description,
    styleRefs: context.primitive.styleRefs,
    states: [syntheticDefaultState(context.primitive, context.tokenIndex)]
  };
}

function syntheticDefaultState(primitive: PrimitiveDefinition, tokenIndex: TokenIndex): PrimitiveState {
  return {
    id: 'default',
    name: primitive.name,
    tokens: primitive.tokenGroupIds.flatMap(groupId => {
      const token = tokenIndex.byGroup.get(groupId)?.tokens[0];
      return token ? [`${groupId}.${token.id}`] : [];
    }),
    prototypeOnly: primitive.prototypeOnly,
    notes: [],
    implementationHints: []
  };
}

function primitiveHasTerm(primitive: PrimitiveDefinition, term: string): boolean {
  return primitiveFamilyTerms(primitive).has(term);
}

function isCommandVariantStateSet(stateSet: PrimitiveStateSet): boolean {
  const haystack = `${stateSet.id} ${stateSet.name} ${stateSet.description}`.toLowerCase();
  return /\b(variant|intent|decision)\b/.test(haystack);
}

function isInputVariantStateSet(stateSet: PrimitiveStateSet): boolean {
  const haystack = `${stateSet.id} ${stateSet.name} ${stateSet.description}`.toLowerCase();
  return /\b(variant|frame|fill)\b/.test(haystack);
}

function isInteractionStateSet(stateSet: PrimitiveStateSet): boolean {
  const haystack = `${stateSet.id} ${stateSet.name} ${stateSet.description}`.toLowerCase();
  return /\b(interaction|state|lifecycle)\b/.test(haystack);
}

function mergeVisualStates(primary: PrimitiveState, secondary: PrimitiveState): PrimitiveState {
  return {
    id: `${primary.id}-${secondary.id}`,
    name: `${primary.name} ${secondary.name}`,
    tokens: uniqueStrings([...(primary.tokens ?? []), ...(secondary.tokens ?? [])]),
    tokenRoles: { ...primary.tokenRoles, ...secondary.tokenRoles },
    prototypeOnly: primary.prototypeOnly || secondary.prototypeOnly,
    notes: [...(primary.notes ?? []), ...(secondary.notes ?? [])],
    implementationHints: [...(primary.implementationHints ?? []), ...(secondary.implementationHints ?? [])]
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function inputStateClass(state: PrimitiveState): string {
  const id = cssClassName(state.id);
  const classes = [`inp-${id}`];
  if (id.includes('filled')) classes.push('inp-filled');
  if (id.includes('ghost')) classes.push('inp-ghost');
  if (id.includes('outline')) classes.push('inp-outline');
  if (id.includes('underline')) classes.push('inp-underline');
  if (state.id.includes('focus')) classes.push('is-focused');
  if (state.id.includes('invalid') || state.id.includes('error')) classes.push('is-invalid');
  if (isDisabledState(state)) classes.push('is-disabled');
  return classes.join(' ');
}

function inputStateText(state: PrimitiveState): string {
  if (state.id === 'empty') return 'Placeholder';
  if (state.id === 'value') return 'Entered value';
  if (state.id.includes('invalid')) return 'Needs attention';
  if (state.id.includes('disabled')) return 'Disabled';
  return state.name;
}

function inputPlaceholderState(state: PrimitiveState): boolean {
  return state.id.includes('empty') || state.name.toLowerCase().includes('empty');
}

function buttonClass(state: PrimitiveState): string {
  const id = state.id.toLowerCase();
  if (id.includes('secondary')) return 'btn-secondary';
  if (id.includes('tonal') || id.includes('draft') || id.includes('hold') || id.includes('attention')) return 'btn-tonal';
  if (id.includes('outline')) return 'btn-outline';
  if (id.includes('ghost')) return 'btn-ghost';
  if (id.includes('link')) return 'btn-link';
  if (id.includes('destructive') || id.includes('danger') || id.includes('risk')) return 'btn-destructive';
  if (id.includes('accent')) return 'btn-accent';
  if (id.includes('success') || id.includes('approve') || id.includes('ready')) return 'btn-success';
  if (id.includes('gradient')) return 'btn-gradient';
  return 'btn-primary';
}

function buttonStateClass(state: PrimitiveState): string {
  const classes: string[] = [];
  if (isLoadingState(state)) classes.push('is-loading');
  if (isDisabledState(state)) classes.push('is-disabled');
  return classes.join(' ');
}

function stateOnClass(state: PrimitiveState): string {
  return state.id.includes('on') || state.id.includes('checked') ? 'on' : '';
}

function disabledClass(state: PrimitiveState): string {
  return isDisabledState(state) ? 'is-disabled' : '';
}

function isDisabledState(state: PrimitiveState): boolean {
  return state.id.includes('disabled');
}

function isLoadingState(state: PrimitiveState): boolean {
  return state.id.includes('loading');
}

function badgeClass(state: PrimitiveState): string {
  const id = state.id.toLowerCase();
  if (id.includes('secondary')) return 'badge-secondary';
  if (id.includes('tonal')) return 'badge-tonal';
  if (id.includes('accent')) return 'badge-accent';
  if (id.includes('destructive') || id.includes('danger')) return 'badge-destructive';
  if (id.includes('success') || id.includes('ready')) return 'badge-success';
  if (id.includes('outline')) return 'badge-outline';
  return 'badge-default';
}

function cardClass(state: PrimitiveState): string {
  const id = state.id.toLowerCase();
  const classes: string[] = [];
  if (id.includes('flat')) classes.push('flat');
  if (id.includes('elevated') || id.includes('raised') || id.includes('compact') || id.includes('expanded')) classes.push('elevated');
  if (id.includes('status') || id.includes('accent')) classes.push('status-accent');
  return classes.join(' ');
}

function cssClassName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
}

function groupPrimitivesByFamily(primitives: PrimitiveDefinition[]): FamilyGroup[] {
  const groups = new Map<string, PrimitiveDefinition[]>();
  for (const primitive of primitives) {
    const family = inferPrimitiveFamily(primitive);
    const current = groups.get(family) ?? [];
    current.push(primitive);
    groups.set(family, current);
  }
  return [...groups.entries()]
    .map(([family, items]) => ({ family, primitives: items }))
    .sort((a, b) => familySortIndex(a.family) - familySortIndex(b.family) || a.family.localeCompare(b.family));
}

function inferPrimitiveFamily(primitive: PrimitiveDefinition): string {
  const terms = primitiveFamilyTerms(primitive);
  if (hasFamilyTerm(terms, 'button')) return 'button';
  if (hasFamilyTerm(terms, 'otp', 'input', 'textarea')) return 'input';
  if (hasFamilyTerm(terms, 'select')) return 'select';
  if (hasFamilyTerm(terms, 'checkbox')) return 'checkbox';
  if (hasFamilyTerm(terms, 'radio')) return 'radio';
  if (hasFamilyTerm(terms, 'switch')) return 'switch';
  if (hasFamilyTerm(terms, 'slider')) return 'slider';
  if (hasFamilyTerm(terms, 'tabs', 'tab', 'segmented')) return 'tabs';
  if (hasFamilyTerm(terms, 'text', 'typography')) return 'text';
  if (hasFamilyTerm(terms, 'surface')) return 'surface';
  if (hasFamilyTerm(terms, 'media')) return 'media';
  if (hasFamilyTerm(terms, 'card')) return 'card';
  if (hasFamilyTerm(terms, 'nav', 'navbar', 'navigation', 'back')) return 'navigation';
  if (hasFamilyTerm(terms, 'separator')) return 'separator';
  if (hasFamilyTerm(terms, 'list')) return 'list';
  if (hasFamilyTerm(terms, 'row')) return 'row';
  if (hasFamilyTerm(terms, 'loading', 'progress')) return 'loading';
  if (hasFamilyTerm(terms, 'badge', 'pill')) return 'badge';
  if (hasFamilyTerm(terms, 'icon')) return 'icon';
  if (hasFamilyTerm(terms, 'avatar')) return 'avatar';
  if (hasFamilyTerm(terms, 'skeleton')) return 'skeleton';
  if (hasFamilyTerm(terms, 'toast')) return 'toast';
  if (hasFamilyTerm(terms, 'tooltip')) return 'tooltip';
  if (hasFamilyTerm(terms, 'dialog')) return 'dialog';
  if (hasFamilyTerm(terms, 'alert')) return 'alert';
  if (hasFamilyTerm(terms, 'menu')) return 'menu';
  if (hasFamilyTerm(terms, 'sheet')) return 'sheet';
  return 'generic';
}

function primitiveFamilyTerms(primitive: PrimitiveDefinition): Set<string> {
  return new Set(
    `${primitive.id} ${primitive.name}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

function hasFamilyTerm(terms: Set<string>, ...candidates: string[]): boolean {
  return candidates.some(candidate => terms.has(candidate));
}

function familySortIndex(family: string): number {
  const index = FAMILY_ORDER.indexOf(family);
  return index === -1 ? FAMILY_ORDER.length : index;
}

function familyAccent(family: string): string {
  const accents: Record<string, string> = {
    token: 'var(--bp-sample-accent-token)',
    button: 'var(--bp-sample-accent-action)',
    input: 'var(--bp-sample-accent-input)',
    select: 'var(--bp-sample-accent-input)',
    checkbox: 'var(--bp-sample-accent-input)',
    radio: 'var(--bp-sample-accent-input)',
    switch: 'var(--bp-sample-accent-input)',
    slider: 'var(--bp-sample-accent-input)',
    text: 'var(--bp-sample-accent-input)',
    surface: 'var(--bp-sample-accent-surface)',
    card: 'var(--bp-sample-accent-surface)',
    media: 'var(--bp-sample-accent-surface)',
    navigation: 'var(--bp-sample-accent-surface)',
    tabs: 'var(--bp-sample-accent-surface)',
    separator: 'var(--bp-sample-accent-surface)',
    list: 'var(--bp-sample-accent-row)',
    row: 'var(--bp-sample-accent-row)',
    loading: 'var(--bp-sample-accent-feedback)',
    badge: 'var(--bp-sample-accent-feedback)',
    icon: 'var(--bp-sample-accent-feedback)',
    skeleton: 'var(--bp-sample-accent-feedback)',
    toast: 'var(--bp-sample-accent-feedback)',
    avatar: 'var(--bp-sample-accent-feedback)',
    tooltip: 'var(--bp-sample-accent-feedback)',
    alert: 'var(--bp-sample-accent-feedback)',
    dialog: 'var(--bp-sample-accent-overlay)',
    menu: 'var(--bp-sample-accent-overlay)',
    sheet: 'var(--bp-sample-accent-overlay)',
    generic: 'var(--bp-sample-fg)'
  };
  return accents[family] ?? 'var(--bp-sample-fg)';
}

function familyWidth(family: string): number {
  if (family === 'button' || family === 'input') return 960;
  if (family === 'row' || family === 'list') return 430;
  return 400;
}

function firstStateToken(tokenIndex: TokenIndex, state: PrimitiveState, type: DesignToken['type']): TokenRecord | undefined {
  return state.tokens.map(tokenRef => tokenIndex.byRef.get(tokenRef)).find(record => record?.token.type === type);
}

function firstTokenFromGroups(
  tokenIndex: TokenIndex,
  groupIds: string[],
  type: DesignToken['type'],
  preferredTokenId?: string
): TokenRecord | undefined {
  for (const groupId of groupIds) {
    const group = tokenIndex.byGroup.get(groupId);
    if (!group) {
      continue;
    }
    const token = group.tokens.find(candidate => candidate.type === type && (!preferredTokenId || candidate.id === preferredTokenId));
    if (token) {
      return tokenIndex.byRef.get(`${group.id}.${token.id}`);
    }
  }
  for (const groupId of groupIds) {
    const group = tokenIndex.byGroup.get(groupId);
    const token = group?.tokens.find(candidate => candidate.type === type);
    if (group && token) {
      return tokenIndex.byRef.get(`${group.id}.${token.id}`);
    }
  }
  return undefined;
}

function setTokenHook(element: HTMLElement, record: TokenRecord | undefined, templateHook: string): void {
  if (!record) {
    return;
  }
  element.dataset.tokenRole = record.ref;
  element.dataset.templateHook = templateHook;
  element.dataset.tokenType = record.token.type;
  element.dataset.tokenStyleRef = record.token.styleRef;
}

function applyTokenPreview(element: HTMLElement, token: DesignToken, tokenIndex: TokenIndex): void {
  const value = resolveTokenReferences(tokenIndex, token.value);
  switch (token.type) {
    case 'color':
      element.style.background = value;
      break;
    case 'space':
    case 'size':
      element.style.width = value;
      break;
    case 'radius':
      element.style.borderRadius = value;
      break;
    case 'typography':
      element.style.font = value;
      if (!element.style.font) {
        element.style.fontFamily = value;
      }
      element.textContent = 'Aa';
      break;
    case 'shadow':
      element.style.boxShadow = value;
      break;
    case 'motion':
      element.textContent = 'ms';
      break;
  }
}

function resolveTokenReferences(tokenIndex: TokenIndex, value: string, depth = 0): string {
  if (depth > 4) {
    return value;
  }
  return value.replace(/var\((--[\w-]+)\)/g, (reference, styleRef: string) => {
    const record = [...tokenIndex.byRef.values()].find(candidate => candidate.token.styleRef === styleRef);
    return record ? resolveTokenReferences(tokenIndex, record.token.value, depth + 1) : reference;
  });
}

function mountScreens({ root, canvas: boardCanvas, project: bundle }: BoardContext): BoardMount {
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
  // Flow subpages filter the board view only; deep links (state/viewport) always
  // resolve their frames regardless of the active subpage.
  const flowFilter = request.state || request.viewport ? undefined : (activeScreenFlow ?? undefined);
  const frameLayouts = layoutScreenFrames(bundle, request, flowFilter);
  const fallbackWidth = frameLayouts.length > 0 ? Math.max(393, ...frameLayouts.map(layout => layout.preset.width)) : 1440;
  const fallbackHeight = frameLayouts.length > 0
    ? Math.max(852, ...frameLayouts.map(layout => frameExtentHeight(layout.screen, layout.preset)))
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
  frameLayouts.forEach(layout => {
    if (layout.flowLabel) {
      const label = el('div', 'screen-flow-label bp-chrome-world-label', layout.flowLabel.text);
      label.style.left = `${layout.flowLabel.x}px`;
      label.style.top = `${layout.flowLabel.y}px`;
      root.append(label);
    }
    if (layout.routeLabel) {
      const label = el('div', 'screen-route-label bp-chrome-world-label', layout.routeLabel.text);
      label.style.left = `${layout.routeLabel.x}px`;
      label.style.top = `${layout.routeLabel.y}px`;
      root.append(label);
    }
    root.append(createPrototypeFrame(
      bundle,
      tokenIndex,
      layout.screen,
      layout.preset,
      layout.x,
      layout.y,
      layout.prototypeSelection,
      layout.selectionError
    ));
  });

  return {
    configure,
    fit: () => controller.fitTo([...root.querySelectorAll<HTMLElement>('.frame')])
  };
}

function mountHistoryScreens(
  root: HTMLElement,
  boardCanvas: CanvasController,
  bundle: BlueprintProjectBundle,
  screenId: string,
  request: PrototypeReviewSelectionRequest
): BoardMount {
  root.dataset.canvasMode = 'history';
  root.dataset.screenId = screenId;
  const screen = bundle.screens.screens.find(candidate => candidate.id === screenId);
  if (!screen?.prototype) {
    explorationTitle.textContent = 'History unavailable';
    const unavailable = createFocusedUnavailablePanel(
      'History unavailable',
      'Ask the agent to check this screen history and open it again.'
    );
    root.append(unavailable);
    const configure = (): CanvasController => boardCanvas.configure({
      minScale: 0.15,
      readableScale: 0.55,
      fallbackWidth: 420,
      fallbackHeight: 180
    });
    const controller = configure();
    return { configure, fit: () => controller.fitTo([unavailable]) };
  }

  let selection: SelectedPrototypeReviewCondition;
  let preset: FramePreset | undefined;
  try {
    selection = selectPrototypeReviewCondition(screen, request);
    preset = bundle.manifest.framePresets.find(candidate => candidate.id === selection.framePresetId);
    if (!preset) {
      throw new Error('Missing frame preset.');
    }
  } catch {
    explorationTitle.textContent = `${screenFrameLabel(screen)} · History unavailable`;
    const unavailable = createFocusedUnavailablePanel(
      'History unavailable',
      'This saved screen context is no longer available. Ask the agent to inspect it.'
    );
    root.append(unavailable);
    const configure = (): CanvasController => boardCanvas.configure({
      minScale: 0.15,
      readableScale: 0.55,
      fallbackWidth: 420,
      fallbackHeight: 180
    });
    const controller = configure();
    return { configure, fit: () => controller.fitTo([unavailable]) };
  }

  root.setAttribute('aria-label', `${screen.name} history`);
  explorationTitle.textContent = `${screenFrameLabel(screen)} · History`;
  const frameHeight = frameExtentHeight(screen, preset);
  const configure = (): CanvasController => boardCanvas.configure({
    minScale: 0.08,
    readableScale: 0.12,
    fallbackWidth: preset.width,
    fallbackHeight: frameHeight
  });
  const controller = configure();
  const startX = 90;
  const gapX = 80;
  const rowGap = 170;
  let y = 220;

  const versions = bundle.history.entries
    .filter(entry => (
      entry.screenId === screen.id
        && entry.state === selection.state
        && entry.framePresetId === preset.id
    ))
    .sort((left, right) => right.version - left.version);
  appendHistoryRowLabel(root, 'Versions', startX, y - 56);
  let x = startX;
  root.append(createExplorationPrototypeFrame({
    bundle,
    screen,
    preset,
    selection,
    role: 'current',
    label: 'Current',
    canonicalBoundary: true,
    unavailableNoun: 'Version',
    x,
    y
  }));
  x += preset.width + gapX;
  for (const entry of versions) {
    const versionBundle = createExplorationCompileBundle(bundle, entry.screen, screenPrototypeForComparison(entry.screen));
    const versionScreen = versionBundle.screens.screens[0] ?? entry.screen;
    root.append(createExplorationPrototypeFrame({
      bundle: versionBundle,
      screen: versionScreen,
      preset,
      selection,
      role: 'version',
      historyVersion: entry.version,
      label: `V${entry.version}`,
      canonicalBoundary: false,
      unavailableNoun: 'Version',
      x,
      y
    }));
    x += preset.width + gapX;
  }
  y += frameHeight + rowGap;

  const explorations = bundle.explorations.explorations
    .filter(exploration => (
      exploration.target.screenId === screen.id
        && exploration.target.state === selection.state
        && exploration.target.framePresetId === preset.id
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const exploration of explorations) {
    appendHistoryRowLabel(
      root,
      `${exploration.title} · ${historyLifecycleLabel(exploration.lifecycle)}`,
      startX,
      y - 56
    );
    x = startX;
    const baselineScreen = exploration.target.baseline.screen;
    const baselineBundle = createExplorationCompileBundle(
      bundle,
      baselineScreen,
      exploration.target.baseline.prototype
    );
    root.append(createExplorationPrototypeFrame({
      bundle: baselineBundle,
      screen: baselineBundle.screens.screens[0] ?? baselineScreen,
      preset,
      selection,
      exploration,
      role: 'baseline',
      label: 'Starting point',
      canonicalBoundary: false,
      x,
      y
    }));
    x += preset.width + gapX;
    for (const candidate of exploration.candidates) {
      const candidateBundle = createExplorationCompileBundle(bundle, baselineScreen, candidate.prototype);
      root.append(createExplorationPrototypeFrame({
        bundle: candidateBundle,
        screen: candidateBundle.screens.screens[0] ?? baselineScreen,
        preset,
        selection,
        exploration,
        role: 'candidate',
        candidateId: candidate.id,
        label: candidate.id === exploration.selectedCandidateId ? `${candidate.label} · Chosen` : candidate.label,
        canonicalBoundary: false,
        x,
        y
      }));
      x += preset.width + gapX;
    }
    y += frameHeight + rowGap;
  }

  return {
    configure,
    fit: () => controller.fitTo([...root.querySelectorAll<HTMLElement>('.frame-slot')])
  };
}

function appendHistoryRowLabel(root: HTMLElement, label: string, x: number, y: number): void {
  const rowLabel = el('div', 'bp-chrome-history-row-label', label);
  rowLabel.style.left = `${x}px`;
  rowLabel.style.top = `${y}px`;
  root.append(rowLabel);
}

function historyLifecycleLabel(lifecycle: ExplorationDefinition['lifecycle']): string {
  return lifecycle === 'active' ? 'Active' : lifecycle === 'promoted' ? 'Promoted' : 'Archived';
}

function screenPrototypeForComparison(screen: ScreenDefinition): ExplorationPrototypeSource {
  if (!screen.prototype) {
    throw new Error(`Screen "${screen.id}" does not retain a prototype source.`);
  }
  return screen.prototype;
}

function mountExplorationScreens(
  root: HTMLElement,
  boardCanvas: CanvasController,
  bundle: BlueprintProjectBundle,
  explorationId: string
): BoardMount {
  root.dataset.canvasMode = 'exploration';
  root.dataset.explorationId = explorationId;
  const exploration = bundle.explorations.explorations.find(candidate => candidate.id === explorationId);
  if (!exploration) {
    explorationTitle.textContent = 'Exploration unavailable';
    root.dataset.explorationStatus = 'unavailable';
    const unavailable = createExplorationUnavailablePanel();
    root.append(unavailable);
    const configure = (): CanvasController =>
      boardCanvas.configure({
        minScale: 0.15,
        readableScale: 0.55,
        fallbackWidth: 420,
        fallbackHeight: 180
      });
    const controller = configure();
    return {
      configure,
      fit: () => controller.fitTo([unavailable])
    };
  }

  const screen = exploration.target.baseline.screen;
  const preset = bundle.manifest.framePresets.find(candidate => candidate.id === exploration.target.framePresetId);
  root.dataset.screenId = screen.id;
  root.setAttribute('aria-label', `${screen.name} exploration`);
  explorationTitle.textContent = `${screenFrameLabel(screen)} · ${exploration.title}`;
  if (!preset || !screen.prototype) {
    root.dataset.explorationStatus = 'unavailable';
    const unavailable = createExplorationUnavailablePanel();
    root.append(unavailable);
    const configure = (): CanvasController =>
      boardCanvas.configure({
        minScale: 0.15,
        readableScale: 0.55,
        fallbackWidth: 420,
        fallbackHeight: 180
      });
    const controller = configure();
    return {
      configure,
      fit: () => controller.fitTo([unavailable])
    };
  }

  const condition = screen.prototype.reviewConditions.find(candidate =>
    candidate.framePresetId === exploration.target.framePresetId && candidate.state === exploration.target.state
  );
  const selection: SelectedPrototypeReviewCondition = {
    conditionId: condition?.id ?? 'exploration-target',
    framePresetId: exploration.target.framePresetId,
    state: exploration.target.state
  };
  const fallbackHeight = frameExtentHeight(screen, preset);
  const configure = (): CanvasController =>
    boardCanvas.configure({
      minScale: 0.08,
      readableScale: 0.12,
      fallbackWidth: preset.width,
      fallbackHeight
    });
  const controller = configure();
  const startX = 90;
  const y = 180;
  const gapX = 80;
  let x = startX;

  const baselineBundle = createExplorationCompileBundle(bundle, screen, exploration.target.baseline.prototype);
  const baselineScreen = baselineBundle.screens.screens[0] ?? screen;
  root.append(createExplorationPrototypeFrame({
    bundle: baselineBundle,
    screen: baselineScreen,
    preset,
    selection,
    exploration,
    role: 'baseline',
    label: 'Current',
    x,
    y
  }));
  x += preset.width + gapX;

  for (const candidate of exploration.candidates) {
    const candidateBundle = createExplorationCompileBundle(bundle, screen, candidate.prototype);
    const candidateScreen = candidateBundle.screens.screens[0] ?? screen;
    root.append(createExplorationPrototypeFrame({
      bundle: candidateBundle,
      screen: candidateScreen,
      preset,
      selection,
      exploration,
      role: 'candidate',
      candidateId: candidate.id,
      label: candidate.label,
      x,
      y
    }));
    x += preset.width + gapX;
  }

  return {
    configure,
    fit: () => controller.fitTo([...root.querySelectorAll<HTMLElement>('.frame-slot')])
  };
}

function createExplorationCompileBundle(
  bundle: BlueprintProjectBundle,
  screen: ScreenDefinition,
  prototype: ExplorationPrototypeSource
): BlueprintProjectBundle {
  if (!screen.prototype) {
    return bundle;
  }
  const shadowScreen: ScreenDefinition = {
    ...screen,
    prototype: {
      ...screen.prototype,
      source: prototype.source,
      styles: prototype.styles,
      assetRefs: prototype.assetRefs
    }
  };
  return {
    ...bundle,
    screens: {
      ...bundle.screens,
      screens: [shadowScreen, ...bundle.screens.screens.filter(candidate => candidate.id !== screen.id)]
    }
  };
}

interface ExplorationFrameOptions {
  bundle: BlueprintProjectBundle;
  screen: ScreenDefinition;
  preset: FramePreset;
  selection: SelectedPrototypeReviewCondition;
  exploration?: ExplorationDefinition;
  role: 'current' | 'version' | 'baseline' | 'candidate';
  candidateId?: string;
  historyVersion?: number;
  canonicalBoundary?: boolean;
  unavailableNoun?: 'Variation' | 'Version';
  label: string;
  x: number;
  y: number;
}

function createExplorationPrototypeFrame(options: ExplorationFrameOptions): HTMLElement {
  const {
    bundle,
    screen,
    preset,
    selection,
    exploration,
    role,
    candidateId,
    historyVersion,
    canonicalBoundary = role === 'baseline' || role === 'current',
    unavailableNoun = 'Variation',
    label,
    x,
    y
  } = options;
  const slot = el('div', 'frame-slot exploration-frame-slot');
  slot.style.left = `${x}px`;
  slot.style.top = `${y}px`;
  if (exploration) {
    slot.dataset.explorationId = exploration.id;
  }
  slot.dataset.explorationRole = role;
  if (candidateId) {
    slot.dataset.explorationCandidateId = candidateId;
  }
  if (historyVersion !== undefined) {
    slot.dataset.historyVersion = String(historyVersion);
  }
  slot.dataset.selectionFrameKey = [exploration?.id ?? '', role, candidateId ?? '', historyVersion ?? ''].join('\u0000');

  const frame = el('article', 'frame frame-canonical exploration-frame');
  frame.style.setProperty('--frame-width', `${preset.width}px`);
  frame.style.setProperty('--frame-height', `${preset.height}px`);
  frame.style.setProperty('--frame-safe-top', `${preset.safeArea.top}px`);
  frame.style.setProperty('--frame-safe-right', `${preset.safeArea.right}px`);
  frame.style.setProperty('--frame-safe-bottom', `${preset.safeArea.bottom}px`);
  frame.style.setProperty('--frame-safe-left', `${preset.safeArea.left}px`);
  frame.style.setProperty('--frame-body-top', `${bodyTopInset(preset)}px`);
  frame.style.setProperty('--frame-body-bottom', `${bodyBottomInset(preset)}px`);
  frame.dataset.screenId = screen.id;
  frame.dataset.frameType = preset.type;
  frame.dataset.framePresetId = preset.id;
  frame.dataset.reviewConditionId = selection.conditionId;
  frame.dataset.reviewState = selection.state;
  if (exploration) {
    frame.dataset.explorationId = exploration.id;
  }
  frame.dataset.explorationRole = role;
  if (candidateId) {
    frame.dataset.explorationCandidateId = candidateId;
  }
  if (historyVersion !== undefined) {
    frame.dataset.historyVersion = String(historyVersion);
  }
  if (canonicalBoundary) {
    setBoundary(frame, 'screen', screen.id, bundle.manifest.project.id, screen.name);
    frame.dataset.boundarySummary = screen.description;
  }

  const head = el('div', 'frame-head bp-chrome-frame-head');
  const note = el('div', 'frame-note bp-chrome-frame-note');
  note.append(el('span', 'dot'), el('span', 'frame-name', label));
  head.append(note);

  const rendered = createExplorationPrototypeScreen(bundle, screen, preset, selection, label, unavailableNoun);
  frame.dataset.explorationStatus = rendered.available ? 'available' : 'unavailable';
  if (preset.type === 'mobile') {
    const display = el('div', 'frame-display');
    display.append(createStatusBar(), rendered.element, createFrameHomeIndicator());
    frame.append(display);
  } else {
    frame.append(createBrowserBar(screen), rendered.element);
  }
  slot.append(head, frame);
  return slot;
}

function createExplorationPrototypeScreen(
  bundle: BlueprintProjectBundle,
  screen: ScreenDefinition,
  preset: FramePreset,
  selection: SelectedPrototypeReviewCondition,
  label: string,
  unavailableNoun: 'Variation' | 'Version' = 'Variation'
): { element: HTMLElement; available: boolean } {
  const host = el('div', `screen canonical-prototype-screen canonical-prototype-screen-${preset.type}`);
  host.dataset.frameType = preset.type;
  host.dataset.prototypeRenderMode = 'canonical-app-owned';
  try {
    const compiled = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: screen.id },
      state: selection.state
    });
    const iframe = document.createElement('iframe');
    iframe.className = 'canonical-prototype-iframe';
    applyPrototypeIframeIsolation(iframe);
    iframe.title = `${label} · ${screen.name} · ${selection.state} · ${preset.name}`;
    iframe.srcdoc = compiled.html;
    prototypeDocumentByFrame.set(iframe, compiled.html);
    iframe.dataset.prototypeTargetBoundary = compiled.targetBoundaryId;
    iframe.dataset.prototypeObservedUses = JSON.stringify(compiled.observedUses);
    host.append(iframe);
    return { element: host, available: true };
  } catch {
    host.dataset.explorationStatus = 'unavailable';
    const message = el('div', 'prototype-compile-error exploration-prototype-error');
    message.setAttribute('role', 'status');
    message.append(
      el('strong', '', `${unavailableNoun} unavailable`),
      el('span', '', unavailableNoun === 'Variation'
        ? 'Ask the agent to refresh this exploration.'
        : 'Ask the agent to check this saved version.')
    );
    host.append(message);
    return { element: host, available: false };
  }
}

function createExplorationUnavailablePanel(): HTMLElement {
  return createFocusedUnavailablePanel(
    'Exploration unavailable',
    'Ask the agent to check the saved exploration and open it again.'
  );
}

function createFocusedUnavailablePanel(title: string, message: string): HTMLElement {
  const panel = el('section', 'bp-chrome-exploration-unavailable');
  panel.dataset.explorationStatus = 'unavailable';
  panel.style.left = '90px';
  panel.style.top = '180px';
  panel.append(
    el('strong', '', title),
    el('span', '', message)
  );
  return panel;
}

interface ScreenFrameLayout {
  screen: ScreenDefinition;
  preset: FramePreset;
  x: number;
  y: number;
  flow?: string;
  flowLabel?: { text: string; x: number; y: number };
  routeLabel?: { text: string; x: number; y: number };
  prototypeSelection?: SelectedPrototypeReviewCondition;
  selectionError?: string;
}

// Rows are routes; a row's columns read left-to-right as substates of that route.
// The group key is the screen's full production route, so distinct subroutes
// (e.g. /settings vs /settings/flic) each get their own row instead of one
// overlong row per top-level section.
function routeGroupOf(screen: ScreenDefinition): string {
  return screenRoutePath(screen);
}

function layoutScreenFrames(
  bundle: BlueprintProjectBundle,
  request: PrototypeReviewSelectionRequest,
  flowFilter?: string
): ScreenFrameLayout[] {
  const startX = 90;
  const startY = 160;
  const gapX = 80;
  const gapY = 120;

  // Screens group by declared sub-flow (first-seen order); a flow filter narrows
  // the board to one flow's subpage. Within a flow, each top-level route gets its
  // own labeled row in first-seen order.
  const groups = new Map<string | undefined, ScreenDefinition[]>();
  for (const screen of bundle.screens.screens) {
    const key = screen.flow;
    if (flowFilter !== undefined && key !== flowFilter) {
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)?.push(screen);
  }

  const layouts: ScreenFrameLayout[] = [];
  let y = startY;
  // Flow labels only earn their place when several flows share one canvas
  // (deep-link boards); on a single-flow page the rail already names it.
  const showFlowLabels = groups.size > 1;
  for (const [flow, screens] of groups) {
    const rows = new Map<string, ScreenDefinition[]>();
    for (const screen of screens) {
      const key = routeGroupOf(screen);
      if (!rows.has(key)) {
        rows.set(key, []);
      }
      rows.get(key)?.push(screen);
    }
    let flowLabeled = !showFlowLabels;
    for (const [route, rowScreens] of rows) {
      let x = startX;
      let rowHeight = 0;
      let routeLabeled = false;
      for (const screen of rowScreens) {
        for (const resolved of resolveScreenFrameVariants(bundle, screen, request)) {
          const layout: ScreenFrameLayout = { screen, preset: resolved.preset, x, y, flow, ...resolved.prototype };
          if (!flowLabeled && flow !== undefined) {
            layout.flowLabel = { text: flow, x: startX, y: y - 70 };
            flowLabeled = true;
          }
          if (!routeLabeled) {
            layout.routeLabel = { text: route, x: startX, y: y - 44 };
            routeLabeled = true;
          }
          layouts.push(layout);
          x += resolved.preset.width + gapX;
          rowHeight = Math.max(rowHeight, frameExtentHeight(screen, resolved.preset));
        }
      }
      y += rowHeight + gapY;
    }
  }

  return layouts;
}

// Canonical frames draw device/browser chrome outside the captured screen host,
// so the frame's visible extent exceeds the preset's content dimensions.
function frameExtentHeight(screen: ScreenDefinition, preset: FramePreset): number {
  if (!screen.prototype) {
    return preset.height;
  }
  return preset.height + (preset.type === 'mobile' ? 59 + 24 : 48);
}

function resolveScreenFrameVariants(
  bundle: BlueprintProjectBundle,
  screen: ScreenDefinition,
  request: PrototypeReviewSelectionRequest
): Array<{
  preset: FramePreset;
  prototype: { prototypeSelection?: SelectedPrototypeReviewCondition; selectionError?: string };
}> {
  // An explicit state/viewport request (capture, deep link) keeps single-frame selection.
  if (request.state || request.viewport || !screen.prototype) {
    return [resolveScreenFrame(bundle, screen, request)];
  }
  // Default board view: one frame per declared review condition (phone, desktop, states).
  return screen.prototype.reviewConditions.map(condition => {
    const preset = bundle.manifest.framePresets.find(candidate => candidate.id === condition.framePresetId);
    if (!preset) {
      return {
        preset: resolveFramePreset(bundle, screen),
        prototype: {
          selectionError: `Screen "${screen.id}" review condition "${condition.id}" references unknown frame preset "${condition.framePresetId}".`
        }
      };
    }
    return {
      preset,
      prototype: {
        prototypeSelection: { conditionId: condition.id, framePresetId: condition.framePresetId, state: condition.state }
      }
    };
  });
}

function resolveScreenFrame(
  bundle: BlueprintProjectBundle,
  screen: ScreenDefinition,
  request: PrototypeReviewSelectionRequest
): {
  preset: FramePreset;
  prototype: { prototypeSelection?: SelectedPrototypeReviewCondition; selectionError?: string };
} {
  if (!screen.prototype) {
    return { preset: resolveFramePreset(bundle, screen), prototype: {} };
  }
  try {
    const prototypeSelection = selectPrototypeReviewCondition(screen, request);
    const preset = bundle.manifest.framePresets.find(candidate => candidate.id === prototypeSelection.framePresetId);
    if (!preset) {
      throw new Error(
        `Screen "${screen.id}" review condition "${prototypeSelection.conditionId}" references unknown frame preset "${prototypeSelection.framePresetId}".`
      );
    }
    return { preset, prototype: { prototypeSelection } };
  } catch (error) {
    return {
      preset: resolveFramePreset(bundle, screen),
      prototype: { selectionError: errorMessage(error) }
    };
  }
}

function resolveFramePreset(bundle: BlueprintProjectBundle, screen: ScreenDefinition): FramePreset {
  return (
    bundle.manifest.framePresets.find(preset => preset.id === screen.framePresetId) ??
    bundle.manifest.framePresets.find(preset => preset.type === 'mobile') ??
    bundle.manifest.framePresets[0] ??
    defaultMobileFramePreset()
  );
}

function defaultMobileFramePreset(): FramePreset {
  return {
    id: 'phone',
    name: 'Phone',
    type: 'mobile',
    width: 393,
    height: 852,
    safeArea: {
      top: 59,
      right: 20,
      bottom: 34,
      left: 20
    }
  };
}

function addGroupHeading(
  root: HTMLElement,
  controller: CanvasController,
  options: { title: string; subtitle: string; x: number; y: number; accent: string }
): HTMLElement {
  const heading = el('div', 'group-head bp-chrome-group-head');
  heading.style.left = `${options.x}px`;
  heading.style.top = `${options.y}px`;
  heading.style.setProperty('--head-accent', options.accent);
  heading.append(el('h1', '', options.title), el('div', 'sub', options.subtitle));
  root.append(heading);
  controller.makeDraggable(heading, heading);
  return heading;
}

function createPrototypeFrame(
  bundle: BlueprintProjectBundle,
  tokenIndex: TokenIndex,
  screen: ScreenDefinition,
  preset: FramePreset,
  x: number,
  y: number,
  prototypeSelection?: SelectedPrototypeReviewCondition,
  selectionError?: string
): HTMLElement {
  // The frame lives inside an unclipped slot: the canonical frame clips its own
  // rounded chrome (overflow: hidden), so the floating head must hang from the slot
  // to stay visible above the frame.
  const slot = el('div', 'frame-slot');
  slot.style.left = `${x}px`;
  slot.style.top = `${y}px`;
  slot.dataset.liveFrameKey = liveFrameKey(screen.id, preset.id, prototypeSelection);
  const frame = el('article', 'frame');
  frame.style.setProperty('--frame-width', `${preset.width}px`);
  frame.style.setProperty('--frame-height', `${preset.height}px`);
  frame.style.setProperty('--frame-safe-top', `${preset.safeArea.top}px`);
  frame.style.setProperty('--frame-safe-right', `${preset.safeArea.right}px`);
  frame.style.setProperty('--frame-safe-bottom', `${preset.safeArea.bottom}px`);
  frame.style.setProperty('--frame-safe-left', `${preset.safeArea.left}px`);
  frame.style.setProperty('--frame-body-top', `${bodyTopInset(preset)}px`);
  frame.style.setProperty('--frame-body-bottom', `${bodyBottomInset(preset)}px`);
  setBoundary(frame, 'screen', screen.id, bundle.manifest.project.id, screen.name);
  frame.dataset.screenId = screen.id;
  frame.dataset.frameType = preset.type;
  frame.dataset.framePresetId = preset.id;
  frame.dataset.boundarySummary = screen.description;
  if (prototypeSelection) {
    frame.dataset.reviewConditionId = prototypeSelection.conditionId;
    frame.dataset.reviewState = prototypeSelection.state;
  }

  const head = el('div', 'frame-head bp-chrome-frame-head');
  const chip = el('button', 'frame-chip bp-chrome-frame-chip') as HTMLButtonElement;
  chip.type = 'button';
  chip.title = 'Select screen and copy its reference';
  chip.dataset.boundaryAction = 'copy-id';
  chip.append(el('span', 'dot'), el('span', 'frame-name', screenFrameLabel(screen)));
  chip.addEventListener('click', () => {
    setCanvasSelection(domSelectionState(frame), true);
    const name = chip.querySelector<HTMLElement>('.frame-name');
    const original = name?.textContent ?? '';
    if (name) {
      name.textContent = `${screen.id} copied`;
    }
    chip.classList.add('copied');
    window.setTimeout(() => {
      chip.classList.remove('copied');
      if (name) {
        name.textContent = original;
      }
    }, 900);
  });
  const shot = createIconButton('frame-shot bp-chrome-frame-tool bp-chrome-frame-shot', 'Copy screen as PNG', cameraIcon());
  const save = createIconButton('frame-save bp-chrome-frame-tool bp-chrome-frame-save', 'Save screen as PNG', downloadIcon());
  head.append(chip, shot, save);
  const exploration = prototypeSelection
    ? bundle.explorations.explorations.find(candidate =>
      candidate.lifecycle === 'active'
        && candidate.target.screenId === screen.id
        && candidate.target.state === prototypeSelection.state
        && candidate.target.framePresetId === preset.id
    )
    : undefined;
  if (exploration) {
    const variations = el('button', 'bp-chrome-frame-exploration', 'Variations') as HTMLButtonElement;
    variations.type = 'button';
    variations.title = `Open ${exploration.title}`;
    variations.dataset.explorationId = exploration.id;
    variations.addEventListener('click', () => openExploration(exploration.id));
    head.append(variations);
  }
  const hasSavedHistory = prototypeSelection
    ? bundle.history.entries.some(entry => (
      entry.screenId === screen.id
        && entry.state === prototypeSelection.state
        && entry.framePresetId === preset.id
    )) || bundle.explorations.explorations.some(candidate => (
      candidate.lifecycle !== 'active'
        && candidate.target.screenId === screen.id
        && candidate.target.state === prototypeSelection.state
        && candidate.target.framePresetId === preset.id
    ))
    : false;
  if (prototypeSelection && hasSavedHistory) {
    const historyButton = el('button', 'bp-chrome-frame-history', 'History') as HTMLButtonElement;
    historyButton.type = 'button';
    historyButton.title = `Open ${screen.name} history`;
    historyButton.dataset.historyScreenId = screen.id;
    historyButton.addEventListener('click', () => openHistory(screen.id, prototypeSelection.state, preset.id));
    head.append(historyButton);
  }

  if (screen.prototype) {
    // Canonical screens render inside device/browser chrome that lives OUTSIDE the
    // captured screen host, keeping MCP/canvas captures at exact preset content pixels.
    const canonicalScreen = createCanonicalPrototypeScreen(bundle, screen, preset, prototypeSelection, selectionError);
    const screenEl = canonicalScreen.element;
    const findingBoundaryIds = frameFindingBoundaryIds(bundle, screen, screenEl);
    const findingCount = designFindings(bundle).filter(finding => findingBoundaryIds.includes(finding.boundaryId)).length;
    if (findingCount > 0) {
      const findingsButton = el('button', 'bp-chrome-frame-findings', findingCount === 1 ? '1 finding' : `${findingCount} findings`) as HTMLButtonElement;
      findingsButton.type = 'button';
      findingsButton.title = `Show design findings for ${screen.name}`;
      findingsButton.dataset.findingsScreenId = screen.id;
      findingsButton.addEventListener('click', () => openFindingsPanel({ title: screen.name, boundaryIds: findingBoundaryIds }));
      head.append(findingsButton);
    }
    wireFrameCapture({
      screenEl,
      shot,
      save,
      screenId: screen.id,
      captureDocument: canonicalScreen.captureDocument
    });
    frame.classList.add('frame-canonical');
    if (preset.type === 'mobile') {
      // Display stack (status bar, screen, home indicator) clipped to the
      // phone's rounded panel inside a full bezel ring.
      const display = el('div', 'frame-display');
      display.append(createStatusBar(), screenEl, createFrameHomeIndicator());
      frame.append(display);
    } else {
      frame.append(createBrowserBar(screen), screenEl);
    }
    slot.append(head, frame);
    return slot;
  }

  const screenEl = createLegacyPrototypeScreen(bundle, tokenIndex, screen, preset);
  wireFrameCapture({ screenEl, shot, save, screenId: screen.id });

  slot.append(head, frame);
  frame.append(screenEl);
  return slot;
}

function liveFrameKey(
  screenId: string,
  framePresetId: string,
  selection?: SelectedPrototypeReviewCondition
): string {
  return [screenId, framePresetId, selection?.state ?? '', selection?.conditionId ?? ''].join('\u0000');
}

function createFrameHomeIndicator(): HTMLElement {
  const strip = el('div', 'frame-home-indicator');
  strip.append(el('span', 'frame-home-indicator-pill'));
  return strip;
}

function createCanonicalPrototypeScreen(
  bundle: BlueprintProjectBundle,
  screen: ScreenDefinition,
  preset: FramePreset,
  selection: SelectedPrototypeReviewCondition | undefined,
  selectionError: string | undefined
): { element: HTMLElement; captureDocument?: string } {
  const host = el('div', `screen canonical-prototype-screen canonical-prototype-screen-${preset.type}`);
  host.dataset.frameType = preset.type;
  host.dataset.prototypeRenderMode = 'canonical-app-owned';
  if (selectionError || !selection) {
    host.append(createPrototypeCompileError(selectionError ?? `Screen "${screen.id}" has no selected review condition.`));
    return { element: host };
  }
  try {
    const compiled = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: screen.id },
      state: selection.state
    });
    const iframe = document.createElement('iframe');
    iframe.className = 'canonical-prototype-iframe';
    applyPrototypeIframeIsolation(iframe);
    iframe.title = `${screen.name} · ${selection.state} · ${preset.name}`;
    iframe.srcdoc = compiled.html;
    prototypeDocumentByFrame.set(iframe, compiled.html);
    iframe.dataset.prototypeTargetBoundary = compiled.targetBoundaryId;
    iframe.dataset.prototypeObservedUses = JSON.stringify(compiled.observedUses);
    host.append(iframe);
    return { element: host, captureDocument: compiled.html };
  } catch (error) {
    host.append(createPrototypeCompileError(error));
    return { element: host };
  }
}

function createLegacyPrototypeScreen(
  bundle: BlueprintProjectBundle,
  tokenIndex: TokenIndex,
  screen: ScreenDefinition,
  preset: FramePreset
): HTMLElement {
  const screenEl = el('div', `screen screen-template screen-template-${preset.type}`);
  screenEl.dataset.frameType = preset.type;
  screenEl.dataset.prototypeRenderMode = 'legacy-fallback';
  screenEl.dataset.prototypeRenderLabel = 'Legacy section projection fallback';
  const body = el('div', 'screen-template-body');
  body.dataset.screenId = screen.id;
  applyScreenCanvasTokens(body, tokenIndex);
  for (const section of screen.sections) {
    body.append(createScreenSectionPrototype(bundle, tokenIndex, screen, section));
  }
  if (preset.type === 'mobile') {
    screenEl.append(createStatusBar(), body, el('div', 'home-indicator'));
  } else {
    screenEl.append(createBrowserBar(screen), body);
  }
  return screenEl;
}

function createPrototypeCompileError(error: unknown): HTMLElement {
  const message = el('div', 'prototype-compile-error');
  message.setAttribute('role', 'alert');
  message.append(
    el('strong', '', 'Prototype unavailable'),
    el('span', '', errorMessage(error))
  );
  return message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bodyTopInset(preset: FramePreset): number {
  if (preset.type === 'desktop') {
    return Math.max(preset.safeArea.top, 48);
  }
  return preset.safeArea.top;
}

function bodyBottomInset(preset: FramePreset): number {
  if (preset.type === 'desktop') {
    return preset.safeArea.bottom;
  }
  return 24;
}

function createScreenSectionPrototype(
  bundle: BlueprintProjectBundle,
  tokenIndex: TokenIndex,
  screen: ScreenDefinition,
  section: ScreenDefinition['sections'][number]
): HTMLElement {
  const sectionEl = el('section', 'screen-section');
  setBoundary(sectionEl, 'section', `${screen.id}/${section.id}`, bundle.manifest.project.id, section.name);
  sectionEl.dataset.screenId = screen.id;
  sectionEl.dataset.prototypeOnly = String(section.prototypeOnly);

  const dependencies = section.uses.map(dependency => createScreenDependencyView(bundle, tokenIndex, section, dependency));
  const primaryDependency = dependencies[0];
  if (primaryDependency) {
    sectionEl.dataset.screenDependencyFamily = primaryDependency.family;
    sectionEl.style.setProperty('--section-accent', familyAccent(primaryDependency.family));
  } else {
    sectionEl.style.setProperty('--section-accent', familyAccent('generic'));
  }

  sectionEl.title = section.name;

  const body = el('div', 'screen-section-body');
  for (const layoutClass of sectionLayoutClasses(section)) {
    body.classList.add(layoutClass);
  }
  for (const dependency of dependencies) {
    body.append(dependency.node);
  }
  if (dependencies.length === 0) {
    body.append(el('p', 'screen-section-copy', fallbackSectionContent(section)));
  }
  sectionEl.append(body);

  return sectionEl;
}

function createScreenDependencyView(
  bundle: BlueprintProjectBundle,
  tokenIndex: TokenIndex,
  section: ScreenDefinition['sections'][number],
  dependency: BoundaryDependency
): { node: HTMLElement; family: string } {
  const resolved = resolveScreenDependency(bundle, dependency);
  const family = resolved.primitive ? inferPrimitiveFamily(resolved.primitive) : 'generic';
  const node = el('article', `screen-dependency screen-dependency-${family}`);
  node.dataset.screenUses = `${dependency.kind}:${dependency.id}`;
  node.dataset.prototypeFamily = family;
  node.style.setProperty('--dependency-accent', familyAccent(family));
  const keywords = dependencyLayoutKeywords(dependency);
  for (const keyword of keywords) {
    node.classList.add(`dep-${keyword}`);
  }

  if (resolved.primitive) {
    const state = resolved.state ?? resolved.primitive.stateSets.flatMap(stateSet => stateSet.states)[0];
    const copy = resolveScreenPrototypeCopy(section, dependency);
    node.dataset.prototypePrimitive = resolved.primitive.id;
    if (state) {
      node.dataset.prototypeState = state.id;
    }
    node.append(createScreenDependencySpecimen({ bundle, tokenIndex, primitive: resolved.primitive, family }, state, copy, dependency, keywords));
    return { node, family };
  }

  node.append(createScreenPrototypeFallback(family, dependency.binding?.copy ?? fallbackSectionContent(section), dependency));
  return { node, family };
}

function createScreenDependencySpecimen(
  context: PrimitiveRenderContext,
  state: PrimitiveState | undefined,
  copy: string,
  dependency: BoundaryDependency,
  keywords: Set<string> = new Set()
): HTMLElement {
  const effectiveState = state ?? syntheticDefaultState(context.primitive, context.tokenIndex);
  let node: HTMLElement;

  if (context.family === 'button' && primitiveHasTerm(context.primitive, 'back')) {
    node = createBackButtonSpecimen(context, effectiveState);
  } else if (context.family === 'button') {
    node = createButtonSpecimen(context, effectiveState, copy);
    node.classList.add('screen-button-specimen');
  } else if (context.family === 'badge') {
    node = el('span', `badge ${badgeClass(effectiveState)}`, copy);
    node.dataset.primitiveStateId = effectiveState.id;
    applyPrimitiveTokenStyles(node, context, effectiveState, {
      colorHook: 'screen-badge-fill',
      colorProperty: 'background'
    });
  } else if (context.family === 'card' || context.family === 'surface') {
    node = createScreenCardSpecimen(context, effectiveState, copy, keywords);
  } else if (context.family === 'media') {
    node = createScreenMediaSpecimen(context, effectiveState, copy);
  } else if (context.family === 'row' || context.family === 'list') {
    const parts = splitCopyParts(copy);
    node = createListRow(parts[0] ?? copy, parts[1] ?? '');
    node.dataset.primitiveStateId = effectiveState.id;
    applyPrimitiveTokenStyles(node, context, effectiveState, {
      colorHook: 'screen-row-surface',
      colorProperty: 'background',
      spaceHook: 'screen-row-padding-inline',
      radiusHook: 'screen-row-radius'
    });
  } else if (context.family === 'input') {
    node = el('div', `inp screen-input-specimen ${inputStateClass(effectiveState)}`);
    node.dataset.primitiveStateId = effectiveState.id;
    node.append(el('span', 'inp-text', copy));
    applyPrimitiveTokenStyles(node, context, effectiveState, {
      colorHook: 'screen-input-border',
      colorProperty: 'border',
      spaceHook: 'screen-input-padding-inline',
      radiusHook: 'screen-input-radius',
      typographyHook: 'screen-input-type'
    });
  } else if (context.family === 'checkbox' || context.family === 'switch') {
    node = createScreenChoiceSpecimen(context, effectiveState, copy);
  } else if (context.family === 'slider') {
    node = createScreenSliderSpecimen(context, effectiveState, copy);
  } else if (context.family === 'navigation') {
    node = primitiveHasTerm(context.primitive, 'back')
      ? createBackButtonSpecimen(context, effectiveState)
      : createScreenNavigationSpecimen(context, effectiveState, splitCopyParts(copy)[0] ?? copy);
  } else if (context.family === 'separator') {
    node = createScreenSeparatorSpecimen(context, effectiveState, dependency.binding?.copy?.trim() ? copy : '');
  } else if (context.family === 'loading') {
    node = createScreenLoadingSpecimen(context, effectiveState);
  } else if (context.family === 'dialog' || context.family === 'menu' || context.family === 'sheet' || context.family === 'skeleton' || context.family === 'icon') {
    node = createScreenCardSpecimen(context, effectiveState, copy, keywords);
  } else {
    node = createScreenPrototypeFallback(context.family, copy, dependency);
  }

  if (dependency.binding?.data) {
    node.dataset.dataRef = dependency.binding.data;
  }
  return node;
}

function createScreenChoiceSpecimen(context: PrimitiveRenderContext, state: PrimitiveState, copy: string): HTMLElement {
  const sample = el('div', 'choice-specimen screen-choice-specimen');
  const isSwitch = context.family === 'switch';
  const control = isSwitch ? el('span', `sw ${stateOnClass(state)} ${disabledClass(state)}`) : el('span', `cbx ${stateOnClass(state)} ${disabledClass(state)}`);
  control.dataset.primitiveStateId = state.id;
  if (isSwitch) {
    control.append(el('span', 'sw-thumb'));
  }
  applyPrimitiveTokenStyles(control, context, state, {
    colorHook: `screen-${context.family}-accent`,
    colorProperty: 'background',
    radiusHook: `screen-${context.family}-radius`,
    motionHook: `screen-${context.family}-motion`
  });
  sample.append(control, el('span', 'choice-label', copy));
  return sample;
}

function createScreenSliderSpecimen(context: PrimitiveRenderContext, state: PrimitiveState, copy: string): HTMLElement {
  const row = el('div', 'slider-row screen-slider-specimen');
  row.dataset.primitiveStateId = state.id;
  row.append(el('span', 'slider-label', copy));
  const slider = el('span', `slider ${disabledClass(state)}`);
  const track = el('span', 'track');
  const fill = el('span', 'fill');
  fill.style.width = isDisabledState(state) ? '42%' : '66%';
  const thumb = el('span', 'thumb');
  thumb.style.left = fill.style.width;
  slider.append(track, fill, thumb);
  applyPrimitiveTokenStyles(fill, context, state, {
    colorHook: 'screen-slider-fill',
    colorProperty: 'background',
    motionHook: 'screen-slider-motion'
  });
  row.append(slider);
  return row;
}

function createScreenNavigationSpecimen(context: PrimitiveRenderContext, state: PrimitiveState, copy: string): HTMLElement {
  const nav = createNavigationSpecimen(state, copy);
  nav.classList.add('screen-navigation-specimen');
  nav.dataset.primitiveStateId = state.id;
  applyPrimitiveTokenStyles(nav, context, state, {
    colorHook: 'screen-navigation-surface',
    colorProperty: 'background',
    radiusHook: 'screen-navigation-radius',
    shadowHook: 'screen-navigation-shadow'
  });
  return nav;
}

function createScreenSeparatorSpecimen(context: PrimitiveRenderContext, state: PrimitiveState, copy: string): HTMLElement {
  const sample = el('div', 'separator-specimen screen-separator-specimen');
  sample.dataset.primitiveStateId = state.id;
  if (copy) {
    sample.append(el('span', 'separator-label', copy));
  }
  const line = el('span', `separator ${state.id}`);
  applyPrimitiveTokenStyles(line, context, state, {
    colorHook: 'screen-separator-color',
    colorProperty: 'background'
  });
  sample.append(line);
  return sample;
}

function createScreenLoadingSpecimen(context: PrimitiveRenderContext, state: PrimitiveState): HTMLElement {
  const panel = el('div', 'loading-panel screen-loading-specimen');
  panel.dataset.primitiveStateId = state.id;
  panel.append(el('span', 'loading-dot'), el('span', 'loading-dot'), el('span', 'loading-dot'));
  applyPrimitiveTokenStyles(panel, context, state, {
    colorHook: 'screen-loading-surface',
    colorProperty: 'background',
    radiusHook: 'screen-loading-radius',
    motionHook: 'screen-loading-motion'
  });
  return panel;
}

function createScreenPrototypeFallback(family: string, copy: string, dependency: BoundaryDependency): HTMLElement {
  let node: HTMLElement;
  if (family === 'button') {
    node = el('span', 'screen-prototype-button-label', copy);
  } else if (family === 'badge') {
    node = el('span', 'screen-prototype-pill-label', copy);
  } else {
    node = el('p', 'screen-section-copy', copy);
  }

  if (dependency.binding?.data) {
    node.dataset.dataRef = dependency.binding.data;
  }
  return node;
}

function resolveScreenPrototypeCopy(
  section: ScreenDefinition['sections'][number],
  dependency: BoundaryDependency
): string {
  const copy = dependency.binding?.copy?.trim();
  if (copy) {
    return copy;
  }
  return fallbackSectionContent(section);
}

function fallbackSectionContent(section: ScreenDefinition['sections'][number]): string {
  return section.prototypeOnly ? `${section.name} placeholder` : section.name;
}

function resolveScreenDependency(
  bundle: BlueprintProjectBundle,
  dependency: BoundaryDependency
): { primitive?: PrimitiveDefinition; state?: PrimitiveState } {
  if (dependency.kind === 'primitive') {
    const primitive = bundle.primitives.primitives.find(candidate => candidate.id === dependency.id);
    return { primitive };
  }

  if (dependency.kind === 'state-set') {
    const [primitiveId, stateSetId] = dependency.id.split('/');
    const primitive = bundle.primitives.primitives.find(candidate => candidate.id === primitiveId);
    const stateSet = primitive?.stateSets.find(candidate => candidate.id === stateSetId);
    const state = stateSet?.states.find(candidate => candidate.id === dependency.binding?.variant || candidate.id === dependency.binding?.state) ?? stateSet?.states[0];
    return { primitive, state };
  }

  return {};
}

function createStatusBar(): HTMLElement {
  const status = el('div', 'status-bar');
  const icons = el('span', 'status-icons');
  icons.innerHTML = `${signalIcon()}${wifiIcon()}${batteryIcon()}`;
  status.append(el('span', 'time', '9:41'), icons);
  return status;
}

function signalIcon(): string {
  return '<svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor" aria-hidden="true"><rect x="0" y="7" width="3" height="5" rx="1"/><rect x="4.5" y="5" width="3" height="7" rx="1"/><rect x="9" y="2.5" width="3" height="9.5" rx="1"/><rect x="13.5" y="0" width="3" height="12" rx="1"/></svg>';
}

function wifiIcon(): string {
  return '<svg width="17" height="12" viewBox="0 0 17 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M1.5 3.6a10.4 10.4 0 0 1 14 0"/><path d="M3.9 6.3a7 7 0 0 1 9.2 0"/><path d="M6.4 9a3.6 3.6 0 0 1 4.2 0"/><circle cx="8.5" cy="11" r="1" fill="currentColor" stroke="none"/></svg>';
}

function batteryIcon(): string {
  return '<svg width="27" height="13" viewBox="0 0 27 13" fill="none" aria-hidden="true"><rect x="0.5" y="0.5" width="22" height="12" rx="3.5" stroke="currentColor" stroke-opacity="0.5"/><rect x="2.5" y="2.5" width="16" height="8" rx="1.8" fill="currentColor"/><path d="M25 4.5v4a2.2 2.2 0 0 0 0-4Z" fill="currentColor" fill-opacity="0.5"/></svg>';
}

function createBrowserBar(screen: ScreenDefinition): HTMLElement {
  const bar = el('div', 'browser-bar');
  const controls = el('span', 'browser-controls');
  controls.append(el('span', 'browser-dot close'), el('span', 'browser-dot minimize'), el('span', 'browser-dot maximize'));
  const address = el('span', 'browser-address');
  const route = el('span', 'browser-address-text', screen.productionRelationship?.routePath ?? screen.name);
  address.innerHTML = lockIcon();
  address.append(route);
  bar.append(controls, address, el('span', 'browser-bar-spacer'));
  return bar;
}

function lockIcon(): string {
  return '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
}

function createSpecCard(options: {
  label: string;
  x: number;
  y: number;
  width: number;
  accent: string;
  boundary: [BoundaryKind, string, string];
}): HTMLElement {
  const card = el('article', 'spec');
  card.style.left = `${options.x}px`;
  card.style.top = `${options.y}px`;
  card.style.width = `${options.width}px`;
  card.style.setProperty('--accent', options.accent);
  setBoundary(card, options.boundary[0], options.boundary[1], options.boundary[2], options.label);

  const chip = el('button', 'spec-chip bp-chrome-world-label') as HTMLButtonElement;
  chip.type = 'button';
  chip.title = 'Drag canvas item';
  chip.append(el('span', 'dot'), el('span', '', options.label));
  card.append(chip);
  return card;
}

function appendSpecBody(card: HTMLElement): HTMLElement {
  const body = el('div', 'spec-body');
  card.append(body);
  return body;
}

function createIconButton(className: string, title: string, iconMarkup: string): HTMLButtonElement {
  const button = el('button', className) as HTMLButtonElement;
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = iconMarkup;
  return button;
}

function wireFrameCapture(options: {
  screenEl: HTMLElement;
  shot: HTMLButtonElement;
  save: HTMLButtonElement;
  screenId: string;
  captureDocument?: string;
}): void {
  const capture = async (): Promise<Blob> => {
    const blob = options.captureDocument
      ? await captureCanonicalPrototype(options.screenEl, options.captureDocument)
      : await toBlob(options.screenEl, {
          pixelRatio: 2,
          style: {
            boxShadow: 'none'
          }
        });
    if (!blob) {
      throw new Error('Screen capture returned an empty image.');
    }
    return blob;
  };

  options.shot.addEventListener('click', async () => {
    if (options.shot.classList.contains('busy')) {
      return;
    }
    options.shot.classList.add('busy');
    const blobPromise = capture();
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      flashCaptureButton(options.shot, 'done');
    } catch {
      const blob = await blobPromise.catch(() => null);
      if (blob) {
        downloadBlob(blob, options.screenId);
        flashCaptureButton(options.shot, 'done');
      } else {
        flashCaptureButton(options.shot, 'fail');
      }
    }
  });

  options.save.addEventListener('click', async () => {
    if (options.save.classList.contains('busy')) {
      return;
    }
    options.save.classList.add('busy');
    const blob = await capture().catch(() => null);
    if (blob) {
      downloadBlob(blob, options.screenId);
    }
    flashCaptureButton(options.save, blob ? 'done' : 'fail');
  });
}

/**
 * html-to-image cannot read the deliberately opaque iframe used by the canvas,
 * so serializing the visible host produces a white PNG. Render the same compiled,
 * no-script document in a short-lived readable iframe and capture its document
 * root instead. The review iframe remains fully sandboxed and unchanged.
 */
async function captureCanonicalPrototype(screenEl: HTMLElement, html: string): Promise<Blob | null> {
  const width = screenEl.clientWidth;
  const height = screenEl.clientHeight;
  if (width <= 0 || height <= 0) {
    throw new Error('Screen capture requires a visible frame with non-zero dimensions.');
  }

  const captureFrame = document.createElement('iframe');
  captureFrame.style.cssText = [
    'position:fixed',
    `left:-${width + 100}px`,
    'top:0',
    `width:${width}px`,
    `height:${height}px`,
    'border:0',
    'pointer-events:none'
  ].join(';');
  captureFrame.tabIndex = -1;
  captureFrame.setAttribute('aria-hidden', 'true');
  // Same-origin access is needed only for serialization. Scripts remain denied
  // by both the sandbox and the compiled document's content security policy.
  captureFrame.setAttribute('sandbox', 'allow-same-origin');

  try {
    await loadCaptureDocument(captureFrame, html);
    const captureRoot = captureFrame.contentDocument?.documentElement;
    if (!captureRoot) {
      throw new Error('Screen capture could not access the rendered prototype document.');
    }
    await waitForCaptureReadiness(captureRoot.ownerDocument);
    return await toBlob(captureRoot, {
      width,
      height,
      canvasWidth: width,
      canvasHeight: height,
      pixelRatio: 2,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        overflow: 'hidden',
        boxShadow: 'none'
      }
    });
  } finally {
    captureFrame.remove();
  }
}

async function loadCaptureDocument(frame: HTMLIFrameElement, html: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('Screen capture document did not load in time.'));
    }, 10000);
    frame.addEventListener(
      'load',
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
    frame.addEventListener(
      'error',
      () => {
        window.clearTimeout(timeout);
        reject(new Error('Screen capture document failed to load.'));
      },
      { once: true }
    );
    frame.srcdoc = html;
    document.body.append(frame);
  });
}

async function waitForCaptureReadiness(document: Document): Promise<void> {
  await document.fonts.ready;
  await Promise.all(
    Array.from(document.images).map(async image => {
      if (!image.complete) {
        await new Promise<void>((resolve, reject) => {
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => reject(new Error('Screen capture image failed to load.')), { once: true });
        });
      }
      await image.decode();
    })
  );

  const view = document.defaultView;
  if (!view) {
    return;
  }
  await new Promise<void>(resolve => view.requestAnimationFrame(() => resolve()));
  await new Promise<void>(resolve => view.requestAnimationFrame(() => resolve()));
}

function downloadBlob(blob: Blob, id: string): void {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = `${id}.png`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function flashCaptureButton(button: HTMLButtonElement, result: 'done' | 'fail'): void {
  button.classList.remove('busy');
  button.classList.add(result);
  window.setTimeout(() => button.classList.remove(result), 1200);
}

const ICON_PATHS = {
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'more-horizontal': '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  sparkles: '<path d="M9.9 2.8 8.2 7.4 3.6 9.1l4.6 1.7 1.7 4.6 1.7-4.6 4.6-1.7-4.6-1.7-1.7-4.6Z"/><path d="m18.6 13.5-.8 2.1-2.1.8 2.1.8.8 2.1.8-2.1 2.1-.8-2.1-.8-.8-2.1Z"/>'
} as const;

function sampleIcon(name: keyof typeof ICON_PATHS): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

function cameraIcon(): string {
  return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>';
}

function fitIcon(): string {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
}

function downloadIcon(): string {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
}

function refreshCanvasReviewState(boardId: BoardId): void {
  const state = boardState.get(boardId);
  if (!state) {
    return;
  }

  const records = collectVisibleBoundaryRecords(state.root, boardId);
  const boundarySync = validateVisibleBoundaryRecords(project, records);
  const screenId = boardId === 'screens' ? undefined : records.find(record => record.kind === 'screen')?.screenId;
  window.__BLUEPRINT_REVIEW__ = {
    projectId: project.manifest.project.id,
    boundarySync,
    manifest: createReviewManifest(project, records, {
      board: boardId,
      screenId,
      packetToolName: 'extract'
    }),
    styleEvidence: createCanvasStyleEvidence(project, records)
  };
}

let focusedActivityElements: HTMLElement[] = [];
const inFlightToolFocuses = new Map<string, { focuses: BlueprintAgentActivityFocus[]; startedAt: string }>();
const announcedRevisions: string[] = [];
let pendingProjectApplies = 0;
let projectErrorActive = false;
let completionRevision: string | undefined;
let completionDwellUntil = 0;
let changedBoundaryFocuses: BlueprintAgentActivityFocus[] = [];
let activeActivityKey: string | undefined;
let activityClearTimer: number | undefined;
let lastAgentActivity: BlueprintAgentActivityEvent | undefined;
let lastAppliedRevision: string | undefined;
let projectApplyQueue = Promise.resolve();
const focusedPrototypeFrames = new Set<HTMLIFrameElement>();
let agentFrameFocusGeneration = 0;

type AgentStatusState = 'working' | 'thinking' | 'applying' | 'complete' | 'waiting' | 'failed';

function setAgentStatus(state: AgentStatusState, label: string): void {
  agentStatus.hidden = false;
  agentStatus.dataset.phase = state;
  agentStatusLabel.textContent = label;
}

function connectBlueprintLiveRuntime(): void {
  const runtime = window.__BLUEPRINT_LIVE_RUNTIME__;
  if (!runtime || typeof EventSource === 'undefined') return;

  const source = new EventSource(runtime.eventsPath);
  source.addEventListener('agent-activity', message => {
    const event = parseLiveEvent<BlueprintAgentActivityEvent>(message);
    if (!event || event.version !== 1) return;
    window.__BLUEPRINT_AGENT_ACTIVITY__ = event;
    showAgentActivity(event);
  });
  source.addEventListener('project-changed', message => {
    const event = parseLiveEvent<BlueprintProjectChangedEvent>(message);
    if (!event || event.version !== 1) return;
    announcedRevisions.push(event.revision);
    pendingProjectApplies += 1;
    if (lastAgentActivity?.phase === 'completed' && activityClearTimer !== undefined) window.clearTimeout(activityClearTimer);
    projectApplyQueue = projectApplyQueue
      .then(() => applyProjectChange(event, runtime.snapshotPath))
      .then(() => {
        announcedRevisions.splice(0, announcedRevisions.indexOf(event.revision) + 1);
        projectErrorActive = false;
      })
      .catch(error => {
        setAgentStatus('waiting', errorMessage(error));
      })
      .finally(() => {
        pendingProjectApplies -= 1;
        checkAgentCompletion();
      });
  });
  source.addEventListener('project-error', message => {
    const event = parseLiveEvent<BlueprintProjectErrorEvent>(message);
    projectErrorActive = true;
    if (activityClearTimer !== undefined) window.clearTimeout(activityClearTimer);
    setAgentStatus('waiting', event?.message
      ? 'Blueprint is waiting for the current edit to become valid'
      : 'Blueprint could not apply the latest edit');
  });
}

async function applyProjectChange(event: BlueprintProjectChangedEvent, snapshotPath: string): Promise<void> {
  if (event.revision === lastAppliedRevision) return;
  const preservedView = activeBoardId ? canvas.snapshot() : undefined;
  setAgentStatus('applying', 'Blueprint is applying the latest changes');
  markFocusedBoundaryBusy(true);
  const requestUrl = new URL(snapshotPath, window.location.href);
  requestUrl.searchParams.set('revision', event.revision);
  const response = await fetch(requestUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Blueprint could not load revision ${event.revision}.`);
  const snapshot = await response.json() as BlueprintProjectSnapshot;
  if (snapshot.version !== 1 || !snapshot.bundle) throw new Error('Blueprint returned an invalid live project snapshot.');
  if (snapshot.revision === lastAppliedRevision) return;
  const changedPaths = snapshot.revision === event.revision ? event.changedPaths : [];
  const leftChangeBaseline = viewingChangeBaseline;
  if (leftChangeBaseline) project = exitChangeBaselineView();
  const advancedPastEvent = snapshot.revision !== event.revision || leftChangeBaseline;

  const previousProjectId = project.manifest.project.id;
  if (!changeBaseline || changeBaseline.activityKey !== activeActivityKey) {
    changeBaseline = { bundle: project, activityKey: activeActivityKey };
  }
  project = createConfiguredProjectBundle(snapshot.bundle);
  window.__BLUEPRINT_PROJECT_BUNDLE__ = snapshot.bundle;
  screenFlows = projectScreenFlows(project);
  if (!activeScreenFlow || !screenFlows.includes(activeScreenFlow)) {
    activeScreenFlow = requestedScreenFlow() ?? screenFlows[0] ?? null;
  }
  refreshBoardSwitcher();
  refreshFlowSwitcher();

  const updates: Promise<void>[] = [];
  if (boardState.has('primitives') && (advancedPastEvent || pathsAffectPrimitives(changedPaths))) {
    updates.push(replaceMountedBoard('primitives'));
  }
  if (boardState.has('screens')) {
    const reconciled = !advancedPastEvent && previousProjectId === project.manifest.project.id
      ? await reconcileScreenFrames(changedPaths)
      : false;
    if (!reconciled) updates.push(replaceMountedBoard('screens'));
  }
  await Promise.all(updates);
  if (activeBoardId) {
    boardState.get(activeBoardId)?.mounted.configure();
    if (preservedView) canvas.setView(preservedView);
  }
  lastAppliedRevision = snapshot.revision;
  latestChanges = narrowScreenChangesToSections(changeBaseline.bundle, project, changedBoundaries(changeBaseline.bundle, project));
  renderChangeAnnotations();
  const changedFocuses = activityFocusesForChangedPaths(project, changedPaths);
  changedBoundaryFocuses = activeActivityKey ? uniqueAgentFocuses([...changedBoundaryFocuses, ...changedFocuses]) : changedFocuses;
  renderAgentFocus();
  markFocusedBoundaryBusy(lastAgentActivity?.phase === 'started' || lastAgentActivity?.phase === 'completed');
  restoreAgentStatusAfterApply();
}

function pathsAffectPrimitives(changedPaths: string[]): boolean {
  return changedPaths.some(changedPath => (
    changedPath === 'manifest.json' ||
    changedPath === 'tokens.json' ||
    changedPath === 'primitives.json' ||
    changedPath === 'components.json' ||
    changedPath.startsWith('prototype/primitives/') ||
    changedPath.startsWith('prototype/components/')
  ));
}

async function reconcileScreenFrames(changedPaths: string[]): Promise<boolean> {
  if (focusedReviewIsRequested()) return false;
  const state = boardState.get('screens');
  if (!state) return true;
  const affected = affectedScreenIds(changedPaths);
  if (!affected || affected.size === 0) return false;
  const params = new URLSearchParams(location.search);
  const request: PrototypeReviewSelectionRequest = {
    state: params.get('state') ?? undefined,
    viewport: params.get('viewport') ?? undefined
  };
  const flowFilter = request.state || request.viewport ? undefined : (activeScreenFlow ?? undefined);
  const layouts = layoutScreenFrames(project, request, flowFilter).filter(layout => affected.has(layout.screen.id));
  const oldFrames = new Map(
    [...state.root.querySelectorAll<HTMLElement>('.frame-slot[data-live-frame-key]')]
      .map(frame => [frame.dataset.liveFrameKey ?? '', frame] as const)
  );
  const nextKeys = layouts.map(layout => liveFrameKey(layout.screen.id, layout.preset.id, layout.prototypeSelection));
  if (nextKeys.some(key => !oldFrames.has(key))) return false;
  const currentKeys = [...oldFrames.entries()]
    .filter(([, frame]) => affected.has(frame.querySelector<HTMLElement>('.frame')?.dataset.screenId ?? ''))
    .map(([key]) => key);
  if (currentKeys.length !== nextKeys.length) return false;

  const tokenIndex = createTokenIndex(project);
  await Promise.all(layouts.map(async layout => {
    const key = liveFrameKey(layout.screen.id, layout.preset.id, layout.prototypeSelection);
    const previous = oldFrames.get(key);
    if (!previous) return;
    previous.classList.add('bp-chrome-live-frame-updating');
    previous.setAttribute('aria-busy', 'true');
    const next = createPrototypeFrame(
      project,
      tokenIndex,
      layout.screen,
      layout.preset,
      layout.x,
      layout.y,
      layout.prototypeSelection,
      layout.selectionError
    );
    next.style.visibility = 'hidden';
    state.root.append(next);
    await waitForPrototypeFrames(next);
    next.style.removeProperty('visibility');
    next.classList.add('bp-chrome-live-frame-enter');
    previous.replaceWith(next);
  }));
  if (activeBoardId === 'screens') {
    refreshCanvasReviewState('screens');
    renderCanvasAnnotations();
  }
  return true;
}

function affectedScreenIds(changedPaths: string[]): Set<string> | undefined {
  const screenIds = new Set<string>();
  for (const changedPath of changedPaths) {
    if (
      changedPath === 'manifest.json' || changedPath === 'screens.json' ||
      changedPath.startsWith('explorations/') || changedPath.startsWith('history/')
    ) return undefined;
    if (
      changedPath === 'tokens.json' || changedPath === 'primitives.json' || changedPath === 'components.json' ||
      changedPath.startsWith('prototype/primitives/') || changedPath.startsWith('prototype/components/')
    ) {
      project.screens.screens.forEach(screen => screenIds.add(screen.id));
      continue;
    }
    const owner = project.screens.screens.find(screen => screen.prototype && [
      screen.prototype.source,
      ...screen.prototype.styles,
      ...screen.prototype.assetRefs
    ].includes(changedPath));
    if (!owner) return undefined;
    screenIds.add(owner.id);
  }
  return screenIds;
}

function showAgentActivity(event: BlueprintAgentActivityEvent): void {
  if (event.phase === 'started') {
    if (activeActivityKey !== agentActivityKey(event)) {
      inFlightToolFocuses.clear();
      changedBoundaryFocuses = [];
    }
    lastAgentActivity = event;
    activeActivityKey = agentActivityKey(event);
    inFlightToolFocuses.set(event.toolUseId, { focuses: event.focuses, startedAt: event.emittedAt });
    if (activityClearTimer !== undefined) window.clearTimeout(activityClearTimer);
    setAgentStatus('working', event.label);
    renderAgentFocus();
    markFocusedBoundaryBusy(true);
    return;
  }

  if (activeActivityKey !== agentActivityKey(event)) return;
  const startedAt = inFlightToolFocuses.get(event.toolUseId)?.startedAt ?? event.emittedAt;
  inFlightToolFocuses.delete(event.toolUseId);
  if ([...inFlightToolFocuses.values()].some(tool => tool.startedAt > startedAt)) {
    renderAgentFocus();
    return;
  }
  lastAgentActivity = event;
  if (activityClearTimer !== undefined) window.clearTimeout(activityClearTimer);
  renderAgentFocus();
  if (event.phase === 'failed') {
    setAgentStatus('failed', event.label);
    markFocusedBoundaryBusy(false);
    activityClearTimer = window.setTimeout(clearAgentActivity, 1_800);
    return;
  }
  setAgentStatus('thinking', event.label);
  completionRevision = event.revision;
  completionDwellUntil = Date.now() + 800;
  checkAgentCompletion();
}

function checkAgentCompletion(): void {
  if (lastAgentActivity?.phase !== 'completed') return;
  if (activityClearTimer !== undefined) window.clearTimeout(activityClearTimer);
  if (pendingProjectApplies > 0 || (completionRevision !== undefined && announcedRevisions.includes(completionRevision))) return;
  if (projectErrorActive || lastAgentActivity.projectValid === false) {
    setAgentStatus('waiting', 'Blueprint is waiting for the current edit to become valid');
    return;
  }
  activityClearTimer = window.setTimeout(() => {
    setAgentStatus('complete', 'Changes are live');
    markFocusedBoundaryBusy(false);
    activityClearTimer = window.setTimeout(clearAgentActivity, 700);
  }, Math.max(0, completionDwellUntil - Date.now()));
}

function currentAgentFocuses(): BlueprintAgentActivityFocus[] {
  const focuses = uniqueAgentFocuses([
    ...lastAgentActivity?.focuses ?? [],
    ...[...inFlightToolFocuses.values()].reverse().flatMap(tool => tool.focuses),
    ...changedBoundaryFocuses
  ]);
  const specific = focuses.filter(focus => focus.kind !== 'project' && focus.kind !== 'board');
  return specific.length > 0 ? specific : focuses;
}

function uniqueAgentFocuses(focuses: BlueprintAgentActivityFocus[]): BlueprintAgentActivityFocus[] {
  return [...new Map(focuses.map(focus => [focus.boundaryId, focus] as const)).values()];
}

function renderAgentFocus(): void {
  clearAgentFocus();
  const focuses = currentAgentFocuses();
  if (focuses.length === 0) return;
  const label = lastAgentActivity?.label ?? 'Changes are live';
  const visibleRoot = activeBoardId ? boardState.get(activeBoardId)?.root : undefined;
  const frameFocus = new Map<HTMLIFrameElement, Set<string>>();
  const canvasFocuses: BlueprintAgentActivityFocus[] = [];
  for (const focus of focuses) {
    const consumers = visibleRoot && activeBoardId === 'screens' &&
      (focus.kind === 'primitive' || focus.kind === 'component' || focus.kind === 'section')
      ? prototypeFramesUsingBoundary(visibleRoot, focus)
      : [];
    if (consumers.length === 0) canvasFocuses.push(focus);
    for (const frame of consumers) frameFocus.set(frame, new Set([...frameFocus.get(frame) ?? [], focus.boundaryId]));
  }

  for (const [frame, boundaryIds] of frameFocus) {
    applyPrototypeFrameFocus(frame, boundaryIds);
    const context = frame.closest<HTMLElement>('.frame');
    if (context && !focusedActivityElements.includes(context)) {
      context.classList.add('bp-chrome-agent-focus-context');
      context.dataset.agentActivityLabel = label;
      focusedActivityElements.push(context);
    }
  }
  if (canvasFocuses.length > 0) renderCanvasAgentFocus(canvasFocuses, label, frameFocus.size > 0);
  setFocusedActivityFailed(lastAgentActivity?.phase === 'failed');
}

function renderCanvasAgentFocus(canvasFocuses: BlueprintAgentActivityFocus[], label: string, framesFocused: boolean): void {
  if (!framesFocused && lastAgentActivity) {
    const primary = canvasFocuses[0];
    const requestedBoard = primary.kind === 'board' && isBoardId(primary.localId) ? primary.localId : primary.board;
    if (requestedBoard && activeBoardId !== requestedBoard) {
      showBoard(requestedBoard);
    }
  }

  const activeRoot = activeBoardId ? boardState.get(activeBoardId)?.root : undefined;
  for (const focus of canvasFocuses) {
    let target = activeRoot ? findBoundaryElement(activeRoot, focus.boundaryId) : undefined;
    if (!target && focus.screenId && activeRoot) {
      target = findBoundaryElement(activeRoot, boundaryId(project.manifest.project.id, 'screen', focus.screenId));
    }
    if (!target) continue;
    target.classList.add('bp-chrome-agent-focus');
    target.dataset.agentActivityLabel = label;
    if (!focusedActivityElements.includes(target)) focusedActivityElements.push(target);
  }
  if (focusedActivityElements.length === 0) {
    viewport.classList.add('bp-agent-project-focus');
  }
}

function findBoundaryElement(root: HTMLElement, id: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('[data-boundary-id]')]
    .find(element => element.dataset.boundaryId === id);
}

function clearAgentActivity(): void {
  activeActivityKey = undefined;
  lastAgentActivity = undefined;
  inFlightToolFocuses.clear();
  changedBoundaryFocuses = [];
  completionRevision = undefined;
  window.__BLUEPRINT_AGENT_ACTIVITY__ = undefined;
  agentStatus.hidden = true;
  delete agentStatus.dataset.phase;
  clearAgentFocus();
}

function agentActivityKey(event: BlueprintAgentActivityEvent): string {
  return `${event.sessionId}\u0000${event.turnId ?? event.toolUseId}`;
}

function clearAgentFocus(): void {
  viewport.classList.remove('bp-agent-project-focus');
  agentFrameFocusGeneration += 1;
  for (const layer of document.querySelectorAll('.bp-chrome-agent-frame-focus')) layer.remove();
  focusedPrototypeFrames.clear();
  for (const element of focusedActivityElements) {
    element.classList.remove(
      'bp-chrome-agent-focus',
      'bp-chrome-agent-focus-context',
      'bp-chrome-agent-focus-failed'
    );
    element.removeAttribute('aria-busy');
    delete element.dataset.agentActivityLabel;
  }
  focusedActivityElements = [];
}

function prototypeFramesUsingBoundary(root: HTMLElement, focus: BlueprintAgentActivityFocus): HTMLIFrameElement[] {
  const focusBoundaryId = focus.boundaryId;
  return [...root.querySelectorAll<HTMLIFrameElement>('iframe[data-prototype-target-boundary]')].filter(frame => {
    if (focus.kind === 'section') {
      return prototypeDocumentByFrame.get(frame)?.includes(`data-blueprint-section-boundary-id="${focusBoundaryId}"`) ?? false;
    }
    if (frame.dataset.prototypeTargetBoundary === focusBoundaryId) return true;
    try {
      const uses = JSON.parse(frame.dataset.prototypeObservedUses ?? '[]') as Array<{ targetBoundaryId?: string }>;
      return uses.some(use => use.targetBoundaryId === focusBoundaryId);
    } catch {
      return false;
    }
  });
}

function applyPrototypeFrameFocus(frame: HTMLIFrameElement, boundaryIds: ReadonlySet<string>): void {
  const html = prototypeDocumentByFrame.get(frame);
  const host = frame.parentElement;
  if (!html || !host) return;
  focusedPrototypeFrames.add(frame);
  const generation = agentFrameFocusGeneration;
  void measurePrototypeBoundaryExtents(html, frame.clientWidth, frame.clientHeight, boundaryIds).then(extents => {
    if (generation !== agentFrameFocusGeneration || !frame.isConnected) return;
    host.querySelector(':scope > .bp-chrome-agent-frame-focus')?.remove();
    const layer = el('div', 'bp-chrome-agent-frame-focus');
    layer.setAttribute('aria-hidden', 'true');
    layer.dataset.focusBoundaryIds = [...boundaryIds].join(' ');
    layer.classList.toggle('bp-chrome-agent-focus-failed', lastAgentActivity?.phase === 'failed');
    for (const extent of extents) {
      const box = el('div', 'bp-chrome-agent-frame-focus-box');
      box.style.left = `${extent.left}px`;
      box.style.top = `${extent.top}px`;
      box.style.width = `${extent.right - extent.left}px`;
      box.style.height = `${extent.bottom - extent.top}px`;
      layer.append(box);
    }
    host.append(layer);
  });
}

function measurePrototypeBoundaryExtents(
  html: string,
  width: number,
  height: number,
  boundaryIds: ReadonlySet<string>
): Promise<BoundaryExtent[]> {
  return readPrototypeTwin(html, width, height, twinDocument => measureBoundaryExtents(twinDocument, boundaryIds), []);
}

/**
 * The visible frame keeps its empty-permission sandbox, so boundary geometry is
 * read from a short-lived same-origin twin rendering the same no-script document.
 */
function readPrototypeTwin<T>(
  html: string,
  width: number,
  height: number,
  read: (twinDocument: Document) => T,
  fallback: T
): Promise<T> {
  if (width <= 0 || height <= 0) return Promise.resolve(fallback);
  return new Promise(resolve => {
    const twin = document.createElement('iframe');
    twin.style.cssText = `position:fixed;left:-${width + 100}px;top:0;width:${width}px;height:${height}px;border:0;pointer-events:none;`;
    twin.tabIndex = -1;
    twin.setAttribute('aria-hidden', 'true');
    twin.setAttribute('sandbox', 'allow-same-origin');
    twin.addEventListener('load', () => {
      const twinDocument = twin.contentDocument;
      const measured = twinDocument
        ? twinDocument.fonts.ready.then(() => read(twinDocument))
        : Promise.resolve(fallback);
      void measured
        .catch(() => fallback)
        .then(result => {
          twin.remove();
          resolve(result);
        });
    }, { once: true });
    twin.srcdoc = html;
    document.body.append(twin);
  });
}

function setFocusedActivityFailed(failed: boolean): void {
  for (const element of focusedActivityElements) element.classList.toggle('bp-chrome-agent-focus-failed', failed);
  for (const layer of document.querySelectorAll('.bp-chrome-agent-frame-focus')) {
    layer.classList.toggle('bp-chrome-agent-focus-failed', failed);
  }
}

function markFocusedBoundaryBusy(busy: boolean): void {
  for (const element of focusedActivityElements) element.setAttribute('aria-busy', String(busy));
}

function restoreAgentStatusAfterApply(): void {
  if (!lastAgentActivity) {
    setAgentStatus('complete', 'Changes are live');
    if (activityClearTimer !== undefined) window.clearTimeout(activityClearTimer);
    activityClearTimer = window.setTimeout(clearAgentActivity, 900);
    return;
  }
  if (lastAgentActivity.phase === 'failed') {
    setAgentStatus('failed', lastAgentActivity.label);
  } else if (lastAgentActivity.phase === 'completed') {
    setAgentStatus('thinking', lastAgentActivity.label);
  } else {
    setAgentStatus('working', lastAgentActivity.label);
  }
}

function renderCanvasAnnotations(): void {
  renderCanvasSelection();
  renderChangeAnnotations();
  renderFindingAnnotations();
}

const designFindingsByBundle = new WeakMap<BlueprintProjectBundle, DesignFinding[]>();
let findingsPanelState: { title: string; boundaryIds: string[] } | undefined;
let findingAnnotationGeneration = 0;

function designFindings(bundle: BlueprintProjectBundle): DesignFinding[] {
  let findings = designFindingsByBundle.get(bundle);
  if (!findings) {
    findings = collectDesignFindings(bundle);
    designFindingsByBundle.set(bundle, findings);
  }
  return findings;
}

function frameFindingBoundaryIds(bundle: BlueprintProjectBundle, screen: ScreenDefinition, screenEl: HTMLElement): string[] {
  const iframe = screenEl.querySelector<HTMLIFrameElement>('iframe.canonical-prototype-iframe');
  return [...new Set([
    boundaryId(bundle.manifest.project.id, 'screen', screen.id),
    ...iframe ? observedBoundaryIds(iframe) : [],
    ...bundle.tokens.tokenGroups.map(group => boundaryId(bundle.manifest.project.id, 'token-group', group.id))
  ])];
}

function observedBoundaryIds(iframe: HTMLIFrameElement): string[] {
  try {
    const uses = JSON.parse(iframe.dataset.prototypeObservedUses ?? '[]') as Array<{ targetBoundaryId?: string }>;
    return uses.flatMap(use => use.targetBoundaryId ? [use.targetBoundaryId] : []);
  } catch {
    return [];
  }
}

function renderFindingAnnotations(): void {
  const generation = ++findingAnnotationGeneration;
  for (const layer of document.querySelectorAll('.bp-chrome-finding-layer')) layer.remove();
  renderFindingsPanel();
  const root = activeBoardId === 'screens' ? boardState.get('screens')?.root : undefined;
  if (!root) return;
  const componentIds = new Set(designFindings(project).filter(finding => finding.kind === 'component').map(finding => finding.boundaryId));
  if (componentIds.size === 0) return;
  for (const frame of root.querySelectorAll<HTMLIFrameElement>('iframe.canonical-prototype-iframe')) {
    const html = prototypeDocumentByFrame.get(frame);
    const flagged = new Set(observedBoundaryIds(frame).filter(id => componentIds.has(id)));
    if (!html || flagged.size === 0) continue;
    void measurePrototypeBoundaryExtents(html, frame.clientWidth, frame.clientHeight, flagged).then(extents => {
      const host = frame.parentElement;
      if (generation !== findingAnnotationGeneration || !host || !frame.isConnected) return;
      const layer = el('div', 'bp-chrome-finding-layer');
      layer.setAttribute('aria-hidden', 'true');
      layer.dataset.findingBoundaryIds = [...flagged].join(' ');
      for (const extent of extents) {
        const box = el('div', 'bp-chrome-finding-box');
        box.style.left = `${extent.left}px`;
        box.style.top = `${extent.top}px`;
        box.style.width = `${extent.right - extent.left}px`;
        box.style.height = `${extent.bottom - extent.top}px`;
        layer.append(box);
      }
      host.append(layer);
    });
  }
}

function openFindingsPanel(state: { title: string; boundaryIds: string[] }): void {
  findingsPanelState = state;
  renderFindingsPanel();
}

function closeFindingsPanel(): void {
  findingsPanelState = undefined;
  renderFindingsPanel();
}

function renderFindingsPanel(): void {
  findingsPanel.replaceChildren();
  findingsPanel.hidden = !findingsPanelState;
  if (!findingsPanelState) return;
  const { boundaryIds, title } = findingsPanelState;
  const findings = designFindings(project).filter(finding => boundaryIds.includes(finding.boundaryId));
  const header = el('header', 'bp-chrome-findings-header');
  const heading = el('div', 'bp-chrome-findings-title');
  heading.append(el('strong', '', title), el('span', '', findings.length === 1 ? '1 finding' : `${findings.length} findings`));
  const copyAll = el('button', 'bp-chrome-findings-copy', 'Copy all') as HTMLButtonElement;
  copyAll.type = 'button';
  copyAll.disabled = findings.length === 0;
  copyAll.addEventListener('click', () => {
    void copyText(findings.map(designFindingReference).join('\n')).then(() => flashCopied(copyAll));
  });
  const close = el('button', 'bp-chrome-findings-close', '×') as HTMLButtonElement;
  close.type = 'button';
  close.title = 'Close findings';
  close.setAttribute('aria-label', 'Close findings');
  close.addEventListener('click', closeFindingsPanel);
  header.append(heading, copyAll, close);
  const list = el('ol', 'bp-chrome-findings-list');
  for (const finding of findings) {
    const item = el('li', 'bp-chrome-findings-item');
    item.dataset.findingBoundaryId = finding.boundaryId;
    item.dataset.findingRule = finding.rule;
    const meta = el('div', 'bp-chrome-findings-meta');
    meta.append(
      el('span', 'bp-chrome-findings-boundary', boundaryDisplayName(project, finding.kind, finding.localId)),
      el('code', 'bp-chrome-findings-location', finding.location)
    );
    const copy = el('button', 'bp-chrome-findings-copy', 'Copy') as HTMLButtonElement;
    copy.type = 'button';
    copy.title = 'Copy this finding for the agent';
    copy.addEventListener('click', () => {
      void copyText(designFindingReference(finding)).then(() => flashCopied(copy));
    });
    item.append(meta, el('p', 'bp-chrome-findings-message', finding.message), copy);
    list.append(item);
  }
  if (findings.length === 0) list.append(el('li', 'bp-chrome-findings-empty', 'No findings remain.'));
  findingsPanel.append(header, list);
}

function flashCopied(button: HTMLButtonElement): void {
  const label = button.textContent;
  button.textContent = 'Copied';
  window.setTimeout(() => {
    button.textContent = label;
  }, 1_000);
}

let changeBaseline: { bundle: BlueprintProjectBundle; activityKey: string | undefined } | undefined;
let latestChanges: BlueprintAgentActivityFocus[] = [];
let viewingChangeBaseline = false;
let liveProjectDuringBaselineView: BlueprintProjectBundle | undefined;
let changeAnnotationGeneration = 0;

function narrowScreenChangesToSections(
  previous: BlueprintProjectBundle,
  next: BlueprintProjectBundle,
  focuses: BlueprintAgentActivityFocus[]
): BlueprintAgentActivityFocus[] {
  return focuses.flatMap(focus => {
    if (focus.kind !== 'screen') return [focus];
    const before = previous.screens.screens.find(screen => screen.id === focus.localId);
    const after = next.screens.screens.find(screen => screen.id === focus.localId);
    if (!before?.prototype || !after?.prototype || JSON.stringify(before) !== JSON.stringify(after)) return [focus];
    const ownedFiles = [...after.prototype.styles, ...after.prototype.assetRefs];
    if (ownedFiles.some(file => previous.prototypeSourceContents[file] !== next.prototypeSourceContents[file])) return [focus];
    const beforeMarkup = sectionMarkup(previous.prototypeSourceContents[before.prototype.source]);
    const afterMarkup = sectionMarkup(next.prototypeSourceContents[after.prototype.source]);
    if (!beforeMarkup || !afterMarkup || beforeMarkup.outside !== afterMarkup.outside) return [focus];
    const sectionIds = [...afterMarkup.sections.keys()].filter(id => afterMarkup.sections.get(id) !== beforeMarkup.sections.get(id));
    return sectionIds.length > 0
      ? sectionIds.map(id => activityFocusForBoundary(next, 'section', `${focus.localId}/${id}`))
      : [focus];
  });
}

function sectionMarkup(source: string | undefined): { outside: string; sections: Map<string, string> } | undefined {
  if (source === undefined) return undefined;
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  const markers = [...parsed.querySelectorAll('[data-blueprint-section]')];
  const sections = new Map(markers.map(marker => [marker.getAttribute('data-blueprint-section') ?? '', marker.outerHTML] as const));
  for (const marker of markers) marker.replaceWith(parsed.createComment(marker.getAttribute('data-blueprint-section') ?? ''));
  return { outside: parsed.documentElement.outerHTML, sections };
}

function renderChangeAnnotations(): void {
  const generation = ++changeAnnotationGeneration;
  for (const layer of document.querySelectorAll('.bp-chrome-change-layer')) layer.remove();
  for (const element of document.querySelectorAll('.bp-chrome-changed')) element.classList.remove('bp-chrome-changed');
  renderChangeBar();
  const root = activeBoardId ? boardState.get(activeBoardId)?.root : undefined;
  if (!root || latestChanges.length === 0) return;
  const frameChanges = new Map<HTMLIFrameElement, Set<string>>();
  for (const change of latestChanges) {
    const frames = activeBoardId === 'screens' && (change.kind === 'primitive' || change.kind === 'component' || change.kind === 'section')
      ? prototypeFramesUsingBoundary(root, change)
      : [];
    for (const frame of frames) frameChanges.set(frame, new Set([...frameChanges.get(frame) ?? [], change.boundaryId]));
    if (frames.length > 0) continue;
    for (const element of root.querySelectorAll<HTMLElement>('[data-boundary-id]')) {
      if (element.dataset.boundaryId === change.boundaryId) element.classList.add('bp-chrome-changed');
    }
  }
  for (const [frame, boundaryIds] of frameChanges) {
    const html = prototypeDocumentByFrame.get(frame);
    if (!html) continue;
    void measurePrototypeBoundaryExtents(html, frame.clientWidth, frame.clientHeight, boundaryIds).then(extents => {
      const host = frame.parentElement;
      if (generation !== changeAnnotationGeneration || !host || !frame.isConnected) return;
      const layer = el('div', 'bp-chrome-change-layer');
      layer.setAttribute('aria-hidden', 'true');
      layer.dataset.changeBoundaryIds = [...boundaryIds].join(' ');
      for (const extent of extents) {
        const box = el('div', 'bp-chrome-change-box');
        box.style.left = `${extent.left}px`;
        box.style.top = `${extent.top}px`;
        box.style.width = `${extent.right - extent.left}px`;
        box.style.height = `${extent.bottom - extent.top}px`;
        layer.append(box);
      }
      host.append(layer);
    });
  }
}

function renderChangeBar(): void {
  changeBar.hidden = latestChanges.length === 0;
  const liveProject = liveProjectDuringBaselineView ?? project;
  const names = latestChanges.map(change => boundaryDisplayName(liveProject, change.kind, change.localId));
  const listed = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
  changeLabel.textContent = `${latestChanges.length === 1 ? '1 change' : `${latestChanges.length} changes`}: ${listed}`;
  changeLabel.title = names.join(', ');
  changeToggle.setAttribute('aria-pressed', String(viewingChangeBaseline));
  changeToggle.textContent = viewingChangeBaseline ? 'After' : 'Before';
  changeToggle.title = viewingChangeBaseline ? 'Show the canvas with these changes' : 'Show the canvas before these changes';
  changeBar.classList.toggle('bp-chrome-changes-before', viewingChangeBaseline);
}

function queueChangeBaselineView(show: boolean): void {
  projectApplyQueue = projectApplyQueue.then(async () => {
    if (show === viewingChangeBaseline || !changeBaseline || latestChanges.length === 0) return;
    if (show) {
      liveProjectDuringBaselineView = project;
      project = changeBaseline.bundle;
      viewingChangeBaseline = true;
    } else {
      project = exitChangeBaselineView();
    }
    await Promise.all([...boardState.keys()].map(id => replaceMountedBoard(id)));
    renderChangeBar();
  }).catch(error => {
    setAgentStatus('waiting', errorMessage(error));
  });
}

function exitChangeBaselineView(): BlueprintProjectBundle {
  const liveProject = liveProjectDuringBaselineView ?? project;
  liveProjectDuringBaselineView = undefined;
  viewingChangeBaseline = false;
  return liveProject;
}

function dismissChanges(): void {
  if (viewingChangeBaseline) queueChangeBaselineView(false);
  projectApplyQueue = projectApplyQueue.then(() => {
    changeBaseline = undefined;
    latestChanges = [];
    renderChangeAnnotations();
  }, () => undefined);
}

interface SelectionNode extends BlueprintSelectedBoundary {
  instance?: number;
  extent?: BoundaryExtent;
}

interface CanvasSelectionState {
  chain: SelectionNode[];
  index: number;
  frameKey?: string;
  measuredFrame?: HTMLIFrameElement;
  frame: Omit<BlueprintCanvasSelection, keyof BlueprintSelectedBoundary | 'context'>;
}

let canvasSelectionState: CanvasSelectionState | undefined;
let selectionPointerStart: { x: number; y: number } | undefined;
let selectionHitGeneration = 0;
let selectionRenderGeneration = 0;
let selectionHintTimer: number | undefined;
let selectionPublishQueue = Promise.resolve();

viewport.addEventListener('pointerdown', event => {
  selectionPointerStart = { x: event.clientX, y: event.clientY };
}, { capture: true });
viewport.addEventListener('click', event => {
  void selectAtPointer(event);
});
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (findingsPanelState) {
    closeFindingsPanel();
  } else if (canvasSelectionState) {
    setCanvasSelection(undefined);
  }
});

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
  const iframe = target.closest('.canonical-prototype-screen')
    ?.querySelector<HTMLIFrameElement>(':scope > iframe.canonical-prototype-iframe');
  if (iframe) {
    await selectInPrototypeFrame(iframe, event.clientX, event.clientY);
    return;
  }
  const element = target.closest<HTMLElement>('[data-boundary-id]');
  setCanvasSelection(element ? domSelectionState(element) : undefined, element !== null);
}

async function selectInPrototypeFrame(iframe: HTMLIFrameElement, clientX: number, clientY: number): Promise<void> {
  const html = prototypeDocumentByFrame.get(iframe);
  const frameElement = iframe.closest<HTMLElement>('.frame');
  if (!html || !frameElement) return;
  const rect = iframe.getBoundingClientRect();
  const scale = iframe.clientWidth > 0 ? rect.width / iframe.clientWidth : 1;
  const x = (clientX - rect.left) / scale;
  const y = (clientY - rect.top) / scale;
  const generation = ++selectionHitGeneration;
  const hits = await readPrototypeTwin(html, iframe.clientWidth, iframe.clientHeight, twinDocument => boundaryHitsAtPoint(twinDocument, x, y), []);
  if (generation !== selectionHitGeneration || !iframe.isConnected) return;
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
    ? iframe.closest('.frame-slot')?.querySelector('.frame-note .frame-name')?.textContent
    : undefined;
  setCanvasSelection({
    chain: frameLabel
      ? chain.map(node => node.kind === 'screen' ? { ...node, label: `${node.label} · ${frameLabel}` } : node)
      : chain,
    index: 0,
    frameKey: selectionFrameKey(iframe),
    measuredFrame: iframe,
    frame: frameSelectionContext(frameElement)
  }, true);
}

function selectionFrameKey(element: Element): string | undefined {
  const slot = element.closest<HTMLElement>('.frame-slot');
  return slot?.dataset.liveFrameKey ?? slot?.dataset.selectionFrameKey;
}

function domSelectionState(element: HTMLElement): CanvasSelectionState {
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

function setCanvasSelection(state: CanvasSelectionState | undefined, copyReference = false): void {
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

function renderCanvasSelection(): void {
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
  const iframe = scope.querySelector<HTMLIFrameElement>('iframe.canonical-prototype-iframe');
  const html = iframe ? prototypeDocumentByFrame.get(iframe) : undefined;
  if (!iframe || !html) return;
  const draw = (extent: BoundaryExtent | undefined): void => {
    const host = iframe.parentElement;
    if (generation !== selectionRenderGeneration || !extent || !host || !iframe.isConnected) return;
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
  if (state.measuredFrame === iframe && node.extent) {
    draw(node.extent);
  } else {
    void readPrototypeTwin(html, iframe.clientWidth, iframe.clientHeight, twinDocument => (
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

function parseLiveEvent<T>(message: Event): T | undefined {
  if (!(message instanceof MessageEvent) || typeof message.data !== 'string') return undefined;
  try {
    return JSON.parse(message.data) as T;
  } catch {
    return undefined;
  }
}

function collectVisibleBoundaryRecords(root: HTMLElement, board: BoardId): VisibleBoundaryRecord[] {
  return [...root.querySelectorAll<HTMLElement>('[data-boundary-id][data-boundary-kind]')].map(element => {
    const computed = window.getComputedStyle(element);
    return {
      id: element.dataset.boundaryId ?? '',
      kind: (element.dataset.boundaryKind ?? 'project') as BoundaryKind,
      board,
      label: element.dataset.boundaryLabel ?? element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '',
      screenId: element.dataset.screenId,
      renderedSnippet: element.outerHTML.slice(0, 900),
      computedStyles: {
        backgroundColor: computed.backgroundColor,
        borderColor: computed.borderColor,
        borderRadius: computed.borderRadius,
        color: computed.color
      }
    };
  });
}

function setBoundary(element: HTMLElement, kind: BoundaryKind, localId: string, projectId: string, label = localId): void {
  element.dataset.boundaryId = boundaryId(projectId, kind, localId);
  element.dataset.boundaryKind = kind;
  element.dataset.boundaryLocalId = localId;
  element.dataset.boundaryLabel = label;
  element.dataset.handoffTool = JSON.stringify({
    name: 'extract',
    arguments: {
      project: project.sourceRoot,
      boundary: `${kind}:${localId}`,
      mode: 'deep'
    }
  });
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
}

function isVisibleBoard(board: BoardDefinition): board is BoardDefinition & { id: BoardId } {
  return isBoardId(board.id);
}

function isBoardId(value: unknown): value is BoardId {
  return value === 'primitives' || value === 'screens';
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text) {
    node.textContent = text;
  }
  return node;
}

showBoard(isBoardId(requestedBoard) ? requestedBoard : defaultBoard);
connectBlueprintLiveRuntime();

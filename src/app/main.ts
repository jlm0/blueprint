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
import { brandMarkSourceIssues } from '../core/brand-lint';
import { changedBoundaries } from '../core/change';
import { parseOpaqueColor, relativeLuminance } from '../core/color';
import { colorRolePairs, contrastRatio } from '../core/contrast-lint';
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
  BoundaryKind,
  BrandFile,
  BrandMark,
  BrandMarkVariant,
  ComponentDefinition,
  DeclaredGroup,
  DesignToken,
  ExplorationDefinition,
  ExplorationPrototypeSource,
  FramePreset,
  PrimitiveDefinition,
  ScreenDefinition,
  TokenGroup
} from '../core/types';
import type { VisibleBoundaryRecord } from '../core/review';
import { createCanvasController, type CanvasController, type CanvasView } from './canvas-controller';
import {
  boundaryHitsAtPoint,
  measureBoundaryExtents,
  measureBoundaryInstance,
  type BoundaryExtent
} from './boundary-extent';
import { loadConfiguredProject } from './fixture-projects';
import { BASE_PRIMITIVE_CONTRACT, isBasePrimitive } from '../core/base-primitives';
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
  scrollTop?: number;
}

interface BoardMount {
  configure: () => void;
  fit: () => void;
}

interface BoardConfig {
  label: string;
  className: string;
  surface: 'canvas' | 'document';
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

const SUBNAV_STORAGE_KEY = 'blueprint.subnav';
const CHROME_THEME_PROPERTIES = [
  '--bp-chrome-canvas-bg',
  '--bp-chrome-surface',
  '--bp-chrome-fg',
  '--bp-chrome-muted-fg',
  '--bp-chrome-border',
  '--bp-chrome-border-strong',
  '--bp-chrome-surface-hover',
  '--bp-chrome-surface-active',
  '--bp-chrome-accent',
  '--bp-chrome-accent-soft',
  '--bp-chrome-primary',
  '--bp-chrome-primary-fg',
  '--bp-chrome-focus',
  '--bp-chrome-grid-line',
  '--bp-chrome-grid-line-major',
  '--bp-chrome-radius',
  '--bp-chrome-radius-sm',
  '--bp-chrome-font',
  '--bp-chrome-font-display',
  '--bp-chrome-font-mono'
];

let changeBaseline: { bundle: BlueprintProjectBundle; activityKey: string | undefined } | undefined;
let latestChanges: BlueprintAgentActivityFocus[] = [];

let project = loadConfiguredProject();
const shell = el('div');
shell.id = 'app-shell';
shell.className = 'bp-chrome-shell';
refreshSurround();

const rail = el('aside', 'bp-chrome-rail');
const projectMark = el('span', 'bp-chrome-project-mark');
projectMark.setAttribute('aria-hidden', 'true');
const switcher = el('nav', 'board-switcher bp-chrome-board-switcher');
switcher.setAttribute('aria-label', 'Blueprint sections');
const subnavToggle = el('button', 'bp-chrome-subnav-toggle') as HTMLButtonElement;
subnavToggle.type = 'button';
subnavToggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>';
subnavToggle.addEventListener('click', () => setSubnavCollapsed(shell.dataset.subnav !== 'collapsed'));
rail.append(projectMark, switcher, subnavToggle);

const subnav = el('aside', 'bp-chrome-subnav');
const subnavHead = el('header', 'bp-chrome-subnav-head');
const projectName = el('span', 'bp-chrome-project-name');
const sectionTitle = el('h2', 'bp-chrome-section-title');
subnavHead.append(projectName, sectionTitle);
const itemNav = el('nav', 'bp-chrome-item-nav');
itemNav.setAttribute('aria-label', 'Section items');

subnav.append(subnavHead, itemNav);
const NAV_COLLAPSED_STORAGE_KEY = 'blueprint.nav.collapsed';
const collapsedNavGroups = readCollapsedNavGroups();
const narrowViewport = window.matchMedia('(max-width: 700px)');
setSubnavCollapsed(narrowViewport.matches || readStoredSubnavCollapsed(), false);

function setSubnavCollapsed(collapsed: boolean, remember = !narrowViewport.matches): void {
  shell.dataset.subnav = collapsed ? 'collapsed' : 'open';
  subnav.inert = collapsed;
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  subnavToggle.title = label;
  subnavToggle.setAttribute('aria-label', label);
  subnavToggle.setAttribute('aria-expanded', String(!collapsed));
  if (!remember) return;
  try {
    localStorage.setItem(SUBNAV_STORAGE_KEY, collapsed ? 'collapsed' : 'open');
  } catch {
    // Storage can be unavailable in private or sandboxed contexts; the toggle still works for this page.
  }
}

function closeOverlaySubnav(): void {
  if (narrowViewport.matches) setSubnavCollapsed(true);
}

function readStoredSubnavCollapsed(): boolean {
  try {
    return localStorage.getItem(SUBNAV_STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

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

const documentView = el('main', 'bp-chrome-document');
documentView.id = 'document';
documentView.setAttribute('aria-label', 'Blueprint pages');
documentView.hidden = true;

const stage = el('div', 'bp-chrome-stage');
stage.append(explorationNavigator, viewport, documentView);
shell.append(rail, subnav, stage);
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
stage.append(fitButton);

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
stage.append(agentStatus);

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
stage.append(selectionBar);

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
stage.append(changeBar);

const findingsPanel = el('aside', 'bp-chrome-findings');
findingsPanel.hidden = true;
findingsPanel.setAttribute('aria-label', 'Design findings');
stage.append(findingsPanel);

const boardConfigs: Record<BoardId, BoardConfig> = {
  primitives: {
    label: 'Primitives',
    className: 'board-root board-primitives board-document',
    surface: 'document',
    mount: mountDocumentBoard
  },
  screens: {
    label: 'Screens',
    className: 'board-root board-screens',
    surface: 'canvas',
    mount: mountScreens
  }
};

const boardState = new Map<BoardId, MountedBoard>();
let activeBoardId: BoardId | null = null;

// Screens board pages: one sub-navigation group per declared page; each page is a
// fresh canvas showing only that page's frames. The first page is the default
// canvas — grouping is intentional, there is no catch-all page.
let screenPages = declaredScreenPages(project);
let activeScreenPage: string | null = null;

type DocumentSectionId = 'foundations' | 'primitives' | 'components';
type SectionId = DocumentSectionId | 'screens';

interface SectionItem {
  id: string;
  label: string;
  group?: string;
  boundaryKind: BoundaryKind;
  notice?: string;
}

const DOCUMENT_SECTIONS: DocumentSectionId[] = ['foundations', 'primitives', 'components'];

const BRAND_ITEM_ID = 'brand';

const SECTION_LABELS: Record<SectionId, string> = {
  foundations: 'Foundations',
  primitives: 'Primitives',
  components: 'Components',
  screens: 'Screens'
};

let activeSection: DocumentSectionId = requestedDocumentSection() ?? 'foundations';
const activeItemBySection = new Map<DocumentSectionId, string>();
const requestedItem = new URLSearchParams(location.search).get('item');
if (requestedItem) activeItemBySection.set(activeSection, requestedItem);

function declaredScreenPages(bundle: BlueprintProjectBundle): DeclaredGroup[] {
  return bundle.screens.pages ?? [];
}

function hasScreenPage(pageId: string): boolean {
  return screenPages.some(page => page.id === pageId);
}

function requestedDocumentSection(): DocumentSectionId | undefined {
  const section = new URLSearchParams(location.search).get('section');
  return DOCUMENT_SECTIONS.find(candidate => candidate === section);
}

function sectionItems(bundle: BlueprintProjectBundle, section: DocumentSectionId): SectionItem[] {
  if (section === 'foundations') {
    return [
      ...(bundle.brand ? [{ id: BRAND_ITEM_ID, label: 'Brand', boundaryKind: 'project' as const }] : []),
      ...bundle.tokens.tokenGroups.map(group => ({ id: group.id, label: group.name, boundaryKind: 'token-group' as const }))
    ];
  }
  if (section === 'primitives') {
    return groupPrimitivesForNavigation(bundle.primitives.primitives).flatMap(({ label, primitives }) =>
      primitives.map(primitive => ({
        id: primitive.id,
        label: primitive.name,
        group: label,
        boundaryKind: 'primitive' as const,
        ...(isBasePrimitive(primitive.id) ? {} : { notice: 'Not in the primitive set' })
      }))
    );
  }
  const sections = bundle.components.sections ?? [];
  const rank = (component: ComponentDefinition): number => {
    const index = sections.findIndex(section => section.id === component.section);
    return index === -1 ? sections.length : index;
  };
  return [...bundle.components.components].sort((a, b) => rank(a) - rank(b)).map(component => ({
    id: component.id,
    label: component.name,
    group: sections.find(section => section.id === component.section)?.name,
    boundaryKind: 'component' as const
  }));
}

function activeItem(bundle: BlueprintProjectBundle, section: DocumentSectionId): SectionItem | undefined {
  const items = sectionItems(bundle, section);
  const remembered = activeItemBySection.get(section);
  return items.find(item => item.id === remembered) ?? items[0];
}

function currentSection(): SectionId {
  return activeBoardId === 'screens' ? 'screens' : activeSection;
}

function visibleSections(): SectionId[] {
  const boards = new Set(project.manifest.boards.filter(isVisibleBoard).map(board => board.id));
  return [
    ...(boards.has('primitives') ? DOCUMENT_SECTIONS : []),
    ...(boards.has('screens') ? ['screens' as const] : [])
  ];
}

function sectionLabel(section: SectionId): string {
  const boardId = section === 'screens' ? 'screens' : section === 'primitives' ? 'primitives' : undefined;
  return project.manifest.boards.find(board => board.id === boardId)?.name ?? SECTION_LABELS[section];
}

function refreshBoardSwitcher(): void {
  projectName.textContent = project.manifest.project.name;
  projectMark.textContent = project.manifest.project.name.trim().charAt(0).toUpperCase();
  switcher.replaceChildren();
  for (const section of visibleSections()) {
    const button = el('button', 'bp-chrome-section-button') as HTMLButtonElement;
    button.type = 'button';
    button.dataset.section = section;
    if (section === 'primitives' || section === 'screens') button.dataset.board = section;
    button.innerHTML = sectionIcon(section);
    button.title = sectionLabel(section);
    button.setAttribute('aria-label', sectionLabel(section));
    button.append(el('span', 'bp-chrome-section-label', sectionLabel(section)));
    button.addEventListener('click', () => showSection(section));
    switcher.append(button);
  }
  refreshNavigationState();
}


function refreshItemNav(): void {
  itemNav.replaceChildren();
  const section = currentSection();
  sectionTitle.textContent = sectionLabel(section);
  if (section === 'screens') {
    itemNav.hidden = focusedReviewIsRequested();
    if (!itemNav.hidden) refreshScreenNav();
    return;
  }
  itemNav.hidden = false;
  const items = sectionItems(project, section);
  const selected = activeItem(project, section);
  const changed = new Set(latestChanges.map(change => `${change.kind}:${change.localId}`));
  const createItemButton = (item: SectionItem): HTMLElement => {
    const button = el('button', 'bp-chrome-item') as HTMLButtonElement;
    button.type = 'button';
    button.dataset.item = item.id;
    button.setAttribute('aria-pressed', String(item.id === selected?.id));
    button.append(el('span', 'bp-chrome-item-label', item.label));
    if (item.notice) {
      button.dataset.notice = 'true';
      button.title = item.notice;
      button.append(el('span', 'bp-chrome-item-notice', '!'));
    }
    if (changed.has(`${item.boundaryKind}:${item.id}`)) button.dataset.changed = 'true';
    button.addEventListener('click', () => {
      closeOverlaySubnav();
      openDocumentItem(section, item.id);
    });
    return button;
  };
  const groups = new Map<string | undefined, SectionItem[]>();
  for (const item of items) groups.set(item.group, [...groups.get(item.group) ?? [], item]);
  for (const [group, members] of groups) {
    const buttons = members.map(createItemButton);
    if (group === undefined) itemNav.append(...buttons);
    else itemNav.append(createNavGroup({ key: `${section}:${group}`, label: group, items: buttons }));
  }
  if (items.length === 0) {
    itemNav.append(el('p', 'bp-chrome-item-empty', section === 'components' ? 'No components yet' : 'Nothing here yet'));
  }
}

function refreshScreenNav(): void {
  const pageIds = new Set(screenPages.map(page => page.id));
  const createScreenButton = (screen: ScreenDefinition): HTMLElement => {
    const button = el('button', 'bp-chrome-item') as HTMLButtonElement;
    button.type = 'button';
    button.dataset.screen = screen.id;
    button.append(el('span', 'bp-chrome-item-label', screenFrameLabel(screen)));
    button.addEventListener('click', () => {
      closeOverlaySubnav();
      if (pageIds.has(screen.page) && screen.page !== activeScreenPage) setScreenPage(screen.page, screen.id);
      else focusScreenFrames(screen.id);
    });
    return button;
  };
  for (const screenPage of screenPages) {
    const screens = project.screens.screens.filter(screen => screen.page === screenPage.id);
    itemNav.append(createNavGroup({
      key: `screens:${screenPage.id}`,
      label: screenPage.name,
      description: screenPage.description,
      items: screens.map(createScreenButton),
      page: { id: screenPage.id, active: screenPage.id === activeScreenPage, select: () => setScreenPage(screenPage.id) }
    }));
  }
  itemNav.append(...project.screens.screens.filter(screen => !pageIds.has(screen.page)).map(createScreenButton));
}

function createNavGroup(options: {
  key: string;
  label: string;
  description?: string;
  items: HTMLElement[];
  page?: { id: string; active: boolean; select: () => void };
}): HTMLElement {
  const storageKey = navGroupStorageKey(options.key);
  const group = el('div', 'bp-chrome-nav-group');
  const head = el('div', 'bp-chrome-nav-group-head');
  const toggle = el('button', 'bp-chrome-nav-group-toggle') as HTMLButtonElement;
  toggle.type = 'button';
  toggle.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  const label = el('button', 'bp-chrome-nav-group-label') as HTMLButtonElement;
  label.type = 'button';
  label.append(el('span', 'bp-chrome-nav-group-name', options.label), el('span', 'bp-chrome-nav-group-count', String(options.items.length)));
  const list = el('div', 'bp-chrome-nav-group-items');
  list.append(...options.items);
  if (options.description) label.title = options.description;
  if (options.page) {
    label.dataset.page = options.page.id;
    label.setAttribute('aria-pressed', String(options.page.active));
  }
  const setOpen = (open: boolean, remember: boolean): void => {
    group.dataset.open = String(open);
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${options.label}`);
    if (!options.page) label.setAttribute('aria-expanded', String(open));
    if (!remember) return;
    if (open) collapsedNavGroups.delete(storageKey);
    else collapsedNavGroups.add(storageKey);
    storeCollapsedNavGroups();
  };
  setOpen(!collapsedNavGroups.has(storageKey), false);
  toggle.addEventListener('click', () => setOpen(group.dataset.open !== 'true', true));
  label.addEventListener('click', () => {
    if (!options.page) {
      setOpen(group.dataset.open !== 'true', true);
      return;
    }
    setOpen(true, true);
    options.page.select();
  });
  head.append(toggle, label);
  group.append(head, list);
  return group;
}

function navGroupStorageKey(key: string): string {
  return `${project.manifest.project.id}:${key}`;
}

function revealNavGroup(key: string | undefined): void {
  if (key && collapsedNavGroups.delete(navGroupStorageKey(key))) storeCollapsedNavGroups();
}

function readCollapsedNavGroups(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string') : []);
  } catch {
    return new Set();
  }
}

function storeCollapsedNavGroups(): void {
  try {
    localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsedNavGroups]));
  } catch {
    // Storage can be unavailable in private or sandboxed contexts; groups still toggle for this page.
  }
}

function refreshNavigationState(): void {
  const section = currentSection();
  switcher.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.section === section));
  });
  refreshItemNav();
}

function requestedScreenPage(): string | null {
  const param = new URLSearchParams(location.search).get('page');
  return param && hasScreenPage(param) ? param : null;
}

function setScreenPage(pageId: string, focusScreenId?: string): void {
  activeScreenPage = pageId;
  revealNavGroup(`screens:${pageId}`);
  const url = new URL(window.location.href);
  url.searchParams.set('page', pageId);
  history.replaceState(null, '', url);
  refreshItemNav();
  if (activeBoardId === 'screens') {
    remountBoard('screens');
  } else {
    discardBoard('screens');
    showBoard('screens');
  }
  if (focusScreenId) requestAnimationFrame(() => focusScreenFrames(focusScreenId));
}

function showSection(section: SectionId): void {
  if (section === 'screens') {
    showBoard('screens');
    return;
  }
  openDocumentItem(section, activeItemBySection.get(section));
}

function openDocumentItem(section: DocumentSectionId, itemId: string | undefined): void {
  activeSection = section;
  if (itemId) activeItemBySection.set(section, itemId);
  const group = sectionItems(project, section).find(item => item.id === itemId)?.group;
  if (group) revealNavGroup(`${section}:${group}`);
  if (activeBoardId === 'primitives') {
    remountBoard('primitives');
  } else {
    discardBoard('primitives');
    showBoard('primitives');
  }
}

function stepDocumentItem(offset: number): void {
  const items = sectionItems(project, activeSection);
  const index = items.findIndex(item => item.id === activeItem(project, activeSection)?.id);
  const next = items[index + offset];
  if (next) openDocumentItem(activeSection, next.id);
}

function focusScreenFrames(screenId: string): void {
  const root = boardState.get('screens')?.root;
  const frames = root ? [...root.querySelectorAll<HTMLElement>('.frame-slot')].filter(slot => (
    slot.querySelector<HTMLElement>('.frame')?.dataset.screenId === screenId
  )) : [];
  if (frames.length > 0) canvas.fitTo(frames);
}

function sectionIcon(section: SectionId): string {
  const paths: Record<SectionId, string> = {
    foundations: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16"/>',
    primitives: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    components: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    screens: '<rect x="3" y="5" width="12" height="14" rx="1.5"/><rect x="17" y="7" width="4" height="10" rx="1"/>'
  };
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[section]}</svg>`;
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
  const targetPage = exploration?.target.baseline.screen.page ?? historyScreen?.page;
  const url = new URL(window.location.href);
  url.searchParams.delete('exploration');
  url.searchParams.delete('history');
  url.searchParams.delete('state');
  url.searchParams.delete('viewport');
  if (targetPage && hasScreenPage(targetPage)) {
    activeScreenPage = targetPage;
    url.searchParams.set('page', targetPage);
  } else {
    activeScreenPage = screenPages[0]?.id ?? null;
    url.searchParams.delete('page');
  }
  history.replaceState(null, '', url);
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


function showBoard(id: BoardId): void {
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
  activeBoardId = id;

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

function discardBoard(id: BoardId): void {
  boardState.get(id)?.root.remove();
  boardState.delete(id);
}

// Rebuilds a board from scratch (used when the screens page or the
// document item changes); the fresh mount refits instead of restoring a stale view.
function remountBoard(id: BoardId): void {
  discardBoard(id);
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
  if (isActive) await waitForPrototypeFrames(nextRoot);

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

async function waitForPrototypeFrames(root: HTMLElement): Promise<void> {
  const frames = [...root.querySelectorAll<HTMLIFrameElement>('iframe.canonical-prototype-iframe, iframe.canonical-primitive-iframe')];
  if (frames.length === 0) return;
  await Promise.race([
    Promise.all(frames.map(frame => new Promise<void>(resolve => {
      frame.addEventListener('load', () => resolve(), { once: true });
    }))),
    new Promise<void>(resolve => window.setTimeout(resolve, 500))
  ]);
}

function mountDocumentBoard({ root, project: bundle }: BoardContext): BoardMount {
  const tokenIndex = createTokenIndex(bundle);
  const item = activeItem(bundle, activeSection);
  root.dataset.section = activeSection;
  const page = item ? createDocumentItemPage(bundle, tokenIndex, activeSection, item.id) : undefined;
  root.append(page ?? createEmptySectionPage(activeSection));
  return {
    configure: () => undefined,
    fit: () => {
      documentView.scrollTop = 0;
    }
  };
}

function createDocumentItemPage(
  bundle: BlueprintProjectBundle,
  tokenIndex: TokenIndex,
  section: DocumentSectionId,
  itemId: string
): HTMLElement | undefined {
  if (section === 'foundations') {
    if (itemId === BRAND_ITEM_ID && bundle.brand) return createBrandPage(bundle, tokenIndex, bundle.brand);
    const group = tokenIndex.byGroup.get(itemId);
    return group ? createFoundationPage(bundle, tokenIndex, group) : undefined;
  }
  if (section === 'primitives') {
    const primitive = bundle.primitives.primitives.find(candidate => candidate.id === itemId);
    return primitive ? createPrimitivePage(bundle, tokenIndex, primitive) : undefined;
  }
  const component = bundle.components.components.find(candidate => candidate.id === itemId);
  return component ? createComponentPage(bundle, component) : undefined;
}

function createDocumentPage(kicker: string, title: string, description: string, badges: HTMLElement[] = []): { page: HTMLElement; body: HTMLElement } {
  const page = el('article', 'bp-chrome-doc-page');
  const head = el('header', 'bp-chrome-doc-head');
  const titleRow = el('div', 'bp-chrome-doc-title-row');
  titleRow.append(el('h1', 'bp-chrome-doc-title', title));
  if (badges.length > 0) {
    const facts = el('div', 'bp-chrome-doc-facts');
    facts.append(...badges);
    titleRow.append(facts);
  }
  head.append(el('p', 'bp-chrome-doc-kicker', kicker), titleRow);
  if (description) head.append(el('p', 'bp-chrome-doc-lede', description));
  const body = el('div', 'bp-chrome-doc-body');
  page.append(head, body);
  return { page, body };
}

function createDocumentSection(title: string, ...children: HTMLElement[]): HTMLElement {
  const section = el('section', 'bp-chrome-doc-section');
  section.append(el('h2', 'bp-chrome-doc-section-title', title), ...children);
  return section;
}

function createEmptySectionPage(section: DocumentSectionId): HTMLElement {
  const copy: Record<DocumentSectionId, [string, string]> = {
    foundations: ['No tokens yet', 'Foundations show the color, type, space, shape and motion tokens every primitive reads from.'],
    primitives: ['No primitives yet', 'Primitives are the fixed building blocks every app shares, such as the button and the input.'],
    components: ['No components yet', 'Components are this app\'s own compositions built from primitives, such as a bento grid on a landing page. Primitives stay fixed; components are where an app adds its own pieces.']
  };
  const [title, description] = copy[section];
  const { page } = createDocumentPage(SECTION_LABELS[section], title, description);
  page.classList.add('bp-chrome-doc-empty');
  return page;
}

const BRAND_ROLE_LABELS: Record<BrandMark['role'], string> = {
  mark: 'Mark',
  wordmark: 'Wordmark',
  lockup: 'Lockup',
  'app-icon': 'App icon'
};

function createBrandPage(bundle: BlueprintProjectBundle, tokenIndex: TokenIndex, brand: BrandFile): HTMLElement {
  const marks = brand.marks ?? [];
  const badges = [el('span', 'bp-chrome-doc-fact', `${marks.length} ${marks.length === 1 ? 'mark' : 'marks'}`)];
  const { page, body } = createDocumentPage('Foundations', brand.name, brand.tagline ?? '', badges);
  page.dataset.brand = 'true';
  applyProjectCanvas(body, tokenIndex);

  if (brand.personality && brand.personality.length > 0) {
    const traits = el('div', 'bp-chrome-brand-traits');
    for (const trait of brand.personality) {
      const item = el('div', 'bp-chrome-brand-trait');
      item.append(el('h3', 'bp-chrome-brand-trait-name', trait.name), el('p', 'bp-chrome-brand-trait-text', trait.description));
      traits.append(item);
    }
    body.append(createDocumentSection('Personality', traits));
  }

  if (marks.length > 0) {
    const list = el('div', 'bp-chrome-brand-marks');
    list.append(...marks.map(mark => createBrandMarkSpecimen(bundle, tokenIndex, mark)));
    body.append(createDocumentSection('Marks', list));
  }

  if (brand.voice) {
    const summary = el('p', 'bp-chrome-doc-text', brand.voice.summary);
    body.append(createDocumentSection('Voice', summary, createBrandExamples(brand.voice.do, brand.voice.dont, true)));
  }
  if (brand.usage) {
    body.append(createDocumentSection('Usage', createBrandExamples(brand.usage.do, brand.usage.dont, false)));
  }
  return page;
}

function createBrandMarkSpecimen(bundle: BlueprintProjectBundle, tokenIndex: TokenIndex, mark: BrandMark): HTMLElement {
  const specimen = el('div', 'bp-chrome-brand-mark');
  specimen.dataset.brandMark = mark.id;
  const head = el('div', 'bp-chrome-brand-mark-head');
  head.append(el('h3', 'bp-chrome-specimen-title', mark.name), el('span', 'bp-chrome-doc-fact', BRAND_ROLE_LABELS[mark.role] ?? mark.role));
  specimen.append(head, el('p', 'bp-chrome-doc-text', mark.description));

  const source = bundle.prototypeSourceContents[mark.source];
  const displayHeight = mark.role === 'wordmark' || mark.role === 'lockup' ? 40 : 56;
  const draw = (height: number, label: string): SVGSVGElement | undefined => source === undefined ? undefined : createBrandGraphic(source, height, label);
  if (!draw(displayHeight, mark.name)) {
    specimen.append(el('p', 'bp-chrome-doc-notice', `${mark.source} is missing or failed the brand mark source checks, so it is not drawn.`));
    return specimen;
  }

  const variants = el('div', 'bp-chrome-brand-row');
  for (const variant of mark.variants ?? []) {
    variants.append(createBrandTile(tokenIndex, variant, draw(displayHeight, `${mark.name}, ${variant.name}`)!, variant.name));
  }
  specimen.append(variants);

  const primary = mark.variants?.[0];
  if (!primary) return specimen;
  const construction = el('div', 'bp-chrome-brand-row');
  const clearGraphic = draw(displayHeight, `${mark.name} with its clear space`)!;
  const clearArea = el('div', 'bp-chrome-brand-clearspace');
  const basis = mark.clearSpace?.basis === 'width' ? Number(clearGraphic.getAttribute('width')) : displayHeight;
  clearArea.style.padding = `${Math.round((mark.clearSpace?.ratio ?? 0) * basis)}px`;
  clearArea.append(clearGraphic);
  construction.append(createBrandTile(tokenIndex, primary, clearArea, ['Clear space', mark.clearSpace?.note].filter(Boolean).join(' · ')));

  const minimum = mark.minimumSize;
  if (minimum) {
    const graphic = draw(displayHeight, `${mark.name} at its minimum size`)!;
    const ratio = Number(graphic.getAttribute('width')) / displayHeight;
    const height = minimum.axis === 'width' ? minimum.px / ratio : minimum.px;
    graphic.setAttribute('height', String(Math.round(height * 100) / 100));
    graphic.setAttribute('width', String(Math.round(height * ratio * 100) / 100));
    const size = `Minimum ${minimum.px} px ${minimum.axis === 'width' ? 'wide' : 'tall'}`;
    construction.append(createBrandTile(tokenIndex, primary, graphic, [size, minimum.note].filter(Boolean).join(' · ')));
  }
  specimen.append(construction);
  return specimen;
}

function createBrandTile(tokenIndex: TokenIndex, variant: BrandMarkVariant, content: Element, caption: string): HTMLElement {
  const tile = el('figure', 'bp-chrome-brand-tile');
  tile.dataset.brandVariant = variant.id;
  const surface = el('div', 'bp-chrome-brand-surface');
  const color = (ref: string | undefined): string | undefined => {
    const record = ref ? tokenIndex.byRef.get(ref) : undefined;
    return record?.token.type === 'color' ? resolveTokenReferences(tokenIndex, record.token.value) : undefined;
  };
  const background = color(variant.background);
  const foreground = color(variant.foreground);
  const accent = color(variant.accent);
  if (background) surface.style.background = background;
  if (foreground) surface.style.color = foreground;
  if (accent) surface.style.setProperty('--brand-accent', accent);
  surface.append(content);
  tile.append(surface, el('figcaption', 'bp-chrome-brand-caption', caption));
  return tile;
}

function createBrandGraphic(source: string, height: number, label: string): SVGSVGElement | undefined {
  if (brandMarkSourceIssues(source).length > 0) return undefined;
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (svg.localName !== 'svg' || parsed.getElementsByTagName('parsererror').length > 0) return undefined;
  // The text checks above run before entity decoding, so decoded attribute values are checked again here.
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    const unsafeText = node.localName === 'style' && /url\(\s*["']?(?!#)|@import/i.test(node.textContent ?? '');
    if (unsafeText || /^(script|foreignobject|image|iframe|object|embed)$/i.test(node.localName)) return undefined;
    for (const attribute of node.attributes) {
      const value = attribute.value.toLowerCase();
      if (/^on/i.test(attribute.name) || value.includes('javascript:') || /url\(\s*["']?(?!#)/.test(value)) return undefined;
      if (/href$/i.test(attribute.name) && !value.trim().startsWith('#')) return undefined;
    }
  }
  const [, , boxWidth, boxHeight] = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  if (!boxWidth || !boxHeight) return undefined;
  const graphic = document.importNode(svg, true) as unknown as SVGSVGElement;
  graphic.setAttribute('height', String(height));
  graphic.setAttribute('width', String(Math.round(height * (boxWidth / boxHeight) * 100) / 100));
  graphic.setAttribute('role', 'img');
  graphic.setAttribute('aria-label', label);
  graphic.classList.add('bp-chrome-brand-graphic');
  return graphic;
}

function createBrandExamples(doItems: string[], dontItems: string[], quoted: boolean): HTMLElement {
  const examples = el('div', 'bp-chrome-brand-examples');
  for (const [tone, title, items] of [['do', 'Do', doItems], ['dont', "Don't", dontItems]] as const) {
    const column = el('div', 'bp-chrome-brand-example-list');
    column.dataset.tone = tone;
    const list = el('ul', 'bp-chrome-brand-example-items');
    for (const item of items) list.append(el('li', '', quoted ? `\u201c${item}\u201d` : item));
    column.append(el('h3', 'bp-chrome-specimen-title', title), list);
    examples.append(column);
  }
  return examples;
}

function createFoundationPage(bundle: BlueprintProjectBundle, tokenIndex: TokenIndex, group: TokenGroup): HTMLElement {
  const { page, body } = createDocumentPage('Foundations', group.name, group.description);
  setBoundary(page, 'token-group', group.id, bundle.manifest.project.id, group.name);
  page.dataset.boundarySummary = group.description;
  page.dataset.tokenGroup = group.id;
  body.classList.add('token-card-body');
  applyProjectCanvas(body, tokenIndex);

  if (group.notes.length > 0) {
    const rules = el('ul', 'bp-chrome-doc-rules');
    for (const note of group.notes) rules.append(el('li', '', note));
    body.append(createDocumentSection('Rules', rules));
  }
  if (group.tokens.some(token => token.styleRef === SURFACE_LADDER_ROLES[0])) {
    const ladder = createSurfaceLadder(tokenIndex);
    const pairs = createContrastPairs(tokenIndex);
    if (ladder || pairs) {
      const context = el('div', 'token-context');
      for (const part of [ladder, pairs]) if (part) context.append(part);
      body.append(createDocumentSection('In context', context));
    }
  }

  const byType = new Map<DesignToken['type'], DesignToken[]>();
  for (const token of group.tokens) byType.set(token.type, [...byType.get(token.type) ?? [], token]);
  for (const [type, tokens] of byType) {
    body.append(createDocumentSection(TOKEN_TYPE_LABELS[type], createTokenSpecimens(tokenIndex, group, type, tokens)));
  }
  return page;
}

const TOKEN_TYPE_LABELS: Record<DesignToken['type'], string> = {
  color: 'Colors',
  typography: 'Type',
  space: 'Space',
  size: 'Sizes',
  radius: 'Radii',
  shadow: 'Shadows',
  motion: 'Motion'
};

function createTokenSpecimens(tokenIndex: TokenIndex, group: TokenGroup, type: DesignToken['type'], tokens: DesignToken[]): HTMLElement {
  const list = el('div', `token-specimens token-specimens-${type}`);
  for (const token of tokens) {
    const record = tokenIndex.byRef.get(`${group.id}.${token.id}`);
    const value = resolveTokenReferences(tokenIndex, token.value);
    const specimen = el('div', 'token-specimen');
    setTokenHook(specimen, record, `${type}-token-specimen`);
    specimen.dataset.tokenType = token.type;
    specimen.append(createTokenVisual(token, value), createTokenCaption(group, token));
    list.append(specimen);
  }
  return list;
}

function createTokenVisual(token: DesignToken, value: string): HTMLElement {
  const visual = el('div', 'token-visual');
  switch (token.type) {
    case 'color':
      visual.style.background = value;
      break;
    case 'typography':
      if (isFontStack(value)) {
        visual.classList.add('token-visual-family');
        visual.style.fontFamily = value;
        visual.append(el('span', 'token-visual-glyph', 'Aa'), el('span', 'token-visual-alphabet', 'ABCDEFGHIJKLM nopqrstuvwxyz 0123456789'));
      } else if (/^-?[\d.]+em$/.test(value.trim())) {
        visual.classList.add('token-visual-tracking');
        visual.style.letterSpacing = value;
        visual.textContent = 'Tracking';
      } else {
        visual.classList.add('token-visual-type');
        visual.style.font = value;
        if (!visual.style.font) visual.style.fontFamily = value;
        visual.textContent = token.description || token.name;
      }
      break;
    case 'space':
    case 'size': {
      const length = singleLength(value);
      if (length !== undefined) {
        const bar = el('span', 'token-visual-bar');
        bar.style.width = `${Math.min(length, 640)}px`;
        visual.append(bar);
      } else {
        visual.classList.add('token-visual-text');
        visual.textContent = value;
      }
      break;
    }
    case 'radius': {
      const tile = el('span', 'token-visual-radius');
      tile.style.borderRadius = value;
      visual.append(tile);
      break;
    }
    case 'shadow': {
      const tile = el('span', 'token-visual-shadow');
      tile.style.boxShadow = value;
      visual.append(tile);
      break;
    }
    case 'motion': {
      const dot = el('span', 'token-visual-motion-dot');
      dot.style.transition = `transform ${value}`;
      visual.classList.add('token-visual-motion');
      visual.append(dot);
      break;
    }
  }
  return visual;
}

function createTokenCaption(group: TokenGroup, token: DesignToken): HTMLElement {
  const caption = el('div', 'token-caption');
  const name = el('div', 'token-caption-name');
  name.append(el('b', '', token.name), createCodeWords('', token.value));
  caption.append(name);
  if (token.description && token.type !== 'typography') caption.append(el('p', 'token-caption-description', token.description));
  caption.append(createCodeWords('token-caption-ref', `${group.id}.${token.id} · ${token.styleRef}`));
  return caption;
}

function createCodeWords(className: string, text: string): HTMLElement {
  const code = el('code', className);
  // Keeps names like --app-font-sans whole: a line may only break between words, not after a hyphen.
  for (const part of text.split(/(\s+)/)) code.append(/^\s*$/.test(part) ? part : el('span', 'token-code-word', part));
  return code;
}

function isFontStack(value: string): boolean {
  return !/\d+(?:\.\d+)?px/.test(value) && /[,"']/.test(value);
}

function singleLength(value: string): number | undefined {
  const match = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

function createPrimitivePage(bundle: BlueprintProjectBundle, tokenIndex: TokenIndex, primitive: PrimitiveDefinition): HTMLElement {
  const family = inferPrimitiveFamily(primitive);
  const prototype = primitive.prototype;
  const badges = [
    createPlatformBadge(primitive.platforms),
    el('span', 'bp-chrome-doc-fact', plural(prototype?.states.length ?? 0, 'state')),
    ...(prototype?.variants.length ? [el('span', 'bp-chrome-doc-fact', plural(prototype.variants.length, 'variant'))] : []),
    ...(prototype?.sizes?.length ? [el('span', 'bp-chrome-doc-fact', plural(prototype.sizes.length, 'size'))] : [])
  ];
  const { page, body } = createDocumentPage(`Primitive · ${primitiveGroupLabel(family)}`, primitive.name, primitive.description, badges);
  setBoundary(page, 'primitive', primitive.id, bundle.manifest.project.id, primitive.name);
  page.dataset.boundarySummary = primitive.description;
  page.dataset.primitiveFamily = family;

  if (!isBasePrimitive(primitive.id)) {
    body.append(el('p', 'bp-chrome-doc-notice', `This is not one of the ${BASE_PRIMITIVE_CONTRACT.length} Blueprint primitives. App-specific pieces belong in components, built from primitives.`));
  }
  const specimen = el('div', 'bp-chrome-doc-specimen');
  specimen.append(renderCanonicalPrimitiveSpecimen({ bundle, tokenIndex, primitive, family }));
  body.append(specimen);

  if (prototype?.accessibilityIntent) body.append(createDocumentSection('Accessibility', el('p', 'bp-chrome-doc-text', prototype.accessibilityIntent)));
  if (prototype?.slots.length) body.append(createDocumentSection('Slots', createChipList(prototype.slots)));
  const roles = Object.entries(prototype?.tokenRoles ?? {});
  if (roles.length > 0) {
    const list = el('div', 'bp-chrome-doc-roles');
    for (const [tokenRef, role] of roles) {
      const row = el('div', 'bp-chrome-doc-role');
      const record = tokenIndex.byRef.get(tokenRef);
      const swatch = el('span', 'token-role-swatch');
      if (record) applyTokenPreview(swatch, record.token, tokenIndex);
      row.append(swatch, el('span', 'bp-chrome-doc-role-name', role), el('code', '', tokenRef));
      list.append(row);
    }
    body.append(createDocumentSection('Token roles', list));
  }
  if (primitive.notes.length > 0) {
    const notes = el('ul', 'bp-chrome-doc-rules');
    for (const note of primitive.notes) notes.append(el('li', '', note));
    body.append(createDocumentSection('Notes', notes));
  }
  return page;
}

function createPlatformBadge(platforms: PrimitiveDefinition['platforms']): HTMLElement {
  const only = platforms?.length === 1 ? platforms[0] : undefined;
  const label = only === 'mobile' ? 'Mobile' : only === 'desktop' ? 'Web' : 'Mobile and web';
  const badge = el('span', 'bp-chrome-doc-fact bp-chrome-doc-platform');
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', label);
  badge.title = label;
  const icon = (paths: string) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  badge.innerHTML = [
    only === 'desktop' ? '' : icon('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>'),
    only === 'mobile' ? '' : icon('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>')
  ].join('');
  return badge;
}

function createComponentPage(bundle: BlueprintProjectBundle, component: ComponentDefinition): HTMLElement {
  const section = bundle.components.sections?.find(candidate => candidate.id === component.section);
  const { page, body } = createDocumentPage(section ? `Component · ${section.name}` : 'Component', component.name, component.description);
  setBoundary(page, 'component', component.id, bundle.manifest.project.id, component.name);
  page.dataset.boundarySummary = component.description;

  const pieces = component.uses.filter(use => use.kind === 'primitive' || use.kind === 'component');
  if (pieces.length > 0) {
    const list = el('div', 'bp-chrome-doc-chips');
    for (const use of pieces) {
      const target = use.kind === 'primitive'
        ? bundle.primitives.primitives.find(candidate => candidate.id === use.id)
        : bundle.components.components.find(candidate => candidate.id === use.id);
      const chip = el('button', 'bp-chrome-doc-chip bp-chrome-doc-link', target?.name ?? use.id) as HTMLButtonElement;
      chip.type = 'button';
      chip.title = `${use.kind}:${use.id}`;
      chip.addEventListener('click', () => openDocumentItem(use.kind === 'primitive' ? 'primitives' : 'components', use.id));
      list.append(chip);
    }
    body.append(createDocumentSection('Built from', list));
  }

  const width = componentPreviewWidth(bundle, component.id);
  const states = component.prototype?.states ?? [];
  if (states.length > 0) {
    body.append(createDocumentSection('States', createSpecimenGroup(undefined, states.map(state => createComponentPreview(bundle, component, state, width)))));
  }

  if (component.notes?.length) {
    const notes = el('ul', 'bp-chrome-doc-rules');
    for (const note of component.notes) notes.append(el('li', '', note));
    body.append(createDocumentSection('Notes', notes));
  }
  return page;
}

function createComponentPreview(bundle: BlueprintProjectBundle, component: ComponentDefinition, state: string, width: number): HTMLElement {
  const item = el('figure', 'bp-chrome-specimen-cell');
  try {
    const compiled = compilePrototypeDocument({ bundle, target: { kind: 'component', id: component.id }, state });
    const iframe = document.createElement('iframe');
    iframe.className = 'canonical-primitive-iframe component-preview-iframe';
    applyPrototypeIframeIsolation(iframe);
    iframe.title = `${component.name} · ${state}`;
    iframe.srcdoc = compiled.html;
    prototypeDocumentByFrame.set(iframe, compiled.html);
    iframe.dataset.prototypeTargetBoundary = compiled.targetBoundaryId;
    iframe.dataset.prototypeObservedUses = JSON.stringify(compiled.observedUses);
    item.append(createPreviewFit(iframe));
    fitPreviewFrame(iframe, { width, height: 160 });
    measureComponentPreview(compiled.html, width, size => fitPreviewFrame(iframe, size));
  } catch (error) {
    item.append(createPrototypeCompileError(error));
  }
  item.append(el('figcaption', 'bp-chrome-specimen-caption', humanizeId(state)));
  return item;
}

function createSpecimenGroup(title: string | undefined, cells: HTMLElement[]): HTMLElement {
  const group = el('div', 'bp-chrome-specimen-group');
  if (title) group.append(el('h3', 'bp-chrome-specimen-title', humanizeId(title)));
  const row = el('div', 'bp-chrome-specimen-row');
  row.append(...cells);
  group.append(row);
  return group;
}

function humanizeId(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words.length <= 2 ? words.toUpperCase() : words.charAt(0).toUpperCase() + words.slice(1);
}

// Previews keep their natural size and scale down only when the column is narrower, so pages never scroll sideways.
const previewFitObserver = new ResizeObserver(entries => {
  for (const entry of entries) scalePreview(entry.target as HTMLElement);
});

function createPreviewFit(frame: HTMLIFrameElement): HTMLElement {
  const host = el('div', 'bp-chrome-preview-fit');
  host.append(frame);
  return host;
}

function fitPreviewFrame(frame: HTMLIFrameElement, size: { width: number; height: number }): void {
  frame.style.width = `${size.width}px`;
  frame.style.height = `${size.height}px`;
  const host = frame.parentElement;
  if (!host) return;
  host.dataset.previewWidth = String(size.width);
  host.dataset.previewHeight = String(size.height);
  host.style.width = `${size.width}px`;
  scalePreview(host);
  previewFitObserver.observe(host);
}

function scalePreview(host: HTMLElement): void {
  const width = Number(host.dataset.previewWidth);
  const height = Number(host.dataset.previewHeight);
  const frame = host.firstElementChild;
  if (!(frame instanceof HTMLElement) || !width || !height || host.clientWidth === 0) return;
  const scale = Math.min(1, host.clientWidth / width);
  frame.style.transform = scale < 1 ? `scale(${scale})` : '';
  host.style.height = `${Math.ceil(height * scale)}px`;
}

function measureComponentPreview(html: string, width: number, done: (size: { width: number; height: number }) => void): void {
  const probe = document.createElement('iframe');
  probe.style.cssText = `position:absolute;left:-10000px;top:0;width:${width}px;height:1px;border:0;visibility:hidden;`;
  probe.setAttribute('aria-hidden', 'true');
  probe.addEventListener('load', () => {
    const measure = (): void => {
      try {
        const body = probe.contentDocument?.body;
        const root = body?.firstElementChild as HTMLElement | null | undefined;
        const rect = root?.getBoundingClientRect();
        const intrinsic = rect && rect.width < width - 48 ? Math.ceil(rect.width) + 24 : width;
        const height = Math.max(rect ? Math.ceil(rect.bottom) + 12 : 0, probe.contentDocument?.documentElement.scrollHeight ?? 0);
        done({ width: Math.max(160, intrinsic), height: Math.min(1600, Math.max(48, height)) });
      } catch {
        // Keep the default preview size when the document cannot be measured.
      } finally {
        probe.remove();
      }
    };
    void (probe.contentDocument?.fonts.ready ?? Promise.resolve()).then(measure, measure);
  });
  probe.srcdoc = html;
  document.body.append(probe);
}

function componentPreviewWidth(bundle: BlueprintProjectBundle, componentId: string): number {
  const users = new Set([componentId]);
  for (const component of bundle.components.components) {
    if (component.uses.some(use => use.kind === 'component' && use.id === componentId)) users.add(component.id);
  }
  const presets = new Map(bundle.manifest.framePresets.map(preset => [preset.id, preset]));
  const widths = bundle.screens.screens
    .filter(screen => screen.sections.some(section => section.uses.some(use => use.kind === 'component' && users.has(use.id))))
    .flatMap(screen => {
      const preset = presets.get(screen.framePresetId);
      return preset ? [Math.min(preset.width, 1120)] : [];
    });
  return widths.length > 0 ? Math.min(...widths) : 640;
}


function createChipList(values: string[]): HTMLElement {
  const list = el('div', 'bp-chrome-doc-chips');
  for (const value of values) list.append(el('span', 'bp-chrome-doc-chip', value));
  return list;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

interface TokenRecord {
  ref: string;
  group: TokenGroup;
  token: DesignToken;
}

interface TokenIndex {
  byRef: Map<string, TokenRecord>;
  byStyleRef: Map<string, TokenRecord>;
  byGroup: Map<string, TokenGroup>;
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

const PRIMITIVE_GROUPS: Array<{ label: string; families: string[] }> = [
  { label: 'Actions', families: ['button'] },
  { label: 'Inputs', families: ['input', 'select', 'checkbox', 'radio', 'switch', 'slider'] },
  { label: 'Text', families: ['text'] },
  { label: 'Surfaces', families: ['surface', 'card', 'media'] },
  { label: 'Navigation', families: ['navigation', 'tabs'] },
  { label: 'Structure', families: ['separator', 'list', 'row'] },
  { label: 'Feedback', families: ['loading', 'badge', 'icon', 'avatar', 'skeleton', 'toast', 'tooltip', 'alert'] },
  { label: 'Overlays', families: ['dialog', 'menu', 'sheet'] }
];

function primitiveGroupLabel(family: string): string {
  return PRIMITIVE_GROUPS.find(group => group.families.includes(family))?.label ?? 'Other';
}

function groupPrimitivesForNavigation(primitives: PrimitiveDefinition[]): Array<{ label: string; primitives: PrimitiveDefinition[] }> {
  const byLabel = new Map<string, PrimitiveDefinition[]>();
  for (const { family, primitives: members } of groupPrimitivesByFamily(primitives)) {
    const label = primitiveGroupLabel(family);
    byLabel.set(label, [...byLabel.get(label) ?? [], ...members]);
  }
  return [...PRIMITIVE_GROUPS.map(group => group.label), 'Other']
    .flatMap(label => byLabel.has(label) ? [{ label, primitives: byLabel.get(label) ?? [] }] : []);
}

function createTokenIndex(bundle: BlueprintProjectBundle): TokenIndex {
  const byRef = new Map<string, TokenRecord>();
  const byStyleRef = new Map<string, TokenRecord>();
  const byGroup = new Map<string, TokenGroup>();
  for (const group of bundle.tokens.tokenGroups) {
    byGroup.set(group.id, group);
    for (const token of group.tokens) {
      const record = { ref: `${group.id}.${token.id}`, group, token };
      byRef.set(record.ref, record);
      byStyleRef.set(token.styleRef, record);
    }
  }
  return { byRef, byStyleRef, byGroup };
}

const SURFACE_LADDER_ROLES = [
  '--app-color-background',
  '--app-color-surface',
  '--app-color-surface-2',
  '--app-color-surface-3',
  '--app-color-surface-4',
  '--app-color-surface-5',
  '--app-color-surface-6'
];

function resolvedColor(tokenIndex: TokenIndex, styleRef: string): string | undefined {
  const record = tokenIndex.byStyleRef.get(styleRef);
  return record?.token.type === 'color' ? resolveTokenReferences(tokenIndex, record.token.value) : undefined;
}

function applyProjectCanvas(element: HTMLElement, tokenIndex: TokenIndex): void {
  const background = resolvedColor(tokenIndex, '--app-color-background');
  const foreground = resolvedColor(tokenIndex, '--app-color-foreground');
  const muted = resolvedColor(tokenIndex, '--app-color-muted');
  const surface = resolvedColor(tokenIndex, '--app-color-surface');
  const border = resolvedColor(tokenIndex, '--app-color-border');
  if (background) element.style.background = background;
  if (border) element.style.setProperty('--bp-sample-border', border);
  if (foreground) element.style.setProperty('--bp-sample-fg', foreground);
  if (muted) element.style.setProperty('--bp-sample-muted-fg', muted);
  if (surface) element.style.setProperty('--bp-sample-swatch-bg', surface);
}

function createSurfaceLadder(tokenIndex: TokenIndex): HTMLElement | undefined {
  const steps = SURFACE_LADDER_ROLES.flatMap(styleRef => {
    const record = tokenIndex.byStyleRef.get(styleRef);
    const value = resolvedColor(tokenIndex, styleRef);
    return record && value ? [{ record, value }] : [];
  });
  if (steps.length < 2) {
    return undefined;
  }
  const ladder = el('section', 'token-ladder');
  ladder.append(el('p', 'token-section-label', 'Surface ladder'));
  let parent: HTMLElement = ladder;
  for (const { record, value } of steps) {
    const step = el('div', 'token-ladder-step');
    step.style.background = value;
    step.append(el('span', 'token-ladder-label', `${record.token.name} · ${record.token.value}`));
    setTokenHook(step, record, 'color-ladder-step');
    parent.append(step);
    parent = step;
  }
  return ladder;
}

function createContrastPairs(tokenIndex: TokenIndex): HTMLElement | undefined {
  const list = el('div', 'token-pairs-list');
  for (const pair of colorRolePairs) {
    const foreground = tokenIndex.byStyleRef.get(pair.foreground);
    const background = tokenIndex.byStyleRef.get(pair.background);
    const foregroundValue = resolvedColor(tokenIndex, pair.foreground);
    const backgroundValue = resolvedColor(tokenIndex, pair.background);
    if (!foreground || !background || !foregroundValue || !backgroundValue) {
      continue;
    }
    const row = el('div', 'token-pair');
    row.dataset.tokenPair = `${pair.foreground} on ${pair.background}`;
    const sample = el('span', 'token-pair-sample', pair.minimum === 3 ? '' : 'Aa');
    sample.dataset.pairKind = pair.minimum === 3 ? 'indicator' : 'text';
    sample.style.background = backgroundValue;
    sample.style.color = foregroundValue;
    const foregroundRgb = parseOpaqueColor(foregroundValue);
    const backgroundRgb = parseOpaqueColor(backgroundValue);
    const ratio = foregroundRgb && backgroundRgb ? contrastRatio(foregroundRgb, backgroundRgb) : undefined;
    const verdict = el('span', 'token-pair-ratio');
    if (ratio === undefined) {
      verdict.textContent = 'not measured';
    } else {
      const passes = ratio >= pair.minimum;
      verdict.dataset.passes = String(passes);
      verdict.textContent = `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1 ${passes ? '✓' : `✕ needs ${pair.minimum}`}`;
    }
    row.append(sample, el('span', 'token-pair-label', `${foreground.token.name} on ${background.token.name}`), verdict);
    list.append(row);
  }
  if (list.childElementCount === 0) {
    return undefined;
  }
  const section = el('section', 'token-pairs');
  section.append(el('p', 'token-section-label', 'Contrast pairs'), list);
  return section;
}

function renderCanonicalPrimitiveSpecimen(context: PrimitiveRenderContext): HTMLElement {
  const root = el('div', 'canonical-primitive-specimen');
  root.dataset.prototypeRenderMode = 'canonical-app-owned';
  root.style.setProperty('--cell-w', `${primitiveCellWidth(context.family, context.primitive.id)}px`);
  const states = context.primitive.prototype?.states ?? [];
  const variants = context.primitive.prototype?.variants ?? [];
  const sizes = context.primitive.prototype?.sizes ?? [];
  root.append(createDocumentSection(
    variants.length > 1 ? 'Variants' : 'States',
    ...(variants.length > 0 ? variants : [undefined]).map(variant => createSpecimenGroup(
      variants.length > 1 ? variant : undefined,
      states.map(state => createCanonicalPrimitiveCell(context, state, variant))
    ))
  ));
  if (sizes.length > 0) {
    root.append(createDocumentSection(
      'Sizes',
      ...sizes.map(size => createSpecimenGroup(size, states.map(state => createCanonicalPrimitiveCell(context, state, undefined, size))))
    ));
  }
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
  const item = el('figure', 'bp-chrome-specimen-cell');
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
    item.append(createPreviewFit(iframe));
    // The visible frame keeps its empty-permission sandbox, so its content is
    // measured through an ephemeral offscreen twin instead; the twin renders
    // the same CSP-locked no-script document and is removed immediately.
    measureCanonicalCellSize(compiled.html, primitiveCellWidth(context.family, context.primitive.id), size => fitPreviewFrame(iframe, size));
  } catch (error) {
    item.append(createPrototypeCompileError(error));
  }
  item.append(el('figcaption', 'bp-chrome-specimen-caption', humanizeId(state)));
  return item;
}

/**
 * Fits a specimen cell to its rendered control so the cell hugs the content
 * instead of clipping or stretching it. Controls with their own width hug it;
 * full-bleed controls (width:100% roots) keep the family width, and content
 * that runs wider grows its own cell.
 */
function measureCanonicalCellSize(
  html: string,
  fallbackWidth: number,
  done: (size: { width: number; height: number }) => void
): void {
  const probe = document.createElement('iframe');
  // A 1px-tall probe lets the document's scroll size report the real content
  // extent, including overlays and line boxes that spill past the root.
  probe.style.cssText = `position:absolute;left:-10000px;top:0;width:${fallbackWidth}px;height:1px;border:0;visibility:hidden;`;
  probe.setAttribute('aria-hidden', 'true');
  probe.addEventListener('load', () => {
    try {
      const documentRoot = probe.contentDocument?.documentElement;
      const control = probe.contentDocument?.querySelector<HTMLElement>('[data-blueprint-primitive]') ?? probe.contentDocument?.body;
      const rect = control?.getBoundingClientRect();
      const fillsCell = !rect || rect.width >= fallbackWidth - 25;
      const extent = control ? [control, ...control.querySelectorAll('*')].reduce((right, node) => Math.max(right, node.getBoundingClientRect().right), 0) : 0;
      const overflow = (documentRoot?.scrollWidth ?? 0) > fallbackWidth ? documentRoot!.scrollWidth : 0;
      const measuredWidth = fillsCell
        ? Math.max(fallbackWidth, documentRoot?.scrollWidth ?? 0)
        : Math.max(Math.ceil(extent) + 12, overflow);
      const measuredHeight = rect ? Math.max(Math.ceil(rect.height) + 24, documentRoot?.scrollHeight ?? 0) : 88;
      done({
        width: Math.min(520, measuredWidth),
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
    case 'size': {
      const bar = el('span', 'token-role-bar');
      bar.style.width = value;
      element.append(bar);
      break;
    }
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
    const record = tokenIndex.byStyleRef.get(styleRef);
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
  frameLayouts.forEach(layout => {
    if (layout.pageLabel) {
      const label = el('div', 'screen-page-label bp-chrome-world-label', layout.pageLabel.text);
      label.style.left = `${layout.pageLabel.x}px`;
      label.style.top = `${layout.pageLabel.y}px`;
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
    fit: () => controller.fitTo([...root.querySelectorAll<HTMLElement>('.frame-slot')])
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
  const frameHeight = frameExtentHeight(preset);
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
  const fallbackHeight = frameExtentHeight(preset);
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
  mountDeviceChrome(frame, bundle, screen, preset, rendered.element);
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
      state: selection.state,
      framePreset: preset
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
  pageLabel?: { text: string; x: number; y: number };
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
  pageFilter?: string
): ScreenFrameLayout[] {
  const startX = 90;
  const startY = 160;
  const gapX = 80;
  const gapY = 120;

  // Screens group by declared page; a page filter narrows the board to one page.
  // Within a page, each top-level route gets its own row in first-seen order; the
  // frame chip names the route.
  const groups = new Map<string | undefined, ScreenDefinition[]>();
  for (const screen of bundle.screens.screens) {
    const key = screen.page;
    if (pageFilter !== undefined && key !== pageFilter) {
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)?.push(screen);
  }

  const layouts: ScreenFrameLayout[] = [];
  let y = startY;
  // Page labels only earn their place when several pages share one canvas
  // (deep-link boards); on a single page the sub-navigation already names it.
  const showPageLabels = groups.size > 1;
  for (const [pageId, screens] of groups) {
    const rows = new Map<string, ScreenDefinition[]>();
    for (const screen of screens) {
      const key = routeGroupOf(screen);
      if (!rows.has(key)) {
        rows.set(key, []);
      }
      rows.get(key)?.push(screen);
    }
    let pageLabeled = !showPageLabels;
    for (const rowScreens of rows.values()) {
      let x = startX;
      let rowHeight = 0;
      for (const screen of rowScreens) {
        for (const resolved of resolveScreenFrameVariants(bundle, screen, request)) {
          const layout: ScreenFrameLayout = { screen, preset: resolved.preset, x, y, ...resolved.prototype };
          if (!pageLabeled && pageId !== undefined) {
            const text = bundle.screens.pages?.find(page => page.id === pageId)?.name ?? pageId;
            layout.pageLabel = { text, x: startX, y: y - 70 };
            pageLabeled = true;
          }
          layouts.push(layout);
          x += resolved.preset.width + gapX;
          rowHeight = Math.max(rowHeight, frameExtentHeight(resolved.preset));
        }
      }
      y += rowHeight + gapY;
    }
  }

  return layouts;
}

// Phones add their bezel around the preset-sized display; browsers add a
// toolbar above the preset-sized viewport.
function frameExtentHeight(preset: FramePreset): number {
  return preset.height + (preset.type === 'mobile' ? 2 * PHONE_BEZEL : BROWSER_BAR_HEIGHT);
}

const PHONE_BEZEL = 11;
const BROWSER_BAR_HEIGHT = 48;

function resolveScreenFrameVariants(
  bundle: BlueprintProjectBundle,
  screen: ScreenDefinition,
  request: PrototypeReviewSelectionRequest
): Array<{
  preset: FramePreset;
  prototype: { prototypeSelection?: SelectedPrototypeReviewCondition; selectionError?: string };
}> {
  // An explicit state/viewport request (capture, deep link) keeps single-frame selection.
  if (request.state || request.viewport) {
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
  mountDeviceChrome(frame, bundle, screen, preset, screenEl);
  slot.append(head, frame);
  return slot;
}

/**
 * Phones render the full-bleed screen at preset size with the status bar and
 * home indicator overlaid, as on device; browsers keep their toolbar outside
 * the viewport because web content never renders beneath it.
 */
function mountDeviceChrome(
  frame: HTMLElement,
  bundle: BlueprintProjectBundle,
  screen: ScreenDefinition,
  preset: FramePreset,
  screenEl: HTMLElement
): void {
  frame.classList.add('frame-device');
  if (preset.type === 'mobile') {
    frame.dataset.appearance = backgroundAppearance(bundle);
    const display = el('div', 'frame-display');
    display.append(screenEl, createStatusBar(), createHomeIndicator());
    frame.append(display);
  } else {
    frame.append(createBrowserBar(screen), screenEl);
  }
}

function refreshSurround(): void {
  const root = document.documentElement;
  root.dataset.surround = backgroundAppearance(project);
  for (const property of CHROME_THEME_PROPERTIES) root.style.removeProperty(property);
  const { colors, shape } = chromeThemeFromTokens(project);
  root.dataset.chromeTheme = colors ? 'app' : 'neutral';
  for (const [property, value] of Object.entries({ ...colors, ...shape })) root.style.setProperty(property, value);
  installProjectFonts(project);
}

function chromeThemeFromTokens(bundle: BlueprintProjectBundle): { colors?: Record<string, string>; shape: Record<string, string> } {
  const tokenIndex = createTokenIndex(bundle);
  const color = (role: string): { value: string; rgb: [number, number, number] } | undefined => {
    const value = resolvedColor(tokenIndex, `--app-color-${role}`);
    const rgb = value ? parseOpaqueColor(value) : undefined;
    return value && rgb ? { value, rgb } : undefined;
  };
  const tokenValue = (styleRef: string): string | undefined => {
    const record = tokenIndex.byStyleRef.get(styleRef);
    return record ? resolveTokenReferences(tokenIndex, record.token.value) : undefined;
  };

  const shape: Record<string, string> = {};
  const radius = singleLength(tokenValue('--app-radius-md') ?? '');
  const radiusSmall = singleLength(tokenValue('--app-radius-sm') ?? '');
  if (radius !== undefined) shape['--bp-chrome-radius'] = `${Math.min(12, Math.max(0, radius))}px`;
  if (radiusSmall !== undefined) shape['--bp-chrome-radius-sm'] = `${Math.min(8, Math.max(0, radiusSmall))}px`;
  const sans = tokenValue('--app-font-sans');
  const display = tokenValue('--app-font-display');
  const mono = tokenValue('--app-font-mono');
  if (sans) shape['--bp-chrome-font'] = sans;
  if (display ?? sans) shape['--bp-chrome-font-display'] = display ?? sans ?? '';
  if (mono) shape['--bp-chrome-font-mono'] = mono;

  const background = color('background');
  const surface = color('surface') ?? background;
  const foreground = color('foreground');
  if (!background || !surface || !foreground) return { shape };
  if (contrastRatio(foreground.rgb, background.rgb) < 4.5 || contrastRatio(foreground.rgb, surface.rgb) < 4.5) return { shape };

  const fg = foreground.value;
  const mix = (amount: number, base = 'transparent'): string => `color-mix(in srgb, ${fg} ${amount}%, ${base})`;
  const muted = color('muted');
  const border = color('border');
  const borderStrong = color('border-strong');
  const primary = color('primary');
  const focus = color('focus-ring');
  return {
    shape,
    colors: {
      '--bp-chrome-canvas-bg': background.value,
      '--bp-chrome-surface': surface.value,
      '--bp-chrome-fg': fg,
      '--bp-chrome-muted-fg': muted && contrastRatio(muted.rgb, surface.rgb) >= 3 ? muted.value : mix(62, surface.value),
      '--bp-chrome-border': border?.value ?? mix(12),
      '--bp-chrome-border-strong': borderStrong?.value ?? mix(24),
      '--bp-chrome-surface-hover': mix(5),
      '--bp-chrome-surface-active': mix(9),
      '--bp-chrome-accent': primary?.value ?? fg,
      '--bp-chrome-accent-soft': primary ? `color-mix(in srgb, ${primary.value} 14%, ${surface.value})` : mix(9),
      '--bp-chrome-primary': fg,
      '--bp-chrome-primary-fg': surface.value,
      '--bp-chrome-focus': focus && contrastRatio(focus.rgb, background.rgb) >= 3 ? focus.value : fg,
      '--bp-chrome-grid-line': mix(2.5),
      '--bp-chrome-grid-line-major': mix(4.5)
    }
  };
}

function installProjectFonts(bundle: BlueprintProjectBundle): void {
  let style = document.getElementById('bp-project-fonts');
  if (!style) {
    style = document.createElement('style');
    style.id = 'bp-project-fonts';
    document.head.append(style);
  }
  const rules = new Set<string>();
  for (const [sourceRef, css] of Object.entries(bundle.prototypeSourceContents)) {
    if (!sourceRef.endsWith('.css')) continue;
    for (const match of css.matchAll(/@font-face\s*\{[^{}]*\}/g)) {
      const rule = inlineFontFaceUrls(bundle, sourceRef, match[0]);
      if (rule) rules.add(rule);
    }
  }
  style.textContent = [...rules].join('\n');
}

function inlineFontFaceUrls(bundle: BlueprintProjectBundle, sourceRef: string, rule: string): string | undefined {
  let resolved = true;
  const inlined = rule.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_match, _quote: string, value: string) => {
    const assetRef = decodeURIComponent(new URL(value.trim(), `https://sidecar.invalid/${sourceRef}`).pathname.slice(1));
    const asset = bundle.prototypeAssetContents[assetRef];
    if (!asset) {
      resolved = false;
      return 'none';
    }
    return `url("data:${asset.mediaType};base64,${asset.base64}")`;
  });
  return resolved ? inlined : undefined;
}

function backgroundAppearance(bundle: BlueprintProjectBundle): 'light' | 'dark' {
  const background = findTokenValue(bundle, ['background']);
  const rgb = background ? parseOpaqueColor(background) : undefined;
  return rgb && relativeLuminance(rgb) < 0.4 ? 'dark' : 'light';
}

function liveFrameKey(
  screenId: string,
  framePresetId: string,
  selection?: SelectedPrototypeReviewCondition
): string {
  return [screenId, framePresetId, selection?.state ?? '', selection?.conditionId ?? ''].join('\u0000');
}

function createHomeIndicator(): HTMLElement {
  const indicator = el('div', 'home-indicator');
  indicator.setAttribute('aria-hidden', 'true');
  return indicator;
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
      state: selection.state,
      framePreset: preset
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

function createStatusBar(): HTMLElement {
  const status = el('div', 'status-bar');
  status.setAttribute('aria-hidden', 'true');
  const icons = el('span', 'status-icons');
  icons.innerHTML = `${signalIcon()}${wifiIcon()}${batteryIcon()}`;
  status.append(el('span', 'status-time', '9:41'), el('span', 'status-island'), icons);
  return status;
}

function signalIcon(): string {
  return '<svg width="19" height="12" viewBox="0 0 19 12" fill="currentColor" aria-hidden="true"><rect x="0" y="7.5" width="3.2" height="4.5" rx="1"/><rect x="5.2" y="5.2" width="3.2" height="6.8" rx="1"/><rect x="10.4" y="2.6" width="3.2" height="9.4" rx="1"/><rect x="15.6" y="0" width="3.2" height="12" rx="1"/></svg>';
}

function wifiIcon(): string {
  return '<svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor" aria-hidden="true"><path d="M8.5 2.3c2.4 0 4.6.9 6.3 2.5l1.2-1.2A10.6 10.6 0 0 0 8.5.6 10.6 10.6 0 0 0 1 3.6l1.2 1.2a9 9 0 0 1 6.3-2.5Z"/><path d="M8.5 5.8c1.5 0 2.8.5 3.8 1.5l1.2-1.2a7 7 0 0 0-10 0l1.2 1.2c1-1 2.3-1.5 3.8-1.5Z"/><path d="M8.5 9.3c.6 0 1.1.2 1.5.6L8.5 11.4 7 9.9c.4-.4.9-.6 1.5-.6Z"/></svg>';
}

function batteryIcon(): string {
  return '<svg width="27" height="13" viewBox="0 0 27 13" fill="none" aria-hidden="true"><rect x="0.5" y="0.5" width="24" height="12" rx="3.8" stroke="currentColor" stroke-opacity="0.35"/><rect x="2" y="2" width="21" height="9" rx="2.5" fill="currentColor"/><path d="M26 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="currentColor" fill-opacity="0.4"/></svg>';
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
      flashCaptureButton(options.shot, 'done', 'Copied');
    } catch {
      const blob = await blobPromise.catch(() => null);
      if (blob) {
        downloadBlob(blob, options.screenId);
        flashCaptureButton(options.shot, 'done', 'Saved');
      } else {
        flashCaptureButton(options.shot, 'fail', 'Failed');
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
    flashCaptureButton(options.save, blob ? 'done' : 'fail', blob ? 'Saved' : 'Failed');
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

const captureButtonResets = new WeakMap<HTMLButtonElement, () => void>();

function flashCaptureButton(button: HTMLButtonElement, result: 'done' | 'fail', label: string): void {
  captureButtonResets.get(button)?.();
  const icon = button.innerHTML;
  const title = button.getAttribute('aria-label') ?? '';
  button.classList.remove('busy');
  button.classList.add(result);
  button.innerHTML = `${result === 'done' ? checkIcon() : failIcon()}<span class="bp-chrome-frame-tool-label" role="status">${label}</span>`;
  button.setAttribute('aria-label', label);
  const reset = (): void => {
    window.clearTimeout(timer);
    captureButtonResets.delete(button);
    button.classList.remove(result);
    button.innerHTML = icon;
    button.setAttribute('aria-label', title);
  };
  const timer = window.setTimeout(reset, 1600);
  captureButtonResets.set(button, reset);
}

function checkIcon(): string {
  return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
}

function failIcon(): string {
  return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
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
  const preservedView = activeBoardId && boardConfigs[activeBoardId].surface === 'canvas' ? canvas.snapshot() : undefined;
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
  refreshSurround();
  screenPages = declaredScreenPages(project);
  if (!activeScreenPage || !hasScreenPage(activeScreenPage)) {
    activeScreenPage = requestedScreenPage() ?? screenPages[0]?.id ?? null;
  }
  refreshBoardSwitcher();
  refreshItemNav();

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
    changedPath === 'brand.json' ||
    changedPath.startsWith('brand/') ||
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
  const pageFilter = request.state || request.viewport ? undefined : (activeScreenPage ?? undefined);
  const layouts = layoutScreenFrames(project, request, pageFilter).filter(layout => affected.has(layout.screen.id));
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
      changedPath === 'brand.json' || changedPath.startsWith('brand/') ||
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
    const section = documentSectionForKind(primary.kind);
    const requestedBoard = primary.kind === 'board' && isBoardId(primary.localId) ? primary.localId : primary.board;
    if (section) {
      const itemId = primary.kind === 'state-set' ? primary.localId.split('/')[0] : primary.localId;
      if (activeBoardId !== 'primitives' || activeSection !== section || activeItem(project, section)?.id !== itemId) {
        openDocumentItem(section, itemId);
      }
    } else if (requestedBoard && activeBoardId !== requestedBoard) {
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

function documentSectionForKind(kind: BoundaryKind): DocumentSectionId | undefined {
  if (kind === 'token-group') return 'foundations';
  if (kind === 'primitive' || kind === 'state-set') return 'primitives';
  if (kind === 'component') return 'components';
  return undefined;
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
  refreshItemNav();
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
    refreshSurround();
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

const requestedScreen = project.screens.screens.find(screen => screen.id === new URLSearchParams(location.search).get('screen'));
activeScreenPage = requestedScreenPage()
  ?? (requestedScreen?.page && hasScreenPage(requestedScreen.page) ? requestedScreen.page : null)
  ?? screenPages[0]?.id
  ?? null;
refreshBoardSwitcher();

const requestedBoard = new URLSearchParams(location.search).get('board');
const defaultBoard = isBoardId(project.manifest.defaultBoardId) ? project.manifest.defaultBoardId : 'primitives';
showBoard(isBoardId(requestedBoard) ? requestedBoard : defaultBoard);
focusRequestedScreen(requestedScreen?.id);
connectBlueprintLiveRuntime();

function focusRequestedScreen(screenId: string | undefined): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('screen')) return;
  url.searchParams.delete('screen');
  history.replaceState(null, '', url);
  if (screenId && activeBoardId === 'screens') {
    revealNavGroup(`screens:${activeScreenPage}`);
    requestAnimationFrame(() => focusScreenFrames(screenId));
  }
}

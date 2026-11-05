import { screenFrameLabel } from '../core/screen-naming';
import type { ScreenDefinition } from '../core/types';
import { discardBoard, remountBoard, showBoard } from './boards';
import {
  activeBoardId,
  activeScreenPage,
  boardState,
  focusedReviewIsRequested,
  hasScreenPage,
  isVisibleBoard,
  latestChanges,
  project,
  requestedExplorationId,
  screenPages,
  setActiveScreenPage
} from './canvas-state';
import { canvas, closeOverlaySubnav, itemNav, projectMark, projectName, sectionTitle, switcher } from './chrome';
import { el } from './dom';
import {
  DOCUMENT_SECTIONS,
  type DocumentSectionId,
  SECTION_LABELS,
  type SectionId,
  type SectionItem,
  activeItem,
  activeItemBySection,
  activeSection,
  sectionItems,
  setActiveSection
} from './sections';

const NAV_COLLAPSED_STORAGE_KEY = 'blueprint.nav.collapsed';

let collapsedNavGroups: Set<string>;

export function loadCollapsedNavGroups(): void {
  collapsedNavGroups = readCollapsedNavGroups();
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

export function refreshBoardSwitcher(): void {
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

export function refreshItemNav(): void {
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

export function refreshNavigationState(): void {
  const section = currentSection();
  switcher.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.section === section));
  });
  refreshItemNav();
}

function setScreenPage(pageId: string, focusScreenId?: string): void {
  setActiveScreenPage(pageId);
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

export function openDocumentItem(section: DocumentSectionId, itemId: string | undefined): void {
  setActiveSection(section);
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

export function stepDocumentItem(offset: number): void {
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

export function exitFocusedReview(): void {
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
    setActiveScreenPage(targetPage);
    url.searchParams.set('page', targetPage);
  } else {
    setActiveScreenPage(screenPages[0]?.id ?? null);
    url.searchParams.delete('page');
  }
  history.replaceState(null, '', url);
  remountBoard('screens');
}

export function openExploration(explorationId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('board', 'screens');
  url.searchParams.set('exploration', explorationId);
  url.searchParams.delete('history');
  url.searchParams.delete('state');
  url.searchParams.delete('viewport');
  history.replaceState(null, '', url);
  remountBoard('screens');
}

export function openHistory(screenId: string, state: string, framePresetId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('board', 'screens');
  url.searchParams.set('history', screenId);
  url.searchParams.set('state', state);
  url.searchParams.set('viewport', framePresetId);
  url.searchParams.delete('exploration');
  history.replaceState(null, '', url);
  remountBoard('screens');
}

export function focusRequestedScreen(screenId: string | undefined): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('screen')) return;
  url.searchParams.delete('screen');
  history.replaceState(null, '', url);
  if (screenId && activeBoardId === 'screens') {
    revealNavGroup(`screens:${activeScreenPage}`);
    requestAnimationFrame(() => focusScreenFrames(screenId));
  }
}

import { type CanvasController, createCanvasController } from './canvas-controller';
import { el } from './dom';

const SUBNAV_STORAGE_KEY = 'blueprint.subnav';

let shell: HTMLElement;
let subnav: HTMLElement;
let subnavToggle: HTMLButtonElement;
let narrowViewport: MediaQueryList;

export let projectMark: HTMLElement;
export let switcher: HTMLElement;
export let projectName: HTMLElement;
export let sectionTitle: HTMLElement;
export let itemNav: HTMLElement;
export let explorationNavigator: HTMLElement;
export let explorationTitle: HTMLElement;
export let viewport: HTMLElement;
export let world: HTMLElement;
export let documentView: HTMLElement;
export let stage: HTMLElement;
export let canvas: CanvasController;

export function createChrome(app: HTMLElement, exitFocusedReview: () => void): void {
  shell = el('div');
  shell.id = 'app-shell';
  shell.className = 'bp-chrome-shell';

  const rail = el('aside', 'bp-chrome-rail');
  projectMark = el('span', 'bp-chrome-project-mark');
  projectMark.setAttribute('aria-hidden', 'true');
  switcher = el('nav', 'board-switcher bp-chrome-board-switcher');
  switcher.setAttribute('aria-label', 'Blueprint sections');
  subnavToggle = el('button', 'bp-chrome-subnav-toggle') as HTMLButtonElement;
  subnavToggle.type = 'button';
  subnavToggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>';
  subnavToggle.addEventListener('click', () => setSubnavCollapsed(shell.dataset.subnav !== 'collapsed'));
  rail.append(projectMark, switcher, subnavToggle);

  subnav = el('aside', 'bp-chrome-subnav');
  const subnavHead = el('header', 'bp-chrome-subnav-head');
  projectName = el('span', 'bp-chrome-project-name');
  sectionTitle = el('h2', 'bp-chrome-section-title');
  subnavHead.append(projectName, sectionTitle);
  itemNav = el('nav', 'bp-chrome-item-nav');
  itemNav.setAttribute('aria-label', 'Section items');

  subnav.append(subnavHead, itemNav);
  narrowViewport = window.matchMedia('(max-width: 700px)');
  setSubnavCollapsed(narrowViewport.matches || readStoredSubnavCollapsed(), false);

  explorationNavigator = el('nav', 'bp-chrome-exploration-nav');
  explorationNavigator.setAttribute('aria-label', 'Exploration navigation');
  explorationNavigator.hidden = true;
  const explorationBackButton = el('button', 'bp-chrome-exploration-back', '← Screens') as HTMLButtonElement;
  explorationBackButton.type = 'button';
  explorationBackButton.addEventListener('click', exitFocusedReview);
  explorationTitle = el('span', 'bp-chrome-exploration-title');
  explorationNavigator.append(explorationBackButton, explorationTitle);

  viewport = el('main');
  viewport.id = 'viewport';
  viewport.className = 'bp-chrome-viewport';
  viewport.setAttribute('aria-label', 'Blueprint canvas');

  world = el('div');
  world.id = 'world';
  viewport.append(world);

  documentView = el('main', 'bp-chrome-document');
  documentView.id = 'document';
  documentView.setAttribute('aria-label', 'Blueprint pages');
  documentView.hidden = true;

  stage = el('div', 'bp-chrome-stage');
  stage.append(explorationNavigator, viewport, documentView);
  shell.append(rail, subnav, stage);
  app.append(shell);

  canvas = createCanvasController({
    viewport,
    world,
    minScale: 0.08,
    fallbackWidth: 320,
    fallbackHeight: 260
  });
  const chromeScaleStyle = document.head.appendChild(document.createElement('style'));
  let chromeScale = Number.NaN;
  // Setting the scale on the world would restyle every frame on each zoom step, so only the heads that read it get it.
  canvas.onViewSettled(view => {
    if (view.s === chromeScale) return;
    chromeScale = view.s;
    chromeScaleStyle.textContent = `.bp-chrome-frame-head, .bp-chrome-world-label { --bp-chrome-canvas-scale: ${view.s}; }`;
  });
}

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

export function closeOverlaySubnav(): void {
  if (narrowViewport.matches) setSubnavCollapsed(true);
}

function readStoredSubnavCollapsed(): boolean {
  try {
    return localStorage.getItem(SUBNAV_STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

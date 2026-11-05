import { type BlueprintAgentActivityFocus, activityFocusForBoundary, boundaryDisplayName } from '../core/activity';
import type { CanvasProjectBundle } from '../core/types';
import { setAgentStatus } from './agent-focus';
import { replaceMountedBoard } from './boards';
import {
  activeBoardId,
  boardState,
  changeBaseline,
  latestChanges,
  project,
  projectApplyQueue,
  setChangeBaseline,
  setLatestChanges,
  setProject,
  setProjectApplyQueue
} from './canvas-state';
import { el, errorMessage } from './dom';
import { createFrameOverlay, resetFrameOverlay, showFrameOverlay } from './frame-overlay';
import { prototypeHostsUsingBoundary } from './frame-uses';
import { refreshItemNav } from './navigation';
import { refreshSurround } from './surround';

export const changeOverlay = createFrameOverlay('bp-chrome-change-layer', 'bp-chrome-change-box', 'changeBoundaryIds');

export let viewingChangeBaseline = false;

let liveProjectDuringBaselineView: CanvasProjectBundle | undefined;
let changeBar: HTMLElement;
let changeLabel: HTMLElement;
let changeToggle: HTMLButtonElement;

export function createChangeBar(): HTMLElement {
  changeBar = el('div', 'bp-chrome-changes');
  changeBar.hidden = true;
  changeBar.setAttribute('role', 'group');
  changeBar.setAttribute('aria-label', 'Latest changes');
  changeLabel = el('span', 'bp-chrome-changes-label');
  changeToggle = el('button', 'bp-chrome-changes-toggle', 'Before') as HTMLButtonElement;
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
  return changeBar;
}

export function narrowScreenChangesToSections(
  previous: CanvasProjectBundle,
  next: CanvasProjectBundle,
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

export function renderChangeAnnotations(): void {
  resetFrameOverlay(changeOverlay);
  refreshItemNav();
  for (const element of document.querySelectorAll('.bp-chrome-changed')) element.classList.remove('bp-chrome-changed');
  renderChangeBar();
  const root = activeBoardId ? boardState.get(activeBoardId)?.root : undefined;
  if (!root || latestChanges.length === 0) return;
  const frameChanges = new Map<HTMLElement, Set<string>>();
  for (const change of latestChanges) {
    const hosts = activeBoardId === 'screens' && (change.kind === 'primitive' || change.kind === 'component' || change.kind === 'section')
      ? prototypeHostsUsingBoundary(root, change)
      : [];
    for (const host of hosts) frameChanges.set(host, new Set([...frameChanges.get(host) ?? [], change.boundaryId]));
    if (hosts.length > 0) continue;
    for (const element of root.querySelectorAll<HTMLElement>('[data-boundary-id]')) {
      if (element.dataset.boundaryId === change.boundaryId) element.classList.add('bp-chrome-changed');
    }
  }
  for (const [host, boundaryIds] of frameChanges) showFrameOverlay(changeOverlay, host, boundaryIds);
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
  setProjectApplyQueue(projectApplyQueue.then(async () => {
    if (show === viewingChangeBaseline || !changeBaseline || latestChanges.length === 0) return;
    if (show) {
      liveProjectDuringBaselineView = project;
      setProject(changeBaseline.bundle);
      viewingChangeBaseline = true;
    } else {
      setProject(exitChangeBaselineView());
    }
    refreshSurround();
    await Promise.all([...boardState.keys()].map(id => replaceMountedBoard(id)));
    renderChangeBar();
  }).catch(error => {
    setAgentStatus('waiting', errorMessage(error));
  }));
}

export function exitChangeBaselineView(): CanvasProjectBundle {
  const liveProject = liveProjectDuringBaselineView ?? project;
  liveProjectDuringBaselineView = undefined;
  viewingChangeBaseline = false;
  return liveProject;
}

function dismissChanges(): void {
  if (viewingChangeBaseline) queueChangeBaselineView(false);
  setProjectApplyQueue(projectApplyQueue.then(() => {
    setChangeBaseline(undefined);
    setLatestChanges([]);
    renderChangeAnnotations();
  }, () => undefined));
}

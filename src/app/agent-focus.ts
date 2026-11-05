import type { BlueprintAgentActivityEvent, BlueprintAgentActivityFocus } from '../core/activity';
import { boundaryId } from '../core/address';
import { activeBoardId, boardState, project } from './canvas-state';
import { el, findBoundaryElement } from './dom';
import { createFrameOverlay, resetFrameOverlay, showFrameOverlay } from './frame-overlay';
import { prototypeHostsUsingBoundary } from './frame-uses';

let focusedActivityElements: HTMLElement[] = [];

const inFlightToolFocuses = new Map<string, { focuses: BlueprintAgentActivityFocus[]; startedAt: string }>();

export const announcedRevisions: string[] = [];

let pendingProjectApplies = 0;

let projectErrorActive = false;

let completionRevision: string | undefined;

let completionDwellUntil = 0;

export let changedBoundaryFocuses: BlueprintAgentActivityFocus[] = [];

export let activeActivityKey: string | undefined;

export let activityClearTimer: number | undefined;

export let lastAgentActivity: BlueprintAgentActivityEvent | undefined;

type AgentStatusState = 'working' | 'thinking' | 'applying' | 'complete' | 'waiting' | 'failed';

let agentStatus: HTMLElement;
let agentStatusLabel: HTMLElement;

export function createAgentStatus(): HTMLElement {
  agentStatus = el('div', 'bp-chrome-agent-status');
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
  agentStatusLabel = el('span', 'bp-chrome-agent-status-label');
  agentStatus.append(agentStatusMark, agentStatusLabel);
  return agentStatus;
}

export function addPendingProjectApplies(change: number): void {
  pendingProjectApplies += change;
}

export function setProjectErrorActive(active: boolean): void {
  projectErrorActive = active;
}

export function setChangedBoundaryFocuses(focuses: BlueprintAgentActivityFocus[]): void {
  changedBoundaryFocuses = focuses;
}

export function setAgentStatus(state: AgentStatusState, label: string): void {
  agentStatus.hidden = false;
  agentStatus.dataset.phase = state;
  agentStatusLabel.textContent = label;
}

export function showAgentActivity(event: BlueprintAgentActivityEvent): void {
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

export function checkAgentCompletion(): void {
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

export function uniqueAgentFocuses(focuses: BlueprintAgentActivityFocus[]): BlueprintAgentActivityFocus[] {
  return [...new Map(focuses.map(focus => [focus.boundaryId, focus] as const)).values()];
}

export function renderAgentFocus(): void {
  clearAgentFocus();
  const focuses = currentAgentFocuses();
  if (focuses.length === 0) return;
  const label = lastAgentActivity?.label ?? 'Changes are live';
  const visibleRoot = activeBoardId ? boardState.get(activeBoardId)?.root : undefined;
  const frameFocus = new Map<HTMLElement, Set<string>>();
  const canvasFocuses: BlueprintAgentActivityFocus[] = [];
  for (const focus of focuses) {
    const consumers = visibleRoot && activeBoardId === 'screens' &&
      (focus.kind === 'primitive' || focus.kind === 'component' || focus.kind === 'section')
      ? prototypeHostsUsingBoundary(visibleRoot, focus)
      : [];
    if (consumers.length === 0) canvasFocuses.push(focus);
    for (const host of consumers) frameFocus.set(host, new Set([...frameFocus.get(host) ?? [], focus.boundaryId]));
  }

  for (const [host, boundaryIds] of frameFocus) {
    showFrameOverlay(agentFocusOverlay, host, boundaryIds);
    const context = host.closest<HTMLElement>('.frame');
    if (context && !focusedActivityElements.includes(context)) {
      context.classList.add('bp-chrome-agent-focus-context');
      context.dataset.agentActivityLabel = label;
      focusedActivityElements.push(context);
    }
  }
  if (canvasFocuses.length > 0) renderCanvasAgentFocus(canvasFocuses, label);
  setFocusedActivityFailed(lastAgentActivity?.phase === 'failed');
}

function renderCanvasAgentFocus(canvasFocuses: BlueprintAgentActivityFocus[], label: string): void {
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
  resetFrameOverlay(agentFocusOverlay);
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

export const agentFocusOverlay = createFrameOverlay('bp-chrome-agent-frame-focus', 'bp-chrome-agent-frame-focus-box', 'focusBoundaryIds', layer => {
  layer.classList.toggle('bp-chrome-agent-focus-failed', lastAgentActivity?.phase === 'failed');
});

function setFocusedActivityFailed(failed: boolean): void {
  for (const element of focusedActivityElements) element.classList.toggle('bp-chrome-agent-focus-failed', failed);
  for (const layer of document.querySelectorAll('.bp-chrome-agent-frame-focus')) {
    layer.classList.toggle('bp-chrome-agent-focus-failed', failed);
  }
}

export function markFocusedBoundaryBusy(busy: boolean): void {
  for (const element of focusedActivityElements) element.setAttribute('aria-busy', String(busy));
}

export function restoreAgentStatusAfterApply(): void {
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

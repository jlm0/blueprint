import {
  type BlueprintAgentActivityEvent,
  type BlueprintOutdatedFile,
  type BlueprintProjectChangedEvent,
  type BlueprintProjectErrorEvent,
  activityFocusesForChangedPaths
} from '../core/activity';
import { createConfiguredProjectBundle } from '../core/bundle';
import { changedBoundaries } from '../core/change';
import { BLUEPRINT_SCHEMA_VERSION } from '../core/schema-version';
import {
  activeActivityKey,
  activityClearTimer,
  addPendingProjectApplies,
  announcedRevisions,
  changedBoundaryFocuses,
  checkAgentCompletion,
  lastAgentActivity,
  markFocusedBoundaryBusy,
  renderAgentFocus,
  restoreAgentStatusAfterApply,
  setAgentStatus,
  setChangedBoundaryFocuses,
  setProjectErrorActive,
  showAgentActivity,
  uniqueAgentFocuses
} from './agent-focus';
import { boardConfigs, replaceMountedBoard } from './boards';
import {
  activeBoardId,
  activeScreenPage,
  boardState,
  changeBaseline,
  declaredScreenPages,
  hasScreenPage,
  project,
  projectApplyQueue,
  requestedScreenPage,
  screenPages,
  setActiveScreenPage,
  setChangeBaseline,
  setLatestChanges,
  setProject,
  setProjectApplyQueue,
  setScreenPages
} from './canvas-state';
import {
  exitChangeBaselineView,
  narrowScreenChangesToSections,
  renderChangeAnnotations,
  beginChangeMarksApply,
  endChangeMarksApply,
  viewingChangeBaseline
} from './change-annotations';
import { canvas } from './chrome';
import { el, errorMessage } from './dom';
import { keepFrameOutputSnapshots } from './frame-output-client';
import { reconcileScreenFrames } from './frame-reconcile';
import { refreshBoardSwitcher, refreshItemNav } from './navigation';
import { type LiveProjectSnapshot, fetchLiveProjectSnapshot } from './project-snapshot';
import { refreshSurround } from './surround';

let lastAppliedRevision: string | undefined;

let liveSnapshot: LiveProjectSnapshot | undefined;

export function loadServedLiveSnapshot(): void {
  liveSnapshot = servedLiveSnapshot();
}

let migrateNoticeBody: HTMLElement;
let migrateNotice: HTMLElement;

export function createMigrateNotice(): HTMLElement {
  migrateNotice = el('div', 'bp-chrome-migrate-notice');
  migrateNotice.hidden = true;
  migrateNotice.setAttribute('role', 'alert');
  migrateNoticeBody = el('p', 'bp-chrome-migrate-notice-body');
  migrateNotice.append(el('strong', 'bp-chrome-migrate-notice-title', 'This sidecar needs migrate'), migrateNoticeBody);
  return migrateNotice;
}

export function showMigrateNotice(outdatedFiles: readonly BlueprintOutdatedFile[]): void {
  migrateNotice.hidden = outdatedFiles.length === 0;
  const files = outdatedFiles.map(outdated => outdated.file);
  const named = files.length > 1 ? `${files.slice(0, -1).join(', ')} and ${files.at(-1)}` : files.join('');
  migrateNoticeBody.textContent = `Blueprint now reads schema ${BLUEPRINT_SCHEMA_VERSION}, and ${named} ${files.length > 1 ? 'use' : 'uses'} an older schema. ` +
    'Ask your agent to run the Blueprint migrate tool on this project. Until then, the canvas shows the last valid version.';
}

function servedLiveSnapshot(): LiveProjectSnapshot | undefined {
  const revision = window.__BLUEPRINT_LIVE_RUNTIME__?.revision;
  const bundle = window.__BLUEPRINT_PROJECT_BUNDLE__;
  return revision && bundle ? { revision, bundle } : undefined;
}

export function connectBlueprintLiveRuntime(): void {
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
    addPendingProjectApplies(1);
    beginChangeMarksApply();
    if (lastAgentActivity?.phase === 'completed' && activityClearTimer !== undefined) window.clearTimeout(activityClearTimer);
    setProjectApplyQueue(projectApplyQueue
      .then(() => applyProjectChange(event, runtime.snapshotPath))
      .then(() => {
        announcedRevisions.splice(0, announcedRevisions.indexOf(event.revision) + 1);
        setProjectErrorActive(false);
        showMigrateNotice([]);
      })
      .catch(error => {
        setAgentStatus('waiting', errorMessage(error));
      })
      .finally(() => {
        addPendingProjectApplies(-1);
        endChangeMarksApply();
        checkAgentCompletion();
      }));
  });
  source.addEventListener('project-error', message => {
    const event = parseLiveEvent<BlueprintProjectErrorEvent>(message);
    setProjectErrorActive(true);
    if (activityClearTimer !== undefined) window.clearTimeout(activityClearTimer);
    const outdatedFiles = event?.outdatedFiles ?? [];
    showMigrateNotice(outdatedFiles);
    setAgentStatus('waiting', outdatedFiles.length > 0
      ? 'Blueprint is waiting for migrate'
      : event?.message
        ? 'Blueprint is waiting for the current edit to become valid'
        : 'Blueprint could not apply the latest edit');
  });
}

async function applyProjectChange(event: BlueprintProjectChangedEvent, snapshotPath: string): Promise<void> {
  if (event.revision === lastAppliedRevision) return;
  const preservedView = activeBoardId && boardConfigs[activeBoardId].surface === 'canvas' ? canvas.snapshot() : undefined;
  setAgentStatus('applying', 'Blueprint is applying the latest changes');
  markFocusedBoundaryBusy(true);
  const snapshot = await fetchLiveProjectSnapshot(new URL(snapshotPath, window.location.href), event.revision, liveSnapshot);
  liveSnapshot = snapshot;
  if (snapshot.revision === lastAppliedRevision) return;
  const changedPaths = snapshot.revision === event.revision ? event.changedPaths : [];
  const leftChangeBaseline = viewingChangeBaseline;
  if (leftChangeBaseline) setProject(exitChangeBaselineView());
  const advancedPastEvent = snapshot.revision !== event.revision || leftChangeBaseline;

  const previousProject = project;
  const previousProjectId = previousProject.manifest.project.id;
  if (!changeBaseline || changeBaseline.activityKey !== activeActivityKey) {
    setChangeBaseline({ bundle: project, activityKey: activeActivityKey });
  }
  setProject(createConfiguredProjectBundle(snapshot.bundle));
  window.__BLUEPRINT_PROJECT_BUNDLE__ = snapshot.bundle;
  refreshSurround();
  setScreenPages(declaredScreenPages(project));
  if (!activeScreenPage || !hasScreenPage(activeScreenPage)) {
    setActiveScreenPage(requestedScreenPage() ?? screenPages[0]?.id ?? null);
  }
  refreshBoardSwitcher();
  refreshItemNav();

  const updates: Promise<void>[] = [];
  if (boardState.has('primitives') && (advancedPastEvent || pathsAffectPrimitives(changedPaths))) {
    updates.push(replaceMountedBoard('primitives'));
  }
  if (boardState.has('screens')) {
    const reconciled = !advancedPastEvent && previousProjectId === project.manifest.project.id
      ? await reconcileScreenFrames(changedPaths, previousProject)
      : false;
    if (!reconciled) updates.push(replaceMountedBoard('screens'));
  }
  await Promise.all(updates);
  if (activeBoardId) {
    boardState.get(activeBoardId)?.mounted.configure();
    if (preservedView) canvas.setView(preservedView);
  }
  lastAppliedRevision = snapshot.revision;
  setLatestChanges(narrowScreenChangesToSections(changeBaseline!.bundle, project, changedBoundaries(changeBaseline!.bundle, project)));
  renderChangeAnnotations();
  keepFrameOutputSnapshots(new Set([changeBaseline!.bundle, project]));
  const changedFocuses = activityFocusesForChangedPaths(project, changedPaths);
  setChangedBoundaryFocuses(activeActivityKey ? uniqueAgentFocuses([...changedBoundaryFocuses, ...changedFocuses]) : changedFocuses);
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
    changedPath === 'inspo.json' ||
    changedPath.startsWith('inspo/') ||
    changedPath.startsWith('prototype/primitives/') ||
    changedPath.startsWith('prototype/components/')
  ));
}

function parseLiveEvent<T>(message: Event): T | undefined {
  if (!(message instanceof MessageEvent) || typeof message.data !== 'string') return undefined;
  try {
    return JSON.parse(message.data) as T;
  } catch {
    return undefined;
  }
}

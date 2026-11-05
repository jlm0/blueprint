import './styles.css';
import { createAgentStatus } from './agent-focus';
import { createFitButton, showBoard, wireBoards } from './boards';
import { annotateMountedHost, renderCanvasAnnotations } from './canvas-annotations';
import { createSelectionBar, wireCanvasSelection } from './canvas-selection';
import {
  declaredScreenPages,
  hasScreenPage,
  isBoardId,
  project,
  requestedScreenPage,
  screenPages,
  setActiveScreenPage,
  setProject,
  setScreenPages
} from './canvas-state';
import { createChangeBar } from './change-annotations';
import { createChrome, stage } from './chrome';
import { createFindingsPanel } from './design-findings';
import { mountDocumentBoard } from './document-board';
import { loadConfiguredProject } from './fixture-projects';
import { wireFrameHost } from './frame-host';
import {
  connectBlueprintLiveRuntime,
  createMigrateNotice,
  loadServedLiveSnapshot,
  showMigrateNotice
} from './live-runtime';
import {
  exitFocusedReview,
  focusRequestedScreen,
  loadCollapsedNavGroups,
  refreshBoardSwitcher,
  refreshNavigationState
} from './navigation';
import { mountScreens } from './screen-board';
import { restoreRequestedSection } from './sections';
import { refreshSurround } from './surround';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Blueprint app root is missing.');
}

setProject(loadConfiguredProject());
refreshSurround();
loadCollapsedNavGroups();
createChrome(app, exitFocusedReview);
stage.append(
  createFitButton(),
  createAgentStatus(),
  createMigrateNotice(),
  createSelectionBar(),
  createChangeBar(),
  createFindingsPanel()
);

wireBoards({
  configs: {
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
  },
  refreshNavigationState,
  renderCanvasAnnotations
});

setScreenPages(declaredScreenPages(project));
restoreRequestedSection();
loadServedLiveSnapshot();
wireFrameHost(annotateMountedHost);
wireCanvasSelection();

const requestedScreen = project.screens.screens.find(screen => screen.id === new URLSearchParams(location.search).get('screen'));

setActiveScreenPage(requestedScreenPage()
  ?? (requestedScreen?.page && hasScreenPage(requestedScreen.page) ? requestedScreen.page : null)
  ?? screenPages[0]?.id
  ?? null);

refreshBoardSwitcher();

const requestedBoard = new URLSearchParams(location.search).get('board');
const defaultBoard = isBoardId(project.manifest.defaultBoardId) ? project.manifest.defaultBoardId : 'primitives';

showBoard(isBoardId(requestedBoard) ? requestedBoard : defaultBoard);
focusRequestedScreen(requestedScreen?.id);
showMigrateNotice(window.__BLUEPRINT_PROJECT_LOAD_ERROR__?.outdatedFiles ?? []);
connectBlueprintLiveRuntime();

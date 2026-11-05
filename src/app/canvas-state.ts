import type { BlueprintAgentActivityFocus } from '../core/activity';
import type { BoardDefinition, CanvasProjectBundle, DeclaredGroup } from '../core/types';
import type { CanvasController, CanvasView } from './canvas-controller';

export type BoardId = 'primitives' | 'screens';

export interface MountedBoard {
  root: HTMLElement;
  mounted: BoardMount;
  view: CanvasView | null;
  scrollTop?: number;
}

export interface BoardMount {
  configure: () => void;
  fit: () => void;
}

export interface BoardConfig {
  label: string;
  className: string;
  surface: 'canvas' | 'document';
  mount: (context: BoardContext) => BoardMount;
}

export interface BoardContext {
  root: HTMLElement;
  canvas: CanvasController;
  project: CanvasProjectBundle;
}

export let changeBaseline: { bundle: CanvasProjectBundle; activityKey: string | undefined } | undefined;

export function setChangeBaseline(next: { bundle: CanvasProjectBundle; activityKey: string | undefined } | undefined): void {
  changeBaseline = next;
}

export let latestChanges: BlueprintAgentActivityFocus[] = [];

export function setLatestChanges(next: BlueprintAgentActivityFocus[]): void {
  latestChanges = next;
}

export let project: CanvasProjectBundle;

export function setProject(next: CanvasProjectBundle): void {
  project = next;
}

export const boardState = new Map<BoardId, MountedBoard>();

export let activeBoardId: BoardId | null = null;

export function setActiveBoardId(next: BoardId | null): void {
  activeBoardId = next;
}

// Screens board pages: one sub-navigation group per declared page; each page is a
// fresh canvas showing only that page's frames. The first page is the default
// canvas — grouping is intentional, there is no catch-all page.
export let screenPages: DeclaredGroup[];

export function setScreenPages(next: DeclaredGroup[]): void {
  screenPages = next;
}

export let activeScreenPage: string | null = null;

export function setActiveScreenPage(next: string | null): void {
  activeScreenPage = next;
}

export function declaredScreenPages(bundle: CanvasProjectBundle): DeclaredGroup[] {
  return bundle.screens.pages ?? [];
}

export function hasScreenPage(pageId: string): boolean {
  return screenPages.some(page => page.id === pageId);
}

export function requestedScreenPage(): string | null {
  const param = new URLSearchParams(location.search).get('page');
  return param && hasScreenPage(param) ? param : null;
}

function explorationIsRequested(): boolean {
  return new URLSearchParams(location.search).has('exploration');
}

function historyIsRequested(): boolean {
  return new URLSearchParams(location.search).has('history');
}

export function focusedReviewIsRequested(): boolean {
  return explorationIsRequested() || historyIsRequested();
}

export function requestedExplorationId(): string {
  return new URLSearchParams(location.search).get('exploration') ?? '';
}

export let projectApplyQueue = Promise.resolve();

export function setProjectApplyQueue(next: Promise<void>): void {
  projectApplyQueue = next;
}

export function isVisibleBoard(board: BoardDefinition): board is BoardDefinition & { id: BoardId } {
  return isBoardId(board.id);
}

export function isBoardId(value: unknown): value is BoardId {
  return value === 'primitives' || value === 'screens';
}

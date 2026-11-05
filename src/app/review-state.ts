import { boundaryId } from '../core/address';
import {
  type VisibleBoundaryRecord,
  createCanvasStyleEvidence,
  createReviewManifest,
  validateVisibleBoundaryRecords
} from '../core/review';
import type { BoundaryKind } from '../core/types';
import { type BoardId, boardState, project } from './canvas-state';

export function refreshCanvasReviewState(boardId: BoardId): void {
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

function collectVisibleBoundaryRecords(root: HTMLElement, board: BoardId): VisibleBoundaryRecord[] {
  return [...root.querySelectorAll<HTMLElement>('[data-boundary-id][data-boundary-kind]')].map(element => {
    const computed = window.getComputedStyle(element);
    return {
      id: element.dataset.boundaryId ?? '',
      kind: (element.dataset.boundaryKind ?? 'project') as BoundaryKind,
      board,
      label: element.dataset.boundaryLabel ?? element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '',
      screenId: element.dataset.screenId,
      renderedSnippet: (element.cloneNode(false) as HTMLElement).outerHTML.slice(0, 900),
      computedStyles: {
        backgroundColor: computed.backgroundColor,
        borderColor: computed.borderColor,
        borderRadius: computed.borderRadius,
        color: computed.color
      }
    };
  });
}

export function setBoundary(element: HTMLElement, kind: BoundaryKind, localId: string, projectId: string, label = localId): void {
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

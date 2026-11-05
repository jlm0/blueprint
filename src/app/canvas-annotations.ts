import { agentFocusOverlay } from './agent-focus';
import { canvasSelectionState, renderCanvasSelection, selectionFrameKey } from './canvas-selection';
import { changeOverlay, renderChangeAnnotations } from './change-annotations';
import { drawFrameChangeMarks } from './change-marks';
import { findingOverlay, renderFindingAnnotations } from './design-findings';
import { drawFrameOverlay } from './frame-overlay';

export function annotateMountedHost(host: HTMLElement): void {
  for (const overlay of [findingOverlay, changeOverlay, agentFocusOverlay]) drawFrameOverlay(overlay, host);
  drawFrameChangeMarks(host);
  const state = canvasSelectionState;
  if (
    state?.frameKey !== undefined
    && state.chain[state.index]?.instance !== undefined
    && selectionFrameKey(host) === state.frameKey
    && !host.querySelector(':scope > .bp-chrome-selection-layer')
  ) renderCanvasSelection();
}

export function renderCanvasAnnotations(): void {
  renderCanvasSelection();
  renderChangeAnnotations();
  renderFindingAnnotations();
}

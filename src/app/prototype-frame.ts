import { screenFrameLabel } from '../core/screen-naming';
import type { CanvasProjectBundle } from '../core/types';
import { domSelectionState, setCanvasSelection } from './canvas-selection';
import { designFindings, frameFindingBoundaryIds, openFindingsPanel } from './design-findings';
import { mountDeviceChrome } from './device-chrome';
import { createIconButton, el } from './dom';
import { wireFrameCapture } from './frame-capture';
import { captureScreenFrameDocument, createCanonicalPrototypeScreen, screenFrameDocument } from './frame-host';
import type { FrameMounter } from './frame-mounting';
import { prototypeUsesByHost } from './frame-uses';
import { frameViewBySlot, openFrameViewer } from './frame-viewer';
import { cameraIcon, downloadIcon, expandIcon } from './icons';
import { openExploration, openHistory } from './navigation';
import { setBoundary } from './review-state';
import { type ScreenFrameLayout, liveFrameKey } from './screen-layout';
import { backgroundAppearance } from './surround';
import type { TokenIndex } from './tokens';

export function createPrototypeFrame(
  bundle: CanvasProjectBundle,
  tokenIndex: TokenIndex,
  layout: ScreenFrameLayout,
  mounter: FrameMounter
): HTMLElement {
  const { screen, preset, x, y, prototypeSelection, selectionError } = layout;
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
  const canonicalScreen = createCanonicalPrototypeScreen(bundle, screen, preset, prototypeSelection, selectionError, x, y);
  const screenEl = canonicalScreen.element;
  const screenFrame = canonicalScreen.frame;
  const findingsButton = el('button', 'bp-chrome-frame-findings') as HTMLButtonElement;
  findingsButton.type = 'button';
  findingsButton.title = `Show design findings for ${screen.name}`;
  findingsButton.dataset.findingsScreenId = screen.id;
  let findingBoundaryIds: string[] = [];
  findingsButton.addEventListener('click', () => openFindingsPanel({ title: screen.name, boundaryIds: findingBoundaryIds }));
  let findingsBundle = bundle;
  const showFindings = (usedBoundaryIds: Iterable<string>): void => {
    findingBoundaryIds = frameFindingBoundaryIds(findingsBundle, screen, usedBoundaryIds);
    const findingCount = designFindings(findingsBundle).filter(finding => findingBoundaryIds.includes(finding.boundaryId)).length;
    findingsButton.textContent = findingCount === 1 ? '1 finding' : `${findingCount} findings`;
    if (findingCount === 0) findingsButton.remove();
    else if (!findingsButton.isConnected) head.append(findingsButton);
  };
  showFindings(prototypeUsesByHost.get(screenEl)?.usedBoundaryIds ?? []);
  wireFrameCapture({
    screenEl,
    shot,
    save,
    screenId: screen.id,
    captureDocument: screenFrame ? () => captureScreenFrameDocument(screenFrame) : undefined
  });
  if (screenFrame) {
    frameViewBySlot.set(slot, { bundle, screen, preset, document: () => screenFrameDocument(screenFrame) });
    const view = createIconButton('frame-view bp-chrome-frame-tool bp-chrome-frame-view', 'View screen in full screen', expandIcon());
    view.addEventListener('click', () => openFrameViewer(slot));
    save.after(view);
    screenFrame.onFailed = () => {
      frameViewBySlot.delete(slot);
      view.remove();
      showFindings([]);
      mounter.remove(screenFrame);
    };
    screenFrame.onBundleChanged = next => {
      findingsBundle = next;
      showFindings(prototypeUsesByHost.get(screenEl)?.usedBoundaryIds ?? []);
      if (frame.dataset.appearance) frame.dataset.appearance = backgroundAppearance(next);
    };
  }
  frame.classList.add('frame-canonical');
  mountDeviceChrome(frame, bundle, screen, preset, screenEl);
  slot.append(head, frame);
  if (screenFrame) mounter.add(screenFrame);
  return slot;
}

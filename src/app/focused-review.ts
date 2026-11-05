import { screenFrameLabel } from '../core/screen-naming';
import type {
  CanvasProjectBundle,
  ExplorationDefinition,
  ExplorationPrototypeSource,
  FramePreset,
  SavedScreen,
  ScreenDefinition
} from '../core/types';
import {
  type PrototypeReviewSelectionRequest,
  type SelectedPrototypeReviewCondition,
  selectPrototypeReviewCondition
} from '../prototype/compiler';
import type { CanvasController } from './canvas-controller';
import type { BoardMount } from './canvas-state';
import { explorationTitle } from './chrome';
import { mountDeviceChrome } from './device-chrome';
import { el } from './dom';
import { compileScreenFrame, createCanonicalPrototypeIframe } from './frame-host';
import { declaredFrameUses, prototypeUsesByHost } from './frame-uses';
import { setBoundary } from './review-state';
import { frameExtentHeight } from './screen-layout';

export function mountHistoryScreens(
  root: HTMLElement,
  boardCanvas: CanvasController,
  bundle: CanvasProjectBundle,
  screenId: string,
  request: PrototypeReviewSelectionRequest
): BoardMount {
  root.dataset.canvasMode = 'history';
  root.dataset.screenId = screenId;
  const screen = bundle.screens.screens.find(candidate => candidate.id === screenId);
  if (!screen?.prototype) {
    explorationTitle.textContent = 'History unavailable';
    const unavailable = createFocusedUnavailablePanel(
      'History unavailable',
      'Ask the agent to check this screen history and open it again.'
    );
    root.append(unavailable);
    const configure = (): CanvasController => boardCanvas.configure({
      minScale: 0.15,
      readableScale: 0.55,
      fallbackWidth: 420,
      fallbackHeight: 180
    });
    const controller = configure();
    return { configure, fit: () => controller.fitTo([unavailable]) };
  }

  let selection: SelectedPrototypeReviewCondition;
  let preset: FramePreset | undefined;
  try {
    selection = selectPrototypeReviewCondition(screen, request);
    preset = bundle.manifest.framePresets.find(candidate => candidate.id === selection.framePresetId);
    if (!preset) {
      throw new Error('Missing frame preset.');
    }
  } catch {
    explorationTitle.textContent = `${screenFrameLabel(screen)} · History unavailable`;
    const unavailable = createFocusedUnavailablePanel(
      'History unavailable',
      'This saved screen context is no longer available. Ask the agent to inspect it.'
    );
    root.append(unavailable);
    const configure = (): CanvasController => boardCanvas.configure({
      minScale: 0.15,
      readableScale: 0.55,
      fallbackWidth: 420,
      fallbackHeight: 180
    });
    const controller = configure();
    return { configure, fit: () => controller.fitTo([unavailable]) };
  }

  root.setAttribute('aria-label', `${screen.name} history`);
  explorationTitle.textContent = `${screenFrameLabel(screen)} · History`;
  const frameHeight = frameExtentHeight(preset);
  const configure = (): CanvasController => boardCanvas.configure({
    minScale: 0.08,
    readableScale: 0.12,
    fallbackWidth: preset.width,
    fallbackHeight: frameHeight
  });
  const controller = configure();
  const startX = 90;
  const gapX = 80;
  const rowGap = 170;
  let y = 220;

  const versions = bundle.history.entries
    .filter(entry => (
      entry.screenId === screen.id
        && entry.state === selection.state
        && entry.framePresetId === preset.id
    ))
    .sort((left, right) => right.version - left.version);
  appendHistoryRowLabel(root, 'Versions', startX, y - 56);
  let x = startX;
  root.append(createExplorationPrototypeFrame({
    bundle,
    screen,
    preset,
    selection,
    role: 'current',
    label: 'Current',
    canonicalBoundary: true,
    unavailableNoun: 'Version',
    x,
    y
  }));
  x += preset.width + gapX;
  for (const entry of versions) {
    const versionBundle = createExplorationCompileBundle(bundle, entry.screen, screenPrototypeForComparison(entry.screen));
    const versionScreen = versionBundle.screens.screens[0] ?? entry.screen;
    root.append(createExplorationPrototypeFrame({
      bundle: versionBundle,
      screen: versionScreen,
      preset,
      selection,
      role: 'version',
      historyVersion: entry.version,
      label: `V${entry.version}`,
      canonicalBoundary: false,
      unavailableNoun: 'Version',
      x,
      y
    }));
    x += preset.width + gapX;
  }
  y += frameHeight + rowGap;

  const explorations = bundle.explorations.explorations
    .filter(exploration => (
      exploration.target.screenId === screen.id
        && exploration.target.state === selection.state
        && exploration.target.framePresetId === preset.id
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const exploration of explorations) {
    appendHistoryRowLabel(
      root,
      `${exploration.title} · ${historyLifecycleLabel(exploration.lifecycle)}`,
      startX,
      y - 56
    );
    x = startX;
    const baselineScreen = exploration.target.baseline.screen;
    const baselineBundle = createExplorationCompileBundle(
      bundle,
      baselineScreen,
      exploration.target.baseline.prototype
    );
    root.append(createExplorationPrototypeFrame({
      bundle: baselineBundle,
      screen: baselineBundle.screens.screens[0] ?? baselineScreen,
      preset,
      selection,
      exploration,
      role: 'baseline',
      label: 'Starting point',
      canonicalBoundary: false,
      x,
      y
    }));
    x += preset.width + gapX;
    for (const candidate of exploration.candidates) {
      const candidateBundle = createExplorationCompileBundle(bundle, baselineScreen, candidate.prototype);
      root.append(createExplorationPrototypeFrame({
        bundle: candidateBundle,
        screen: candidateBundle.screens.screens[0] ?? baselineScreen,
        preset,
        selection,
        exploration,
        role: 'candidate',
        candidateId: candidate.id,
        label: candidate.id === exploration.selectedCandidateId ? `${candidate.label} · Chosen` : candidate.label,
        canonicalBoundary: false,
        x,
        y
      }));
      x += preset.width + gapX;
    }
    y += frameHeight + rowGap;
  }

  return {
    configure,
    fit: () => controller.fitTo([...root.querySelectorAll<HTMLElement>('.frame-slot')])
  };
}

function appendHistoryRowLabel(root: HTMLElement, label: string, x: number, y: number): void {
  const rowLabel = el('div', 'bp-chrome-history-row-label', label);
  rowLabel.style.left = `${x}px`;
  rowLabel.style.top = `${y}px`;
  root.append(rowLabel);
}

function historyLifecycleLabel(lifecycle: ExplorationDefinition['lifecycle']): string {
  return lifecycle === 'active' ? 'Active' : lifecycle === 'promoted' ? 'Promoted' : 'Archived';
}

function screenPrototypeForComparison(screen: SavedScreen): ExplorationPrototypeSource {
  if (!screen.prototype) {
    throw new Error(`Screen "${screen.id}" does not retain a prototype source.`);
  }
  return screen.prototype;
}

export function mountExplorationScreens(
  root: HTMLElement,
  boardCanvas: CanvasController,
  bundle: CanvasProjectBundle,
  explorationId: string
): BoardMount {
  root.dataset.canvasMode = 'exploration';
  root.dataset.explorationId = explorationId;
  const exploration = bundle.explorations.explorations.find(candidate => candidate.id === explorationId);
  if (!exploration) {
    explorationTitle.textContent = 'Exploration unavailable';
    root.dataset.explorationStatus = 'unavailable';
    const unavailable = createExplorationUnavailablePanel();
    root.append(unavailable);
    const configure = (): CanvasController =>
      boardCanvas.configure({
        minScale: 0.15,
        readableScale: 0.55,
        fallbackWidth: 420,
        fallbackHeight: 180
      });
    const controller = configure();
    return {
      configure,
      fit: () => controller.fitTo([unavailable])
    };
  }

  const screen = exploration.target.baseline.screen;
  const preset = bundle.manifest.framePresets.find(candidate => candidate.id === exploration.target.framePresetId);
  root.dataset.screenId = screen.id;
  root.setAttribute('aria-label', `${screen.name} exploration`);
  explorationTitle.textContent = `${screenFrameLabel(screen)} · ${exploration.title}`;
  if (!preset || !screen.prototype) {
    root.dataset.explorationStatus = 'unavailable';
    const unavailable = createExplorationUnavailablePanel();
    root.append(unavailable);
    const configure = (): CanvasController =>
      boardCanvas.configure({
        minScale: 0.15,
        readableScale: 0.55,
        fallbackWidth: 420,
        fallbackHeight: 180
      });
    const controller = configure();
    return {
      configure,
      fit: () => controller.fitTo([unavailable])
    };
  }

  const condition = screen.prototype.reviewConditions.find(candidate =>
    candidate.framePresetId === exploration.target.framePresetId && candidate.state === exploration.target.state
  );
  const selection: SelectedPrototypeReviewCondition = {
    conditionId: condition?.id ?? 'exploration-target',
    framePresetId: exploration.target.framePresetId,
    state: exploration.target.state
  };
  const fallbackHeight = frameExtentHeight(preset);
  const configure = (): CanvasController =>
    boardCanvas.configure({
      minScale: 0.08,
      readableScale: 0.12,
      fallbackWidth: preset.width,
      fallbackHeight
    });
  const controller = configure();
  const startX = 90;
  const y = 180;
  const gapX = 80;
  let x = startX;

  const baselineBundle = createExplorationCompileBundle(bundle, screen, exploration.target.baseline.prototype);
  const baselineScreen = baselineBundle.screens.screens[0] ?? screen;
  root.append(createExplorationPrototypeFrame({
    bundle: baselineBundle,
    screen: baselineScreen,
    preset,
    selection,
    exploration,
    role: 'baseline',
    label: 'Current',
    x,
    y
  }));
  x += preset.width + gapX;

  for (const candidate of exploration.candidates) {
    const candidateBundle = createExplorationCompileBundle(bundle, screen, candidate.prototype);
    const candidateScreen = candidateBundle.screens.screens[0] ?? screen;
    root.append(createExplorationPrototypeFrame({
      bundle: candidateBundle,
      screen: candidateScreen,
      preset,
      selection,
      exploration,
      role: 'candidate',
      candidateId: candidate.id,
      label: candidate.label,
      x,
      y
    }));
    x += preset.width + gapX;
  }

  return {
    configure,
    fit: () => controller.fitTo([...root.querySelectorAll<HTMLElement>('.frame-slot')])
  };
}

function createExplorationCompileBundle(
  bundle: CanvasProjectBundle,
  screen: SavedScreen,
  prototype: ExplorationPrototypeSource
): CanvasProjectBundle {
  if (!screen.prototype) {
    return bundle;
  }
  const shadowScreen = {
    ...screen,
    prototype: {
      ...screen.prototype,
      source: prototype.source,
      styles: prototype.styles,
      assetRefs: prototype.assetRefs
    }
  } as ScreenDefinition;
  return {
    ...bundle,
    screens: {
      ...bundle.screens,
      screens: [shadowScreen, ...bundle.screens.screens.filter(candidate => candidate.id !== screen.id)]
    }
  };
}

interface ExplorationFrameOptions {
  bundle: CanvasProjectBundle;
  screen: ScreenDefinition;
  preset: FramePreset;
  selection: SelectedPrototypeReviewCondition;
  exploration?: ExplorationDefinition;
  role: 'current' | 'version' | 'baseline' | 'candidate';
  candidateId?: string;
  historyVersion?: number;
  canonicalBoundary?: boolean;
  unavailableNoun?: 'Variation' | 'Version';
  label: string;
  x: number;
  y: number;
}

function createExplorationPrototypeFrame(options: ExplorationFrameOptions): HTMLElement {
  const {
    bundle,
    screen,
    preset,
    selection,
    exploration,
    role,
    candidateId,
    historyVersion,
    canonicalBoundary = role === 'baseline' || role === 'current',
    unavailableNoun = 'Variation',
    label,
    x,
    y
  } = options;
  const slot = el('div', 'frame-slot exploration-frame-slot');
  slot.style.left = `${x}px`;
  slot.style.top = `${y}px`;
  if (exploration) {
    slot.dataset.explorationId = exploration.id;
  }
  slot.dataset.explorationRole = role;
  if (candidateId) {
    slot.dataset.explorationCandidateId = candidateId;
  }
  if (historyVersion !== undefined) {
    slot.dataset.historyVersion = String(historyVersion);
  }
  slot.dataset.selectionFrameKey = [exploration?.id ?? '', role, candidateId ?? '', historyVersion ?? ''].join('\u0000');

  const frame = el('article', 'frame frame-canonical exploration-frame');
  frame.style.setProperty('--frame-width', `${preset.width}px`);
  frame.style.setProperty('--frame-height', `${preset.height}px`);
  frame.style.setProperty('--frame-safe-top', `${preset.safeArea.top}px`);
  frame.style.setProperty('--frame-safe-right', `${preset.safeArea.right}px`);
  frame.style.setProperty('--frame-safe-bottom', `${preset.safeArea.bottom}px`);
  frame.style.setProperty('--frame-safe-left', `${preset.safeArea.left}px`);
  frame.dataset.screenId = screen.id;
  frame.dataset.frameType = preset.type;
  frame.dataset.framePresetId = preset.id;
  frame.dataset.reviewConditionId = selection.conditionId;
  frame.dataset.reviewState = selection.state;
  if (exploration) {
    frame.dataset.explorationId = exploration.id;
  }
  frame.dataset.explorationRole = role;
  if (candidateId) {
    frame.dataset.explorationCandidateId = candidateId;
  }
  if (historyVersion !== undefined) {
    frame.dataset.historyVersion = String(historyVersion);
  }
  if (canonicalBoundary) {
    setBoundary(frame, 'screen', screen.id, bundle.manifest.project.id, screen.name);
    frame.dataset.boundarySummary = screen.description;
  }

  const head = el('div', 'frame-head bp-chrome-frame-head');
  const note = el('div', 'frame-note bp-chrome-frame-note');
  note.append(el('span', 'dot'), el('span', 'frame-name', label));
  head.append(note);

  const rendered = createExplorationPrototypeScreen(bundle, screen, preset, selection, label, unavailableNoun);
  frame.dataset.explorationStatus = rendered.available ? 'available' : 'unavailable';
  mountDeviceChrome(frame, bundle, screen, preset, rendered.element);
  slot.append(head, frame);
  return slot;
}

function createExplorationPrototypeScreen(
  bundle: CanvasProjectBundle,
  screen: ScreenDefinition,
  preset: FramePreset,
  selection: SelectedPrototypeReviewCondition,
  label: string,
  unavailableNoun: 'Variation' | 'Version' = 'Variation'
): { element: HTMLElement; available: boolean } {
  const host = el('div', `screen canonical-prototype-screen canonical-prototype-screen-${preset.type}`);
  host.dataset.frameType = preset.type;
  host.dataset.prototypeRenderMode = 'canonical-app-owned';
  try {
    const compiled = compileScreenFrame({ bundle, screen, preset, selection });
    host.append(createCanonicalPrototypeIframe(compiled, `${label} · ${screen.name} · ${selection.state} · ${preset.name}`));
    prototypeUsesByHost.set(host, {
      ...declaredFrameUses(bundle, screen),
      targetBoundaryId: compiled.targetBoundaryId,
      usedBoundaryIds: new Set(compiled.observedUses.map(use => use.targetBoundaryId))
    });
    return { element: host, available: true };
  } catch {
    host.dataset.explorationStatus = 'unavailable';
    const message = el('div', 'prototype-compile-error exploration-prototype-error');
    message.setAttribute('role', 'status');
    message.append(
      el('strong', '', `${unavailableNoun} unavailable`),
      el('span', '', unavailableNoun === 'Variation'
        ? 'Ask the agent to refresh this exploration.'
        : 'Ask the agent to check this saved version.')
    );
    host.append(message);
    return { element: host, available: false };
  }
}

function createExplorationUnavailablePanel(): HTMLElement {
  return createFocusedUnavailablePanel(
    'Exploration unavailable',
    'Ask the agent to check the saved exploration and open it again.'
  );
}

function createFocusedUnavailablePanel(title: string, message: string): HTMLElement {
  const panel = el('section', 'bp-chrome-exploration-unavailable');
  panel.dataset.explorationStatus = 'unavailable';
  panel.style.left = '90px';
  panel.style.top = '180px';
  panel.append(
    el('strong', '', title),
    el('span', '', message)
  );
  return panel;
}

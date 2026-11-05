import type { CanvasProjectBundle } from '../core/types';
import type { BoundaryExtent } from './boundary-extent';
import { canvas, viewport } from './chrome';
import { el } from './dom';
import { type DocumentDiff, UNKNOWN_DIFF, diffPrototypeDocuments } from './element-diff';
import { slotScreenFrame } from './frame-host';
import { yieldToMain } from './frame-mounting';
import { type FrameOutputTarget, frameTargetIn } from './frame-output';
import { changedFrameOutputs, compileFrameDocument } from './frame-output-client';
import { framesInChangeScope } from './frame-output-service';

type ChangeMarksState = 'pending' | 'settled';

interface ChangeMarks {
  root: HTMLElement;
  before: CanvasProjectBundle;
  after: CanvasProjectBundle;
  showOutlines: boolean;
  report: (state: ChangeMarksState) => void;
  compared: Set<string>;
  changed: Set<string>;
  /** The element diff cannot read what changed in these frames, so its answer cannot clear the mark. */
  unconfirmable: Set<string>;
  outlines: Map<string, BoundaryExtent[]>;
  comparing: number;
  queue: FrameOutputTarget[];
  draining: boolean;
}

let marks: ChangeMarks | undefined;
let watchingView = false;

function frameTarget(slot: HTMLElement): FrameOutputTarget | undefined {
  const frame = slotScreenFrame(slot);
  const key = slot.dataset.liveFrameKey;
  return frame && key ? { key, screenId: frame.source.screen.id, state: frame.source.selection.state, preset: frame.source.preset } : undefined;
}

function drawOutlines(host: HTMLElement, outlines: readonly BoundaryExtent[]): void {
  const layer = el('div', 'bp-chrome-change-layer');
  layer.setAttribute('aria-hidden', 'true');
  for (const outline of outlines) {
    const box = el('div', 'bp-chrome-change-box');
    box.style.left = `${outline.left}px`;
    box.style.top = `${outline.top}px`;
    box.style.width = `${outline.right - outline.left}px`;
    box.style.height = `${outline.bottom - outline.top}px`;
    layer.append(box);
  }
  host.append(layer);
}

function report(current: ChangeMarks): void {
  current.report(current.comparing > 0 || current.draining ? 'pending' : 'settled');
}

function watchView(): void {
  if (watchingView) return;
  watchingView = true;
  const wake = (): void => {
    if (marks) void drainDiffQueue(marks);
  };
  canvas.onViewSettled(wake);
  window.addEventListener('resize', wake);
}

function slotInView(slot: HTMLElement): boolean {
  const box = slot.getBoundingClientRect();
  const view = viewport.getBoundingClientRect();
  return box.right > view.left && box.left < view.right && box.bottom > view.top && box.top < view.bottom;
}

function applyMark(current: ChangeMarks, slot: HTMLElement): void {
  const target = frameTarget(slot);
  const frame = slotScreenFrame(slot);
  const element = slot.querySelector<HTMLElement>('.frame');
  if (!target || !frame || !element) return;
  frame.host.querySelector(':scope > .bp-chrome-change-layer')?.remove();
  if (!current.changed.has(target.key)) {
    element.classList.remove('bp-chrome-changed');
    return;
  }
  const outlines = frame.mounted && current.showOutlines ? current.outlines.get(target.key) ?? [] : [];
  element.classList.toggle('bp-chrome-changed', outlines.length === 0);
  if (outlines.length > 0) drawOutlines(frame.host, outlines);
}

function slotsByKey(root: HTMLElement): Map<string, HTMLElement> {
  const slots = new Map<string, HTMLElement>();
  for (const slot of root.querySelectorAll<HTMLElement>('.frame-slot[data-live-frame-key]')) {
    if (slot.dataset.liveFrameKey) slots.set(slot.dataset.liveFrameKey, slot);
  }
  return slots;
}

async function diffFrame(current: ChangeMarks, target: FrameOutputTarget): Promise<DocumentDiff> {
  try {
    const [beforeHtml, afterHtml] = await Promise.all([compileFrameDocument(current.before, frameTargetIn(current.before, target)), compileFrameDocument(current.after, target)]);
    return beforeHtml && afterHtml ? await diffPrototypeDocuments(beforeHtml, afterHtml, target.preset.width, target.preset.height) : UNKNOWN_DIFF;
  } catch {
    return UNKNOWN_DIFF;
  }
}

/** A hash also changes for a rule that does not paint now, so a frame takes its mark from the diff. A frame keeps its mark from the previous edit until this diff answers. Each diff loads 2 documents, so a frame out of view waits until the view reaches it. */
async function drainDiffQueue(current: ChangeMarks): Promise<void> {
  if (current.draining) return;
  current.draining = true;
  report(current);
  try {
    for (;;) {
      const slots = slotsByKey(current.root);
      const next = current.queue.findIndex(({ key }) => {
        const slot = slots.get(key);
        return slot === undefined || slotInView(slot);
      });
      if (next < 0) return;
      const [target] = current.queue.splice(next, 1);
      if (!slots.has(target.key)) {
        current.compared.delete(target.key);
        continue;
      }
      const diff = await diffFrame(current, target);
      if (marks !== current) return;
      if (diff.changed || current.unconfirmable.has(target.key)) current.changed.add(target.key);
      else current.changed.delete(target.key);
      current.outlines.set(target.key, diff.outlines);
      const slot = slotsByKey(current.root).get(target.key);
      if (slot) applyMark(current, slot);
      await yieldToMain();
      if (marks !== current) return;
    }
  } finally {
    current.draining = false;
    if (marks === current) report(current);
  }
}

async function compareFrames(current: ChangeMarks, targets: FrameOutputTarget[]): Promise<void> {
  const answer = await changedFrameOutputs(current.before, current.after, targets);
  if (marks !== current) return;
  current.comparing -= 1;
  if (answer) {
    for (const target of targets) {
      if (!answer.changed.has(target.key)) {
        current.changed.delete(target.key);
        current.outlines.delete(target.key);
        continue;
      }
      if (answer.unconfirmable.has(target.key)) {
        current.unconfirmable.add(target.key);
        current.changed.add(target.key);
      }
      current.queue.push(target);
    }
  } else {
    for (const target of framesInChangeScope(current.before, current.after, targets, false)) current.changed.add(target.key);
  }
  for (const slot of slotsByKey(current.root).values()) applyMark(current, slot);
  void drainDiffQueue(current);
}

export function renderFrameChangeMarks(options: {
  root: HTMLElement;
  before: CanvasProjectBundle;
  after: CanvasProjectBundle;
  showOutlines: boolean;
  report: (state: ChangeMarksState) => void;
}): void {
  const { root, before, after, showOutlines } = options;
  if (marks?.before !== before || marks.after !== after) {
    const carried = marks?.before === before ? marks : undefined;
    marks = {
      root,
      before,
      after,
      showOutlines,
      report: options.report,
      compared: new Set(),
      changed: new Set(carried?.changed),
      unconfirmable: new Set(),
      outlines: new Map(carried?.outlines),
      comparing: 0,
      queue: [],
      draining: false
    };
  }
  const current = marks;
  current.root = root;
  current.showOutlines = showOutlines;
  watchView();
  const slots = [...root.querySelectorAll<HTMLElement>('.frame-slot[data-live-frame-key]')];
  for (const slot of slots) applyMark(current, slot);
  const missing = slots.flatMap(slot => {
    const target = frameTarget(slot);
    return target && !current.compared.has(target.key) ? [target] : [];
  });
  if (missing.length > 0) {
    for (const target of missing) current.compared.add(target.key);
    current.comparing += 1;
    void compareFrames(current, missing);
  }
  report(current);
}

/** The answer is false when no marks exist. */
export function reportFrameChangeMarks(): boolean {
  if (marks) report(marks);
  return marks !== undefined;
}

export function clearFrameChangeMarks(): void {
  marks = undefined;
}

/** A frame off screen has no document until it mounts, so its outlines wait for the mount. */
export function drawFrameChangeMarks(host: HTMLElement): void {
  const slot = host.closest<HTMLElement>('.frame-slot[data-live-frame-key]');
  if (marks && slot) applyMark(marks, slot);
}

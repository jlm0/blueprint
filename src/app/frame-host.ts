import { screenFrameLabel } from '../core/screen-naming';
import type { CanvasProjectBundle, FramePreset, ScreenDefinition } from '../core/types';
import {
  type CompiledPrototypeDocument,
  type SelectedPrototypeReviewCondition,
  compilePrototypeDocument
} from '../prototype/compiler';
import { applyPrototypeIframeIsolation } from '../prototype/host-policy';
import { frameMounterByRoot } from './boards';
import { canvas } from './chrome';
import { createPrototypeCompileError, el } from './dom';
import { captureCanonicalPrototype } from './frame-capture';
import { trackFrameLoad } from './frame-loads';
import type { MountableFrame } from './frame-mounting';
import { prototypeDocument } from './frame-overlay';
import {
  FRAME_THUMBNAIL_ELEMENT_LIMIT,
  FRAME_THUMBNAIL_LIMIT,
  FRAME_THUMBNAIL_PIXEL_RATIO,
  createFrameThumbnailCache,
  createIdleQueue,
  frameElementCount,
  frameThumbnailKey,
  idleCallback
} from './frame-thumbnails';
import { declaredFrameUses, prototypeUsesByHost } from './frame-uses';
import { withAssetBytes } from './prototype-assets';
import { PHONE_BEZEL, frameExtentHeight, liveFrameKey } from './screen-layout';

let annotateMountedHost: (host: HTMLElement) => void;

// The annotations of a mounted frame read the selection, and the selection mounts frames, so main.ts passes the listener in to keep the imports acyclic.
export function wireFrameHost(annotate: (host: HTMLElement) => void): void {
  annotateMountedHost = annotate;
}

export const screenFrameByHost = new WeakMap<HTMLElement, ScreenFrame>();

const frameThumbnails = createFrameThumbnailCache(FRAME_THUMBNAIL_LIMIT, url => URL.revokeObjectURL(url));

const thumbnailKeyByBundle = new WeakMap<CanvasProjectBundle, Map<string, string>>();

const frameThumbnailQueue = createIdleQueue(captureFrameThumbnail, whenCanvasIdle);

interface ScreenFrameSource {
  bundle: CanvasProjectBundle;
  screen: ScreenDefinition;
  preset: FramePreset;
  selection: SelectedPrototypeReviewCondition;
}

export interface ScreenFrame extends MountableFrame {
  host: HTMLElement;
  source: ScreenFrameSource;
  iframe?: HTMLIFrameElement;
  failed?: boolean;
  onFailed?: () => void;
  /** Keeps what the chrome of a frame shows up to date when the frame keeps its document for a new snapshot. */
  onBundleChanged?: (bundle: CanvasProjectBundle) => void;
  thumbnailKey?: string;
}

export function createCanonicalPrototypeScreen(
  bundle: CanvasProjectBundle,
  screen: ScreenDefinition,
  preset: FramePreset,
  selection: SelectedPrototypeReviewCondition | undefined,
  selectionError: string | undefined,
  x: number,
  y: number
): { element: HTMLElement; frame?: ScreenFrame } {
  const host = el('div', `screen canonical-prototype-screen canonical-prototype-screen-${preset.type}`);
  host.dataset.frameType = preset.type;
  host.dataset.prototypeRenderMode = 'canonical-app-owned';
  if (selectionError || !selection) {
    host.append(createPrototypeCompileError(selectionError ?? `Screen "${screen.id}" has no selected review condition.`));
    return { element: host };
  }
  const source: ScreenFrameSource = { bundle, screen, preset, selection };
  const frame: ScreenFrame = {
    host,
    source,
    box: { left: x, top: y, width: preset.width + (preset.type === 'mobile' ? 2 * PHONE_BEZEL : 0), height: frameExtentHeight(preset) },
    mounted: false,
    bytes: undefined,
    mount: () => mountScreenFrame(frame),
    unmount: () => unmountScreenFrame(frame),
    thumbnailKey: thumbnailKeyByBundle.get(bundle)?.get(liveFrameKey(screen.id, preset.id, selection))
  };
  screenFrameByHost.set(host, frame);
  prototypeUsesByHost.set(host, declaredFrameUses(bundle, screen));
  host.append(createFramePlaceholder(source, frameThumbnail(frame)));
  return { element: host, frame };
}

export function compileScreenFrame({ bundle, screen, preset, selection }: ScreenFrameSource): CompiledPrototypeDocument {
  return compilePrototypeDocument({
    bundle,
    target: { kind: 'screen', id: screen.id },
    state: selection.state,
    framePreset: preset,
    assetOrigin: location.origin
  });
}

export async function captureScreenFrameDocument(frame: ScreenFrame): Promise<string | undefined> {
  if (frame.failed) return undefined;
  const { bundle, screen, preset, selection } = frame.source;
  return compilePrototypeDocument({
    bundle: await withAssetBytes(bundle, screen.prototype.assetRefs ?? [], location.origin),
    target: { kind: 'screen', id: screen.id },
    state: selection.state,
    framePreset: preset
  }).html;
}

export function createCanonicalPrototypeIframe(compiled: CompiledPrototypeDocument, title: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'canonical-prototype-iframe';
  applyPrototypeIframeIsolation(iframe);
  iframe.title = title;
  iframe.srcdoc = compiled.html;
  trackFrameLoad(iframe);
  iframe.dataset.prototypeTargetBoundary = compiled.targetBoundaryId;
  iframe.dataset.prototypeObservedUses = JSON.stringify(compiled.observedUses);
  return iframe;
}

function mountScreenFrame(frame: ScreenFrame): void {
  if (frame.mounted || frame.failed) return;
  let compiled: CompiledPrototypeDocument;
  try {
    compiled = compileScreenFrame(frame.source);
  } catch (error) {
    failScreenFrame(frame, error);
    return;
  }
  const { screen, selection, preset } = frame.source;
  const iframe = createCanonicalPrototypeIframe(compiled, `${screen.name} · ${selection.state} · ${preset.name}`);
  iframe.addEventListener('load', () => frameThumbnailQueue.add(frame), { once: true });
  const placeholder = frame.host.querySelector(':scope > .bp-chrome-frame-placeholder');
  if (placeholder) placeholder.replaceWith(iframe);
  else frame.host.prepend(iframe);
  frame.iframe = iframe;
  frame.mounted = true;
  frame.bytes = compiled.html.length;
  const declared = prototypeUsesByHost.get(frame.host);
  prototypeUsesByHost.set(frame.host, {
    targetBoundaryId: compiled.targetBoundaryId,
    usedBoundaryIds: new Set(compiled.observedUses.map(use => use.targetBoundaryId)),
    sectionBoundaryIds: declared?.sectionBoundaryIds ?? new Set()
  });
  annotateMountedHost(frame.host);
}

function unmountScreenFrame(frame: ScreenFrame): void {
  if (!frame.iframe) return;
  frame.iframe.replaceWith(createFramePlaceholder(frame.source, frameThumbnail(frame)));
  frame.iframe = undefined;
  frame.mounted = false;
  frame.requested = false;
}

export function requestFrameMount(frame: ScreenFrame): void {
  const root = frame.host.closest<HTMLElement>('[data-board-root]');
  const mounter = root ? frameMounterByRoot.get(root) : undefined;
  if (!mounter) return;
  frame.requested = true;
  mounter.schedule();
}

function failScreenFrame(frame: ScreenFrame, error: unknown): void {
  frame.host.replaceChildren(createPrototypeCompileError(error));
  frame.iframe = undefined;
  frame.mounted = false;
  frame.failed = true;
  prototypeUsesByHost.delete(frame.host);
  frame.onFailed?.();
}

export function screenFrameDocument(frame: ScreenFrame): string | undefined {
  if (frame.iframe) return prototypeDocument(frame.iframe);
  if (frame.failed) return undefined;
  try {
    return compileScreenFrame(frame.source).html;
  } catch (error) {
    failScreenFrame(frame, error);
    return undefined;
  }
}

function createFramePlaceholder({ screen, selection, preset }: ScreenFrameSource, thumbnail?: string): HTMLElement {
  const placeholder = el('div', 'bp-chrome-frame-placeholder');
  placeholder.append(
    el('strong', 'bp-chrome-frame-placeholder-title', screenFrameLabel(screen)),
    el('span', 'bp-chrome-frame-placeholder-meta', `${selection.state} · ${preset.name}`)
  );
  if (thumbnail) showPlaceholderThumbnail(placeholder, thumbnail);
  return placeholder;
}

function showPlaceholderThumbnail(placeholder: HTMLElement, url: string): void {
  const image = document.createElement('img');
  image.className = 'bp-chrome-frame-placeholder-thumbnail';
  image.alt = '';
  image.decoding = 'async';
  image.src = url;
  placeholder.append(image);
}

function frameThumbnail(frame: ScreenFrame): string | undefined {
  return frame.thumbnailKey ? frameThumbnails.get(frame.thumbnailKey) : undefined;
}

export function rememberFrameThumbnail(frame: ScreenFrame): void {
  if (!frame.thumbnailKey) return;
  const { bundle, screen, preset, selection } = frame.source;
  let keys = thumbnailKeyByBundle.get(bundle);
  if (!keys) {
    keys = new Map();
    thumbnailKeyByBundle.set(bundle, keys);
  }
  keys.set(liveFrameKey(screen.id, preset.id, selection), frame.thumbnailKey);
}

async function whenCanvasIdle(): Promise<void> {
  await idleCallback();
  while (canvas.gesturing()) {
    await new Promise<void>(resolve => {
      const stop = canvas.onViewSettled(() => {
        if (canvas.gesturing()) return;
        stop();
        resolve();
      });
    });
    await idleCallback();
  }
}

async function captureFrameThumbnail(frame: ScreenFrame): Promise<void> {
  const live = frame.iframe && frame.host.isConnected ? prototypeDocument(frame.iframe) : undefined;
  if (!live || frameElementCount(live) > FRAME_THUMBNAIL_ELEMENT_LIMIT) return;
  const key = frameThumbnailKey(live, frame.host.clientWidth, frame.host.clientHeight);
  frame.thumbnailKey = key;
  rememberFrameThumbnail(frame);
  if (!frameThumbnails.get(key)) {
    const html = await captureScreenFrameDocument(frame);
    const blob = html ? await captureCanonicalPrototype(frame.host, html, FRAME_THUMBNAIL_PIXEL_RATIO) : null;
    if (!blob) return;
    frameThumbnails.set(key, URL.createObjectURL(blob));
  }
  const placeholder = frame.mounted ? undefined : frame.host.querySelector<HTMLElement>(':scope > .bp-chrome-frame-placeholder');
  const url = frameThumbnails.get(key);
  if (placeholder && url && !placeholder.querySelector('.bp-chrome-frame-placeholder-thumbnail')) showPlaceholderThumbnail(placeholder, url);
}

export function slotScreenFrame(slot: HTMLElement): ScreenFrame | undefined {
  const host = slot.querySelector<HTMLElement>('.canonical-prototype-screen');
  return host ? screenFrameByHost.get(host) : undefined;
}

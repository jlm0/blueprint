import { type BoundaryExtent, measureBoundaryExtents } from './boundary-extent';
import { el } from './dom';

/** A request that never ends must not hold the marks of each later frame. */
const TWIN_LOAD_TIMEOUT_MS = 10_000;

export function prototypeDocument(iframe: HTMLIFrameElement): string | undefined {
  return iframe.srcdoc || undefined;
}

export function mountedPrototypeIframe(host: HTMLElement): HTMLIFrameElement | undefined {
  return host.querySelector<HTMLIFrameElement>(':scope > iframe.canonical-prototype-iframe') ?? undefined;
}

interface FrameOverlay {
  layerClass: string;
  boxClass: string;
  datasetKey: string;
  generation: number;
  targets: Map<HTMLElement, ReadonlySet<string>>;
  drawn: WeakMap<HTMLElement, number>;
  decorate?: (layer: HTMLElement) => void;
}

export function createFrameOverlay(layerClass: string, boxClass: string, datasetKey: string, decorate?: (layer: HTMLElement) => void): FrameOverlay {
  return { layerClass, boxClass, datasetKey, generation: 0, targets: new Map(), drawn: new WeakMap(), decorate };
}

export function resetFrameOverlay(overlay: FrameOverlay): void {
  overlay.generation += 1;
  overlay.targets.clear();
  for (const layer of document.querySelectorAll(`.${overlay.layerClass}`)) layer.remove();
}

export function showFrameOverlay(overlay: FrameOverlay, host: HTMLElement, boundaryIds: ReadonlySet<string>): void {
  overlay.targets.set(host, boundaryIds);
  drawFrameOverlay(overlay, host);
}

// Frames off screen are not mounted, so each overlay draws on mount from the targets of its last render.
export function drawFrameOverlay(overlay: FrameOverlay, host: HTMLElement): void {
  const boundaryIds = overlay.targets.get(host);
  const iframe = mountedPrototypeIframe(host);
  const html = iframe ? prototypeDocument(iframe) : undefined;
  if (!boundaryIds || !iframe || !html || overlay.drawn.get(host) === overlay.generation) return;
  const generation = overlay.generation;
  overlay.drawn.set(host, generation);
  void measurePrototypeBoundaryExtents(html, iframe.clientWidth, iframe.clientHeight, boundaryIds).then(extents => {
    if (generation !== overlay.generation || !host.isConnected) return;
    host.querySelector(`:scope > .${overlay.layerClass}`)?.remove();
    const layer = el('div', overlay.layerClass);
    layer.setAttribute('aria-hidden', 'true');
    layer.dataset[overlay.datasetKey] = [...boundaryIds].join(' ');
    overlay.decorate?.(layer);
    for (const extent of extents) {
      const box = el('div', overlay.boxClass);
      box.style.left = `${extent.left}px`;
      box.style.top = `${extent.top}px`;
      box.style.width = `${extent.right - extent.left}px`;
      box.style.height = `${extent.bottom - extent.top}px`;
      layer.append(box);
    }
    host.append(layer);
  });
}

function measurePrototypeBoundaryExtents(
  html: string,
  width: number,
  height: number,
  boundaryIds: ReadonlySet<string>
): Promise<BoundaryExtent[]> {
  return readPrototypeTwin(html, width, height, twinDocument => measureBoundaryExtents(twinDocument, boundaryIds), []);
}

/**
 * The visible frame keeps its empty-permission sandbox, so boundary geometry is
 * read from a short-lived same-origin twin rendering the same no-script document.
 */
export function readPrototypeTwin<T>(
  html: string,
  width: number,
  height: number,
  read: (twinDocument: Document) => T | Promise<T>,
  fallback: T
): Promise<T> {
  if (width <= 0 || height <= 0) return Promise.resolve(fallback);
  return new Promise(resolve => {
    const twin = document.createElement('iframe');
    twin.style.cssText = `position:fixed;left:-${width + 100}px;top:0;width:${width}px;height:${height}px;border:0;pointer-events:none;`;
    twin.tabIndex = -1;
    twin.setAttribute('aria-hidden', 'true');
    twin.setAttribute('sandbox', 'allow-same-origin');
    const settle = (result: T): void => {
      window.clearTimeout(timer);
      twin.remove();
      resolve(result);
    };
    const timer = window.setTimeout(() => settle(fallback), TWIN_LOAD_TIMEOUT_MS);
    twin.addEventListener('load', () => {
      const twinDocument = twin.contentDocument;
      const measured = twinDocument
        ? twinDocument.fonts.ready.then(() => {
          window.clearTimeout(timer);
          return read(twinDocument);
        })
        : Promise.resolve(fallback);
      void measured.catch(() => fallback).then(settle);
    }, { once: true });
    twin.srcdoc = html;
    document.body.append(twin);
  });
}

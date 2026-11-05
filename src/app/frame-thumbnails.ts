import { PROTOTYPE_ASSET_PATH_PREFIX } from '../prototype/host-policy';
import { textHash } from './text-hash';

export const FRAME_THUMBNAIL_LIMIT = 256;
const FRAME_THUMBNAIL_PIXEL_RATIO = 0.5;
// Parsing, serializing, and encoding a document take about 8.6 ms per MB on an M-series Mac, so a larger document blocks input for more than 50 ms.
export const FRAME_THUMBNAIL_DOCUMENT_LIMIT = 4 * 1024 * 1024;
// An SVG image holds a CSS animation at its first keyframe and a transition at its start, and `html` is not its root, so a margin collapses out of `html` and no background reaches a canvas. These rules give the frame its resting look, and `:where` lets each rule of the document win.
const FRAME_AT_REST_CSS = ':where(html,body){display:flow-root;min-height:100vh}*,*::before,*::after{animation-delay:-99999s!important;transition:none!important}';
const ASSET_HASH = /^[0-9a-f]{64}$/;
const BASE64_GROWTH = 4 / 3;

/** An SVG image loads no file, so each linked asset of the document becomes a data URL. The answer is undefined when the document grows over the limit. */
async function inlineLinkedAssets(markup: string): Promise<string | undefined> {
  const source = `${location.origin}${PROTOTYPE_ASSET_PATH_PREFIX}`;
  const hashes = new Set(markup.split(source).slice(1).map(rest => rest.slice(0, 64)).filter(hash => ASSET_HASH.test(hash)));
  let inlined = markup;
  for (const hash of hashes) {
    const url = `${source}${hash}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Blueprint could not load asset ${hash}.`);
    const blob = await response.blob();
    if (inlined.length + blob.size * BASE64_GROWTH > FRAME_THUMBNAIL_DOCUMENT_LIMIT) return undefined;
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error(`Blueprint could not read asset ${hash}.`));
      reader.readAsDataURL(blob);
    });
    inlined = inlined.replaceAll(url, () => data);
  }
  return inlined;
}

/** html-to-image copies every computed style of each element, so it takes about 0.6 ms per element. The browser renders this document in an SVG image, which runs no script and loads no file. */
export async function renderFrameThumbnail(html: string, width: number, height: number, pixelRatio = FRAME_THUMBNAIL_PIXEL_RATIO): Promise<Blob | null> {
  if (html.length > FRAME_THUMBNAIL_DOCUMENT_LIMIT) return null;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const rest = parsed.createElement('style');
  rest.textContent = FRAME_AT_REST_CSS;
  parsed.head.append(rest);
  const markup = await inlineLinkedAssets(new XMLSerializer().serializeToString(parsed.documentElement));
  if (markup === undefined) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * pixelRatio));
  canvas.height = Math.max(1, Math.round(height * pixelRatio));
  // A document keeps a copy of each image URL that it loads until the document closes, so the image loads in a document that closes after the draw.
  const host = document.createElement('iframe');
  host.hidden = true;
  document.body.append(host);
  try {
    const view = host.contentWindow as typeof globalThis | null;
    if (!view) throw new Error('Blueprint could not open a document for the frame image.');
    const image = new view.Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`)}`;
    await image.decode();
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
  } finally {
    host.remove();
  }
  return new Promise(resolve => canvas.toBlob(resolve));
}

export function frameThumbnailKey(html: string, width: number, height: number): string {
  return `${width}x${height}.${textHash([html])}`;
}

export interface FrameThumbnailCache {
  get: (key: string) => string | undefined;
  set: (key: string, url: string) => void;
}

export function createFrameThumbnailCache(limit: number, release: (url: string) => void): FrameThumbnailCache {
  const urls = new Map<string, string>();
  return {
    get(key) {
      const url = urls.get(key);
      if (url === undefined) return undefined;
      urls.delete(key);
      urls.set(key, url);
      return url;
    },
    set(key, url) {
      const previous = urls.get(key);
      if (previous !== undefined && previous !== url) release(previous);
      urls.delete(key);
      urls.set(key, url);
      for (const [oldest, oldestUrl] of urls) {
        if (urls.size <= limit) break;
        urls.delete(oldest);
        release(oldestUrl);
      }
    }
  };
}

export interface IdleQueue<T> {
  add: (item: T) => void;
}

export function createIdleQueue<T>(run: (item: T) => Promise<void>, whenIdle: () => Promise<void>): IdleQueue<T> {
  const pending = new Set<T>();
  let running = false;
  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (pending.size > 0) {
        await whenIdle();
        const [item] = pending;
        if (item === undefined) break;
        pending.delete(item);
        await run(item).catch(() => undefined);
      }
    } finally {
      running = false;
    }
  };
  return {
    add(item) {
      pending.add(item);
      void pump();
    }
  };
}

export function idleCallback(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 50);
  });
}

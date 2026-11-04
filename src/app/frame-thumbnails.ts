export const FRAME_THUMBNAIL_LIMIT = 256;
export const FRAME_THUMBNAIL_PIXEL_RATIO = 0.5;
// html-to-image copies every computed style of each element, about 0.55 ms per element on an M-series Mac, so larger documents block input for more than 200 ms.
export const FRAME_THUMBNAIL_ELEMENT_LIMIT = 300;

export function frameElementCount(html: string): number {
  return html.match(/<[a-z]/gi)?.length ?? 0;
}

export function frameThumbnailKey(html: string): string {
  let first = 0xdeadbeef ^ html.length;
  let second = 0x41c6ce57 ^ html.length;
  for (let index = 0; index < html.length; index += 1) {
    const code = html.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return `${html.length.toString(36)}.${(first >>> 0).toString(36)}.${(second >>> 0).toString(36)}`;
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

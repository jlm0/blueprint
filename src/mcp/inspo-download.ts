import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Names the public project, never the person, as the contact for image hosts. */
export const INSPO_USER_AGENT = 'blueprint (+https://github.com/jlm0/blueprint)';
export const INSPO_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const PASTE_IMAGE_ADDRESS = 'Fix: right-click the image, choose "Copy Image Address", and paste that link.';

export type InspoImageExtension = 'png' | 'jpg' | 'webp' | 'gif';

export interface InspoFetcher {
  fetch: (url: URL, init: RequestInit) => Promise<Response>;
  lookup: (hostname: string) => Promise<string[]>;
}

export const defaultInspoFetcher: InspoFetcher = {
  fetch: (url, init) => globalThis.fetch(url, init),
  lookup: async hostname => (await dnsLookup(hostname, { all: true })).map(entry => entry.address)
};

export interface DownloadedInspoImage {
  extension: InspoImageExtension;
  bytes: Buffer;
}

/** @throws {Error} When the link is not an https image address Blueprint can download. */
export function normalizeInspoUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" is not a link. Fix: paste the full image address, starting with https://.`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`"${raw}" does not use https. Fix: paste the https address of the image.`);
  }
  if (url.username || url.password) {
    throw new Error(`"${raw}" carries a user name or password. Fix: paste the image address without them.`);
  }
  const host = url.hostname.toLowerCase();
  if (host === 'dribbble.com' || host === 'www.dribbble.com') {
    throw new Error(`"${raw}" is a Dribbble page, and Dribbble pages refuse downloads. Fix: open the shot, right-click the image, choose "Copy Image Address", and paste that cdn.dribbble.com link.`);
  }
  if (host === 'cdn.dribbble.com') {
    url.search = '';
  }
  url.hash = '';
  return url;
}

/** @throws {Error} When the link resolves to a private address, is not an image, or is too large. */
export async function downloadInspoImage(raw: string, fetcher: InspoFetcher, signal?: AbortSignal): Promise<DownloadedInspoImage> {
  let url = normalizeInspoUrl(raw);
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let redirects = 0; ; redirects += 1) {
    await assertPublicHost(url, fetcher);
    const response = await fetcher.fetch(url, {
      redirect: 'manual',
      signal: requestSignal,
      headers: { 'User-Agent': INSPO_USER_AGENT, Accept: 'image/png,image/jpeg,image/gif,image/*;q=0.8' }
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`"${raw}" redirects more than ${MAX_REDIRECTS} times. ${PASTE_IMAGE_ADDRESS}`);
      }
      url = new URL(location, url);
      if (url.protocol !== 'https:') {
        throw new Error(`"${raw}" redirects to a link without https. ${PASTE_IMAGE_ADDRESS}`);
      }
      continue;
    }
    if (response.headers.get('x-amzn-waf-action') || response.status === 403) {
      await response.body?.cancel();
      throw new Error(`"${raw}" refuses downloads from tools. Fix: open the image alone in a browser tab, then paste the address of that tab.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`"${raw}" returned HTTP ${response.status}. Fix: open the link in a browser to check it, then paste the image address again.`);
    }
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (mediaType === 'text/html') {
      await response.body?.cancel();
      throw new Error(`"${raw}" is a web page, not an image. ${PASTE_IMAGE_ADDRESS}`);
    }
    if (Number(response.headers.get('content-length')) > INSPO_MAX_IMAGE_BYTES) {
      await response.body?.cancel();
      throw new Error(`"${raw}" is larger than ${INSPO_MAX_IMAGE_BYTES / 1024 / 1024} MiB. Fix: paste the address of a smaller version of the image.`);
    }
    const bytes = await readCapped(response, raw);
    const extension = sniffImageType(bytes);
    if (!extension) {
      throw new Error(`"${raw}" returned ${mediaType ? `"${mediaType}"` : 'unknown'} data, not a PNG, JPEG, WebP, or GIF image. ${PASTE_IMAGE_ADDRESS}`);
    }
    return { extension, bytes };
  }
}

export function sniffImageType(bytes: Buffer): InspoImageExtension | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return undefined;
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !(lower === '::' || lower === '::1' || lower.startsWith('::ffff:') || /^(?:f[cd]|fe[89ab]|ff)/.test(lower));
  }
  return false;
}

async function assertPublicHost(url: URL, fetcher: InspoFetcher): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [hostname] : await fetcher.lookup(hostname);
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new Error(`"${url.hostname}" is a local or private address. Fix: paste the address of an image on the public web.`);
  }
}

async function readCapped(response: Response, raw: string): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > INSPO_MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error(`"${raw}" is larger than ${INSPO_MAX_IMAGE_BYTES / 1024 / 1024} MiB. Fix: paste the address of a smaller version of the image.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

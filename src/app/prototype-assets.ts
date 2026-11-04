import { PROTOTYPE_ASSET_PATH_PREFIX } from '../prototype/host-policy';
import type { BlueprintProjectBundle, CanvasProjectBundle, PrototypeAssetContent } from '../core/types';

const BINARY_CHUNK = 0x8000;

export async function withAssetBytes(
  bundle: CanvasProjectBundle,
  assetRefs: readonly string[],
  origin: string
): Promise<BlueprintProjectBundle> {
  const entries = await Promise.all(assetRefs.map(async (assetRef): Promise<Array<[string, PrototypeAssetContent]>> => {
    const asset = bundle.prototypeAssetContents[assetRef];
    if (!asset) return [];
    if ('base64' in asset) return [[assetRef, asset]];
    return [[assetRef, { mediaType: asset.mediaType, base64: await fetchAssetBase64(asset.sha256, origin) }]];
  }));
  return { ...bundle, prototypeAssetContents: Object.fromEntries(entries.flat()) };
}

async function fetchAssetBase64(sha256: string, origin: string): Promise<string> {
  const response = await fetch(new URL(`${PROTOTYPE_ASSET_PATH_PREFIX}${sha256}`, origin));
  if (!response.ok) throw new Error(`Blueprint could not load asset ${sha256}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += BINARY_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + BINARY_CHUNK));
  }
  return btoa(binary);
}

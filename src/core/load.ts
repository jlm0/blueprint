import path from 'node:path';
import { collectPrototypeAssetRefs, collectPrototypeTextSourceRefs, createProjectBundle } from './bundle';
import { ContainedBlueprintReader } from './filesystem-containment';
import type {
  BlueprintManifest,
  BlueprintProjectBundle,
  ComponentFile,
  PrimitiveFile,
  PrototypeAssetContent,
  ScreenFile,
  TokenFile
} from './types';

export async function loadProjectFromFs(sourceRoot: string): Promise<BlueprintProjectBundle> {
  const reader = await ContainedBlueprintReader.create(sourceRoot);
  const manifest = await readJson<BlueprintManifest>(reader, 'manifest.json');
  const tokens = await readJson<TokenFile>(reader, 'tokens.json');
  const primitives = await readJson<PrimitiveFile>(reader, 'primitives.json');
  const components = await readOptionalJson<ComponentFile>(reader, 'components.json');
  const screens = await readJson<ScreenFile>(reader, 'screens.json');
  const componentFile = components ?? {
    schemaVersion: '1.0.0',
    projectId: manifest.project.id,
    components: []
  };
  const sourceRefs = collectPrototypeTextSourceRefs(primitives, componentFile, screens);
  const prototypeSourceContents: Record<string, string> = {};
  for (const sourceRef of sourceRefs) {
    const content = await reader.readText(sourceRef, { kind: 'prototype source', optional: true });
    if (content !== undefined) {
      prototypeSourceContents[sourceRef] = content;
    }
  }
  const prototypeAssetContents: Record<string, PrototypeAssetContent> = {};
  for (const assetRef of collectPrototypeAssetRefs(screens)) {
    const bytes = await reader.readBytes(assetRef, { kind: 'prototype asset', optional: true });
    if (bytes !== undefined) {
      prototypeAssetContents[assetRef] = {
        mediaType: assetMediaType(assetRef),
        base64: bytes.toString('base64')
      };
    }
  }

  return createProjectBundle(normalizePath(sourceRoot), {
    manifest,
    tokens,
    primitives,
    ...(components ? { components } : {}),
    screens,
    prototypeSourceContents,
    prototypeAssetContents
  });
}

export function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

async function readJson<T>(reader: ContainedBlueprintReader, fileRef: string): Promise<T> {
  const raw = await reader.readText(fileRef, { kind: 'fixed JSON' });
  if (raw === undefined) {
    throw new Error(`fixed JSON "${fileRef}" does not exist.`);
  }
  return JSON.parse(raw) as T;
}

async function readOptionalJson<T>(reader: ContainedBlueprintReader, fileRef: string): Promise<T | undefined> {
  const raw = await reader.readText(fileRef, { kind: 'fixed JSON', optional: true });
  return raw === undefined ? undefined : JSON.parse(raw) as T;
}

function assetMediaType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const byExtension: Record<string, string> = {
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  };
  return byExtension[extension] ?? 'application/octet-stream';
}

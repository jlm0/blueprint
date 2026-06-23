import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createProjectBundle } from './bundle';
import type { BlueprintManifest, BlueprintProjectBundle, PrimitiveFile, ScreenFile, TokenFile } from './types';

export async function loadProjectFromFs(sourceRoot: string): Promise<BlueprintProjectBundle> {
  const [manifest, tokens, primitives, screens] = await Promise.all([
    readJson<BlueprintManifest>(path.join(sourceRoot, 'manifest.json')),
    readJson<TokenFile>(path.join(sourceRoot, 'tokens.json')),
    readJson<PrimitiveFile>(path.join(sourceRoot, 'primitives.json')),
    readJson<ScreenFile>(path.join(sourceRoot, 'screens.json'))
  ]);

  return createProjectBundle(normalizePath(sourceRoot), { manifest, tokens, primitives, screens });
}

export function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

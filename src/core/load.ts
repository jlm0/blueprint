import path from 'node:path';
import {
  collectBrandSourceRefs,
  collectExplorationAssetRefs,
  collectExplorationTextSourceRefs,
  collectHistoryAssetRefs,
  collectHistoryTextSourceRefs,
  collectPrototypeAssetRefs,
  collectPrototypeTextSourceRefs,
  createProjectBundle
} from './bundle';
import { ContainedBlueprintReader } from './filesystem-containment';
import { assertNoNewerSchema, BLUEPRINT_SCHEMA_VERSION, fileSchemaVersions } from './schema-version';
import { explorationRecordRef, historyRecordRef } from './storage-records';
import type {
  BlueprintManifest,
  BlueprintProjectBundle,
  BrandFile,
  ComponentFile,
  ExplorationDefinition,
  ExplorationFile,
  ExplorationRecordFile,
  InspoFile,
  PrimitiveFile,
  PrototypeAssetContent,
  ScreenFile,
  ScreenHistoryEntry,
  ScreenHistoryFile,
  ScreenHistoryRecordFile,
  TokenFile
} from './types';
import { assertStructuredShapes } from './structured-shapes';

export async function loadProjectFromFs(sourceRoot: string): Promise<BlueprintProjectBundle> {
  const reader = await createProjectReader(sourceRoot);
  const manifest = await readJson<BlueprintManifest>(reader, 'manifest.json');
  const tokens = await readJson<TokenFile>(reader, 'tokens.json');
  const primitives = await readJson<PrimitiveFile>(reader, 'primitives.json');
  const components = await readJson<ComponentFile>(reader, 'components.json');
  const screens = await readJson<ScreenFile>(reader, 'screens.json');
  const brandText = await reader.readText('brand.json', { kind: 'fixed JSON', optional: true });
  const brand = brandText === undefined ? undefined : parseJson<BrandFile>('brand.json', brandText);
  const inspoText = await reader.readText('inspo.json', { kind: 'fixed JSON', optional: true });
  const inspo = inspoText === undefined ? undefined : parseJson<InspoFile>('inspo.json', inspoText);
  assertNoNewerSchema(fileSchemaVersions({ manifest, tokens, primitives, components, screens, brand, inspo }));
  assertStructuredShapes({ manifest, tokens, primitives, components, screens, brand });
  const explorationRecordRefs = await reader.listFileRefs('explorations', { optional: true, suffix: '.json' });
  const historyRecordRefs = await reader.listFileRefs('history', { optional: true, suffix: '.json' });
  const recordSchemaVersions: Record<string, string> = {};
  const explorations = await readExplorationCollection(reader, manifest.project.id, explorationRecordRefs, recordSchemaVersions);
  const history = await readHistoryCollection(reader, manifest.project.id, historyRecordRefs, recordSchemaVersions);
  const sourceRefs = [
    ...collectPrototypeTextSourceRefs(primitives, components, screens),
    ...collectBrandSourceRefs(brand),
    ...collectExplorationTextSourceRefs(explorations),
    ...collectHistoryTextSourceRefs(history)
  ];
  const prototypeSourceContents: Record<string, string> = {};
  for (const sourceRef of new Set(sourceRefs)) {
    const content = await reader.readText(sourceRef, { kind: 'prototype source', optional: true });
    if (content !== undefined) {
      prototypeSourceContents[sourceRef] = content;
    }
  }
  const prototypeAssetContents: Record<string, PrototypeAssetContent> = {};
  const assetRefs = [
    ...collectPrototypeAssetRefs(screens),
    ...collectExplorationAssetRefs(explorations),
    ...collectHistoryAssetRefs(history)
  ];
  for (const assetRef of new Set(assetRefs)) {
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
    components,
    screens,
    brand,
    inspo,
    explorations,
    history,
    recordSchemaVersions,
    explorationRecordRefs,
    historyRecordRefs,
    prototypeSourceContents,
    prototypeAssetContents
  });
}

async function readExplorationCollection(
  reader: ContainedBlueprintReader,
  projectId: string,
  recordRefs: string[],
  recordSchemaVersions: Record<string, string>
): Promise<ExplorationFile> {
  const byId = new Map<string, ExplorationDefinition>();
  for (const recordRef of recordRefs) {
    const record = await readRecord<ExplorationRecordFile>(reader, recordRef, recordSchemaVersions);
    if (record.projectId !== projectId) {
      throw new Error(`Exploration record "${recordRef}" projectId must match manifest project id "${projectId}".`);
    }
    if (recordRef !== explorationRecordRef(record.exploration.id)) {
      throw new Error(`Exploration record "${recordRef}" does not match exploration id "${record.exploration.id}".`);
    }
    if (byId.has(record.exploration.id)) {
      throw new Error(`Exploration record id "${record.exploration.id}" is duplicated.`);
    }
    byId.set(record.exploration.id, record.exploration);
  }
  return {
    schemaVersion: BLUEPRINT_SCHEMA_VERSION,
    projectId,
    explorations: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
  };
}

async function readHistoryCollection(
  reader: ContainedBlueprintReader,
  projectId: string,
  recordRefs: string[],
  recordSchemaVersions: Record<string, string>
): Promise<ScreenHistoryFile> {
  const entries: ScreenHistoryEntry[] = [];
  const keys = new Set<string>();
  for (const recordRef of recordRefs) {
    const record = await readRecord<ScreenHistoryRecordFile>(reader, recordRef, recordSchemaVersions);
    if (record.projectId !== projectId) {
      throw new Error(`History record "${recordRef}" projectId must match manifest project id "${projectId}".`);
    }
    if (recordRef !== historyRecordRef(record.entry.screenId, record.entry.version)) {
      throw new Error(
        `History record "${recordRef}" does not match screen "${record.entry.screenId}" V${record.entry.version}.`
      );
    }
    const key = `${record.entry.screenId}\u0000${record.entry.version}`;
    if (keys.has(key)) {
      throw new Error(`History record for screen "${record.entry.screenId}" V${record.entry.version} is duplicated.`);
    }
    keys.add(key);
    entries.push(record.entry);
  }
  return {
    schemaVersion: BLUEPRINT_SCHEMA_VERSION,
    projectId,
    entries: entries.sort((left, right) => (
      left.screenId.localeCompare(right.screenId) || left.version - right.version
    ))
  };
}

export function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

async function readRecord<T extends { schemaVersion: string }>(
  reader: ContainedBlueprintReader,
  recordRef: string,
  recordSchemaVersions: Record<string, string>
): Promise<T> {
  const record = await readJson<T>(reader, recordRef);
  const version = record?.schemaVersion;
  assertNoNewerSchema([[recordRef, version]]);
  if (version !== BLUEPRINT_SCHEMA_VERSION) recordSchemaVersions[recordRef] = String(version);
  return record;
}

async function readJson<T>(reader: ContainedBlueprintReader, fileRef: string): Promise<T> {
  const raw = await reader.readText(fileRef, { kind: 'fixed JSON' });
  if (raw === undefined) {
    throw new Error(`fixed JSON "${fileRef}" does not exist.`);
  }
  return parseJson<T>(fileRef, raw);
}

async function createProjectReader(sourceRoot: string): Promise<ContainedBlueprintReader> {
  try {
    return await ContainedBlueprintReader.create(sourceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(`Blueprint project "${sourceRoot}" does not exist. Fix: pass the path of the design/blueprint folder of the app, or create it with the init tool.`);
  }
}

function parseJson<T>(fileRef: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${fileRef} is not valid JSON: ${(error as Error).message}. Fix: correct the JSON syntax of ${fileRef}.`);
  }
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

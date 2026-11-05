import path from 'node:path';
import type * as z from 'zod/v4';
import {
  collectBrandSourceRefs,
  collectExplorationAssetRefs,
  collectExplorationTextSourceRefs,
  collectHistoryAssetRefs,
  collectHistoryTextSourceRefs,
  collectPrototypeAssetRefs,
  collectPrototypeTextSourceRefs,
  createProjectBundle,
  type RawProjectFiles
} from './bundle';
import { ContainedBlueprintReader } from './filesystem-containment';
import { isObject } from './raw-json';
import { structuredFileErrors } from './schemas/issues';
import { STRUCTURED_FILE_SCHEMAS } from './schemas/project';
import { explorationRecordFileSchema, screenHistoryRecordFileSchema } from './schemas/records';
import { assertNoNewerSchema, BLUEPRINT_SCHEMA_VERSION, fileSchemaVersions, schemaVersionErrors, schemaVersionText } from './schema-version';
import { explorationRecordRef, historyRecordRef, isSavedRecordFile } from './storage-records';
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

type StructuredFiles = Pick<RawProjectFiles, 'manifest' | 'tokens' | 'primitives' | 'components' | 'screens' | 'brand' | 'inspo'>;

class RecordIdentityError extends Error {}

export async function loadProjectFromFs(sourceRoot: string): Promise<BlueprintProjectBundle> {
  const reader = await createProjectReader(sourceRoot);
  const files: StructuredFiles = {
    manifest: await readJson<BlueprintManifest>(reader, 'manifest.json'),
    tokens: await readJson<TokenFile>(reader, 'tokens.json'),
    primitives: await readJson<PrimitiveFile>(reader, 'primitives.json'),
    components: await readJson<ComponentFile>(reader, 'components.json'),
    screens: await readJson<ScreenFile>(reader, 'screens.json'),
    brand: await readOptionalJson<BrandFile>(reader, 'brand.json'),
    inspo: await readOptionalJson<InspoFile>(reader, 'inspo.json')
  };
  assertNoNewerSchema(fileSchemaVersions(files));
  assertCurrentFilesMatchSchemas(files);
  const recordSchemaVersions: Record<string, string> = {};
  try {
    return await readBundle(reader, sourceRoot, files, recordSchemaVersions);
  } catch (error) {
    const readerFailed = error instanceof TypeError || error instanceof RecordIdentityError;
    const refusals = readerFailed ? schemaVersionErrors({ ...files, recordSchemaVersions }) : [];
    if (refusals.length === 0) throw error;
    // A file on an older schema has no known shape, so a reader can fail on it, and the agent needs the migrate refusal.
    throw new Error(refusals.join('\n'));
  }
}

/** A file on another schema skips the check, because the current schema does not describe it and `migrate` owns it. */
function isOnOtherSchema(content: unknown): boolean {
  return isObject(content) && content.schemaVersion !== BLUEPRINT_SCHEMA_VERSION;
}

function assertCurrentFilesMatchSchemas(files: StructuredFiles): void {
  const errors = STRUCTURED_FILE_SCHEMAS.flatMap(({ file, key, schema }) => {
    const content = files[key];
    return content === undefined || isOnOtherSchema(content) ? [] : structuredFileErrors(file, schema, content);
  });
  if (errors.length > 0) throw new Error(errors.join('\n'));
}

async function readBundle(
  reader: ContainedBlueprintReader,
  sourceRoot: string,
  files: StructuredFiles,
  recordSchemaVersions: Record<string, string>
): Promise<BlueprintProjectBundle> {
  const { manifest, primitives, components, screens, brand } = files;
  const explorationRecordRefs = (await reader.listFileRefs('explorations', { optional: true, suffix: '.json' })).filter(isSavedRecordFile);
  const historyRecordRefs = (await reader.listFileRefs('history', { optional: true, suffix: '.json' })).filter(isSavedRecordFile);
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
    if (sourceRef in Object.prototype) {
      throw new Error(`Prototype source ref "${sourceRef}" is the name of a built-in object property, which Blueprint cannot store. Fix: name a file with its folder and extension, such as "prototype/screens/home.html".`);
    }
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
    ...files,
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
    const record = await readRecord<ExplorationRecordFile>(reader, recordRef, explorationRecordFileSchema, recordSchemaVersions);
    if (record.projectId !== projectId) {
      throw new RecordIdentityError(`Exploration record "${recordRef}" projectId must match manifest project id "${projectId}". Fix: set projectId in ${recordRef} to "${projectId}".`);
    }
    if (recordRef !== explorationRecordRef(record.exploration.id)) {
      throw new RecordIdentityError(`Exploration record "${recordRef}" does not match exploration id "${record.exploration.id}". Fix: rename the file to ${explorationRecordRef(record.exploration.id)}, or set exploration.id in it to match its file name.`);
    }
    if (byId.has(record.exploration.id)) {
      throw new RecordIdentityError(`Exploration record id "${record.exploration.id}" is duplicated. Fix: delete ${recordRef}, or give it another exploration id.`);
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
    const record = await readRecord<ScreenHistoryRecordFile>(reader, recordRef, screenHistoryRecordFileSchema, recordSchemaVersions);
    if (record.projectId !== projectId) {
      throw new RecordIdentityError(`History record "${recordRef}" projectId must match manifest project id "${projectId}". Fix: set projectId in ${recordRef} to "${projectId}".`);
    }
    if (recordRef !== historyRecordRef(record.entry.screenId, record.entry.version)) {
      throw new RecordIdentityError(
        `History record "${recordRef}" does not match screen "${record.entry.screenId}" V${record.entry.version}. Fix: rename the file to ${historyRecordRef(record.entry.screenId, record.entry.version)}, or set entry.screenId and entry.version in it to match its file name.`
      );
    }
    const key = `${record.entry.screenId}\u0000${record.entry.version}`;
    if (keys.has(key)) {
      throw new RecordIdentityError(`History record for screen "${record.entry.screenId}" V${record.entry.version} is duplicated. Fix: delete ${recordRef}, or give it another version.`);
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
  schema: z.ZodType<T>,
  recordSchemaVersions: Record<string, string>
): Promise<T> {
  const record = await readJson<T>(reader, recordRef);
  const version = record?.schemaVersion;
  assertNoNewerSchema([[recordRef, version]]);
  if (version !== BLUEPRINT_SCHEMA_VERSION) recordSchemaVersions[recordRef] = schemaVersionText(version);
  if (isOnOtherSchema(record)) return record;
  const errors = structuredFileErrors(recordRef, schema, record);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return record;
}

async function readJson<T>(reader: ContainedBlueprintReader, fileRef: string): Promise<T> {
  const raw = await reader.readText(fileRef, { kind: 'fixed JSON' });
  if (raw === undefined) {
    throw new Error(`fixed JSON "${fileRef}" does not exist. Fix: restore ${fileRef} from git, or pass the directory of a complete project.`);
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

async function readOptionalJson<T>(reader: ContainedBlueprintReader, fileRef: string): Promise<T | undefined> {
  const raw = await reader.readText(fileRef, { kind: 'fixed JSON', optional: true });
  return raw === undefined ? undefined : parseJson<T>(fileRef, raw);
}

function parseJson<T>(fileRef: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${fileRef} is not valid JSON: ${(error as Error).message}. Fix: make ${fileRef} valid JSON at the position that this message names.`);
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

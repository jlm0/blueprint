import { existsSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { INSPO_IMAGE_DIRECTORY, INSPO_IMAGE_PATTERN } from '../core/inspo-contract';
import { BLUEPRINT_SCHEMA_VERSION } from '../core/schema-version';
import type { BlueprintProjectBundle, InspoDirection, InspoEntry, InspoFile } from '../core/types';
import { defaultInspoFetcher, downloadInspoImage, normalizeInspoUrl, type DownloadedInspoImage, type InspoFetcher } from './inspo-download';
import { normalize, throwIfAborted } from './operation-support';
import {
  assertBlueprintProjectPath,
  assertContainedWrite,
  assertValidMutation,
  commitProjectMutation,
  jsonFileContent,
  loadCurrentProject,
  withProjectMutation,
  type ProjectFileWrite
} from './project-files';
import { workerProjectValidator, type ProjectValidator } from './project-validation';
import { inspoOutputSchema, type InspoInput, type InspoOutput } from './schemas';

export const INSPO_GITIGNORE = '*\n!.gitignore\n';

export async function inspoBlueprint(
  input: InspoInput,
  signal?: AbortSignal,
  fetcher: InspoFetcher = defaultInspoFetcher,
  validate: ProjectValidator = workerProjectValidator
): Promise<InspoOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
  // A slow image host must not hold other mutations of this project, so each download ends before the mutation takes its place.
  const downloads = input.operation.type === 'add' || input.operation.type === 'sync'
    ? await downloadInspoImages(input.operation, projectRoot, fetcher, signal)
    : NO_DOWNLOADS;
  return withProjectMutation(projectRoot, signal, () => mutateInspo(input, projectRoot, signal, downloads, validate));
}

interface InspoDownloads {
  added?: DownloadedInspoImage;
  /** The image of each entry that had none, or the text of its download error. */
  synced: Map<string, DownloadedInspoImage | string>;
}

const NO_DOWNLOADS: InspoDownloads = { synced: new Map() };

async function downloadInspoImages(
  operation: Extract<InspoInput['operation'], { type: 'add' | 'sync' }>,
  projectRoot: string,
  fetcher: InspoFetcher,
  signal: AbortSignal | undefined
): Promise<InspoDownloads> {
  const current = currentInspoBoard(await loadCurrentProject(projectRoot));
  if (operation.type === 'add') {
    assertNewInspoEntry(current, operation.id ?? nextInspoEntryId(current.entries));
    return { added: await downloadInspoImage(operation.url, fetcher, signal), synced: new Map() };
  }
  const synced: InspoDownloads['synced'] = new Map();
  for (const entry of current.entries) {
    if (INSPO_IMAGE_PATTERN.test(entry.image) && existsSync(path.join(projectRoot, entry.image))) continue;
    try {
      synced.set(entry.id, await downloadInspoImage(entry.sourceUrl, fetcher, signal));
    } catch (error) {
      throwIfAborted(signal);
      synced.set(entry.id, error instanceof Error ? error.message : String(error));
    }
  }
  return { synced };
}

function currentInspoBoard(bundle: BlueprintProjectBundle): InspoFile {
  if (!bundle.inspo && bundle.brand) {
    throw new Error('This sidecar has a brand.json and no inspo.json, so it has no inspo board. Fix: keep the brand as it is, or start a new sidecar with init and start "inspo".');
  }
  return bundle.inspo ?? emptyInspoFile(bundle.manifest.project.id);
}

function assertNewInspoEntry(current: InspoFile, id: string): void {
  if (current.entries.some(entry => entry.id === id)) {
    throw new Error(`Inspo entry "${id}" already exists. Fix: change it with the update operation, or pass another id.`);
  }
}

async function mutateInspo(
  input: InspoInput,
  projectRoot: string,
  signal: AbortSignal | undefined,
  downloads: InspoDownloads,
  validate: ProjectValidator
): Promise<InspoOutput> {
  const bundle = await loadCurrentProject(projectRoot);
  const projectId = bundle.manifest.project.id;
  const current = currentInspoBoard(bundle);
  const operation = input.operation;
  const writes: ProjectFileWrite[] = [];
  const downloaded: string[] = [];
  const failed: InspoOutput['failed'] = [];
  let removedImage: string | undefined;
  let next: InspoFile;

  switch (operation.type) {
    case 'add': {
      const id = operation.id ?? nextInspoEntryId(current.entries);
      assertNewInspoEntry(current, id);
      const sourceUrl = normalizeInspoUrl(operation.url).href;
      const image = downloads.added as DownloadedInspoImage;
      const imageRef = `${INSPO_IMAGE_DIRECTORY}/${id}.${image.extension}`;
      writes.push({ fileRef: imageRef, content: image.bytes });
      downloaded.push(imageRef);
      const entry: InspoEntry = {
        id,
        sourceUrl,
        image: imageRef,
        aspects: operation.aspects ?? [],
        stance: operation.stance ?? 'like',
        note: operation.note ?? '',
        reading: operation.reading ?? ''
      };
      next = { ...current, entries: [...current.entries, entry] };
      break;
    }
    case 'update': {
      findInspoEntry(current, operation.id);
      const fields = definedFields({
        aspects: operation.aspects,
        stance: operation.stance,
        note: operation.note,
        reading: operation.reading
      });
      if (Object.keys(fields).length === 0) {
        throw new Error(`The update of inspo entry "${operation.id}" changes nothing. Fix: pass aspects, stance, note, or reading.`);
      }
      next = { ...current, entries: current.entries.map(entry => entry.id === operation.id ? { ...entry, ...fields } : entry) };
      break;
    }
    case 'remove': {
      const removed = findInspoEntry(current, operation.id);
      const directions = current.directions.map(direction => ({
        ...direction,
        entryIds: direction.entryIds.filter(entryId => entryId !== removed.id)
      }));
      const orphaned = directions.find(direction => direction.entryIds.length === 0);
      if (orphaned) {
        throw new Error(`The "${orphaned.aspect}" direction comes only from inspo entry "${removed.id}". Fix: give the direction other entryIds with the direction operation, then remove the entry.`);
      }
      removedImage = removed.image;
      next = { ...current, entries: current.entries.filter(entry => entry.id !== removed.id), directions };
      break;
    }
    case 'sync': {
      const entries: InspoEntry[] = [];
      for (const entry of current.entries) {
        const image = downloads.synced.get(entry.id);
        if (image === undefined) {
          entries.push(entry);
        } else if (typeof image === 'string') {
          failed.push({ id: entry.id, error: image });
          entries.push(entry);
        } else {
          const imageRef = `${INSPO_IMAGE_DIRECTORY}/${entry.id}.${image.extension}`;
          writes.push({ fileRef: imageRef, content: image.bytes });
          downloaded.push(imageRef);
          entries.push({ ...entry, image: imageRef });
        }
      }
      next = { ...current, entries };
      break;
    }
    case 'direction': {
      const existing = current.directions.find(direction => direction.aspect === operation.aspect);
      if (!existing && (!operation.statement || !operation.entryIds)) {
        throw new Error(`Inspo has no "${operation.aspect}" direction. Fix: pass statement and entryIds to propose it.`);
      }
      if (existing && !operation.statement && !operation.entryIds && !operation.status) {
        throw new Error(`The "${operation.aspect}" direction call changes nothing. Fix: pass statement, entryIds, or status.`);
      }
      const reworded = !existing ||
        (operation.statement !== undefined && operation.statement !== existing.statement) ||
        (operation.entryIds !== undefined && operation.entryIds.join('\n') !== existing.entryIds.join('\n'));
      const direction: InspoDirection = {
        aspect: operation.aspect,
        statement: operation.statement ?? existing!.statement,
        entryIds: operation.entryIds ?? existing!.entryIds,
        status: operation.status ?? (reworded ? 'proposed' : existing.status)
      };
      next = {
        ...current,
        directions: existing
          ? current.directions.map(item => item === existing ? direction : item)
          : [...current.directions, direction]
      };
      break;
    }
  }

  throwIfAborted(signal);
  const projected = { ...bundle, inspo: next };
  const check = await assertValidMutation(projected, validate, signal);
  writes.push({ fileRef: 'inspo.json', content: jsonFileContent(next) });
  if (!existsSync(path.join(projectRoot, INSPO_IMAGE_DIRECTORY, '.gitignore'))) {
    writes.push({ fileRef: `${INSPO_IMAGE_DIRECTORY}/.gitignore`, content: INSPO_GITIGNORE });
  }
  await commitProjectMutation(projectRoot, writes, check, validate, signal);
  if (removedImage) {
    await removeInspoImage(projectRoot, removedImage);
  }

  return inspoOutputSchema.parse({
    command: 'inspo',
    operation: operation.type,
    project: normalize(projectRoot),
    projectId,
    inspo: next,
    downloaded,
    failed
  });
}

export function emptyInspoFile(projectId: string): InspoFile {
  return { schemaVersion: BLUEPRINT_SCHEMA_VERSION, projectId, entries: [], directions: [] };
}

function nextInspoEntryId(entries: readonly InspoEntry[]): string {
  const taken = new Set(entries.map(entry => entry.id));
  let index = entries.length + 1;
  while (taken.has(`ref-${index}`)) index += 1;
  return `ref-${index}`;
}

function findInspoEntry(inspo: InspoFile, id: string): InspoEntry {
  const entry = inspo.entries.find(item => item.id === id);
  if (!entry) {
    const ids = inspo.entries.map(item => `"${item.id}"`).join(', ');
    throw new Error(`Inspo has no entry "${id}". Fix: use one of these ids: ${ids || 'none, so add an image first'}.`);
  }
  return entry;
}

function definedFields<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

async function removeInspoImage(projectRoot: string, imageRef: string): Promise<void> {
  if (!INSPO_IMAGE_PATTERN.test(imageRef)) return;
  const canonicalRoot = await realpath(projectRoot);
  try {
    const target = await realpath(path.join(canonicalRoot, imageRef));
    assertContainedWrite(canonicalRoot, target, imageRef);
    await rm(target, { force: true });
  } catch {
    return;
  }
}

import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeExplorationBaselineDigest } from '../core/exploration';
import { loadProjectFromFs } from '../core/load';
import type { MigrationOutput } from '../core/migrate';
import { asObject } from '../core/raw-json';
import { ProjectShapeError } from '../core/schemas/issues';
import { explorationRecordRef } from '../core/storage-records';
import type { BlueprintProjectBundle, ValidationResult } from '../core/types';
import { jsonFileContent, writeProjectFiles } from './project-files';

export type ToolValidation = Pick<ValidationResult, 'ok' | 'errors'>;

type Validate = (bundle: BlueprintProjectBundle, signal?: AbortSignal) => Promise<ToolValidation>;

interface MigrationValidation {
  projectId: string;
  validation: ToolValidation;
}

async function projectIdOnDisk(root: string): Promise<string> {
  const id = asObject(asObject(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))).project).id;
  return typeof id === 'string' ? id : '';
}

/** A file that still does not fit its schema must not stop migrate, because the agent needs the repairs and the list of what is left. */
async function refusalOf<T extends MigrationValidation | undefined>(root: string, read: () => Promise<T>): Promise<T | MigrationValidation> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof ProjectShapeError)) throw error;
    return { projectId: await projectIdOnDisk(root), validation: { ok: false, errors: [...error.issues] } };
  }
}

async function validateCurrent(root: string, validate: Validate, signal?: AbortSignal): Promise<MigrationValidation | undefined> {
  const bundle = await loadProjectFromFs(root);
  const digestsCurrent = bundle.explorations.explorations.every(exploration =>
    computeExplorationBaselineDigest(bundle, exploration.id) === exploration.target.baseDigest);
  return digestsCurrent ? { projectId: bundle.manifest.project.id, validation: await validate(bundle, signal) } : undefined;
}

async function validateScratch(scratch: string, migration: MigrationOutput, validate: Validate, signal?: AbortSignal): Promise<MigrationValidation> {
  await writeProjectFiles(scratch, migration.writes);
  let bundle = await loadProjectFromFs(scratch);
  const digestWrites = new Map<string, string>();
  for (const exploration of bundle.explorations.explorations) {
    const baseDigest = computeExplorationBaselineDigest(bundle, exploration.id);
    if (baseDigest === exploration.target.baseDigest) continue;
    const recordRef = explorationRecordRef(exploration.id);
    const record = JSON.parse(await readFile(path.join(scratch, recordRef), 'utf8'));
    record.exploration.target.baseDigest = baseDigest;
    digestWrites.set(recordRef, jsonFileContent(record));
    migration.changes.push(`exploration ${exploration.id}: recomputed target.baseDigest for the migrated baseline.`);
  }
  if (digestWrites.size > 0) {
    await writeProjectFiles(scratch, digestWrites);
    for (const [fileRef, content] of digestWrites) migration.writes.set(fileRef, content);
    bundle = await loadProjectFromFs(scratch);
  }
  return { projectId: bundle.manifest.project.id, validation: await validate(bundle, signal) };
}

/** Validates what migrate would leave, on a scratch copy, and writes each stale exploration digest into the migration. */
export async function validateMigration(projectRoot: string, migration: MigrationOutput, validate: Validate, signal?: AbortSignal): Promise<MigrationValidation> {
  if (migration.writes.size === 0) {
    const current = await refusalOf(projectRoot, () => validateCurrent(projectRoot, validate, signal));
    if (current) return current;
  }
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'blueprint-migrate-')));
  try {
    await cp(projectRoot, scratch, { recursive: true, dereference: true });
    return await refusalOf(scratch, () => validateScratch(scratch, migration, validate, signal));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

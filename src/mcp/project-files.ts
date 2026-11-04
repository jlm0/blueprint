import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadProjectFromFs } from '../core/load';
import { assertCurrentSchema } from '../core/schema-version';
import type { BlueprintProjectBundle, ValidationResult } from '../core/types';
import { normalize } from './operation-support';

export interface ProjectFileWrite {
  fileRef: string;
  content: string | Buffer;
}

interface AppliedProjectFile {
  target: string;
  original?: Buffer;
}

interface ProjectFileTransaction {
  rollback: () => Promise<void>;
}

export type ProjectValidator = (bundle: BlueprintProjectBundle) => ValidationResult;

export function assertValidMutation(bundle: BlueprintProjectBundle, validate: ProjectValidator): void {
  const validation = validate(bundle);
  if (!validation.ok) {
    throw new Error(`The change failed baseline validation, so Blueprint wrote nothing. Fix: correct each error below, then call the tool again.\n${validation.errors.join('\n')}`);
  }
}

export async function assertPersistedProjectValid(
  projectRoot: string,
  projected: BlueprintProjectBundle,
  validate: ProjectValidator
): Promise<void> {
  const persisted = await loadProjectFromFs(projectRoot);
  if (isDeepStrictEqual(comparableMutationBundle(persisted), comparableMutationBundle(projected))) {
    return;
  }
  const validation = validate(persisted);
  if (!validation.ok) {
    throw new Error(`Persisted exploration mutation failed baseline validation:\n${validation.errors.join('\n')}`);
  }
}

// Baseline validation reads neither the sourceFiles path index nor the record order, and projections keep neither as the loader does.
function comparableMutationBundle(bundle: BlueprintProjectBundle): unknown {
  return {
    ...bundle,
    sourceFiles: undefined,
    explorations: {
      ...bundle.explorations,
      explorations: [...bundle.explorations.explorations].sort((left, right) => compareText(left.id, right.id))
    },
    history: {
      ...bundle.history,
      entries: [...bundle.history.entries].sort((left, right) => compareText(left.screenId, right.screenId) || left.version - right.version)
    }
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function jsonFileContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Applies a small set of sidecar writes through sibling temporary files. If a
 * later rename or persisted validation fails, every applied target is restored
 * to its prior bytes and newly created files are removed.
 */
export async function applyProjectFileTransaction(
  projectRoot: string,
  requestedWrites: ProjectFileWrite[]
): Promise<ProjectFileTransaction> {
  const canonicalRoot = await realpath(projectRoot);
  const uniqueWrites = new Map<string, ProjectFileWrite>();
  for (const write of requestedWrites) {
    assertSafeProjectFileRef(write.fileRef);
    const existing = uniqueWrites.get(write.fileRef);
    if (existing) {
      const existingBytes = Buffer.isBuffer(existing.content) ? existing.content : Buffer.from(existing.content);
      const nextBytes = Buffer.isBuffer(write.content) ? write.content : Buffer.from(write.content);
      if (!existingBytes.equals(nextBytes)) {
        throw new Error(`Exploration mutation produced conflicting writes for "${write.fileRef}".`);
      }
      continue;
    }
    uniqueWrites.set(write.fileRef, write);
  }

  const prepared: Array<AppliedProjectFile & { temp: string }> = [];
  try {
    for (const write of uniqueWrites.values()) {
      const lexicalTarget = path.resolve(canonicalRoot, write.fileRef);
      assertContainedWrite(canonicalRoot, lexicalTarget, write.fileRef);
      const parent = path.dirname(lexicalTarget);
      await assertExistingAncestorContained(canonicalRoot, parent, write.fileRef);
      await mkdir(parent, { recursive: true });
      const canonicalParent = await realpath(parent);
      assertContainedWrite(canonicalRoot, canonicalParent, write.fileRef);

      let target = path.join(canonicalParent, path.basename(lexicalTarget));
      let original: Buffer | undefined;
      try {
        const canonicalTarget = await realpath(lexicalTarget);
        assertContainedWrite(canonicalRoot, canonicalTarget, write.fileRef);
        target = canonicalTarget;
        original = await readFile(canonicalTarget);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw error;
        }
      }

      const temp = path.join(canonicalParent, `.${path.basename(lexicalTarget)}.blueprint-${randomUUID()}.tmp`);
      await writeFile(temp, write.content, { flag: 'wx' });
      prepared.push({ target, original, temp });
    }
  } catch (error) {
    await Promise.allSettled(prepared.map(entry => unlink(entry.temp)));
    throw error;
  }

  const applied: AppliedProjectFile[] = [];
  try {
    for (const entry of prepared) {
      await rename(entry.temp, entry.target);
      applied.push({ target: entry.target, ...(entry.original ? { original: entry.original } : {}) });
    }
  } catch (error) {
    await Promise.allSettled(prepared.map(entry => unlink(entry.temp)));
    try {
      await rollbackAppliedFiles(applied);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Exploration file transaction and rollback both failed.');
    }
    throw error;
  }

  let rolledBack = false;
  return {
    rollback: async () => {
      if (rolledBack) {
        return;
      }
      rolledBack = true;
      await rollbackAppliedFiles(applied);
    }
  };
}

async function rollbackAppliedFiles(applied: AppliedProjectFile[]): Promise<void> {
  const errors: unknown[] = [];
  for (const entry of [...applied].reverse()) {
    try {
      if (entry.original === undefined) {
        await unlink(entry.target).catch(error => {
          if (!isNodeError(error) || error.code !== 'ENOENT') {
            throw error;
          }
        });
        continue;
      }
      const temp = path.join(path.dirname(entry.target), `.${path.basename(entry.target)}.rollback-${randomUUID()}.tmp`);
      await writeFile(temp, entry.original, { flag: 'wx' });
      await rename(temp, entry.target);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to roll back one or more Blueprint exploration files.');
  }
}

async function assertExistingAncestorContained(root: string, targetParent: string, fileRef: string): Promise<void> {
  let current = targetParent;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Exploration write "${fileRef}" has no existing contained parent.`);
    }
    current = parent;
  }
  const canonicalAncestor = await realpath(current);
  assertContainedWrite(root, canonicalAncestor, fileRef);
}

function assertSafeProjectFileRef(fileRef: string): void {
  const normalized = fileRef.replace(/\\/g, '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.includes('://') ||
    normalized.split('/').some(segment => segment === '..')
  ) {
    throw new Error(`Exploration write path "${fileRef}" must stay inside the Blueprint project.`);
  }
}

export function assertContainedWrite(root: string, target: string, fileRef: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Exploration write "${fileRef}" resolves outside the canonical Blueprint project root.`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export async function loadCurrentProject(projectRoot: string): Promise<BlueprintProjectBundle> {
  const bundle = await loadProjectFromFs(projectRoot);
  assertCurrentSchema(bundle);
  return bundle;
}

export async function writeProjectFiles(projectRoot: string, writes: Map<string, string>): Promise<void> {
  for (const [fileRef, content] of writes) {
    assertSafeProjectFileRef(fileRef);
    const target = path.join(projectRoot, fileRef);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

export function assertBlueprintProjectPath(projectRoot: string): void {
  if (!existsSync(projectRoot)) {
    throw new Error(`Blueprint project path not found: ${normalize(projectRoot)}.`);
  }
  for (const fileName of ['manifest.json', 'tokens.json', 'primitives.json', 'screens.json']) {
    const filePath = path.join(projectRoot, fileName);
    if (!existsSync(filePath)) {
      throw new Error(`Missing Blueprint project file: ${normalize(filePath)}.`);
    }
  }
}

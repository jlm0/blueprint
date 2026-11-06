import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadProjectFromFs } from '../core/load';
import { assertCurrentSchema } from '../core/schema-version';
import type { BlueprintProjectBundle, ValidationResult } from '../core/types';
import { normalize, runInOrder, throwIfAborted } from './operation-support';
import type { ProjectCheck, ProjectValidator } from './project-validation';
import { scheduleOwnedServeReloads } from './serve-runtimes';

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
  /** Call after the writes pass validation, so a serve runtime of this process holds them before the tool returns. */
  announce: () => void;
}

const projectMutations = new Map<string, Promise<void>>();

/** An archive changes only the lifecycle of an exploration, so an error that the project held before the call does not stop it. */
export interface AddedErrorsGate {
  addedTo: BlueprintProjectBundle;
}

/** `inspo` edits no design file, so a style error stops only the tools that change the design. */
export type MutationGate = 'all-errors' | 'contract-errors' | AddedErrorsGate;

function gated(result: ValidationResult, gate: 'all-errors' | 'contract-errors'): string[] {
  return gate === 'contract-errors' ? result.contractErrors : result.errors;
}

function addedErrors(before: readonly string[], after: readonly string[]): string[] {
  const held = new Map<string, number>();
  for (const error of before) held.set(error, (held.get(error) ?? 0) + 1);
  return after.filter(error => {
    const count = held.get(error) ?? 0;
    held.set(error, count - 1);
    return count <= 0;
  });
}

// A worker check leaves the event loop free, so another mutation of this project must wait until this commit ends.
export async function withProjectMutation<T>(projectRoot: string, signal: AbortSignal | undefined, mutate: () => Promise<T>): Promise<T> {
  return runInOrder(projectMutations, realpathSync.native(projectRoot), signal, mutate);
}

/** A reader that waits here sees the memo of the commit, and it does not join the queue, so it holds no later mutation. */
export function settledProjectMutations(projectRoot: string): Promise<void> {
  const tail = existsSync(projectRoot) ? projectMutations.get(realpathSync.native(projectRoot)) : undefined;
  return tail ?? Promise.resolve();
}

export async function assertValidMutation(
  bundle: BlueprintProjectBundle,
  validate: ProjectValidator,
  signal?: AbortSignal,
  gate: MutationGate = 'all-errors',
  nameFiles: (error: string) => string = error => error
): Promise<ProjectCheck> {
  const check = await validate.projected(bundle, signal);
  if (typeof gate === 'object') {
    const added = check.errors.length === 0 ? [] : addedErrors((await validate.projected(gate.addedTo, signal)).errors, check.errors);
    if (added.length > 0) {
      throw new Error(`The change adds the errors below, so Blueprint wrote nothing. Fix: correct each error below, then call the tool again.\n${added.map(error => nameFiles(error)).join('\n')}`);
    }
    return check;
  }
  const errors = gated(check, gate);
  if (errors.length > 0) {
    throw new Error(`The change failed baseline validation, so Blueprint wrote nothing. Fix: correct each error below, then call the tool again.\n${errors.map(error => nameFiles(error)).join('\n')}`);
  }
  return check;
}

export async function assertPersistedProjectValid(
  projectRoot: string,
  projected: ProjectCheck,
  validate: ProjectValidator,
  signal?: AbortSignal,
  gate: MutationGate = 'all-errors'
): Promise<void> {
  const persisted = await validate.persisted(projectRoot, projected.fingerprint, signal);
  const errors = typeof gate === 'object' ? addedErrors(projected.errors, persisted.errors) : gated(persisted, gate);
  if (errors.length > 0) {
    throw new Error(`Persisted exploration mutation failed baseline validation:\n${errors.join('\n')}`);
  }
}

export async function commitProjectMutation(
  projectRoot: string,
  writes: ProjectFileWrite[],
  projected: ProjectCheck,
  validate: ProjectValidator,
  signal?: AbortSignal,
  gate: MutationGate = 'all-errors'
): Promise<void> {
  throwIfAborted(signal);
  const transaction = await applyProjectFileTransaction(projectRoot, writes);
  try {
    throwIfAborted(signal);
    await assertPersistedProjectValid(projectRoot, projected, validate, signal, gate);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  transaction.announce();
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
        throw new Error(`Exploration mutation produced conflicting writes for "${write.fileRef}". Fix: give each source in this change its own path, so that "${write.fileRef}" has one content.`);
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
      throw new AggregateError([error, rollbackError], 'Exploration file transaction and rollback both failed. Fix: run git status in the project, restore each changed file with git restore, then call the tool again.');
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
    },
    announce: () => scheduleOwnedServeReloads(canonicalRoot, [...uniqueWrites.keys()])
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
    throw new AggregateError(errors, 'Failed to roll back one or more Blueprint exploration files. Fix: run git status in the project, restore each changed file with git restore, then call the tool again.');
  }
}

async function assertExistingAncestorContained(root: string, targetParent: string, fileRef: string): Promise<void> {
  let current = targetParent;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Exploration write "${fileRef}" has no existing contained parent. Fix: create the project directory, then call the tool again.`);
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
    throw new Error(`Exploration write path "${fileRef}" must stay inside the Blueprint project. Fix: pass a relative path inside the project, with no ".." segment.`);
  }
}

export function assertContainedWrite(root: string, target: string, fileRef: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Exploration write "${fileRef}" resolves outside the canonical Blueprint project root. Fix: replace the symbolic link in this path with a directory inside the project, or pass a path inside the project.`);
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
    throw new Error(`Blueprint project path not found: ${normalize(projectRoot)}. Fix: pass the directory that holds manifest.json, or create a project there with the init tool.`);
  }
  for (const fileName of ['manifest.json', 'tokens.json', 'primitives.json', 'screens.json']) {
    const filePath = path.join(projectRoot, fileName);
    if (!existsSync(filePath)) {
      throw new Error(`Missing Blueprint project file: ${normalize(filePath)}. Fix: restore ${fileName} from git, or pass the project directory that holds it.`);
    }
  }
}

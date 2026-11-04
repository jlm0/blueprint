import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import type { BlueprintOutdatedFile } from '../core/activity';
import { canvasLocationParams } from '../core/canvas-location';
import { collectDesignFindings, type DesignFinding } from '../core/findings';
import { loadProjectFromFs } from '../core/load';
import { collectProseAdvisories, type ProseAdvisory } from '../core/prose-advisories';
import { BLUEPRINT_SCHEMA_VERSION, fileSchemaVersions } from '../core/schema-version';
import { selectionSourceFiles } from '../core/selection';
import type { BlueprintProjectBundle, PrototypeSourceGraphIssue, ValidationResult } from '../core/types';
import { inspectPrototypeSourceGraph } from '../prototype/compiler';
import { validateProject, validateProjectReadiness } from '../prototype/validate-project';
import { loadCurrentProject } from './project-files';
import type {
  ProjectCheck,
  ProjectValidationReply,
  ProjectValidationTask,
  ProjectValidationWorkerData,
  ValidatedProject,
  ValidationMemoEntry,
  ValidationReport,
  ValidationReportMode,
  ValidationRun
} from './project-validation';

export interface ProjectValidationSteps {
  load?: (projectRoot: string) => Promise<BlueprintProjectBundle>;
  validate?: (bundle: BlueprintProjectBundle) => ValidationResult;
}

const workerCodeHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const fingerprints = new WeakMap<BlueprintProjectBundle, string>();
const prototypeFileChecks = new WeakMap<BlueprintProjectBundle, Map<string, { ref: string; exists: boolean }>>();

// A baseline or strict result reads `sourceRoot` only to find the missing prototype files and never reads `sourceFiles`, which a projection keeps stale.
export function projectFingerprint(bundle: BlueprintProjectBundle): string {
  const known = fingerprints.get(bundle);
  if (known) return known;
  const fields: Record<string, unknown> = {
    ...bundle,
    sourceRoot: undefined,
    sourceFiles: undefined,
    explorations: {
      ...bundle.explorations,
      explorations: [...bundle.explorations.explorations].sort((left, right) => compareText(left.id, right.id))
    },
    history: {
      ...bundle.history,
      entries: [...bundle.history.entries].sort((left, right) => compareText(left.screenId, right.screenId) || left.version - right.version)
    },
    prototypeSourceContents: sortedEntries(bundle.prototypeSourceContents),
    prototypeAssetContents: sortedEntries(bundle.prototypeAssetContents),
    missingPrototypeFiles: missingPrototypeFiles(bundle),
    workerCodeHash
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(sortedEntries(fields))).digest('hex');
  fingerprints.set(bundle, fingerprint);
  return fingerprint;
}

function sortedEntries(record: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(record).sort(([left], [right]) => compareText(left, right));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function missingPrototypeFiles(bundle: BlueprintProjectBundle): string[] {
  return [...checkPrototypeFiles(bundle).values()].filter(file => !file.exists).map(file => file.ref).sort(compareText);
}

// The fingerprint and the rules read this one result, because a file can change while a validation runs.
function checkPrototypeFiles(bundle: BlueprintProjectBundle): Map<string, { ref: string; exists: boolean }> {
  const known = prototypeFileChecks.get(bundle);
  if (known) return known;
  const refs = new Set<unknown>();
  const owners = [...listOf(bundle.primitives?.primitives), ...listOf(bundle.components?.components), ...listOf(bundle.screens?.screens)];
  for (const owner of owners) {
    const prototype = (owner as { prototype?: { source?: unknown; styles?: unknown; assetRefs?: unknown } } | null)?.prototype;
    refs.add(prototype?.source);
    for (const ref of [...listOf(prototype?.styles), ...listOf(prototype?.assetRefs)]) refs.add(ref);
  }
  const checks = new Map<string, { ref: string; exists: boolean }>();
  for (const ref of refs) {
    if (typeof ref === 'string') {
      const filePath = path.resolve(bundle.sourceRoot, ref);
      checks.set(filePath, { ref, exists: existsSync(filePath) });
    }
  }
  prototypeFileChecks.set(bundle, checks);
  return checks;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export class ProjectValidationSession {
  readonly memo: ValidationMemoEntry;
  readonly runs: ValidationRun[] = [];
  readonly #bundle: BlueprintProjectBundle;

  constructor(bundle: BlueprintProjectBundle, memo: readonly ValidationMemoEntry[]) {
    const fingerprint = projectFingerprint(bundle);
    this.#bundle = bundle;
    this.memo = memo.find(entry => entry.fingerprint === fingerprint) ?? { fingerprint };
  }

  #fileExists = (filePath: string): boolean => checkPrototypeFiles(this.#bundle).get(filePath)?.exists ?? existsSync(filePath);

  sourceGraphIssues = (): PrototypeSourceGraphIssue[] => {
    this.memo.sourceGraphIssues ??= this.#run('source-graph', () => inspectPrototypeSourceGraph(this.#bundle));
    return this.memo.sourceGraphIssues;
  };

  result(mode: 'baseline' | 'strict'): ValidationResult {
    this.memo[mode] ??= this.#run(mode, () => validateProject(this.#bundle, { mode, fileExists: this.#fileExists }, this.sourceGraphIssues));
    return this.memo[mode];
  }

  report(mode: ValidationReportMode): ValidationReport {
    if (mode === 'readiness') {
      return this.#readinessReport();
    }
    const result = this.result(mode);
    return { projectId: this.#bundle.manifest.project.id, ...result, ...this.#advisories() };
  }

  // A readiness report reads the disk, so each call runs its rules again and reuses only the memoized source graph and baseline.
  #readinessReport(): ValidationReport {
    const known = this.result('baseline');
    const { baseline, readiness } = this.#run('readiness', () => validateProjectReadiness(this.#bundle, this.sourceGraphIssues, known));
    return {
      projectId: this.#bundle.manifest.project.id,
      ok: baseline.ok && readiness.tier !== 'blocked',
      errors: baseline.errors,
      ...this.#advisories(),
      readiness
    };
  }

  #advisories(): { findings: DesignFinding[]; prose: ProseAdvisory[] } {
    this.memo.findings ??= advisoryDesignFindings(this.#bundle);
    this.memo.prose ??= proseAdvisories(this.#bundle);
    return { findings: this.memo.findings, prose: this.memo.prose };
  }

  #run<T>(run: ValidationRun, execute: () => T): T {
    this.runs.push(run);
    return execute();
  }
}

function advisoryDesignFindings(bundle: BlueprintProjectBundle): DesignFinding[] {
  try {
    return collectDesignFindings(bundle);
  } catch {
    return [];
  }
}

function proseAdvisories(bundle: BlueprintProjectBundle): ProseAdvisory[] {
  try {
    return collectProseAdvisories(bundle);
  } catch {
    return [];
  }
}

export async function readValidatedProject(projectRoot: string, steps: ProjectValidationSteps = {}): Promise<ValidatedProject> {
  let outdatedFiles: BlueprintOutdatedFile[] = [];
  try {
    const bundle = await (steps.load ?? loadProjectFromFs)(projectRoot);
    outdatedFiles = fileSchemaVersions(bundle)
      .filter(([, version]) => version !== BLUEPRINT_SCHEMA_VERSION)
      .map(([file, version]) => ({ file, version: String(version) }));
    const validation = (steps.validate ?? validateProject)(bundle);
    if (!validation.ok) {
      throw new Error(`Blueprint project failed baseline validation:\n${validation.errors.join('\n')}`);
    }
    return {
      bundle,
      outdatedFiles: [],
      fingerprint: projectFingerprint(bundle),
      assetHashes: hashProjectAssets(bundle)
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), outdatedFiles };
  }
}

export function hashProjectAssets(bundle: BlueprintProjectBundle): Record<string, string> {
  return Object.fromEntries(Object.entries(bundle.prototypeAssetContents).map(([assetRef, asset]) => [
    assetRef,
    createHash('sha256').update(Buffer.from(asset.base64, 'base64')).digest('hex')
  ]));
}

export async function answerProjectTask(task: ProjectValidationTask, memo: readonly ValidationMemoEntry[]): Promise<ProjectValidationReply> {
  let session: ProjectValidationSession | undefined;
  const validation = (bundle: BlueprintProjectBundle): ProjectValidationSession => {
    session = new ProjectValidationSession(bundle, memo);
    return session;
  };
  try {
    const value = await runProjectTask(task, validation);
    return session ? { value, memo: session.memo, runs: session.runs } : { value, runs: [] };
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}

async function runProjectTask(
  task: ProjectValidationTask,
  validation: (bundle: BlueprintProjectBundle) => ProjectValidationSession
): Promise<unknown> {
  switch (task.kind) {
    case 'read':
      return readValidatedProject(task.projectRoot, { validate: bundle => validation(bundle).result('baseline') });
    case 'report':
      return validation(await loadProjectFromFs(task.project)).report(task.mode);
    case 'projected': {
      const check: ProjectCheck = { ...validation(task.bundle).result('baseline'), fingerprint: projectFingerprint(task.bundle) };
      return check;
    }
    case 'persisted': {
      const persisted = await loadProjectFromFs(task.projectRoot);
      if (projectFingerprint(persisted) === task.projectedFingerprint) return { ok: true, errors: [] };
      return validation(persisted).result('baseline');
    }
    case 'canvas-location':
      return canvasLocationParams(await loadCurrentProject(task.projectRoot), task.focus);
    case 'selection-files':
      return selectionSourceFiles(await loadCurrentProject(task.projectRoot), task.selection);
  }
}

if (parentPort) {
  const { task, memo } = workerData as ProjectValidationWorkerData;
  parentPort.postMessage(await answerProjectTask(task, memo));
}

import { channel } from 'node:diagnostics_channel';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, type ResourceLimits } from 'node:worker_threads';
import type { BlueprintOutdatedFile } from '../core/activity';
import type { DesignFinding } from '../core/findings';
import type { ProseAdvisory } from '../core/prose-advisories';
import type { BlueprintCanvasSelection } from '../core/selection';
import type {
  BlueprintProjectBundle,
  PrototypeSourceGraphIssue,
  ReadinessReport,
  ValidationResult
} from '../core/types';
import { abortError, runInOrder } from './operation-support';

export type ValidatedProject = ValidProject | InvalidProject;

export interface ValidProject {
  bundle: BlueprintProjectBundle;
  error?: undefined;
  outdatedFiles: BlueprintOutdatedFile[];
  /** Hash of each input of the validation result, so a reload can tell whether anything changed. */
  fingerprint: string;
  assetHashes: Record<string, string>;
}

export interface InvalidProject {
  bundle?: undefined;
  error: string;
  outdatedFiles: BlueprintOutdatedFile[];
  fingerprint?: undefined;
  assetHashes?: undefined;
}

export type ProjectReader = (projectRoot: string, signal?: AbortSignal) => Promise<ValidatedProject>;

export interface ProjectCheck extends ValidationResult {
  fingerprint: string;
}

export interface ProjectValidator {
  projected: (bundle: BlueprintProjectBundle, signal?: AbortSignal) => Promise<ProjectCheck>;
  persisted: (projectRoot: string, projectedFingerprint: string, signal?: AbortSignal) => Promise<ValidationResult>;
}

export type ValidationReportMode = 'baseline' | 'strict' | 'readiness';

export interface ValidationReport extends ValidationResult {
  projectId: string;
  findings: DesignFinding[];
  prose: ProseAdvisory[];
  readiness?: ReadinessReport;
}

export type ProjectValidationTask =
  | { kind: 'read'; projectRoot: string }
  | { kind: 'report'; project: string; mode: ValidationReportMode }
  | { kind: 'projected'; bundle: BlueprintProjectBundle }
  | { kind: 'persisted'; projectRoot: string; projectedFingerprint: string }
  | { kind: 'canvas-location'; projectRoot: string; focus: string }
  | { kind: 'selection-files'; projectRoot: string; selection: BlueprintCanvasSelection };

export interface ValidationMemoEntry {
  fingerprint: string;
  sourceGraphIssues?: PrototypeSourceGraphIssue[];
  baseline?: ValidationResult;
  strict?: ValidationResult;
  findings?: DesignFinding[];
  prose?: ProseAdvisory[];
}

export type ValidationRun = 'source-graph' | 'baseline' | 'strict' | 'readiness';

export interface ProjectValidationWorkerData {
  task: ProjectValidationTask;
  memo: ValidationMemoEntry[];
}

export type ProjectValidationReply =
  | { value: unknown; memo?: ValidationMemoEntry; runs: ValidationRun[] }
  | { thrown: string };

export interface ProjectValidationRunMessage {
  run: ValidationRun;
  fingerprint: string;
}

export interface ProjectWorkerOptions {
  url?: URL;
  deadlineMs?: number;
  resourceLimits?: ResourceLimits;
}

const VALIDATION_MEMO_CAPACITY = 8;
const PROJECT_TASK_DEADLINE_MS = 300_000;
const WORKER_FAILURE_FIX = 'Fix: call the tool again. If the validation stops again, free memory on this machine or make the project smaller.';

const validationMemo = new Map<string, ValidationMemoEntry>();
const diskValidations = new Map<string, Promise<void>>();

// The count guard reads this channel, because only the worker knows a real run from a memo answer.
export const projectValidationRuns = channel('blueprint:project-validation-run');

export function createWorkerValidator(options: ProjectWorkerOptions = {}): ProjectValidator {
  return {
    projected: (bundle, signal) => runProjectTask<ProjectCheck>({ kind: 'projected', bundle }, signal, options),
    persisted: (projectRoot, projectedFingerprint, signal) =>
      runProjectTask<ValidationResult>({ kind: 'persisted', projectRoot, projectedFingerprint }, signal, options)
  };
}

export const workerProjectValidator = createWorkerValidator();

export const loadValidatedProject: ProjectReader = (projectRoot, signal) => {
  return runInOrder(diskValidations, path.resolve(projectRoot), signal, () =>
    runProjectTask<ValidatedProject>({ kind: 'read', projectRoot }, signal)
  ).catch(error => ({ error: errorMessage(error), outdatedFiles: [] }));
};

export function reportProjectValidation(project: string, mode: ValidationReportMode, signal?: AbortSignal): Promise<ValidationReport> {
  return runInOrder(diskValidations, path.resolve(project), signal, () =>
    runProjectTask<ValidationReport>({ kind: 'report', project, mode }, signal)
  );
}

export function readCanvasLocation(projectRoot: string, focus: string, signal?: AbortSignal): Promise<Record<string, string>> {
  return runProjectTask({ kind: 'canvas-location', projectRoot, focus }, signal);
}

export function readSelectionFiles(projectRoot: string, selection: BlueprintCanvasSelection, signal?: AbortSignal): Promise<string[]> {
  return runProjectTask({ kind: 'selection-files', projectRoot, selection }, signal);
}

// A worker keeps a large sidecar from blocking the MCP event loop, and running out of memory ends only the worker.
function runProjectTask<T>(task: ProjectValidationTask, signal: AbortSignal | undefined, options: ProjectWorkerOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const data: ProjectValidationWorkerData = { task, memo: [...validationMemo.values()] };
    const worker = new Worker(options.url ?? projectValidationWorkerUrl(), {
      workerData: data,
      ...(options.resourceLimits ? { resourceLimits: options.resourceLimits } : {})
    });
    const onAbort = (): void => {
      reject(abortError(signal!));
      void worker.terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const deadline = setTimeout(() => {
      reject(new Error(`Blueprint validation did not answer in time. ${WORKER_FAILURE_FIX}`));
      void worker.terminate();
    }, options.deadlineMs ?? PROJECT_TASK_DEADLINE_MS);
    deadline.unref();
    worker.once('message', (reply: ProjectValidationReply) => {
      if ('thrown' in reply) {
        reject(new Error(reply.thrown));
      } else {
        recordReply(reply);
        resolve(reply.value as T);
      }
      void worker.terminate();
    });
    worker.once('error', error => {
      reject(new Error(`Blueprint validation stopped before it answered: ${error.message}. ${WORKER_FAILURE_FIX}`));
    });
    worker.once('exit', code => {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Blueprint validation stopped with exit code ${code} before it answered. ${WORKER_FAILURE_FIX}`));
    });
  });
}

function recordReply({ memo, runs }: { memo?: ValidationMemoEntry; runs: ValidationRun[] }): void {
  if (!memo) return;
  validationMemo.delete(memo.fingerprint);
  validationMemo.set(memo.fingerprint, memo);
  for (const fingerprint of validationMemo.keys()) {
    if (validationMemo.size <= VALIDATION_MEMO_CAPACITY) break;
    validationMemo.delete(fingerprint);
  }
  for (const run of runs) {
    projectValidationRuns.publish({ run, fingerprint: memo.fingerprint } satisfies ProjectValidationRunMessage);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectValidationWorkerUrl(): URL {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  if (import.meta.url.endsWith('.ts')) {
    return pathToFileURL(path.join(moduleDirectory, 'project-validation-worker.ts'));
  }
  // The MCP build emits each entry, this worker included, in dist/mcp and shared code in dist/mcp/chunks.
  const mcpDirectory = path.basename(moduleDirectory) === 'chunks' ? path.dirname(moduleDirectory) : moduleDirectory;
  return pathToFileURL(path.join(mcpDirectory, 'project-validation-worker.js'));
}

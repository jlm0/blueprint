import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { BlueprintOutdatedFile } from '../core/activity';
import { loadProjectFromFs } from '../core/load';
import { BLUEPRINT_SCHEMA_VERSION, fileSchemaVersions } from '../core/schema-version';
import type { BlueprintProjectBundle, ValidationResult } from '../core/types';
import { validateProject } from '../core/validate';

export type ValidatedProject = ValidProject | InvalidProject;

export interface ValidProject {
  bundle: BlueprintProjectBundle;
  error?: undefined;
  outdatedFiles: BlueprintOutdatedFile[];
  /** Content hash of the bundle, so a reload can tell whether anything changed. */
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

export type ProjectReader = (projectRoot: string) => Promise<ValidatedProject>;

export interface ProjectValidationSteps {
  load?: (projectRoot: string) => Promise<BlueprintProjectBundle>;
  validate?: (bundle: BlueprintProjectBundle) => ValidationResult;
}

/**
 * Loads and validates a project on a worker thread, so a large sidecar never
 * blocks the MCP event loop, and running out of memory ends only the worker.
 */
export const loadValidatedProject: ProjectReader = projectRoot => {
  return new Promise(resolve => {
    const worker = new Worker(projectValidationWorkerUrl(), { workerData: { projectRoot } });
    let answered = false;
    const answer = (result: ValidatedProject): void => {
      if (answered) return;
      answered = true;
      resolve(result);
    };
    worker.once('message', (result: ValidatedProject) => answer(result));
    worker.once('error', error => answer({ error: `Blueprint could not validate the project: ${error.message}`, outdatedFiles: [] }));
    worker.once('exit', code => answer({ error: `Blueprint validation stopped with exit code ${code} before it answered.`, outdatedFiles: [] }));
  });
};

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
      fingerprint: createHash('sha256').update(JSON.stringify(bundle)).digest('hex'),
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

function projectValidationWorkerUrl(): URL {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  if (import.meta.url.endsWith('.ts')) {
    return pathToFileURL(path.join(moduleDirectory, 'project-validation-worker.ts'));
  }
  // The MCP build emits each entry, this worker included, in dist/mcp and shared code in dist/mcp/chunks.
  const mcpDirectory = path.basename(moduleDirectory) === 'chunks' ? path.dirname(moduleDirectory) : moduleDirectory;
  return pathToFileURL(path.join(mcpDirectory, 'project-validation-worker.js'));
}

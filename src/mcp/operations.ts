import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BlueprintProjectBundle,
  ExplorationDefinition,
  ScreenDefinition,
  ScreenHistoryEntry,
} from '../core/types';
import { boundaryId } from '../core/address';
import { canvasLocationParams } from '../core/canvas-location';
import { INSPO_IMAGE_DIRECTORY } from '../core/inspo-contract';
import { loadProjectFromFs } from '../core/load';
import { migrateProjectFiles } from '../core/migrate';
import { selectionReference } from '../core/selection';
import {
  candidateFileNames,
  historyFileNames,
  archiveExploration,
  createExplorationMetadata,
  inspectExploration,
  inspectScreenHistory,
  listExplorations,
  listScreenHistory,
  promoteExploration,
  restoreScreenHistory
} from '../core/exploration';
import {
  explorationRecordFile,
  explorationRecordRef,
  historyRecordFile,
  historyRecordRef
} from '../core/storage-records';
import {
  createExtractionPacket,
  listBoundaryReferences,
  listDeclaredGroups,
  queryPrototypeOnly,
  querySections,
  queryUsedBy,
  queryUses,
  showBoundary
} from '../core/query';
import {
  BLUEPRINT_ACTIVITY_TOKEN_HEADER,
  BLUEPRINT_SELECTION_PATH,
  blueprintActivityRuntimeBaseUrl,
  runtimeDescriptorPattern,
  findLiveBlueprintActivityRuntime,
  withBlueprintServeRuntimeLock,
  type BlueprintActivityRuntimeDescriptor
} from './activity';
import { emptyInspoFile, INSPO_GITIGNORE } from './inspo';
import { validateMigration, type ToolValidation } from './migration-validation';
import { normalize, packageRoot, throwIfAborted, withAbort } from './operation-support';
import {
  applyProjectFileTransaction,
  assertBlueprintProjectPath,
  assertValidMutation,
  commitProjectMutation,
  jsonFileContent,
  loadCurrentProject,
  withProjectMutation,
  type MutationGate,
  type ProjectFileWrite
} from './project-files';
import {
  loadValidatedProject,
  readCanvasLocation,
  readSelectionFiles,
  reportProjectValidation,
  workerProjectValidator,
  type ProjectReader,
  type ProjectValidator,
  type ValidatedProject
} from './project-validation';
import { startServeServer, type CaptureServer, type LocalServeServer, type StoredCanvasSelection } from './serve-server';
import type { ServeProjectSnapshot } from './serve-snapshot';
import {
  exploreOutputSchema,
  extractOutputSchema,
  indexOutputSchema,
  initOutputSchema,
  migrateOutputSchema,
  promoteOutputSchema,
  queryOutputSchema,
  restoreOutputSchema,
  selectionOutputSchema,
  serveOutputSchema,
  validateOutputSchema,
  type ExploreInput,
  type ExploreOutput,
  type ExtractInput,
  type ExtractOutput,
  type IndexInput,
  type IndexOutput,
  type InitInput,
  type InitOutput,
  type MigrateInput,
  type MigrateOutput,
  type PromoteInput,
  type PromoteOutput,
  type QueryInput,
  type QueryOutput,
  type RestoreInput,
  type RestoreOutput,
  type SelectionInput,
  type SelectionOutput,
  type ServeInput,
  type ServeOutput,
  type ValidateInput,
  type ValidateOutput,
  artifactSummarySchema,
  type ArtifactSummary
} from './schemas';

export { captureBlueprint } from './capture';
export { inspoBlueprint } from './inspo';

export interface BlueprintServeHandle extends CaptureServer, ServeOutput {
  port: number;
  baseUrl: string;
  ownership: 'owned' | 'borrowed';
  isAvailable: () => Promise<boolean>;
  settledProject?: () => Promise<ServeProjectSnapshot | undefined>;
  latestProject?: () => ServeProjectSnapshot;
}

export async function initializeBlueprint(input: InitInput, signal?: AbortSignal): Promise<InitOutput> {
  throwIfAborted(signal);
  const { out, projectId, name } = input;
  const destination = path.resolve(out);

  if (existsSync(destination)) {
    const entries = await readdir(destination);
    if (entries.includes('manifest.json')) {
      throw new Error(`Destination is not empty: ${normalize(destination)}. It holds a Blueprint project, and init never writes over a project. Fix: pass an empty out directory. To bring AGENTS.md and the primitives of this project up to the current starter, call migrate.`);
    }
    if (entries.length > 0 && !input.force) {
      throw new Error(`Destination is not empty: ${normalize(destination)}. Retry with force=true to overwrite Blueprint starter files in place. Fix: pass force true to overwrite the starter files, or pass an empty out directory.`);
    }
  }

  throwIfAborted(signal);
  const starterRoot = path.join(packageRoot, 'starter', 'design', 'blueprint');
  await mkdir(destination, { recursive: true });
  await cp(starterRoot, destination, {
    recursive: true,
    force: true,
    ...(input.start === 'inspo' ? { filter: (source: string) => !isStarterBrandPath(starterRoot, source) } : {})
  });
  await rewriteStarterProject(destination, projectId, name);
  if (input.start === 'inspo') {
    await mkdir(path.join(destination, INSPO_IMAGE_DIRECTORY), { recursive: true });
    await writeJsonFile(path.join(destination, 'inspo.json'), emptyInspoFile(projectId));
    await writeFile(path.join(destination, INSPO_IMAGE_DIRECTORY, '.gitignore'), INSPO_GITIGNORE, 'utf8');
  }

  throwIfAborted(signal);
  const validation = await validateOnWorker(await loadProjectFromFs(destination), signal);
  if (!validation.ok) {
    throw new Error(`Initialized project failed baseline validation:\n${validation.errors.join('\n')}`);
  }

  return initOutputSchema.parse({
    command: 'init',
    projectId,
    name,
    out: normalize(destination),
    files: (await readdir(destination)).sort(),
    validation
  });
}

export async function validateBlueprint(input: ValidateInput, signal?: AbortSignal): Promise<ValidateOutput> {
  throwIfAborted(signal);
  const { project, mode } = input;
  const { contractErrors: _contractErrors, styleErrors: _styleErrors, ...report } = await reportProjectValidation(project, mode, signal);
  const output = validateOutputSchema.parse({
    command: 'validate',
    project: normalize(path.resolve(project)),
    mode,
    ...report
  });
  await writeOptionalJsonArtifact(output, input.out);
  return output;
}

export async function migrateBlueprint(input: MigrateInput, signal?: AbortSignal): Promise<MigrateOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
  const starterRoot = path.join(packageRoot, 'starter', 'design', 'blueprint');
  const output = await withProjectMutation(projectRoot, signal, async () => {
    const migration = migrateProjectFiles({
      files: await readProjectTextFiles(projectRoot),
      starterFiles: await readProjectTextFiles(starterRoot)
    });

    throwIfAborted(signal);
    const { projectId, validation } = await validateMigration(projectRoot, migration, validateOnWorker, signal);

    throwIfAborted(signal);
    if (!input.dryRun && migration.writes.size > 0) {
      (await applyProjectFileTransaction(projectRoot, [...migration.writes].map(([fileRef, content]) => ({ fileRef, content })))).announce();
    }
    return migrateOutputSchema.parse({
      command: 'migrate',
      project: normalize(projectRoot),
      projectId,
      dryRun: input.dryRun,
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
      upToDate: migration.upToDate && migration.writes.size === 0,
      changes: migration.changes,
      files: [...migration.writes.keys()].sort(),
      validation
    });
  });
  await writeOptionalJsonArtifact(output, input.out);
  return output;
}

export async function indexBlueprint(input: IndexInput, signal?: AbortSignal): Promise<IndexOutput> {
  throwIfAborted(signal);
  const { project } = input;
  const bundle = await loadCurrentProject(project);
  const output = indexOutputSchema.parse({
    command: 'index',
    project: normalize(path.resolve(project)),
    projectId: bundle.manifest.project.id,
    results: listBoundaryReferences(bundle),
    ...listDeclaredGroups(bundle)
  });
  await writeOptionalJsonArtifact(output, input.out);
  return output;
}

export async function queryBlueprint(input: QueryInput, signal?: AbortSignal): Promise<QueryOutput> {
  throwIfAborted(signal);
  const { project, query } = input;
  const bundle = await loadCurrentProject(project);
  let output: unknown;

  switch (query.type) {
    case 'show':
      output = showBoundary(bundle, query.boundary);
      break;
    case 'uses':
      output = queryUses(bundle, query.boundary);
      break;
    case 'used-by':
      output = queryUsedBy(bundle, query.boundary);
      break;
    case 'sections':
      output = querySections(bundle, query.screen);
      break;
    case 'prototype-only':
      output = queryPrototypeOnly(bundle);
      break;
    case 'explorations': {
      const results = listExplorations(bundle).filter(exploration => (
        (query.screenId === undefined || exploration.target.screenId === query.screenId) &&
        (query.lifecycle === undefined || exploration.lifecycle === query.lifecycle)
      ));
      output = {
        query: 'explorations',
        projectId: bundle.manifest.project.id,
        results
      };
      break;
    }
    case 'exploration':
      output = {
        query: `exploration:${query.explorationId}`,
        projectId: bundle.manifest.project.id,
        results: [inspectExploration(bundle, query.explorationId)]
      };
      break;
    case 'history':
      output = {
        query: 'history',
        projectId: bundle.manifest.project.id,
        results: listScreenHistory(bundle, query.screenId)
      };
      break;
    case 'history-version':
      output = {
        query: `history-version:${query.screenId}:v${query.version}`,
        projectId: bundle.manifest.project.id,
        results: [inspectScreenHistory(bundle, query.screenId, query.version)]
      };
      break;
  }

  const parsed = queryOutputSchema.parse(output);
  await writeOptionalJsonArtifact(parsed, input.out);
  return parsed;
}

export async function extractBlueprint(input: ExtractInput, signal?: AbortSignal): Promise<ExtractOutput> {
  throwIfAborted(signal);
  const { project, boundary, mode } = input;
  const bundle = await loadCurrentProject(project);
  const packet = createExtractionPacket(bundle, boundary, { mode });
  const output = extractOutputSchema.parse(packet);
  await writeOptionalJsonArtifact(output, input.out);
  return output;
}

export async function exploreBlueprint(
  input: ExploreInput,
  signal?: AbortSignal,
  validate: ProjectValidator = workerProjectValidator
): Promise<ExploreOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
  return withProjectMutation(projectRoot, signal, async () => {
    const bundle = await loadCurrentProject(projectRoot);
    const result = input.operation.type === 'create'
      ? createExplorationMetadata(bundle, input.operation)
      : archiveExploration(bundle, input.operation.explorationId);
    const projected = {
      ...bundle,
      explorations: result.explorations,
      prototypeSourceContents: result.prototypeSourceContents
    };
    const gate: MutationGate = input.operation.type === 'create' ? 'all-errors' : { addedTo: bundle };
    const check = await assertValidMutation(projected, validate, signal, gate);
    const output = exploreOutputSchema.parse({
      command: 'explore',
      operation: input.operation.type,
      project: normalize(projectRoot),
      projectId: bundle.manifest.project.id,
      exploration: result.exploration
    });

    await commitProjectMutation(projectRoot, [
      ...result.sourceWrites.map(write => ({ fileRef: write.path, content: write.content })),
      ...explorationMetadataWrites(bundle, result.exploration)
    ], check, validate, signal, gate);
    return output;
  });
}

const SERVE_STYLE_ERROR_LIMIT = 20;

/** What the output of `init` and `migrate` shows. */

export async function promoteBlueprint(
  input: PromoteInput,
  signal?: AbortSignal,
  validate: ProjectValidator = workerProjectValidator
): Promise<PromoteOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
  return withProjectMutation(projectRoot, signal, async () => {
    // The mutation is computed from a fresh filesystem snapshot so the core digest
    // checks are the final read before the bounded file transaction begins.
    const bundle = await loadCurrentProject(projectRoot);
    const result = promoteExploration(bundle, input);
    const projectId = bundle.manifest.project.id;
    const projected = {
      ...bundle,
      screens: result.screens,
      explorations: result.explorations,
      history: result.history,
      prototypeSourceContents: result.prototypeSourceContents
    };
    const check = await assertValidMutation(projected, validate, signal, 'all-errors', candidateFileNames(bundle, input.explorationId, input.candidateId));
    const output = promoteOutputSchema.parse({
      command: 'promote',
      project: normalize(projectRoot),
      projectId,
      explorationId: input.explorationId,
      candidateId: input.candidateId,
      promotedScreen: screenMutationSummary(projectId, result.promotedScreen),
      historicalVersion: historyVersionSummary(result.historicalVersion),
      exploration: result.exploration
    });

    await commitProjectMutation(projectRoot, [
      ...result.sourceWrites.map(write => ({ fileRef: write.path, content: write.content })),
      { fileRef: 'screens.json', content: jsonFileContent(result.screens) },
      ...explorationMetadataWrites(bundle, result.exploration),
      {
        fileRef: historyRecordRef(result.historicalVersion.screenId, result.historicalVersion.version),
        content: jsonFileContent(historyRecordFile(projectId, result.historicalVersion))
      }
    ], check, validate, signal);
    return output;
  });
}

export async function restoreBlueprint(
  input: RestoreInput,
  signal?: AbortSignal,
  validate: ProjectValidator = workerProjectValidator
): Promise<RestoreOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
  return withProjectMutation(projectRoot, signal, async () => {
    const bundle = await loadCurrentProject(projectRoot);
    const result = restoreScreenHistory(bundle, input);
    const projectId = bundle.manifest.project.id;
    const projected = {
      ...bundle,
      screens: result.screens,
      history: result.history,
      prototypeSourceContents: result.prototypeSourceContents
    };
    const check = await assertValidMutation(projected, validate, signal, 'all-errors', historyFileNames(bundle, input.screenId, input.version));
    const output = restoreOutputSchema.parse({
      command: 'restore',
      project: normalize(projectRoot),
      projectId,
      restoredFromVersion: input.version,
      restoredScreen: screenMutationSummary(projectId, result.restoredScreen),
      historicalVersion: historyVersionSummary(result.historicalVersion)
    });

    await commitProjectMutation(projectRoot, [
      ...result.sourceWrites.map(write => ({ fileRef: write.path, content: write.content })),
      { fileRef: 'screens.json', content: jsonFileContent(result.screens) },
      {
        fileRef: historyRecordRef(result.historicalVersion.screenId, result.historicalVersion.version),
        content: jsonFileContent(historyRecordFile(projectId, result.historicalVersion))
      }
    ], check, validate, signal);
    return output;
  });
}

function isStarterBrandPath(starterRoot: string, source: string): boolean {
  const relative = path.relative(starterRoot, source).split(path.sep).join('/');
  return relative === 'brand.json' || relative === 'brand' || relative.startsWith('brand/');
}

export async function blueprintServeRuntimeKey(project: string): Promise<string> {
  const projectRoot = path.resolve(project);
  assertBlueprintProjectPath(projectRoot);
  return normalize(await realpath(projectRoot));
}

export async function serveBlueprint(
  input: ServeInput,
  signal?: AbortSignal,
  existing?: BlueprintServeHandle,
  read: ProjectReader = loadValidatedProject
): Promise<BlueprintServeHandle> {
  throwIfAborted(signal);
  const project = input.project;
  const projectRoot = path.resolve(project);
  assertBlueprintProjectPath(projectRoot);
  const projectKey = await blueprintServeRuntimeKey(projectRoot);
  if (existing && await blueprintServeRuntimeKey(existing.project) !== projectKey) {
    throw new Error('Cannot reuse a Blueprint review runtime for a different project. Fix: call serve with the project path of the running runtime, or restart the MCP server.');
  }

  let reusable = existing;
  if (reusable && !await reusable.isAvailable()) {
    await reusable.close().catch(() => undefined);
    reusable = undefined;
  }

  let selection: ServeOutput['selection'];
  let validated: ValidatedProject | undefined;
  const snapshotBundle = input.explorationId || input.focus ? await settledBundle(reusable, signal) : undefined;
  if (input.explorationId) {
    const explorationId = input.explorationId;
    let bundle = snapshotBundle;
    if (!bundle?.explorations.explorations.some(exploration => exploration.id === explorationId)) {
      validated = await read(projectRoot, signal);
      if (!validated.bundle || validated.error !== undefined) {
        throw new Error(validated.error ?? 'Blueprint project is unavailable. Fix: call validate on this project, then apply the Fix line of each error.');
      }
      bundle = validated.bundle;
    }
    const inspection = inspectExploration(bundle, explorationId);
    selection = {
      kind: 'exploration',
      explorationId: inspection.exploration.id,
      screenId: inspection.exploration.target.screenId
    };
  }
  const focusParams = input.focus ? await focusLocation(projectRoot, input.focus, validated?.bundle ?? snapshotBundle, signal) : undefined;

  const acquisition = reusable
    ? { server: reusable, reused: true }
    : await withBlueprintServeRuntimeLock(projectKey, signal, async () => {
      const discovered = await findLiveBlueprintActivityRuntime(projectKey);
      if (discovered) {
        return { server: borrowedServeServer(projectKey, discovered), reused: true };
      }
      return { server: await startServeServer(projectRoot, input.port, validated, read), reused: false };
    });
  const server = acquisition.server;
  const baseUrl = server.baseUrl;
  const selectedUrl = new URL(baseUrl);
  if (selection) {
    selectedUrl.searchParams.set('board', 'screens');
    selectedUrl.searchParams.set('exploration', selection.explorationId);
  }
  for (const [name, value] of Object.entries(focusParams ?? {})) {
    selectedUrl.searchParams.set(name, value);
  }
  try {
    const styleErrors = await currentStyleErrors(server, validated, projectRoot, read, signal);
    const output = serveOutputSchema.parse({
      command: 'serve',
      project: normalize(projectRoot),
      port: server.port,
      url: selection || focusParams ? selectedUrl.toString() : baseUrl,
      runtime: acquisition.reused ? 'reused' : 'started',
      styleErrorCount: styleErrors.length,
      styleErrors: styleErrors.slice(0, SERVE_STYLE_ERROR_LIMIT),
      ...(input.focus ? { focus: input.focus } : {}),
      ...(selection ? { selection } : {})
    });
    return {
      ...output,
      baseUrl,
      close: server.close,
      ownership: server.ownership,
      isAvailable: server.isAvailable,
      ...(server.settledProject ? { settledProject: server.settledProject } : {}),
      ...(server.latestProject ? { latestProject: server.latestProject } : {})
    };
  } catch (error) {
    if (!acquisition.reused) await server.close();
    throw error;
  }
}

export async function readBlueprintSelection(input: SelectionInput, signal?: AbortSignal): Promise<SelectionOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
  const runtime = await findLiveBlueprintActivityRuntime(await blueprintServeRuntimeKey(projectRoot));
  if (!runtime) {
    throw new Error('No Blueprint review runtime is running for this project. Call serve, then select a boundary in the canvas. Fix: call serve on this project, then ask the person to select a boundary in the canvas.');
  }
  const response = await withAbort(fetch(new URL(BLUEPRINT_SELECTION_PATH, blueprintActivityRuntimeBaseUrl(runtime)), {
    headers: { [BLUEPRINT_ACTIVITY_TOKEN_HEADER]: runtime.token },
    signal
  }), signal);
  if (!response.ok) {
    throw new Error(`Blueprint review runtime refused the selection request with status ${response.status}. Fix: call serve on this project, then call selection again. If the status repeats, restart the MCP server.`);
  }
  const payload = await response.json() as { selection?: StoredCanvasSelection | null; files?: string[] };
  const selection = payload.selection ?? null;
  return selectionOutputSchema.parse({
    command: 'selection',
    project: normalize(projectRoot),
    selection: selection
      ? {
        ...selection,
        reference: selectionReference(selection),
        files: payload.files ?? await readSelectionFiles(projectRoot, selection, signal)
      }
      : null
  });
}

// A borrowed runtime lives in another process, so only a read of the files can answer for it.
async function currentStyleErrors(
  server: LocalServeServer,
  validated: ValidatedProject | undefined,
  projectRoot: string,
  read: ProjectReader,
  signal?: AbortSignal
): Promise<string[]> {
  const settled = server.settledProject ? await withAbort(server.settledProject(), signal) : undefined;
  return (settled ?? server.latestProject?.() ?? validated ?? await read(projectRoot, signal)).styleErrors;
}

async function settledBundle(server: BlueprintServeHandle | undefined, signal?: AbortSignal): Promise<BlueprintProjectBundle | undefined> {
  const snapshot = server?.settledProject ? await withAbort(server.settledProject(), signal) : undefined;
  return snapshot?.error === undefined ? snapshot?.bundle : undefined;
}

// A file change can arrive before the runtime hears of it, so a target that the snapshot lacks gets a read of the files.
async function focusLocation(
  projectRoot: string,
  focus: string,
  bundle: BlueprintProjectBundle | undefined,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  if (bundle) {
    try {
      return canvasLocationParams(bundle, focus);
    } catch {
      return readCanvasLocation(projectRoot, focus, signal);
    }
  }
  return readCanvasLocation(projectRoot, focus, signal);
}

function borrowedServeServer(
  projectRoot: string,
  descriptor: BlueprintActivityRuntimeDescriptor
): LocalServeServer {
  const url = blueprintActivityRuntimeBaseUrl(descriptor);
  const port = Number(new URL(url).port);
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error(`Blueprint runtime descriptor does not contain a valid review port. Fix: delete ${runtimeDescriptorPattern(descriptor.pid)}, then call serve again.`);
  }
  return {
    port,
    url,
    baseUrl: url,
    ownership: 'borrowed',
    isAvailable: async () => {
      const current = await findLiveBlueprintActivityRuntime(projectRoot);
      return current?.pid === descriptor.pid && current.activityUrl === descriptor.activityUrl;
    },
    close: async () => undefined
  };
}

function screenMutationSummary(projectId: string, screen: ScreenDefinition): {
  id: string;
  boundaryId: string;
} {
  return {
    id: screen.id,
    boundaryId: boundaryId(projectId, 'screen', screen.id)
  };
}

function historyVersionSummary(entry: ScreenHistoryEntry): {
  screenId: string;
  version: number;
  state: string;
  framePresetId: string;
} {
  return {
    screenId: entry.screenId,
    version: entry.version,
    state: entry.state,
    framePresetId: entry.framePresetId
  };
}

function explorationMetadataWrites(bundle: BlueprintProjectBundle, changed: ExplorationDefinition): ProjectFileWrite[] {
  return [{
    fileRef: explorationRecordRef(changed.id),
    content: jsonFileContent(explorationRecordFile(bundle.manifest.project.id, changed))
  }];
}

async function rewriteStarterProject(destination: string, projectId: string, name: string): Promise<void> {
  const manifestPath = path.join(destination, 'manifest.json');
  const tokensPath = path.join(destination, 'tokens.json');
  const primitivesPath = path.join(destination, 'primitives.json');
  const componentsPath = path.join(destination, 'components.json');
  const screensPath = path.join(destination, 'screens.json');

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.project.id = projectId;
  manifest.project.name = name;
  manifest.project.sourceRoot = normalize(destination);

  const tokens = JSON.parse(await readFile(tokensPath, 'utf8'));
  tokens.projectId = projectId;

  const primitives = JSON.parse(await readFile(primitivesPath, 'utf8'));
  primitives.projectId = projectId;

  const components = existsSync(componentsPath) ? JSON.parse(await readFile(componentsPath, 'utf8')) : undefined;
  if (components) {
    components.projectId = projectId;
  }

  const screens = JSON.parse(await readFile(screensPath, 'utf8'));
  screens.projectId = projectId;

  const brandPath = path.join(destination, 'brand.json');
  const brand = existsSync(brandPath) ? JSON.parse(await readFile(brandPath, 'utf8')) : undefined;
  if (brand) {
    brand.projectId = projectId;
    brand.name = name;
  }

  const writes = [
    writeJsonFile(manifestPath, manifest),
    writeJsonFile(tokensPath, tokens),
    writeJsonFile(primitivesPath, primitives),
    writeJsonFile(screensPath, screens)
  ];
  if (components) {
    writes.push(writeJsonFile(componentsPath, components));
  }
  if (brand) {
    writes.push(writeJsonFile(brandPath, brand));
  }
  await Promise.all(writes);
}

async function readProjectTextFiles(projectRoot: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.(json|html|css|md)$/.test(entry.name)) {
        files.set(path.relative(projectRoot, full).split(path.sep).join('/'), await readFile(full, 'utf8'));
      }
    }
  };
  await walk(projectRoot);
  return files;
}

async function validateOnWorker(bundle: BlueprintProjectBundle, signal?: AbortSignal): Promise<ToolValidation> {
  const { ok, errors } = await workerProjectValidator.projected(bundle, signal);
  return { ok, errors };
}

/** The response to a tool call that wrote its full JSON to `out`, so a large report does not cross the agent's context. */
export async function artifactSummary(
  command: ArtifactSummary['command'],
  input: { project: string; out: string },
  output: Record<string, unknown>
): Promise<ArtifactSummary> {
  const resolved = path.resolve(input.out);
  const readiness = output.readiness as { tier?: ArtifactSummary['tier'] } | undefined;
  const validation = output.validation as { ok?: boolean } | undefined;
  const ok = (output.ok ?? validation?.ok) as boolean | undefined;
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries({ ...output, ...readiness })) {
    if (Array.isArray(value)) counts[key] = value.length;
  }
  return artifactSummarySchema.parse({
    command,
    project: normalize(path.resolve(input.project)),
    out: normalize(resolved),
    bytes: (await stat(resolved)).size,
    ...(ok === undefined ? {} : { ok }),
    ...(readiness?.tier ? { tier: readiness.tier } : {}),
    counts
  });
}

async function writeOptionalJsonArtifact(value: unknown, out?: string): Promise<void> {
  if (!out) {
    return;
  }
  const resolved = path.resolve(out);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeJsonFile(resolved, value);
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  BlueprintProjectBundle,
  ExplorationDefinition,
  ScreenDefinition,
  ScreenHistoryEntry,
  ValidationResult
} from '../core/types';
import { boundaryId } from '../core/address';
import { canvasLocationParams } from '../core/canvas-location';
import { collectDesignFindings, type DesignFinding } from '../core/findings';
import { INSPO_IMAGE_DIRECTORY } from '../core/inspo-contract';
import { loadProjectFromFs } from '../core/load';
import { migrateProjectFiles } from '../core/migrate';
import { collectProseAdvisories, type ProseAdvisory } from '../core/prose-advisories';
import { selectionReference, selectionSourceFiles } from '../core/selection';
import { validateProject, validateProjectReadiness } from '../prototype/validate-project';
import {
  archiveExploration,
  computeExplorationBaselineDigest,
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
  findLiveBlueprintActivityRuntime,
  withBlueprintServeRuntimeLock,
  type BlueprintActivityRuntimeDescriptor
} from './activity';
import { emptyInspoFile, INSPO_GITIGNORE } from './inspo';
import { normalize, packageRoot, throwIfAborted, withAbort } from './operation-support';
import {
  applyProjectFileTransaction,
  assertBlueprintProjectPath,
  assertPersistedProjectValid,
  assertValidMutation,
  jsonFileContent,
  loadCurrentProject,
  writeProjectFiles,
  type ProjectFileWrite,
  type ProjectValidator
} from './project-files';
import { loadValidatedProject, type ProjectReader, type ValidatedProject } from './project-validation';
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
  settledProject?: () => Promise<ServeProjectSnapshot>;
}

export async function initializeBlueprint(input: InitInput, signal?: AbortSignal): Promise<InitOutput> {
  throwIfAborted(signal);
  const { out, projectId, name } = input;
  const destination = path.resolve(out);

  if (existsSync(destination)) {
    const entries = await readdir(destination);
    if (entries.length > 0 && !input.force) {
      throw new Error(`Destination is not empty: ${normalize(destination)}. Retry with force=true to overwrite Blueprint starter files in place.`);
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
  const bundle = await loadProjectFromFs(destination);
  const validation = validateProject(bundle);
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
  const bundle = await loadProjectFromFs(project);
  if (mode === 'readiness') {
    const { baseline, readiness } = validateProjectReadiness(bundle);
    const ok = baseline.ok && readiness.tier !== 'blocked';
    const output = validateOutputSchema.parse({
      command: 'validate',
      project: normalize(path.resolve(project)),
      projectId: bundle.manifest.project.id,
      mode,
      ok,
      errors: baseline.errors,
      findings: advisoryDesignFindings(bundle),
      prose: proseAdvisories(bundle),
      readiness
    });
    await writeOptionalJsonArtifact(output, input.out);
    return output;
  }

  const result = validateProject(bundle, { mode });
  const output = validateOutputSchema.parse({
    command: 'validate',
    project: normalize(path.resolve(project)),
    projectId: bundle.manifest.project.id,
    mode,
    ...result,
    findings: advisoryDesignFindings(bundle),
    prose: proseAdvisories(bundle)
  });
  await writeOptionalJsonArtifact(output, input.out);
  return output;
}

export async function migrateBlueprint(input: MigrateInput, signal?: AbortSignal): Promise<MigrateOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
  const starterRoot = path.join(packageRoot, 'starter', 'design', 'blueprint');
  const migration = migrateProjectFiles({
    files: await readProjectTextFiles(projectRoot),
    starterPrimitives: JSON.parse(await readFile(path.join(starterRoot, 'primitives.json'), 'utf8')),
    starterAgents: await readFile(path.join(starterRoot, 'AGENTS.md'), 'utf8')
  });

  throwIfAborted(signal);
  const { bundle, validation } = await validateMigration(projectRoot, migration);

  throwIfAborted(signal);
  if (!input.dryRun && migration.writes.size > 0) {
    await applyProjectFileTransaction(projectRoot, [...migration.writes].map(([fileRef, content]) => ({ fileRef, content })));
  }
  const output = migrateOutputSchema.parse({
    command: 'migrate',
    project: normalize(projectRoot),
    projectId: bundle.manifest.project.id,
    dryRun: input.dryRun,
    fromVersion: migration.fromVersion,
    toVersion: migration.toVersion,
    upToDate: migration.writes.size === 0,
    changes: migration.changes,
    files: [...migration.writes.keys()].sort(),
    validation
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
  validate: ProjectValidator = validateProject
): Promise<ExploreOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
  const bundle = await loadCurrentProject(projectRoot);
  const result = input.operation.type === 'create'
    ? createExplorationMetadata(bundle, input.operation)
    : archiveExploration(bundle, input.operation.explorationId);
  const projected = {
    ...bundle,
    explorations: result.explorations,
    prototypeSourceContents: result.prototypeSourceContents
  };
  assertValidMutation(projected, validate);
  const output = exploreOutputSchema.parse({
    command: 'explore',
    operation: input.operation.type,
    project: normalize(projectRoot),
    projectId: bundle.manifest.project.id,
    exploration: result.exploration
  });

  const transaction = await applyProjectFileTransaction(projectRoot, [
    ...result.sourceWrites.map(write => ({ fileRef: write.path, content: write.content })),
    ...explorationMetadataWrites(bundle, result.exploration)
  ]);
  try {
    throwIfAborted(signal);
    await assertPersistedProjectValid(projectRoot, projected, validate);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return output;
}

export async function promoteBlueprint(
  input: PromoteInput,
  signal?: AbortSignal,
  validate: ProjectValidator = validateProject
): Promise<PromoteOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
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
  assertValidMutation(projected, validate);
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

  const transaction = await applyProjectFileTransaction(projectRoot, [
    ...result.sourceWrites.map(write => ({ fileRef: write.path, content: write.content })),
    { fileRef: 'screens.json', content: jsonFileContent(result.screens) },
    ...explorationMetadataWrites(bundle, result.exploration),
    {
      fileRef: historyRecordRef(result.historicalVersion.screenId, result.historicalVersion.version),
      content: jsonFileContent(historyRecordFile(projectId, result.historicalVersion))
    }
  ]);
  try {
    throwIfAborted(signal);
    await assertPersistedProjectValid(projectRoot, projected, validate);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return output;
}

export async function restoreBlueprint(
  input: RestoreInput,
  signal?: AbortSignal,
  validate: ProjectValidator = validateProject
): Promise<RestoreOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
  const bundle = await loadCurrentProject(projectRoot);
  const result = restoreScreenHistory(bundle, input);
  const projectId = bundle.manifest.project.id;
  const projected = {
    ...bundle,
    screens: result.screens,
    history: result.history,
    prototypeSourceContents: result.prototypeSourceContents
  };
  assertValidMutation(projected, validate);
  const output = restoreOutputSchema.parse({
    command: 'restore',
    project: normalize(projectRoot),
    projectId,
    restoredFromVersion: input.version,
    restoredScreen: screenMutationSummary(projectId, result.restoredScreen),
    historicalVersion: historyVersionSummary(result.historicalVersion)
  });

  const transaction = await applyProjectFileTransaction(projectRoot, [
    ...result.sourceWrites.map(write => ({ fileRef: write.path, content: write.content })),
    { fileRef: 'screens.json', content: jsonFileContent(result.screens) },
    {
      fileRef: historyRecordRef(result.historicalVersion.screenId, result.historicalVersion.version),
      content: jsonFileContent(historyRecordFile(projectId, result.historicalVersion))
    }
  ]);
  try {
    throwIfAborted(signal);
    await assertPersistedProjectValid(projectRoot, projected, validate);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return output;
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
    throw new Error('Cannot reuse a Blueprint review runtime for a different project.');
  }

  let reusable = existing;
  if (reusable && !await reusable.isAvailable()) {
    await reusable.close().catch(() => undefined);
    reusable = undefined;
  }

  let selection: ServeOutput['selection'];
  let validated: ValidatedProject | undefined;
  if (input.explorationId) {
    const explorationId = input.explorationId;
    const settled = await reusable?.settledProject?.();
    let bundle = settled?.error === undefined ? settled?.bundle : undefined;
    if (!bundle?.explorations.explorations.some(exploration => exploration.id === explorationId)) {
      validated = await read(projectRoot);
      if (!validated.bundle || validated.error !== undefined) {
        throw new Error(validated.error ?? 'Blueprint project is unavailable.');
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
  const focusParams = input.focus ? canvasLocationParams(await loadCurrentProject(projectRoot), input.focus) : undefined;

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
    const output = serveOutputSchema.parse({
      command: 'serve',
      project: normalize(projectRoot),
      port: server.port,
      url: selection || focusParams ? selectedUrl.toString() : baseUrl,
      runtime: acquisition.reused ? 'reused' : 'started',
      ...(input.focus ? { focus: input.focus } : {}),
      ...(selection ? { selection } : {})
    });
    return {
      ...output,
      baseUrl,
      close: server.close,
      ownership: server.ownership,
      isAvailable: server.isAvailable,
      ...(server.settledProject ? { settledProject: server.settledProject } : {})
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
    throw new Error('No Blueprint review runtime is running for this project. Call serve, then select a boundary in the canvas.');
  }
  const response = await withAbort(fetch(new URL(BLUEPRINT_SELECTION_PATH, blueprintActivityRuntimeBaseUrl(runtime)), {
    headers: { [BLUEPRINT_ACTIVITY_TOKEN_HEADER]: runtime.token },
    signal
  }), signal);
  if (!response.ok) {
    throw new Error(`Blueprint review runtime refused the selection request with status ${response.status}.`);
  }
  const payload = await response.json() as { selection?: StoredCanvasSelection | null };
  const selection = payload.selection ?? null;
  const bundle = selection ? await loadCurrentProject(projectRoot) : undefined;
  return selectionOutputSchema.parse({
    command: 'selection',
    project: normalize(projectRoot),
    selection: selection && bundle
      ? { ...selection, reference: selectionReference(selection), files: selectionSourceFiles(bundle, selection) }
      : null
  });
}

function borrowedServeServer(
  projectRoot: string,
  descriptor: BlueprintActivityRuntimeDescriptor
): LocalServeServer {
  const url = blueprintActivityRuntimeBaseUrl(descriptor);
  const port = Number(new URL(url).port);
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error('Blueprint runtime descriptor does not contain a valid review port.');
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

async function validateMigration(
  projectRoot: string,
  migration: ReturnType<typeof migrateProjectFiles>
): Promise<{ bundle: BlueprintProjectBundle; validation: ValidationResult }> {
  if (migration.writes.size === 0) {
    const bundle = await loadProjectFromFs(projectRoot);
    const digestsCurrent = bundle.explorations.explorations.every(exploration =>
      computeExplorationBaselineDigest(bundle, exploration.id) === exploration.target.baseDigest);
    if (digestsCurrent) return { bundle, validation: validateProject(bundle) };
  }
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'blueprint-migrate-')));
  try {
    await cp(projectRoot, scratch, { recursive: true });
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
    return { bundle, validation: validateProject(bundle) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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

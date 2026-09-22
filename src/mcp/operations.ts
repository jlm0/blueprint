import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { cp, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright';
import type {
  BlueprintProjectBundle,
  ExplorationDefinition,
  ExplorationFile,
  ScreenDefinition,
  ScreenHistoryEntry
} from '../core/types';
import { boundaryId, parseBoundarySelector } from '../core/address';
import { loadProjectFromFs } from '../core/load';
import {
  parseCanvasSelection,
  selectionReference,
  selectionSourceFiles,
  type BlueprintCanvasSelection
} from '../core/selection';
import { createReadinessReport, validateProject } from '../core/validate';
import {
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
  queryPrototypeOnly,
  querySections,
  queryUsedBy,
  queryUses,
  showBoundary
} from '../core/query';
import {
  compilePrototypeReview,
  parsePrototypeReviewRequest,
  resolvePrototypeReviewSelection
} from '../prototype/review';
import { assertChromiumExecutableAvailable, createChromiumDependencyError } from '../prototype/browser-preflight';
import { installPrototypeNetworkGuard } from '../prototype/network-guard';
import { createBlueprintResponseHeaders, evaluateLoopbackHost } from '../prototype/host-policy';
import { PROTOTYPE_CONTENT_SECURITY_POLICY } from '../prototype/compiler';
import {
  BLUEPRINT_ACTIVITY_POST_PATH,
  BLUEPRINT_ACTIVITY_STREAM_PATH,
  BLUEPRINT_ACTIVITY_TOKEN_HEADER,
  BLUEPRINT_CANVAS_TOKEN_HEADER,
  BLUEPRINT_PROJECT_SNAPSHOT_PATH,
  BLUEPRINT_SELECTION_PATH,
  BlueprintActivityHub,
  blueprintActivityRuntimeBaseUrl,
  createBlueprintAgentActivityEvent,
  findLiveBlueprintActivityRuntime,
  parseBlueprintHookBridgeEvent,
  registerBlueprintActivityRuntime,
  withBlueprintServeRuntimeLock,
  type BlueprintActivityRuntimeDescriptor,
  type RegisteredBlueprintActivityRuntime
} from './activity';
import {
  captureOutputSchema,
  exploreOutputSchema,
  extractOutputSchema,
  indexOutputSchema,
  initOutputSchema,
  promoteOutputSchema,
  queryOutputSchema,
  restoreOutputSchema,
  selectionOutputSchema,
  serveOutputSchema,
  validateOutputSchema,
  type CaptureInput,
  type CaptureOutput,
  type ExploreInput,
  type ExploreOutput,
  type ExtractInput,
  type ExtractOutput,
  type IndexInput,
  type IndexOutput,
  type InitInput,
  type InitOutput,
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
  type ValidateOutput
} from './schemas';

const watcherDebounceMs = 120;
const watcherEventGraceMs = 200;
const watcherSettleTimeoutMs = 5_000;

interface CaptureServer {
  url: string;
  close: () => Promise<void>;
}

interface LocalServeServer extends CaptureServer {
  port: number;
  baseUrl: string;
  ownership: 'owned' | 'borrowed';
  isAvailable: () => Promise<boolean>;
}

interface StoredCanvasSelection extends BlueprintCanvasSelection {
  selectedAt: string;
  revision: string;
}

interface ProjectFileWrite {
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

export interface BlueprintServeHandle extends CaptureServer, ServeOutput {
  port: number;
  baseUrl: string;
  ownership: 'owned' | 'borrowed';
  isAvailable: () => Promise<boolean>;
}

const packageRoot = findPackageRoot();
const runtimeImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>;

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
  await cp(starterRoot, destination, { recursive: true, force: true });
  await rewriteStarterProject(destination, projectId, name);

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
    const baseline = validateProject(bundle);
    const readiness = createReadinessReport(bundle);
    const ok = baseline.ok && readiness.tier !== 'blocked';
    const output = validateOutputSchema.parse({
      command: 'validate',
      project: normalize(path.resolve(project)),
      projectId: bundle.manifest.project.id,
      mode,
      ok,
      errors: baseline.errors,
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
    ...result
  });
  await writeOptionalJsonArtifact(output, input.out);
  return output;
}

export async function indexBlueprint(input: IndexInput, signal?: AbortSignal): Promise<IndexOutput> {
  throwIfAborted(signal);
  const { project } = input;
  const bundle = await loadProjectFromFs(project);
  const output = indexOutputSchema.parse({
    command: 'index',
    project: normalize(path.resolve(project)),
    projectId: bundle.manifest.project.id,
    results: listBoundaryReferences(bundle)
  });
  await writeOptionalJsonArtifact(output, input.out);
  return output;
}

export async function queryBlueprint(input: QueryInput, signal?: AbortSignal): Promise<QueryOutput> {
  throwIfAborted(signal);
  const { project, query } = input;
  const bundle = await loadProjectFromFs(project);
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
  const bundle = await loadProjectFromFs(project);
  const packet = createExtractionPacket(bundle, boundary, { mode });
  const output = extractOutputSchema.parse(packet);
  await writeOptionalJsonArtifact(output, input.out);
  return output;
}

export async function captureBlueprint(input: CaptureInput, signal?: AbortSignal): Promise<CaptureOutput> {
  throwIfAborted(signal);
  const { project, boundary, out } = input;
  const selector = parseBoundarySelector(boundary);
  if (selector.kind !== 'screen') {
    throw new Error(`The capture tool currently supports screen boundaries. Received ${selector.kind}:${selector.id}.`);
  }

  const bundle = await loadProjectFromFs(project);
  showBoundary(bundle, selector);
  const selectedScreen = bundle.screens.screens.find(screen => screen.id === selector.id);
  if (!selectedScreen) {
    throw new Error(`Screen not found: ${selector.id}.`);
  }

  if (selectedScreen.prototype) {
    const selection = resolvePrototypeReviewSelection(bundle, {
      screenId: selectedScreen.id,
      state: input.state,
      viewport: input.viewport
    });
    const chromium = await preflightChromium();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

    try {
      browser = await withAbort(chromium.launch(), signal);
      const compiled = compilePrototypeReview(bundle, selection);
      const page = await browser.newPage({
        viewport: { width: selection.width, height: selection.height },
        deviceScaleFactor: 1,
        // Ambient app animation is authored under prefers-reduced-motion: no-preference,
        // so emulating reduce keeps capture bytes deterministic across runs.
        reducedMotion: 'reduce'
      });
      const networkGuard = await installPrototypeNetworkGuard({
        route: async handler => {
          await page.route('**/*', route => handler({
            url: route.request().url(),
            continue: () => route.continue(),
            abort: () => route.abort('blockedbyclient')
          }));
        },
        onFrameNavigated: handler => {
          page.on('framenavigated', frame => handler(frame.url(), frame === page.mainFrame()));
        },
        currentUrl: () => page.url()
      });
      await withAbort(page.setContent(compiled.html, { waitUntil: 'load' }), signal);
      networkGuard.assertClean();
      await withAbort(waitForPrototypeCaptureReadiness(page), signal);
      networkGuard.assertClean();

      const resolvedOut = path.resolve(out);
      await mkdir(path.dirname(resolvedOut), { recursive: true });
      await withAbort(page.screenshot({
        path: resolvedOut,
        type: 'png',
        fullPage: false,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css'
      }), signal);

      return captureOutputSchema.parse({
        command: 'capture',
        project: normalize(path.resolve(project)),
        projectId: bundle.manifest.project.id,
        boundary: selection.boundaryId,
        state: selection.state,
        viewport: selection.framePresetId,
        reviewCondition: selection.conditionId,
        dimensions: { width: selection.width, height: selection.height },
        out: normalize(resolvedOut),
        mediaType: 'image/png',
        source: {
          context: 'source-focused',
          captureTarget: 'compiled-prototype-document',
          method: 'browser-page-screenshot',
          editorChrome: false,
          readiness: {
            fonts: 'ready',
            images: 'decoded',
            layout: 'stable'
          },
          observedBoundaryIds: compiled.observedBoundaryIds
        }
      });
    } finally {
      await browser?.close();
    }
  }

  if (input.state || input.viewport) {
    throw new Error('state and viewport require a screen with declared browser-native prototype review conditions.');
  }

  const renderBundle = {
    ...bundle,
    screens: {
      ...bundle.screens,
      screens: [selectedScreen, ...bundle.screens.screens.filter(screen => screen.id !== selector.id)]
    }
  };
  const fullBoundaryId = boundaryId(bundle.manifest.project.id, 'screen', selector.id);
  const chromium = await preflightChromium();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let captureServer: CaptureServer | undefined;

  try {
    browser = await withAbort(chromium.launch(), signal);
    captureServer = await withAbort(startCaptureServer(), signal);
    const resolvedOut = path.resolve(out);
    await mkdir(path.dirname(resolvedOut), { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    await page.addInitScript(projectBundle => {
      Object.defineProperty(window, '__BLUEPRINT_PROJECT_BUNDLE__', {
        configurable: true,
        value: projectBundle
      });
    }, renderBundle);

    await withAbort(page.goto(`${captureServer.url}?board=screens`), signal);
    const frame = page.locator(`[data-boundary-id="${cssAttr(fullBoundaryId)}"]`).first();
    await withAbort(frame.waitFor({ state: 'visible', timeout: 10000 }), signal);
    const expectedSectionBoundaries = selectedScreen.sections
      .map(section => boundaryId(bundle.manifest.project.id, 'section', `${selectedScreen.id}/${section.id}`))
      .sort();
    const visibleSectionBoundaries = (await frame.locator('[data-boundary-kind="section"][data-boundary-id]').evaluateAll(elements =>
      elements
        .map(element => (element as HTMLElement).dataset.boundaryId ?? '')
        .filter(Boolean)
        .sort()
    )) as string[];
    const missingSectionBoundaries = expectedSectionBoundaries.filter(id => !visibleSectionBoundaries.includes(id));
    if (missingSectionBoundaries.length > 0) {
      throw new Error(`Screen capture pre-download DOM assertion failed. Missing visible section boundaries: ${missingSectionBoundaries.join(', ')}`);
    }
    // Frame tools hang from the unclipped frame slot (sibling of the frame), not the frame itself.
    const save = frame.locator('xpath=..').locator('.frame-save').first();
    await withAbort(save.waitFor({ state: 'visible', timeout: 5000 }), signal);

    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await save.click();
    const download = await withAbort(downloadPromise, signal);
    await withAbort(download.saveAs(resolvedOut), signal);

    return captureOutputSchema.parse({
      command: 'capture',
      project: normalize(path.resolve(project)),
      projectId: bundle.manifest.project.id,
      boundary: fullBoundaryId,
      out: normalize(resolvedOut),
      mediaType: 'image/png',
      source: {
        board: 'screens',
        captureTarget: 'screen-frame',
        method: 'browser-rendered-frame-save',
        preDownloadDomAssertion: 'passed',
        visibleSectionBoundaries
      }
    });
  } finally {
    await browser?.close();
    await captureServer?.close();
  }
}

export async function exploreBlueprint(input: ExploreInput, signal?: AbortSignal): Promise<ExploreOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
  const bundle = await loadProjectFromFs(projectRoot);
  const result = input.operation.type === 'create'
    ? createExplorationMetadata(bundle, input.operation)
    : archiveExploration(bundle, input.operation.explorationId);
  const projected = {
    ...bundle,
    explorations: result.explorations,
    prototypeSourceContents: result.prototypeSourceContents
  };
  assertValidMutation(projected);
  const output = exploreOutputSchema.parse({
    command: 'explore',
    operation: input.operation.type,
    project: normalize(projectRoot),
    projectId: bundle.manifest.project.id,
    exploration: result.exploration
  });

  const transaction = await applyProjectFileTransaction(projectRoot, [
    ...result.sourceWrites.map(write => ({ fileRef: write.path, content: write.content })),
    ...explorationMetadataWrites(bundle, result.explorations, result.exploration)
  ]);
  try {
    throwIfAborted(signal);
    await assertPersistedProjectValid(projectRoot);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return output;
}

export async function promoteBlueprint(input: PromoteInput, signal?: AbortSignal): Promise<PromoteOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
  // The mutation is computed from a fresh filesystem snapshot so the core digest
  // checks are the final read before the bounded file transaction begins.
  const bundle = await loadProjectFromFs(projectRoot);
  const result = promoteExploration(bundle, input);
  const projectId = bundle.manifest.project.id;
  assertValidMutation({
    ...bundle,
    screens: result.screens,
    explorations: result.explorations,
    history: result.history,
    prototypeSourceContents: result.prototypeSourceContents
  });
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
    ...explorationMetadataWrites(bundle, result.explorations, result.exploration),
    {
      fileRef: historyRecordRef(result.historicalVersion.screenId, result.historicalVersion.version),
      content: jsonFileContent(historyRecordFile(projectId, result.historicalVersion))
    }
  ]);
  try {
    throwIfAborted(signal);
    await assertPersistedProjectValid(projectRoot);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return output;
}

export async function restoreBlueprint(input: RestoreInput, signal?: AbortSignal): Promise<RestoreOutput> {
  throwIfAborted(signal);
  const projectRoot = path.resolve(input.project);
  assertBlueprintProjectPath(projectRoot);
  const bundle = await loadProjectFromFs(projectRoot);
  const result = restoreScreenHistory(bundle, input);
  const projectId = bundle.manifest.project.id;
  assertValidMutation({
    ...bundle,
    screens: result.screens,
    history: result.history,
    prototypeSourceContents: result.prototypeSourceContents
  });
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
    await assertPersistedProjectValid(projectRoot);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return output;
}

export async function blueprintServeRuntimeKey(project: string): Promise<string> {
  const projectRoot = path.resolve(project);
  assertBlueprintProjectPath(projectRoot);
  return normalize(await realpath(projectRoot));
}

export async function serveBlueprint(
  input: ServeInput,
  signal?: AbortSignal,
  existing?: BlueprintServeHandle
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
  if (input.explorationId) {
    const bundle = await loadProjectFromFs(projectRoot);
    const validation = validateProject(bundle);
    if (!validation.ok) {
      throw new Error(`Blueprint project failed baseline validation:\n${validation.errors.join('\n')}`);
    }
    const inspection = inspectExploration(bundle, input.explorationId);
    selection = {
      kind: 'exploration',
      explorationId: inspection.exploration.id,
      screenId: inspection.exploration.target.screenId
    };
  }

  const acquisition = reusable
    ? { server: reusable, reused: true }
    : await withBlueprintServeRuntimeLock(projectKey, signal, async () => {
      const discovered = await findLiveBlueprintActivityRuntime(projectKey);
      if (discovered) {
        return { server: borrowedServeServer(projectKey, discovered), reused: true };
      }
      return { server: await startServeServer(projectRoot, input.port), reused: false };
    });
  const server = acquisition.server;
  const baseUrl = server.baseUrl;
  const selectedUrl = new URL(baseUrl);
  if (selection) {
    selectedUrl.searchParams.set('board', 'screens');
    selectedUrl.searchParams.set('exploration', selection.explorationId);
  }
  try {
    const output = serveOutputSchema.parse({
      command: 'serve',
      project: normalize(projectRoot),
      port: server.port,
      url: selection ? selectedUrl.toString() : baseUrl,
      runtime: acquisition.reused ? 'reused' : 'started',
      ...(selection ? { selection } : {})
    });
    return {
      ...output,
      baseUrl,
      close: server.close,
      ownership: server.ownership,
      isAvailable: server.isAvailable
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
  const bundle = selection ? await loadProjectFromFs(projectRoot) : undefined;
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

async function preflightChromium(): Promise<(typeof import('playwright'))['chromium']> {
  let chromium: (typeof import('playwright'))['chromium'];
  try {
    ({ chromium } = await runtimeImport<typeof import('playwright')>('playwright'));
  } catch {
    throw createChromiumDependencyError();
  }

  assertChromiumExecutableAvailable(chromium.executablePath());
  return chromium;
}

async function waitForPrototypeCaptureReadiness(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map(async image => {
        if (!image.complete) {
          await new Promise<void>((resolve, reject) => {
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener('error', () => reject(new Error(`Prototype image failed to load: ${image.currentSrc || image.src}`)), {
              once: true
            });
          });
        }
        if (image.naturalWidth === 0) {
          throw new Error(`Prototype image has no decoded pixels: ${image.currentSrc || image.src}`);
        }
        await image.decode();
      })
    );

    const layoutFingerprint = (): string => {
      const root = document.documentElement;
      const body = document.body;
      const bounds = body.getBoundingClientRect();
      return [
        root.scrollWidth,
        root.scrollHeight,
        body.scrollWidth,
        body.scrollHeight,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height
      ].join('|');
    };
    let previous = layoutFingerprint();
    let stableFrames = 0;
    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const current = layoutFingerprint();
      if (current === previous) {
        stableFrames += 1;
        if (stableFrames >= 2) {
          return;
        }
      } else {
        stableFrames = 0;
      }
      previous = current;
    }
    throw new Error('Prototype layout did not stabilize before capture.');
  });
}

function assertValidMutation(bundle: BlueprintProjectBundle): void {
  const validation = validateProject(bundle);
  if (!validation.ok) {
    throw new Error(`Exploration mutation failed baseline validation:\n${validation.errors.join('\n')}`);
  }
}

async function assertPersistedProjectValid(projectRoot: string): Promise<void> {
  const persisted = await loadProjectFromFs(projectRoot);
  const validation = validateProject(persisted);
  if (!validation.ok) {
    throw new Error(`Persisted exploration mutation failed baseline validation:\n${validation.errors.join('\n')}`);
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

function explorationMetadataWrites(
  bundle: BlueprintProjectBundle,
  explorations: ExplorationFile,
  changed: ExplorationDefinition
): ProjectFileWrite[] {
  const records = bundle.sourceFiles.explorations
    ? explorations.explorations
    : [changed];
  const writes: ProjectFileWrite[] = records.map(exploration => ({
    fileRef: explorationRecordRef(exploration.id),
    content: jsonFileContent(explorationRecordFile(bundle.manifest.project.id, exploration))
  }));
  if (bundle.sourceFiles.explorations) {
    writes.push({
      fileRef: 'explorations.json',
      content: jsonFileContent({
        schemaVersion: explorations.schemaVersion,
        projectId: explorations.projectId,
        explorations: []
      })
    });
  }
  return writes;
}

function jsonFileContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Applies a small set of sidecar writes through sibling temporary files. If a
 * later rename or persisted validation fails, every applied target is restored
 * to its prior bytes and newly created files are removed.
 */
async function applyProjectFileTransaction(
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

function assertContainedWrite(root: string, target: string, fileRef: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Exploration write "${fileRef}" resolves outside the canonical Blueprint project root.`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
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

  const writes = [
    writeJsonFile(manifestPath, manifest),
    writeJsonFile(tokensPath, tokens),
    writeJsonFile(primitivesPath, primitives),
    writeJsonFile(screensPath, screens)
  ];
  if (components) {
    writes.push(writeJsonFile(componentsPath, components));
  }
  await Promise.all(writes);
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

function assertBlueprintProjectPath(projectRoot: string): void {
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

function findPackageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json')) && existsSync(path.join(current, 'starter'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
}

async function startCaptureServer(): Promise<CaptureServer> {
  if (existsSync(path.join(packageRoot, 'src', 'app', 'main.ts'))) {
    const { createServer } = await runtimeImport<typeof import('vite')>('vite');
    const server = await createServer({
      root: packageRoot,
      logLevel: 'error',
      server: {
        host: '127.0.0.1',
        port: 0
      }
    });
    await server.listen();
    const address = server.httpServer?.address();
    const port = typeof address === 'object' && address ? address.port : 5173;
    return {
      url: `http://127.0.0.1:${port}`,
      close: async () => {
        await server.close();
      }
    };
  }

  const siteRoot = path.join(packageRoot, 'dist', 'site');
  if (!existsSync(path.join(siteRoot, 'index.html'))) {
    throw new Error('Blueprint capture requires the app source or a built dist/site. Run from the Blueprint repo or run `npm run build:site` first.');
  }

  return startStaticSiteServer(siteRoot);
}

async function startServeServer(projectRoot: string, requestedPort?: number): Promise<LocalServeServer> {
  const siteRoot = path.join(packageRoot, 'dist', 'site');
  const indexPath = path.join(siteRoot, 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error('Blueprint serve requires built site assets at dist/site. Run `npm run build` first.');
  }
  const indexHtml = await readFile(indexPath, 'utf8');
  if (!indexHtml.includes('<script type="module"')) {
    throw new Error('Blueprint serve could not find the built module script in dist/site/index.html. Re-run `npm run build` and try again.');
  }

  let lastGoodBundle: Awaited<ReturnType<typeof loadProjectFromFs>> | undefined;
  let lastLoadError: string | undefined;
  let publishedFingerprint: string | undefined;
  let publishedError: string | undefined;
  let publishedRevision = randomUUID();
  let runtime: RegisteredBlueprintActivityRuntime | undefined;
  let reloadTimer: NodeJS.Timeout | undefined;
  let reloadsInFlight = 0;
  let canvasSelection: StoredCanvasSelection | undefined;
  const canvasToken = randomUUID();
  const activityHub = new BlueprintActivityHub();

  const settledRevision = async (): Promise<{ revision: string; projectValid: boolean }> => {
    await delay(watcherEventGraceMs);
    const deadline = Date.now() + watcherSettleTimeoutMs;
    while ((reloadTimer || reloadsInFlight > 0) && Date.now() < deadline) {
      await delay(25);
    }
    return { revision: publishedRevision, projectValid: publishedError === undefined };
  };

  const readBundleSnapshot = async (): Promise<{ bundle?: Awaited<ReturnType<typeof loadProjectFromFs>>; error?: string }> => {
    try {
      const bundle = await loadProjectFromFs(projectRoot);
      const validation = validateProject(bundle);
      if (!validation.ok) {
        throw new Error(`Blueprint project failed baseline validation:\n${validation.errors.join('\n')}`);
      }
      lastGoodBundle = bundle;
      lastLoadError = undefined;
      return { bundle };
    } catch (error) {
      lastLoadError = error instanceof Error ? error.message : String(error);
      return { bundle: lastGoodBundle, error: lastLoadError };
    }
  };

  const server = createHttpServer(async (request, response) => {
    if (!admitLoopbackRequest(server, request.headers.host, response)) {
      return;
    }
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeRequestPathname(requestUrl);
    if (!pathname) {
      response.writeHead(400, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
      response.end('Bad request');
      return;
    }

    if (pathname === BLUEPRINT_ACTIVITY_STREAM_PATH) {
      if (request.method !== 'GET') {
        response.writeHead(405, createBlueprintResponseHeaders({
          contentType: 'text/plain; charset=utf-8',
          additionalHeaders: { Allow: 'GET' }
        }));
        response.end('Method not allowed');
        return;
      }
      response.writeHead(200, createBlueprintResponseHeaders({
        contentType: 'text/event-stream; charset=utf-8',
        additionalHeaders: {
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        }
      }));
      activityHub.connect(response);
      return;
    }

    if (pathname === BLUEPRINT_ACTIVITY_POST_PATH) {
      if (request.method !== 'POST') {
        response.writeHead(405, createBlueprintResponseHeaders({
          contentType: 'text/plain; charset=utf-8',
          additionalHeaders: { Allow: 'POST' }
        }));
        response.end('Method not allowed');
        return;
      }
      if (!runtime || request.headers[BLUEPRINT_ACTIVITY_TOKEN_HEADER] !== runtime.descriptor.token) {
        response.writeHead(403, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
        response.end('Forbidden');
        return;
      }
      try {
        const event = parseBlueprintHookBridgeEvent(await readJsonRequest(request));
        if (!event) {
          response.writeHead(400, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
          response.end('Invalid Blueprint activity event');
          return;
        }
        const snapshot = await readBundleSnapshot();
        if (!snapshot.bundle) {
          response.writeHead(409, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
          response.end(snapshot.error ?? 'Blueprint project is unavailable');
          return;
        }
        const activity = createBlueprintAgentActivityEvent(snapshot.bundle, event);
        if (activity.phase === 'started') {
          activityHub.publishActivity(activity);
        } else {
          void settledRevision().then(settled => activityHub.publishActivity({ ...activity, ...settled }));
        }
        response.writeHead(202, createBlueprintResponseHeaders({ contentType: 'application/json; charset=utf-8' }));
        response.end('{"accepted":true}\n');
      } catch (error) {
        response.writeHead(400, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
        response.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (pathname === BLUEPRINT_SELECTION_PATH) {
      if (request.method === 'GET') {
        if (!runtime || request.headers[BLUEPRINT_ACTIVITY_TOKEN_HEADER] !== runtime.descriptor.token) {
          response.writeHead(403, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
          response.end('Forbidden');
          return;
        }
        response.writeHead(200, createBlueprintResponseHeaders({ contentType: 'application/json; charset=utf-8' }));
        response.end(JSON.stringify({ version: 1, selection: canvasSelection ?? null }));
        return;
      }
      if (request.method !== 'PUT') {
        response.writeHead(405, createBlueprintResponseHeaders({
          contentType: 'text/plain; charset=utf-8',
          additionalHeaders: { Allow: 'GET, PUT' }
        }));
        response.end('Method not allowed');
        return;
      }
      if (request.headers[BLUEPRINT_CANVAS_TOKEN_HEADER] !== canvasToken) {
        response.writeHead(403, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
        response.end('Forbidden');
        return;
      }
      try {
        const body = await readJsonRequest(request, 64 * 1024) as { selection?: unknown };
        const selection = body?.selection === null ? null : parseCanvasSelection(body?.selection);
        if (selection === undefined) {
          response.writeHead(400, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
          response.end('Invalid Blueprint canvas selection');
          return;
        }
        canvasSelection = selection
          ? { ...selection, selectedAt: new Date().toISOString(), revision: publishedRevision }
          : undefined;
        response.writeHead(204, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
        response.end();
      } catch (error) {
        response.writeHead(400, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
        response.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (pathname === BLUEPRINT_PROJECT_SNAPSHOT_PATH) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, createBlueprintResponseHeaders({
          contentType: 'text/plain; charset=utf-8',
          additionalHeaders: { Allow: 'GET, HEAD' }
        }));
        response.end('Method not allowed');
        return;
      }
      const snapshot = await readBundleSnapshot();
      if (!snapshot.bundle) {
        response.writeHead(503, createBlueprintResponseHeaders({ contentType: 'application/problem+json; charset=utf-8' }));
        response.end(JSON.stringify({ message: snapshot.error ?? 'Blueprint project is unavailable.' }));
        return;
      }
      response.writeHead(200, createBlueprintResponseHeaders({ contentType: 'application/json; charset=utf-8' }));
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({
        version: 1,
        revision: publishedRevision,
        bundle: snapshot.bundle
      }));
      return;
    }

    if (pathname === '/__blueprint/prototype') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, createBlueprintResponseHeaders({
          contentType: 'text/plain; charset=utf-8',
          additionalHeaders: { Allow: 'GET, HEAD' }
        }));
        response.end('Method not allowed');
        return;
      }

      let reviewRequest: ReturnType<typeof parsePrototypeReviewRequest>;
      try {
        reviewRequest = parsePrototypeReviewRequest(requestUrl);
      } catch (error) {
        writePrototypeRouteError(response, 400, error);
        return;
      }

      try {
        const bundle = await loadProjectFromFs(projectRoot);
        const validation = validateProject(bundle);
        if (!validation.ok) {
          throw new Error(`Blueprint project failed baseline validation:\n${validation.errors.join('\n')}`);
        }
        const selection = resolvePrototypeReviewSelection(bundle, reviewRequest);
        const compiled = compilePrototypeReview(bundle, selection);
        response.writeHead(200, createBlueprintResponseHeaders({
          contentType: 'text/html; charset=utf-8',
          contentSecurityPolicy: PROTOTYPE_CONTENT_SECURITY_POLICY,
          additionalHeaders: {
            'X-Blueprint-Screen': selection.screenId,
            'X-Blueprint-State': selection.state,
            'X-Blueprint-Viewport': selection.framePresetId,
            'X-Blueprint-Review-Condition': selection.conditionId
          }
        }));
        response.end(request.method === 'HEAD' ? undefined : compiled.html);
      } catch (error) {
        const status = error instanceof Error && error.message.startsWith('Screen not found:') ? 404 : 422;
        writePrototypeRouteError(response, status, error);
      }
      return;
    }

    if (pathname === '/index.html') {
      const snapshot = await readBundleSnapshot();
      if (!snapshot.bundle) {
        response.writeHead(200, createBlueprintResponseHeaders({ contentType: 'text/html; charset=utf-8' }));
        response.end(createServeErrorHtml(lastLoadError ?? 'Unable to load Blueprint project.'));
        return;
      }
      response.writeHead(200, createBlueprintResponseHeaders({ contentType: 'text/html; charset=utf-8' }));
      response.end(injectProjectBundle(indexHtml, snapshot.bundle, snapshot.error, canvasToken));
      return;
    }

    const filePath = path.resolve(siteRoot, `.${pathname}`);
    if (!filePath.startsWith(`${path.resolve(siteRoot)}${path.sep}`)) {
      response.writeHead(403, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
      response.end('Forbidden');
      return;
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, createBlueprintResponseHeaders({ contentType: contentType(filePath) }));
      response.end(body);
    } catch {
      response.writeHead(404, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
      response.end('Not found');
    }
  });

  await listenForBlueprintServe(server, requestedPort);
  const address = server.address() as AddressInfo;
  try {
    const initial = await readBundleSnapshot();
    if (initial.bundle && !initial.error) {
      publishedFingerprint = JSON.stringify(initial.bundle);
    }
    runtime = await registerBlueprintActivityRuntime(
      projectRoot,
      `http://127.0.0.1:${address.port}${BLUEPRINT_ACTIVITY_POST_PATH}`
    );
  } catch (error) {
    activityHub.close();
    await closeHttpServer(server);
    throw error;
  }

  const changedPaths = new Set<string>();
  const stopWatching = watchBlueprintProject(projectRoot, changedPath => {
    changedPaths.add(changedPath);
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      reloadsInFlight += 1;
      void readBundleSnapshot().then(snapshot => {
        if (!snapshot.bundle || snapshot.error) {
          const message = snapshot.error ?? 'Blueprint project is unavailable.';
          if (message !== publishedError) {
            publishedError = message;
            activityHub.publish('project-error', {
              version: 1,
              message,
              changedAt: new Date().toISOString()
            });
          }
          return;
        }
        const nextFingerprint = JSON.stringify(snapshot.bundle);
        if (nextFingerprint === publishedFingerprint && publishedError === undefined) {
          changedPaths.clear();
          return;
        }
        publishedFingerprint = nextFingerprint;
        publishedError = undefined;
        publishedRevision = randomUUID();
        activityHub.publish('project-changed', {
          version: 1,
          revision: publishedRevision,
          changedAt: new Date().toISOString(),
          changedPaths: [...changedPaths].sort()
        });
        changedPaths.clear();
      }).finally(() => {
        reloadsInFlight -= 1;
      });
    }, watcherDebounceMs);
    reloadTimer.unref();
  });

  const baseUrl = `http://127.0.0.1:${address.port}/`;
  let closePromise: Promise<void> | undefined;
  return {
    port: address.port,
    url: baseUrl,
    baseUrl,
    ownership: 'owned',
    isAvailable: async () => server.listening,
    close: () => {
      closePromise ??= (async () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        stopWatching();
        activityHub.close();
        await Promise.all([runtime?.close(), closeHttpServer(server)]);
      })();
      return closePromise;
    }
  };
}

function injectProjectBundle(
  indexHtml: string,
  bundle: Awaited<ReturnType<typeof loadProjectFromFs>>,
  loadError: string | undefined,
  canvasToken: string
): string {
  const injection = [
    '<script>',
    `window.__BLUEPRINT_PROJECT_BUNDLE__=${serializeForInlineScript(bundle)};`,
    `window.__BLUEPRINT_LIVE_RUNTIME__=${serializeForInlineScript({
      eventsPath: BLUEPRINT_ACTIVITY_STREAM_PATH,
      snapshotPath: BLUEPRINT_PROJECT_SNAPSHOT_PATH,
      selectionPath: BLUEPRINT_SELECTION_PATH,
      canvasToken
    })};`,
    loadError ? `window.__BLUEPRINT_PROJECT_LOAD_ERROR__=${serializeForInlineScript({ message: loadError })};` : 'delete window.__BLUEPRINT_PROJECT_LOAD_ERROR__;',
    '</script>'
  ].join('');
  return indexHtml.replace('<script type="module"', () => `${injection}<script type="module"`);
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function createServeErrorHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="UTF-8"><title>Blueprint serve error</title></head><body><main id="blueprint-serve-error"><h1>Blueprint project error</h1><pre>${escapeHtml(message)}</pre></main></body></html>`;
}

function watchBlueprintProject(projectRoot: string, onChange: (changedPath: string) => void): () => void {
  const watcher = watch(projectRoot, { recursive: true }, (_eventType, fileName) => {
    const normalized = String(fileName ?? '').replaceAll('\\', '/');
    if (
      normalized.length === 0 ||
      normalized.split('/').some(part => part === '.git' || part === '.blueprint-artifacts' || part === 'node_modules')
    ) {
      return;
    }
    onChange(normalized);
  });
  return () => watcher.close();
}

async function readJsonRequest(request: IncomingMessage, maximumBytes = 256 * 1024): Promise<unknown> {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maximumBytes) {
      throw new Error(`Blueprint activity request exceeded ${maximumBytes} bytes.`);
    }
  }
  return JSON.parse(body);
}

function writePrototypeRouteError(response: ServerResponse, status: number, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  response.writeHead(status, createBlueprintResponseHeaders({ contentType: 'application/problem+json; charset=utf-8' }));
  response.end(
    `${JSON.stringify({
      type: 'blueprint/prototype-review-error',
      title: 'Prototype review unavailable',
      status,
      detail
    })}\n`
  );
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function startStaticSiteServer(siteRoot: string): Promise<CaptureServer> {
  const server = createHttpServer(async (request, response) => {
    if (!admitLoopbackRequest(server, request.headers.host, response)) {
      return;
    }
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeRequestPathname(requestUrl);
    if (!pathname) {
      response.writeHead(400, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
      response.end('Bad request');
      return;
    }
    const filePath = path.resolve(siteRoot, `.${pathname}`);
    if (!filePath.startsWith(`${path.resolve(siteRoot)}${path.sep}`)) {
      response.writeHead(403, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
      response.end('Forbidden');
      return;
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, createBlueprintResponseHeaders({ contentType: contentType(filePath) }));
      response.end(body);
    } catch {
      response.writeHead(404, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
      response.end('Not found');
    }
  });

  await listen(server);
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeHttpServer(server)
  };
}

function decodeRequestPathname(requestUrl: URL): string | undefined {
  try {
    return decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
  } catch {
    return undefined;
  }
}

function listen(server: HttpServer, port = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`EADDRINUSE: port ${port} is already in use for the Blueprint review server.`));
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function listenForBlueprintServe(server: HttpServer, requestedPort?: number): Promise<void> {
  if (requestedPort !== undefined) {
    await listen(server, requestedPort);
    return;
  }
  for (let candidate = 4173; candidate <= 4273; candidate += 1) {
    try {
      await listen(server, candidate);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('EADDRINUSE')) throw error;
    }
  }
  throw new Error('Blueprint could not find an available review port between 4173 and 4273.');
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function admitLoopbackRequest(server: HttpServer, hostHeader: string | undefined, response: ServerResponse): boolean {
  const address = server.address();
  if (!address || typeof address === 'string') {
    response.writeHead(503, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }));
    response.end('Service unavailable');
    return false;
  }

  const decision = evaluateLoopbackHost(hostHeader, address.port);
  if (decision.allowed) {
    return true;
  }
  response.writeHead(decision.status, decision.headers);
  response.end(decision.body);
  return false;
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }
  if (filePath.endsWith('.js')) {
    return 'text/javascript; charset=utf-8';
  }
  if (filePath.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }
  if (filePath.endsWith('.png')) {
    return 'image/png';
  }
  if (filePath.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  return 'application/octet-stream';
}

function normalize(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function cssAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Blueprint tool call was cancelled.');
  }
}

function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return operation;
  }
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Blueprint tool call was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

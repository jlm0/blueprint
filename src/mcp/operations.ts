import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright';
import { boundaryId, parseBoundarySelector } from '../core/address';
import { loadProjectFromFs } from '../core/load';
import { createReadinessReport, validateProject } from '../core/validate';
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
  captureOutputSchema,
  extractOutputSchema,
  indexOutputSchema,
  initOutputSchema,
  queryOutputSchema,
  serveOutputSchema,
  validateOutputSchema,
  type CaptureInput,
  type CaptureOutput,
  type ExtractInput,
  type ExtractOutput,
  type IndexInput,
  type IndexOutput,
  type InitInput,
  type InitOutput,
  type QueryInput,
  type QueryOutput,
  type ServeInput,
  type ServeOutput,
  type ValidateInput,
  type ValidateOutput
} from './schemas';

interface CaptureServer {
  url: string;
  close: () => Promise<void>;
}

interface LocalServeServer extends CaptureServer {
  port: number;
}

export interface BlueprintServeHandle extends CaptureServer, ServeOutput {
  port: number;
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

export async function serveBlueprint(input: ServeInput, signal?: AbortSignal): Promise<BlueprintServeHandle> {
  throwIfAborted(signal);
  const project = input.project;
  const port = input.port;
  const projectRoot = path.resolve(project);
  assertBlueprintProjectPath(projectRoot);

  const server = await startServeServer(projectRoot, port);
  const output = serveOutputSchema.parse({
    command: 'serve',
    project: normalize(projectRoot),
    port: server.port,
    url: server.url
  });
  return { ...output, close: server.close };
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

async function startServeServer(projectRoot: string, port: number): Promise<LocalServeServer> {
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
      response.end(injectProjectBundle(indexHtml, snapshot.bundle, snapshot.error));
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

  await listen(server, port);
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
    close: () => closeHttpServer(server)
  };
}

function injectProjectBundle(indexHtml: string, bundle: Awaited<ReturnType<typeof loadProjectFromFs>>, loadError: string | undefined): string {
  const injection = [
    '<script>',
    `window.__BLUEPRINT_PROJECT_BUNDLE__=${serializeForInlineScript(bundle)};`,
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

#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { boundaryId, parseBoundarySelector } from './core/address';
import { loadProjectFromFs } from './core/load';
import { createReadinessReport, validateProject } from './core/validate';
import {
  createExtractionPacket,
  listBoundaryReferences,
  queryPrototypeOnly,
  querySections,
  queryUsedBy,
  queryUses,
  showBoundary
} from './core/query';
import type { ValidationMode } from './core/types';

type Command = 'init' | 'validate' | 'index' | 'query' | 'extract' | 'capture' | 'serve';
type QueryType = 'show' | 'uses' | 'used-by' | 'sections' | 'prototype-only';
type ExtractMode = 'focused' | 'deep';
type CliValidationMode = ValidationMode | 'readiness';

const defaultProjectPath = 'design/blueprint';

interface CaptureServer {
  url: string;
  close: () => Promise<void>;
}

interface ServeServer extends CaptureServer {
  port: number;
}

interface Args {
  command?: Command;
  project?: string;
  projectId?: string;
  name?: string;
  out?: string;
  boundary?: string;
  screen?: string;
  type?: QueryType;
  mode?: string;
  port?: string;
  force: boolean;
  help: boolean;
}

const packageRoot = findPackageRoot();
const runtimeImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(helpText());
    return;
  }

  if (args.command === 'init') {
    await commandInit(args);
    return;
  }

  if (args.command === 'validate') {
    await commandValidate(args);
    return;
  }

  if (args.command === 'index') {
    await commandIndex(args);
    return;
  }

  if (args.command === 'query') {
    await commandQuery(args);
    return;
  }

  if (args.command === 'extract') {
    await commandExtract(args);
    return;
  }

  if (args.command === 'capture') {
    await commandCapture(args);
    return;
  }

  if (args.command === 'serve') {
    await commandServe(args);
    return;
  }
}

async function commandInit(args: Args): Promise<void> {
  const out = requireArg(args.out, '--out');
  const projectId = requireArg(args.projectId, '--project-id');
  const name = requireArg(args.name, '--name');
  const destination = path.resolve(out);

  if (existsSync(destination)) {
    const entries = await readdir(destination);
    if (entries.length > 0 && !args.force) {
      throw new Error(`Destination is not empty: ${normalize(destination)}. Re-run with --force to overwrite Blueprint starter files in place.`);
    }
  }

  const starterRoot = path.join(packageRoot, 'starter', 'design', 'blueprint');
  await mkdir(destination, { recursive: true });
  await cp(starterRoot, destination, { recursive: true, force: true });
  await rewriteStarterProject(destination, projectId, name);

  const bundle = await loadProjectFromFs(destination);
  const validation = validateProject(bundle);
  if (!validation.ok) {
    throw new Error(`Initialized project failed baseline validation:\n${validation.errors.join('\n')}`);
  }

  await writeOutput(
    {
      command: 'init',
      projectId,
      name,
      out: normalize(destination),
      files: (await readdir(destination)).sort(),
      validation,
      nextCommands: [
        `blueprint validate --project ${normalize(destination)}`,
        `blueprint serve --project ${normalize(destination)}`,
        `blueprint index --project ${normalize(destination)}`,
        `blueprint query --project ${normalize(destination)} --type show --boundary screen:home`,
        `blueprint extract --project ${normalize(destination)} --boundary screen:home --out packet.json`
      ]
    },
    undefined
  );
}

async function commandValidate(args: Args): Promise<void> {
  const project = requireArg(args.project, '--project');
  const mode = validationMode(args.mode);
  const bundle = await loadProjectFromFs(project);
  if (mode === 'readiness') {
    const baseline = validateProject(bundle);
    const readiness = createReadinessReport(bundle);
    const ok = baseline.ok && readiness.tier !== 'blocked';
    await writeOutput(
      {
        command: 'validate',
        project: normalize(path.resolve(project)),
        projectId: bundle.manifest.project.id,
        mode,
        ok,
        errors: baseline.errors,
        readiness
      },
      args.out
    );
    if (!ok) {
      process.exitCode = 1;
    }
    return;
  }

  const result = validateProject(bundle, { mode });
  await writeOutput(
    {
      command: 'validate',
      project: normalize(path.resolve(project)),
      projectId: bundle.manifest.project.id,
      mode,
      ...result
    },
    args.out
  );
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function commandIndex(args: Args): Promise<void> {
  const project = requireArg(args.project, '--project');
  const bundle = await loadProjectFromFs(project);
  await writeOutput(
    {
      command: 'index',
      project: normalize(path.resolve(project)),
      projectId: bundle.manifest.project.id,
      results: listBoundaryReferences(bundle)
    },
    args.out
  );
}

async function commandQuery(args: Args): Promise<void> {
  const project = requireArg(args.project, '--project');
  const type = requireQueryType(args.type);
  const bundle = await loadProjectFromFs(project);
  let output: unknown;

  if (type === 'show') {
    output = showBoundary(bundle, requireArg(args.boundary, '--boundary'));
  }
  if (type === 'uses') {
    output = queryUses(bundle, requireArg(args.boundary, '--boundary'));
  }
  if (type === 'used-by') {
    output = queryUsedBy(bundle, requireArg(args.boundary, '--boundary'));
  }
  if (type === 'sections') {
    output = querySections(bundle, requireArg(args.screen, '--screen'));
  }
  if (type === 'prototype-only') {
    output = queryPrototypeOnly(bundle);
  }

  await writeOutput(output, args.out);
}

async function commandExtract(args: Args): Promise<void> {
  const project = requireArg(args.project, '--project');
  const boundary = requireArg(args.boundary, '--boundary');
  const mode = extractMode(args.mode);
  const bundle = await loadProjectFromFs(project);
  const packet = createExtractionPacket(bundle, boundary, { mode });
  if (args.out) {
    await writeOutput(packet, args.out, { printOutSummary: true });
    return;
  }
  await writeOutput(packet, undefined);
}

async function commandCapture(args: Args): Promise<void> {
  const project = requireArg(args.project, '--project');
  const boundary = requireArg(args.boundary, '--boundary');
  const out = requireArg(args.out, '--out');
  const selector = parseBoundarySelector(boundary);
  if (selector.kind !== 'screen') {
    throw new Error(`blueprint capture currently supports screen boundaries. Received ${selector.kind}:${selector.id}.`);
  }

  const bundle = await loadProjectFromFs(project);
  showBoundary(bundle, selector);
  const selectedScreen = bundle.screens.screens.find(screen => screen.id === selector.id);
  if (!selectedScreen) {
    throw new Error(`Screen not found: ${selector.id}.`);
  }
  const renderBundle = {
    ...bundle,
    screens: {
      ...bundle.screens,
      screens: [selectedScreen, ...bundle.screens.screens.filter(screen => screen.id !== selector.id)]
    }
  };
  const resolvedOut = path.resolve(out);
  await mkdir(path.dirname(resolvedOut), { recursive: true });

  const fullBoundaryId = boundaryId(bundle.manifest.project.id, 'screen', selector.id);
  const captureServer = await startCaptureServer();
  let browser: Awaited<ReturnType<(typeof import('playwright'))['chromium']['launch']>> | undefined;

  try {
    const { chromium } = await runtimeImport<typeof import('playwright')>('playwright');
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    await page.addInitScript(projectBundle => {
      Object.defineProperty(window, '__BLUEPRINT_PROJECT_BUNDLE__', {
        configurable: true,
        value: projectBundle
      });
    }, renderBundle);

    await page.goto(`${captureServer.url}?board=screens`);
    const frame = page.locator(`[data-boundary-id="${cssAttr(fullBoundaryId)}"]`).first();
    await frame.waitFor({ state: 'visible', timeout: 10000 });
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
    const save = frame.locator('.frame-save').first();
    await save.waitFor({ state: 'visible', timeout: 5000 });

    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await save.click();
    const download = await downloadPromise;
    await download.saveAs(resolvedOut);

    await writeOutput(
      {
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
      },
      undefined
    );
  } finally {
    await browser?.close();
    await captureServer.close();
  }
}

async function commandServe(args: Args): Promise<void> {
  const project = args.project ?? defaultProjectPath;
  const port = servePort(args.port);
  const projectRoot = path.resolve(project);
  assertBlueprintProjectPath(projectRoot);

  const server = await startServeServer(projectRoot, port);
  process.stdout.write(`Blueprint serve ready: ${server.url}\n`);
  await waitForShutdown(server);
}

async function rewriteStarterProject(destination: string, projectId: string, name: string): Promise<void> {
  const manifestPath = path.join(destination, 'manifest.json');
  const tokensPath = path.join(destination, 'tokens.json');
  const primitivesPath = path.join(destination, 'primitives.json');
  const screensPath = path.join(destination, 'screens.json');

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.project.id = projectId;
  manifest.project.name = name;
  manifest.project.sourceRoot = normalize(destination);

  const tokens = JSON.parse(await readFile(tokensPath, 'utf8'));
  tokens.projectId = projectId;

  const primitives = JSON.parse(await readFile(primitivesPath, 'utf8'));
  primitives.projectId = projectId;

  const screens = JSON.parse(await readFile(screensPath, 'utf8'));
  screens.projectId = projectId;

  await Promise.all([
    writeJsonFile(manifestPath, manifest),
    writeJsonFile(tokensPath, tokens),
    writeJsonFile(primitivesPath, primitives),
    writeJsonFile(screensPath, screens)
  ]);
}

async function writeOutput(value: unknown, out?: string, options: { printOutSummary?: boolean } = {}): Promise<void> {
  if (out) {
    const resolved = path.resolve(out);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeJsonFile(resolved, value);
    if (options.printOutSummary) {
      process.stdout.write(`${JSON.stringify({ ok: true, out: normalize(resolved) }, null, 2)}\n`);
    }
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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

function parseArgs(argv: string[]): Args {
  const [maybeCommand, ...rest] = argv;
  const args: Args = {
    command: isCommand(maybeCommand) ? maybeCommand : undefined,
    force: false,
    help: maybeCommand === '--help' || maybeCommand === '-h'
  };

  if (maybeCommand && !args.command && !args.help) {
    throw new Error(`Unknown command "${maybeCommand}".\n${helpText()}`);
  }

  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (key === '--force') {
      args.force = true;
      continue;
    }
    if (key === '--help' || key === '-h') {
      args.help = true;
      continue;
    }
    if (!key?.startsWith('--')) {
      throw new Error(`Unexpected argument "${key}".`);
    }
    const value = rest[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${key}.`);
    }
    index += 1;

    if (key === '--project') {
      args.project = value;
    } else if (key === '--project-id') {
      args.projectId = value;
    } else if (key === '--name') {
      args.name = value;
    } else if (key === '--out') {
      args.out = value;
    } else if (key === '--boundary') {
      args.boundary = value;
    } else if (key === '--screen') {
      args.screen = value;
    } else if (key === '--type') {
      args.type = value as QueryType;
    } else if (key === '--mode') {
      args.mode = value;
    } else if (key === '--port') {
      args.port = value;
    } else {
      throw new Error(`Unknown argument ${key}.`);
    }
  }

  return args;
}

function isCommand(value: string | undefined): value is Command {
  return value === 'init' || value === 'validate' || value === 'index' || value === 'query' || value === 'extract' || value === 'capture' || value === 'serve';
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function requireQueryType(value: string | undefined): QueryType {
  if (value === 'show' || value === 'uses' || value === 'used-by' || value === 'sections' || value === 'prototype-only') {
    return value;
  }
  throw new Error('--type must be one of show, uses, used-by, sections, prototype-only.');
}

function validationMode(value: string | undefined): CliValidationMode {
  if (!value || value === 'baseline') {
    return 'baseline';
  }
  if (value === 'strict') {
    return 'strict';
  }
  if (value === 'readiness') {
    return 'readiness';
  }
  throw new Error('--mode must be "baseline", "strict", or "readiness".');
}

function extractMode(value: string | undefined): ExtractMode {
  if (!value || value === 'focused') {
    return 'focused';
  }
  if (value === 'deep') {
    return 'deep';
  }
  throw new Error('--mode must be "focused" or "deep".');
}

function servePort(value: string | undefined): number {
  if (!value) {
    return 4173;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error('--port must be an integer between 0 and 65535.');
  }
  return parsed;
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

async function startServeServer(projectRoot: string, port: number): Promise<ServeServer> {
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
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeRequestPathname(requestUrl);
    if (!pathname) {
      response.writeHead(400);
      response.end('Bad request');
      return;
    }

    if (pathname === '/index.html') {
      const snapshot = await readBundleSnapshot();
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (!snapshot.bundle) {
        response.writeHead(200);
        response.end(createServeErrorHtml(lastLoadError ?? 'Unable to load Blueprint project.'));
        return;
      }
      response.writeHead(200);
      response.end(injectProjectBundle(indexHtml, snapshot.bundle, snapshot.error));
      return;
    }

    const filePath = path.resolve(siteRoot, `.${pathname}`);
    if (!filePath.startsWith(`${path.resolve(siteRoot)}${path.sep}`)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentType(filePath)
      });
      response.end(body);
    } catch {
      response.writeHead(404);
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function startStaticSiteServer(siteRoot: string): Promise<CaptureServer> {
  const server = createHttpServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeRequestPathname(requestUrl);
    if (!pathname) {
      response.writeHead(400);
      response.end('Bad request');
      return;
    }
    const filePath = path.resolve(siteRoot, `.${pathname}`);
    if (!filePath.startsWith(`${path.resolve(siteRoot)}${path.sep}`)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, { 'Content-Type': contentType(filePath) });
      response.end(body);
    } catch {
      response.writeHead(404);
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
        reject(new Error(`EADDRINUSE: port ${port} is already in use for blueprint serve.`));
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

function waitForShutdown(server: ServeServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const close = (): void => {
      process.off('SIGINT', close);
      process.off('SIGTERM', close);
      server.close().then(resolve, reject);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
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

function helpText(): string {
  return `blueprint <command>

Commands:
  init --project-id <id> --name <name> --out <design/blueprint> [--force]
  validate --project <path> [--mode baseline|strict] [--out file]
  index --project <path> [--out file]
  query --project <path> --type <show|uses|used-by|sections|prototype-only> [--boundary kind:id] [--screen id] [--out file]
  extract --project <path> --boundary kind:id [--mode focused|deep] [--out file]
  capture --project <path> --boundary screen:id --out file.png
  serve [--project design/blueprint] [--port 4173]
`;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

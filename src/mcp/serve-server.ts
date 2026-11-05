import { randomUUID } from 'node:crypto';
import { existsSync, watch } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BlueprintOutdatedFile, BlueprintProjectLoadError } from '../core/activity';
import { INSPO_IMAGE_DIRECTORY } from '../core/inspo-contract';
import { BLUEPRINT_SCHEMA_VERSION } from '../core/schema-version';
import { parseCanvasSelection, selectionSourceFiles, type BlueprintCanvasSelection } from '../core/selection';
import type { LinkedProjectBundle } from '../core/types';
import { PROTOTYPE_CONTENT_SECURITY_POLICY } from '../prototype/compiler';
import {
  createBlueprintResponseHeaders,
  createPrototypeAssetResponseHeaders,
  evaluateLoopbackHost,
  PROTOTYPE_ASSET_PATH_PREFIX
} from '../prototype/host-policy';
import {
  compilePrototypeReview,
  parsePrototypeReviewRequest,
  resolvePrototypeReviewSelection
} from '../prototype/review';
import {
  BLUEPRINT_ACTIVITY_POST_PATH,
  BLUEPRINT_ACTIVITY_STREAM_PATH,
  BLUEPRINT_ACTIVITY_TOKEN_HEADER,
  BLUEPRINT_CANVAS_TOKEN_HEADER,
  BLUEPRINT_PROJECT_SNAPSHOT_PATH,
  BLUEPRINT_SELECTION_PATH,
  BlueprintActivityHub,
  createBlueprintAgentActivityEvent,
  parseBlueprintHookBridgeEvent,
  registerBlueprintActivityRuntime,
  type RegisteredBlueprintActivityRuntime
} from './activity';
import { packageRoot } from './operation-support';
import type { ProjectReader, ValidatedProject } from './project-validation';
import { ServeProjectSnapshots, type ServeProjectSnapshot } from './serve-snapshot';

const watcherDebounceMs = 120;
const INSPO_IMAGE_ROUTE = /^\/__blueprint\/inspo\/([a-z0-9]+(?:-[a-z0-9]+)*\.(?:png|jpg|webp|gif))$/;
const PROTOTYPE_ASSET_HASH = /^[0-9a-f]{64}$/;
const watcherEventGraceMs = 200;
const watcherSettleTimeoutMs = 5_000;

export interface CaptureServer {
  url: string;
  close: () => Promise<void>;
}

export interface LocalServeServer extends CaptureServer {
  port: number;
  baseUrl: string;
  ownership: 'owned' | 'borrowed';
  isAvailable: () => Promise<boolean>;
  /** The validated project of an owned runtime, after the file changes it has seen are applied. Undefined when the deadline ends first. */
  settledProject?: () => Promise<ServeProjectSnapshot | undefined>;
  /** The last snapshot, for a caller that must not wait past the deadline of `settledProject`. */
  latestProject?: () => ServeProjectSnapshot;
}

export interface StoredCanvasSelection extends BlueprintCanvasSelection {
  selectedAt: string;
  revision: string;
}

interface ServeState {
  projectRoot: string;
  siteRoot: string;
  indexHtml: string;
  canvasToken: string;
  activityHub: BlueprintActivityHub;
  snapshots: ServeProjectSnapshots;
  runtime?: RegisteredBlueprintActivityRuntime;
  canvasSelection?: StoredCanvasSelection;
}

interface ServeExchange {
  state: ServeState;
  request: IncomingMessage;
  response: ServerResponse;
  requestUrl: URL;
  pathname: string;
}

interface ServeRoute {
  matches: (pathname: string) => boolean;
  methods?: readonly string[];
  handle: (exchange: ServeExchange) => void | Promise<void>;
}

// The order decides the match, and the last route catches each other path.
const SERVE_ROUTES: readonly ServeRoute[] = [
  { matches: exactPath(BLUEPRINT_ACTIVITY_STREAM_PATH), methods: ['GET'], handle: streamActivity },
  { matches: exactPath(BLUEPRINT_ACTIVITY_POST_PATH), methods: ['POST'], handle: receiveActivity },
  { matches: exactPath(BLUEPRINT_SELECTION_PATH), methods: ['GET', 'PUT'], handle: exchangeCanvasSelection },
  { matches: exactPath(BLUEPRINT_PROJECT_SNAPSHOT_PATH), methods: ['GET', 'HEAD'], handle: sendProjectSnapshot },
  { matches: pathname => pathname.startsWith(PROTOTYPE_ASSET_PATH_PREFIX), methods: ['GET', 'HEAD'], handle: sendPrototypeAsset },
  { matches: exactPath('/__blueprint/prototype'), methods: ['GET', 'HEAD'], handle: sendPrototypeReview },
  { matches: pathname => INSPO_IMAGE_ROUTE.test(pathname), methods: ['GET', 'HEAD'], handle: sendInspoImage },
  { matches: exactPath('/index.html'), handle: sendCanvasPage },
  { matches: () => true, handle: sendSiteFile }
];

export async function startServeServer(
  projectRoot: string,
  requestedPort: number | undefined,
  validated: ValidatedProject | undefined,
  read: ProjectReader
): Promise<LocalServeServer> {
  const siteRoot = path.join(packageRoot, 'dist', 'site');
  const indexPath = path.join(siteRoot, 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error('Blueprint serve requires built site assets at dist/site. Run `npm run build` first. Fix: run npm run build in the Blueprint package directory, then call serve again.');
  }
  const indexHtml = await readFile(indexPath, 'utf8');
  if (!indexHtml.includes('<script type="module"')) {
    throw new Error('Blueprint serve could not find the built module script in dist/site/index.html. Re-run `npm run build` and try again. Fix: run npm run build in the Blueprint package directory, then call serve again.');
  }

  const activityHub = new BlueprintActivityHub();
  const snapshots = new ServeProjectSnapshots(projectRoot, {
    read,
    debounceMs: watcherDebounceMs,
    onChanged: ({ revision, changedPaths }) => activityHub.publish('project-changed', {
      version: 1,
      revision,
      changedAt: new Date().toISOString(),
      changedPaths
    }),
    onFailed: ({ message, outdatedFiles }) => activityHub.publish('project-error', {
      version: 1,
      message,
      outdatedFiles,
      changedAt: new Date().toISOString()
    })
  });
  const state: ServeState = { projectRoot, siteRoot, indexHtml, canvasToken: randomUUID(), activityHub, snapshots };

  const server = createHttpServer(async (request, response) => {
    if (!admitLoopbackRequest(server, request.headers.host, response)) {
      return;
    }
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeRequestPathname(requestUrl);
    if (!pathname) {
      writePlainText(response, 400, 'Bad request');
      return;
    }

    const route = SERVE_ROUTES.find(candidate => candidate.matches(pathname))!;
    if (route.methods && !route.methods.includes(request.method ?? '')) {
      writePlainText(response, 405, 'Method not allowed', { Allow: route.methods.join(', ') });
      return;
    }
    await route.handle({ state, request, response, requestUrl, pathname });
  });

  await listenForBlueprintServe(server, requestedPort);
  const address = server.address() as AddressInfo;
  try {
    await snapshots.start(validated);
    state.runtime = await registerBlueprintActivityRuntime(
      projectRoot,
      `http://127.0.0.1:${address.port}${BLUEPRINT_ACTIVITY_POST_PATH}`
    );
  } catch (error) {
    snapshots.close();
    activityHub.close();
    await closeHttpServer(server);
    throw error;
  }

  const stopWatching = watchBlueprintProject(projectRoot, changedPath => snapshots.schedule(changedPath));

  const baseUrl = `http://127.0.0.1:${address.port}/`;
  let closePromise: Promise<void> | undefined;
  return {
    port: address.port,
    url: baseUrl,
    baseUrl,
    ownership: 'owned',
    isAvailable: async () => server.listening,
    settledProject: () => settledBeforeDeadline(snapshots),
    latestProject: () => snapshots.current,
    close: () => {
      closePromise ??= (async () => {
        snapshots.close();
        stopWatching();
        activityHub.close();
        await Promise.all([state.runtime?.close(), closeHttpServer(server)]);
      })();
      return closePromise;
    }
  };
}

function exactPath(expected: string): (pathname: string) => boolean {
  return pathname => pathname === expected;
}

function writePlainText(
  response: ServerResponse,
  status: number,
  body?: string,
  additionalHeaders?: Readonly<Record<string, string>>
): void {
  response.writeHead(status, createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8', additionalHeaders }));
  response.end(body);
}

function hasActivityToken({ runtime }: ServeState, request: IncomingMessage): boolean {
  return runtime !== undefined && request.headers[BLUEPRINT_ACTIVITY_TOKEN_HEADER] === runtime.descriptor.token;
}

function settledBeforeDeadline(snapshots: ServeProjectSnapshots): Promise<ServeProjectSnapshot | undefined> {
  return Promise.race([snapshots.settled(), delay(watcherSettleTimeoutMs, undefined, { ref: false })]);
}

async function settledRevision(snapshots: ServeProjectSnapshots): Promise<{ revision: string; projectValid: boolean }> {
  await delay(watcherEventGraceMs);
  await settledBeforeDeadline(snapshots);
  return { revision: snapshots.current.revision, projectValid: snapshots.current.error === undefined };
}

function streamActivity({ state, response }: ServeExchange): void {
  response.writeHead(200, createBlueprintResponseHeaders({
    contentType: 'text/event-stream; charset=utf-8',
    additionalHeaders: {
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  }));
  state.activityHub.connect(response);
}

async function receiveActivity({ state, request, response }: ServeExchange): Promise<void> {
  if (!hasActivityToken(state, request)) {
    writePlainText(response, 403, 'Forbidden');
    return;
  }
  try {
    const event = parseBlueprintHookBridgeEvent(await readJsonRequest(request));
    if (!event) {
      writePlainText(response, 400, 'Invalid Blueprint activity event');
      return;
    }
    const snapshot = state.snapshots.current;
    if (!snapshot.bundle) {
      writePlainText(response, 409, snapshot.error ?? 'Blueprint project is unavailable');
      return;
    }
    const activity = createBlueprintAgentActivityEvent(snapshot.bundle, event);
    if (activity.phase === 'started') {
      state.activityHub.publishActivity(activity);
    } else {
      void settledRevision(state.snapshots).then(settled => state.activityHub.publishActivity({ ...activity, ...settled }));
    }
    response.writeHead(202, createBlueprintResponseHeaders({ contentType: 'application/json; charset=utf-8' }));
    response.end('{"accepted":true}\n');
  } catch (error) {
    writePlainText(response, 400, error instanceof Error ? error.message : String(error));
  }
}

async function exchangeCanvasSelection({ state, request, response }: ServeExchange): Promise<void> {
  if (request.method === 'GET') {
    if (!hasActivityToken(state, request)) {
      writePlainText(response, 403, 'Forbidden');
      return;
    }
    const selection = state.canvasSelection ?? null;
    const files = selection ? await settledSelectionFiles(state.snapshots, selection) : undefined;
    response.writeHead(200, createBlueprintResponseHeaders({ contentType: 'application/json; charset=utf-8' }));
    response.end(JSON.stringify({ version: 1, selection, ...(files ? { files } : {}) }));
    return;
  }
  if (request.headers[BLUEPRINT_CANVAS_TOKEN_HEADER] !== state.canvasToken) {
    writePlainText(response, 403, 'Forbidden');
    return;
  }
  try {
    const body = await readJsonRequest(request, 64 * 1024) as { selection?: unknown };
    const selection = body?.selection === null ? null : parseCanvasSelection(body?.selection);
    if (selection === undefined) {
      writePlainText(response, 400, 'Invalid Blueprint canvas selection');
      return;
    }
    state.canvasSelection = selection
      ? { ...selection, selectedAt: new Date().toISOString(), revision: state.snapshots.current.revision }
      : undefined;
    writePlainText(response, 204);
  } catch (error) {
    writePlainText(response, 400, error instanceof Error ? error.message : String(error));
  }
}

async function settledSelectionFiles(snapshots: ServeProjectSnapshots, selection: StoredCanvasSelection): Promise<string[] | undefined> {
  const snapshot = await settledBeforeDeadline(snapshots);
  if (!snapshot?.bundle || snapshot.error !== undefined) return undefined;
  try {
    return selectionSourceFiles(snapshot.bundle, selection);
  } catch {
    return undefined;
  }
}

async function sendProjectSnapshot({ state: { snapshots }, request, response, requestUrl }: ServeExchange): Promise<void> {
  if (request.method === 'HEAD') {
    const available = snapshots.current.bundle !== undefined;
    response.writeHead(available ? 200 : 503, createBlueprintResponseHeaders({
      contentType: available ? 'application/json; charset=utf-8' : 'application/problem+json; charset=utf-8'
    }));
    response.end();
    return;
  }
  const snapshot = await snapshots.settled();
  if (!snapshot.linkedBundle) {
    response.writeHead(503, createBlueprintResponseHeaders({ contentType: 'application/problem+json; charset=utf-8' }));
    response.end(JSON.stringify({ message: snapshot.error ?? 'Blueprint project is unavailable.' }));
    return;
  }
  const base = requestUrl.searchParams.get('base');
  const delta = base === null ? undefined : snapshots.deltaFrom(base, snapshot);
  response.writeHead(200, createBlueprintResponseHeaders({ contentType: 'application/json; charset=utf-8' }));
  response.end(JSON.stringify(delta ?? {
    version: 1,
    revision: snapshot.revision,
    bundle: snapshot.linkedBundle
  }));
}

function sendPrototypeAsset({ state, request, response, pathname }: ServeExchange): void {
  const sha256 = pathname.slice(PROTOTYPE_ASSET_PATH_PREFIX.length);
  const asset = PROTOTYPE_ASSET_HASH.test(sha256) ? state.snapshots.asset(sha256) : undefined;
  if (!asset) {
    writePlainText(response, 404, 'Not found');
    return;
  }
  response.writeHead(200, createPrototypeAssetResponseHeaders(asset.mediaType));
  response.end(request.method === 'HEAD' ? undefined : Buffer.from(asset.base64, 'base64'));
}

async function sendPrototypeReview({ state, request, response, requestUrl }: ServeExchange): Promise<void> {
  let reviewRequest: ReturnType<typeof parsePrototypeReviewRequest>;
  try {
    reviewRequest = parsePrototypeReviewRequest(requestUrl);
  } catch (error) {
    writePrototypeRouteError(response, 400, error);
    return;
  }

  try {
    const snapshot = await state.snapshots.settled();
    if (!snapshot.bundle || snapshot.error !== undefined) {
      throw new Error(snapshot.error ?? 'Blueprint project is unavailable. Fix: call validate on this project, then apply the Fix line of each error.');
    }
    const selection = resolvePrototypeReviewSelection(snapshot.bundle, reviewRequest);
    const compiled = compilePrototypeReview(snapshot.bundle, selection);
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
}

async function sendInspoImage({ state, request, response, pathname }: ServeExchange): Promise<void> {
  const fileName = INSPO_IMAGE_ROUTE.exec(pathname)![1]!;
  try {
    const imageRoot = await realpath(path.join(state.projectRoot, INSPO_IMAGE_DIRECTORY));
    const target = await realpath(path.join(imageRoot, fileName));
    if (path.dirname(target) !== imageRoot) {
      throw new Error('Inspo image resolves outside the inspo directory. Fix: replace the symbolic link in the inspo image directory with the image file.');
    }
    const body = await readFile(target);
    response.writeHead(200, createBlueprintResponseHeaders({ contentType: contentType(fileName) }));
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    writePlainText(response, 404, 'Not found');
  }
}

async function sendCanvasPage({ state, response }: ServeExchange): Promise<void> {
  const snapshot = await state.snapshots.settled();
  response.writeHead(200, createBlueprintResponseHeaders({ contentType: 'text/html; charset=utf-8' }));
  if (!snapshot.linkedBundle) {
    response.end(createServeErrorHtml(snapshot.error ?? 'Unable to load Blueprint project.', snapshot.outdatedFiles));
    return;
  }
  response.end(injectProjectBundle(state.indexHtml, snapshot.linkedBundle, snapshot.revision, snapshot.error === undefined ? undefined : { message: snapshot.error, outdatedFiles: snapshot.outdatedFiles }, state.canvasToken));
}

async function sendSiteFile({ state, response, pathname }: ServeExchange): Promise<void> {
  const filePath = path.resolve(state.siteRoot, `.${pathname}`);
  if (!filePath.startsWith(`${path.resolve(state.siteRoot)}${path.sep}`)) {
    writePlainText(response, 403, 'Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, createBlueprintResponseHeaders({ contentType: contentType(filePath) }));
    response.end(body);
  } catch {
    writePlainText(response, 404, 'Not found');
  }
}

function injectProjectBundle(
  indexHtml: string,
  bundle: LinkedProjectBundle,
  revision: string,
  loadError: BlueprintProjectLoadError | undefined,
  canvasToken: string
): string {
  const injection = [
    '<script>',
    `window.__BLUEPRINT_PROJECT_BUNDLE__=${serializeForInlineScript(bundle)};`,
    `window.__BLUEPRINT_LIVE_RUNTIME__=${serializeForInlineScript({
      eventsPath: BLUEPRINT_ACTIVITY_STREAM_PATH,
      snapshotPath: BLUEPRINT_PROJECT_SNAPSHOT_PATH,
      selectionPath: BLUEPRINT_SELECTION_PATH,
      revision,
      canvasToken
    })};`,
    loadError ? `window.__BLUEPRINT_PROJECT_LOAD_ERROR__=${serializeForInlineScript(loadError)};` : 'delete window.__BLUEPRINT_PROJECT_LOAD_ERROR__;',
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

/** The page serve shows while the project has never loaded; it reloads once the project validates. */
function createServeErrorHtml(message: string, outdatedFiles: BlueprintOutdatedFile[]): string {
  const needsMigrate = outdatedFiles.length > 0;
  const body = needsMigrate
    ? [
      '<h1>This sidecar needs migrate</h1>',
      `<p>Blueprint now reads schema ${BLUEPRINT_SCHEMA_VERSION}, and these files use an older schema. Ask your agent to run the Blueprint migrate tool on this project, then fix each error that it returns.</p>`,
      `<ul>${outdatedFiles.map(({ file, version }) => `<li><code>${escapeHtml(file)}</code> is on schema ${escapeHtml(version)}.</li>`).join('')}</ul>`
    ].join('')
    : [
      '<h1>Blueprint cannot load this sidecar</h1>',
      '<p>Fix the errors below. Each one names the change to make.</p>',
      `<pre>${escapeHtml(message)}</pre>`
    ].join('');
  const reload = `<script>new EventSource(${serializeForInlineScript(BLUEPRINT_ACTIVITY_STREAM_PATH)}).addEventListener('project-changed',()=>location.reload());</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${needsMigrate ? 'Blueprint: migrate this sidecar' : 'Blueprint project error'}</title><style>${SERVE_ERROR_CSS}</style></head><body><main id="blueprint-serve-error" data-reason="${needsMigrate ? 'migrate' : 'invalid'}"><p class="eyebrow">Blueprint</p>${body}<p class="hint">This page reloads by itself when the project is valid.</p></main>${reload}</body></html>`;
}

const SERVE_ERROR_CSS = [
  'html{color-scheme:dark;background:#1e1e1e}',
  'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;box-sizing:border-box;font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#ededed}',
  'main{width:min(640px,100%);padding:28px 32px;border:1px solid color-mix(in srgb,#d7a760 58%,transparent);border-radius:8px;background:#262626}',
  '[data-reason=invalid]{border-color:color-mix(in srgb,#e66b6b 62%,transparent)}',
  '.eyebrow{margin:0 0 6px;color:#9a9a9a;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
  'h1{margin:0 0 12px;font-size:20px;line-height:1.3}',
  'p{margin:0 0 12px}',
  'ul{margin:0 0 12px;padding-left:20px}',
  'code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
  'pre{margin:0 0 12px;padding:12px;max-height:50vh;overflow:auto;white-space:pre-wrap;border-radius:6px;background:#1e1e1e;color:#ededed}',
  '.hint{margin:0;color:#9a9a9a;font-size:12px}'
].join('');

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
      throw new Error(`Blueprint activity request exceeded ${maximumBytes} bytes. Fix: send a request of ${maximumBytes} bytes or fewer.`);
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
        reject(new Error(`EADDRINUSE: port ${port} is already in use for the Blueprint review server. Fix: pass another port, or omit port so that Blueprint selects a free port.`));
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
  throw new Error('Blueprint could not find an available review port between 4173 and 4273. Fix: stop a server on one of these ports, or pass a free port above 4273.');
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
    writePlainText(response, 503, 'Service unavailable');
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
  if (filePath.endsWith('.jpg')) {
    return 'image/jpeg';
  }
  if (filePath.endsWith('.webp')) {
    return 'image/webp';
  }
  if (filePath.endsWith('.gif')) {
    return 'image/gif';
  }
  if (filePath.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  return 'application/octet-stream';
}

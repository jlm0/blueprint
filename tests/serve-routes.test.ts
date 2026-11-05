import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { findLiveBlueprintActivityRuntime } from '../src/mcp/activity';
import { blueprintServeRuntimeKey, exploreBlueprint, migrateBlueprint, serveBlueprint, type BlueprintServeHandle } from '../src/mcp/operations';
import { loadValidatedProject, type ProjectReader } from '../src/mcp/project-validation';
import { answerFailedRequests, startServeServer, type LocalServeServer, type ProjectWatch } from '../src/mcp/serve-server';
import { rewriteUntilSeen, serveWatched, settleFileEvents } from './support/serve-watched';
import { hashProjectAssets, readValidatedProject } from '../src/mcp/project-validation-worker';
import { PROTOTYPE_CONTENT_SECURITY_POLICY } from '../src/prototype/compiler';
import { compilePrototypeReview, parsePrototypeReviewRequest, resolvePrototypeReviewSelection } from '../src/prototype/review';

const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';
const brokenRoot = 'fixtures/invalid/broken/design/blueprint';
const siteRoot = 'dist/site';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const DEFENSIVE_HEADERS: HeaderPairs = [
  ['Cache-Control', 'no-store'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Cross-Origin-Resource-Policy', 'same-origin']
];
const PLAIN_TEXT_HEADERS: HeaderPairs = [...DEFENSIVE_HEADERS, ['Content-Type', 'text/plain; charset=utf-8']];
const JSON_HEADERS: HeaderPairs = [...DEFENSIVE_HEADERS, ['Content-Type', 'application/json; charset=utf-8']];
const PROBLEM_HEADERS: HeaderPairs = [...DEFENSIVE_HEADERS, ['Content-Type', 'application/problem+json; charset=utf-8']];
const HTML_HEADERS: HeaderPairs = [...DEFENSIVE_HEADERS, ['Content-Type', 'text/html; charset=utf-8']];
const HOP_BY_HOP_HEADERS = new Set(['date', 'connection', 'keep-alive', 'content-length', 'transfer-encoding']);

type HeaderPairs = Array<[string, string]>;

interface RouteResponse {
  status: number;
  headers: HeaderPairs;
  body: Buffer;
  text: string;
}

interface RouteRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

interface ServedProject {
  project: string;
  served: BlueprintServeHandle;
  port: number;
  activityToken: string;
  canvasToken: string;
  close: () => Promise<void>;
}

describe('serve request failures', () => {
  it('answers a request whose handler throws with 500, and keeps the process and the server alive', async () => {
    const server = createHttpServer(answerFailedRequests(async () => {
      throw new Error('handler fault');
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assertRoute(await sendRoute(port, { path: '/' }), { status: 500, headers: PLAIN_TEXT_HEADERS, text: 'Internal server error' });
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

describe('serve routes on a valid project', () => {
  let target: ServedProject;

  before(async () => {
    target = await serveCopy(umbraRoot, async project => {
      await mkdir(path.join(project, 'inspo'), { recursive: true });
      await writeFile(path.join(project, 'inspo', 'ref-1.png'), PNG);
      await writeFile(path.join(project, 'inspo', 'ref-2.jpg'), PNG);
      await writeFile(path.join(project, 'inspo', 'ref-3.webp'), PNG);
      await writeFile(path.join(project, 'inspo', 'ref-4.gif'), PNG);
      await symlink(path.join(project, 'manifest.json'), path.join(project, 'inspo', 'leak.png'));
    });
  });

  after(async () => {
    await target?.close();
  });

  const send = (request: RouteRequest): Promise<RouteResponse> => sendRoute(target.port, request);

  describe('method rules', () => {
    for (const { path: routePath, methods, allow } of [
      { path: '/__blueprint/events', methods: ['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allow: 'GET' },
      { path: '/__blueprint/agent-activity', methods: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'], allow: 'POST' },
      { path: '/__blueprint/selection', methods: ['HEAD', 'POST', 'DELETE', 'OPTIONS'], allow: 'GET, PUT' },
      { path: '/__blueprint/project', methods: ['POST', 'PUT', 'DELETE', 'OPTIONS'], allow: 'GET, HEAD' },
      { path: '/__blueprint/assets/not-a-hash', methods: ['POST', 'PUT', 'DELETE', 'OPTIONS'], allow: 'GET, HEAD' },
      { path: '/__blueprint/prototype?unsupported=true', methods: ['POST', 'PUT', 'DELETE', 'OPTIONS'], allow: 'GET, HEAD' },
      { path: '/__blueprint/inspo/missing.png', methods: ['POST', 'PUT', 'DELETE', 'OPTIONS'], allow: 'GET, HEAD' }
    ]) {
      for (const method of methods) {
        it(`answers ${method} ${routePath} with 405 and Allow: ${allow}, before any other check`, async () => {
          assertRoute(await send({ method, path: routePath }), {
            status: 405,
            headers: [['Allow', allow], ...PLAIN_TEXT_HEADERS],
            text: method === 'HEAD' ? '' : 'Method not allowed'
          });
        });
      }
    }

    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      it(`has no method rule on /index.html or a site file for ${method}`, async () => {
        const page = await send({ method, path: '/index.html' });
        assert.equal(page.status, 200);
        assert.deepEqual(page.headers, HTML_HEADERS);
        assert.match(page.text, /window\.__BLUEPRINT_PROJECT_BUNDLE__/);

        const script = builtSiteFile('.js');
        const file = await send({ method, path: `/assets/${script}` });
        assert.equal(file.status, 200);
        assert.deepEqual(file.headers, [...DEFENSIVE_HEADERS, ['Content-Type', 'text/javascript; charset=utf-8']]);
        assert.deepEqual(file.body, readFileSync(path.join(siteRoot, 'assets', script)));
      });
    }
  });

  describe('admission', () => {
    for (const routePath of ['/', '/__blueprint/project', '/__blueprint/selection', '/assets/missing.js']) {
      it(`answers a wrong Host on ${routePath} with 421`, async () => {
        assertRoute(await send({ path: routePath, headers: { host: `localhost:${target.port}` } }), {
          status: 421,
          headers: PLAIN_TEXT_HEADERS,
          text: 'Misdirected Request\n'
        });
      });
    }

    it('answers a path that does not decode with 400', async () => {
      assertRoute(await send({ path: '/%E0%A4%A' }), { status: 400, headers: PLAIN_TEXT_HEADERS, text: 'Bad request' });
      assertRoute(await send({ method: 'POST', path: '/__blueprint/%E0%A4%A' }), { status: 400, headers: PLAIN_TEXT_HEADERS, text: 'Bad request' });
    });

    it('matches a route on the decoded path', async () => {
      assert.equal((await send({ path: '/__blueprint/%70roject' })).status, 200);
      assert.equal((await send({ method: 'POST', path: '/__blueprint/%70roject' })).status, 405);
    });

    for (const requestTarget of ['//', '//?x', '/\\', '//a:b', '//%', '//1.2.3.256', 'http://', 'http://a:b/']) {
      it(`answers the target ${JSON.stringify(requestTarget)} that is not a URL with 400, and keeps serving`, async () => {
        assert.equal(await sendRawTarget(target.port, requestTarget), 'HTTP/1.1 400 Bad Request');
        assert.equal((await send({ path: '/__blueprint/project' })).status, 200);
      });
    }
  });

  describe('activity stream', () => {
    it('answers GET with the event stream headers and the stream preamble', async () => {
      const stream = await openStream(target.port);
      try {
        assert.equal(stream.response.statusCode, 200);
        assert.deepEqual(routeHeaders(stream.response), [
          ['X-Accel-Buffering', 'no'],
          ...DEFENSIVE_HEADERS,
          ['Content-Type', 'text/event-stream; charset=utf-8']
        ]);
        assert.equal(stream.response.headers.connection, 'keep-alive');
        await stream.waitFor(text => text.includes(': blueprint activity stream\n\n'));
      } finally {
        stream.close();
      }
    });
  });

  describe('activity post', () => {
    const activity = (phase: string, toolUseId: string): string => JSON.stringify({
      version: 1,
      sessionId: 'route-session',
      toolUseId,
      toolName: 'mcp__blueprint__query',
      phase,
      emittedAt: new Date().toISOString(),
      toolInput: {}
    });
    const post = (body: string, token: string | undefined = target.activityToken): Promise<RouteResponse> => send({
      method: 'POST',
      path: '/__blueprint/agent-activity',
      headers: token === undefined ? {} : { 'x-blueprint-activity-token': token },
      body
    });

    it('refuses a missing or wrong token with 403', async () => {
      for (const token of [undefined, 'wrong-token']) {
        const refused = await sendRoute(target.port, {
          method: 'POST',
          path: '/__blueprint/agent-activity',
          headers: token ? { 'x-blueprint-activity-token': token } : {},
          body: activity('started', 'refused')
        });
        assertRoute(refused, { status: 403, headers: PLAIN_TEXT_HEADERS, text: 'Forbidden' });
      }
    });

    it('answers a body that is not JSON with 400 and the parse error', async () => {
      assertRoute(await post('{'), { status: 400, headers: PLAIN_TEXT_HEADERS, text: thrownMessage(() => JSON.parse('{')) });
    });

    it('answers an event with the wrong shape with 400', async () => {
      assertRoute(await post('{"version":1}'), { status: 400, headers: PLAIN_TEXT_HEADERS, text: 'Invalid Blueprint activity event' });
    });

    it('answers a body over the limit with 400', async () => {
      assertRoute(await post(`"${'x'.repeat(256 * 1024)}"`), {
        status: 400,
        headers: PLAIN_TEXT_HEADERS,
        text: 'Blueprint activity request exceeded 262144 bytes. Fix: send a request of 262144 bytes or fewer.'
      });
    });

    it('accepts a started event at once and a completed event after the snapshot settles', async () => {
      const stream = await openStream(target.port);
      try {
        await stream.waitFor(text => text.includes(': blueprint activity stream\n\n'));
        const accepted = { status: 202, headers: JSON_HEADERS, text: '{"accepted":true}\n' };
        assertRoute(await post(activity('started', 'tool-settled')), accepted);
        await stream.waitFor(text => text.includes('"phase":"started"'));
        assert.doesNotMatch(stream.text(), /"projectValid"/);

        const revision = await currentRevision(target.port);
        const postedAt = Date.now();
        assertRoute(await post(activity('completed', 'tool-settled')), accepted);
        const [event] = await stream.waitForEvents('agent-activity', item => item.phase === 'completed');
        assert.ok(Date.now() - postedAt >= 190, 'a completed event waits for the watcher event grace');
        assert.equal(event.revision, revision);
        assert.equal(event.projectValid, true);
      } finally {
        stream.close();
      }
    });
  });

  describe('selection', () => {
    const selection = {
      boundaryId: 'umbra-gaming/screen/launch',
      kind: 'screen',
      localId: 'launch',
      label: 'Launch',
      context: []
    };
    const get = (token?: string): Promise<RouteResponse> => send({
      path: '/__blueprint/selection',
      headers: token ? { 'x-blueprint-activity-token': token } : {}
    });
    const put = (body: string, token: string | undefined = target.canvasToken): Promise<RouteResponse> => send({
      method: 'PUT',
      path: '/__blueprint/selection',
      headers: token ? { 'x-blueprint-canvas-token': token } : {},
      body
    });

    it('refuses GET without the activity token with 403', async () => {
      assertRoute(await get(), { status: 403, headers: PLAIN_TEXT_HEADERS, text: 'Forbidden' });
      assertRoute(await get(target.canvasToken), { status: 403, headers: PLAIN_TEXT_HEADERS, text: 'Forbidden' });
    });

    it('refuses PUT without the canvas token with 403', async () => {
      const refused = await send({ method: 'PUT', path: '/__blueprint/selection', body: '{"selection":null}' });
      assertRoute(refused, { status: 403, headers: PLAIN_TEXT_HEADERS, text: 'Forbidden' });
      assertRoute(await put('{"selection":null}', target.activityToken), { status: 403, headers: PLAIN_TEXT_HEADERS, text: 'Forbidden' });
    });

    it('answers a body that is not JSON or not a selection with 400', async () => {
      assertRoute(await put('{'), { status: 400, headers: PLAIN_TEXT_HEADERS, text: thrownMessage(() => JSON.parse('{')) });
      for (const body of ['{}', 'null', '{"selection":{"kind":"unknown"}}']) {
        assertRoute(await put(body), { status: 400, headers: PLAIN_TEXT_HEADERS, text: 'Invalid Blueprint canvas selection' });
      }
    });

    it('answers a body over the limit with 400', async () => {
      assertRoute(await put(`"${'x'.repeat(64 * 1024)}"`), {
        status: 400,
        headers: PLAIN_TEXT_HEADERS,
        text: 'Blueprint activity request exceeded 65536 bytes. Fix: send a request of 65536 bytes or fewer.'
      });
    });

    it('stores a selection with 204 and returns it on GET, then clears it', async () => {
      assertRoute(await get(target.activityToken), { status: 200, headers: JSON_HEADERS, text: '{"version":1,"selection":null}' });

      assertRoute(await put(JSON.stringify({ selection })), { status: 204, headers: PLAIN_TEXT_HEADERS, text: '' });
      const stored = await get(target.activityToken);
      assert.equal(stored.status, 200);
      assert.deepEqual(stored.headers, JSON_HEADERS);
      const payload = JSON.parse(stored.text) as { version: number; selection: Record<string, unknown> };
      assert.equal(payload.version, 1);
      assert.deepEqual({ ...payload.selection, selectedAt: undefined, revision: undefined }, { ...selection, selectedAt: undefined, revision: undefined });
      assert.equal(payload.selection.revision, await currentRevision(target.port));
      assert.ok(!Number.isNaN(Date.parse(payload.selection.selectedAt as string)));

      assertRoute(await put('{"selection":null}'), { status: 204, headers: PLAIN_TEXT_HEADERS, text: '' });
      assertRoute(await get(target.activityToken), { status: 200, headers: JSON_HEADERS, text: '{"version":1,"selection":null}' });
    });
  });

  describe('project snapshot', () => {
    it('answers GET with the current revision and bundle', async () => {
      const snapshot = await send({ path: '/__blueprint/project' });
      assert.equal(snapshot.status, 200);
      assert.deepEqual(snapshot.headers, JSON_HEADERS);
      const payload = JSON.parse(snapshot.text) as { version: number; revision: string; bundle: { manifest: { project: { id: string } } } };
      assert.equal(payload.version, 1);
      assert.match(payload.revision, /^[0-9a-f-]{36}$/);
      assert.equal(payload.bundle.manifest.project.id, 'umbra-gaming');
    });

    it('answers HEAD with 200 and no body', async () => {
      assertRoute(await send({ method: 'HEAD', path: '/__blueprint/project' }), { status: 200, headers: JSON_HEADERS, text: '' });
    });

    it('answers an unknown base with the full snapshot', async () => {
      const snapshot = await send({ path: '/__blueprint/project?base=unknown' });
      assert.equal(snapshot.status, 200);
      assert.deepEqual(snapshot.headers, JSON_HEADERS);
      assert.ok((JSON.parse(snapshot.text) as { bundle?: unknown }).bundle);
    });
  });

  describe('prototype assets', () => {
    it('answers GET and HEAD for a current hash with the asset headers', async () => {
      const bundle = await loadProjectFromFs(target.project);
      const hashes = hashProjectAssets(bundle);
      const [assetRef, hash] = Object.entries(hashes)[0]!;
      const asset = bundle.prototypeAssetContents[assetRef]!;
      const headers: HeaderPairs = [
        ['Content-Type', asset.mediaType],
        ['Cache-Control', 'public, max-age=31536000, immutable'],
        ['X-Content-Type-Options', 'nosniff'],
        ['Cross-Origin-Resource-Policy', 'cross-origin'],
        ['Access-Control-Allow-Origin', '*'],
        ['Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox"]
      ];
      const got = await send({ path: `/__blueprint/assets/${hash}` });
      assert.equal(got.status, 200);
      assert.deepEqual(got.headers, headers);
      assert.equal(got.body.toString('base64'), asset.base64);
      assertRoute(await send({ method: 'HEAD', path: `/__blueprint/assets/${hash}` }), { status: 200, headers, text: '' });
    });

    it('answers an unknown or malformed hash with 404', async () => {
      const unknown = createHash('sha256').update('not an asset').digest('hex');
      for (const method of ['GET', 'HEAD']) {
        for (const routePath of [`/__blueprint/assets/${unknown}`, '/__blueprint/assets/not-a-hash', '/__blueprint/assets/', '/__blueprint/assets/..%2Findex.html']) {
          assertRoute(await send({ method, path: routePath }), {
            status: 404,
            headers: PLAIN_TEXT_HEADERS,
            text: method === 'HEAD' ? '' : 'Not found'
          });
        }
      }
    });
  });

  describe('prototype review', () => {
    it('answers GET and HEAD with the compiled document and the review headers', async () => {
      const bundle = await loadProjectFromFs(target.project);
      const selection = resolvePrototypeReviewSelection(bundle, { screenId: 'launch' });
      const compiled = compilePrototypeReview(bundle, selection);
      const headers: HeaderPairs = [
        ['X-Blueprint-Screen', selection.screenId],
        ['X-Blueprint-State', selection.state],
        ['X-Blueprint-Viewport', selection.framePresetId],
        ['X-Blueprint-Review-Condition', selection.conditionId],
        ...DEFENSIVE_HEADERS,
        ['Content-Type', 'text/html; charset=utf-8'],
        ['Content-Security-Policy', PROTOTYPE_CONTENT_SECURITY_POLICY]
      ];
      const got = await send({ path: '/__blueprint/prototype?screen=launch' });
      assert.equal(got.status, 200);
      assert.deepEqual(got.headers, headers);
      assert.equal(got.text, compiled.html);
      assertRoute(await send({ method: 'HEAD', path: '/__blueprint/prototype?screen=launch' }), { status: 200, headers, text: '' });
    });

    it('answers a bad review request with 400 and a problem body', async () => {
      for (const query of ['', '?unsupported=true', '?screen=launch&screen=hub', '?screen=']) {
        const detail = thrownMessage(() => parsePrototypeReviewRequest(new URL(`http://127.0.0.1/__blueprint/prototype${query}`)));
        assertRoute(await send({ path: `/__blueprint/prototype${query}` }), {
          status: 400,
          headers: PROBLEM_HEADERS,
          text: problemBody(400, detail)
        });
      }
    });

    it('answers an unknown screen with 404 and a problem body', async () => {
      assertRoute(await send({ path: '/__blueprint/prototype?screen=missing' }), {
        status: 404,
        headers: PROBLEM_HEADERS,
        text: problemBody(404, 'Screen not found: missing. Fix: pass one of these screen ids: launch, hub, match.')
      });
    });

    it('answers a screen that cannot resolve with 422 and a problem body', async () => {
      const bundle = await loadProjectFromFs(target.project);
      const detail = thrownMessage(() => resolvePrototypeReviewSelection(bundle, { screenId: 'launch', state: 'missing-state' }));
      assertRoute(await send({ path: '/__blueprint/prototype?screen=launch&state=missing-state' }), {
        status: 422,
        headers: PROBLEM_HEADERS,
        text: problemBody(422, detail)
      });
    });

    it('does not treat a longer path as the review route', async () => {
      assertRoute(await send({ path: '/__blueprint/prototype/' }), { status: 404, headers: PLAIN_TEXT_HEADERS, text: 'Not found' });
    });
  });

  describe('inspo images', () => {
    for (const [fileName, mediaType] of [
      ['ref-1.png', 'image/png'],
      ['ref-2.jpg', 'image/jpeg'],
      ['ref-3.webp', 'image/webp'],
      ['ref-4.gif', 'image/gif']
    ] as const) {
      it(`answers GET and HEAD for ${fileName} with ${mediaType}`, async () => {
        const headers: HeaderPairs = [...DEFENSIVE_HEADERS, ['Content-Type', mediaType]];
        const got = await send({ path: `/__blueprint/inspo/${fileName}` });
        assert.equal(got.status, 200);
        assert.deepEqual(got.headers, headers);
        assert.deepEqual(got.body, PNG);
        assertRoute(await send({ method: 'HEAD', path: `/__blueprint/inspo/${fileName}` }), { status: 200, headers, text: '' });
      });
    }

    it('answers a missing image or an image that leaves the directory with 404', async () => {
      for (const method of ['GET', 'HEAD']) {
        for (const routePath of ['/__blueprint/inspo/missing.png', '/__blueprint/inspo/leak.png']) {
          assertRoute(await send({ method, path: routePath }), {
            status: 404,
            headers: PLAIN_TEXT_HEADERS,
            text: method === 'HEAD' ? '' : 'Not found'
          });
        }
      }
    });

    it('does not treat another name as the image route, so POST finds no method rule', async () => {
      for (const routePath of ['/__blueprint/inspo/REF-1.png', '/__blueprint/inspo/ref-1.txt', '/__blueprint/inspo/..%2Fmanifest.json']) {
        for (const method of ['GET', 'POST']) {
          const refused = await send({ method, path: routePath });
          assert.equal(refused.status === 404 || refused.status === 403, true, routePath);
          assert.deepEqual(refused.headers, PLAIN_TEXT_HEADERS, routePath);
        }
      }
    });
  });

  describe('canvas page', () => {
    for (const routePath of ['/', '/index.html', '/?board=screens']) {
      it(`answers GET ${routePath} with the built page and the injected runtime`, async () => {
        const page = await send({ path: routePath });
        assert.equal(page.status, 200);
        assert.deepEqual(page.headers, HTML_HEADERS);

        const built = readFileSync(path.join(siteRoot, 'index.html'), 'utf8');
        const moduleScript = built.indexOf('<script type="module"');
        assert.ok(page.text.startsWith(built.slice(0, moduleScript)));
        assert.ok(page.text.endsWith(built.slice(moduleScript)));
        assert.match(page.text, /window\.__BLUEPRINT_PROJECT_BUNDLE__=\{/);
        assert.match(page.text, /delete window\.__BLUEPRINT_PROJECT_LOAD_ERROR__;/);

        const runtime = JSON.parse(/window\.__BLUEPRINT_LIVE_RUNTIME__=(.*?);(?:delete|window)/s.exec(page.text)![1]!) as Record<string, string>;
        assert.deepEqual(runtime, {
          eventsPath: '/__blueprint/events',
          snapshotPath: '/__blueprint/project',
          selectionPath: '/__blueprint/selection',
          revision: await currentRevision(target.port),
          canvasToken: target.canvasToken
        });
      });
    }
  });

  describe('site files', () => {
    for (const [extension, mediaType] of [
      ['.js', 'text/javascript; charset=utf-8'],
      ['.css', 'text/css; charset=utf-8']
    ] as const) {
      it(`answers a built ${extension} file with ${mediaType}`, async () => {
        const fileName = builtSiteFile(extension);
        const got = await send({ path: `/assets/${fileName}` });
        assert.equal(got.status, 200);
        assert.deepEqual(got.headers, [...DEFENSIVE_HEADERS, ['Content-Type', mediaType]]);
        assert.deepEqual(got.body, readFileSync(path.join(siteRoot, 'assets', fileName)));
      });
    }

    it('answers a missing file or a directory with 404', async () => {
      for (const method of ['GET', 'POST']) {
        for (const routePath of ['/assets/missing.js', '/assets', '/assets/', '/__blueprint/unknown', '/__blueprint/assets']) {
          assertRoute(await send({ method, path: routePath }), { status: 404, headers: PLAIN_TEXT_HEADERS, text: 'Not found' });
        }
      }
    });

    it('answers a path that leaves the site with 403', async () => {
      for (const routePath of ['/..%2Fpackage.json', '/..%2F..%2Fpackage.json', '/..%2Fsite']) {
        assertRoute(await send({ path: routePath }), { status: 403, headers: PLAIN_TEXT_HEADERS, text: 'Forbidden' });
      }
    });
  });
});

describe('serve routes after a live change', () => {
  it('sends a delta, keeps the last good bundle while invalid, and reports each change on the stream', async () => {
    const target = await serveCopy(umbraRoot);
    const stream = await openStream(target.port);
    try {
      await stream.waitFor(text => text.includes(': blueprint activity stream\n\n'));
      const manifestPath = path.join(target.project, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const first = await currentRevision(target.port);

      manifest.project.name = 'Renamed Live';
      const [changed] = await writeUntilEvent(stream, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'project-changed', item => item.revision !== first);
      const second = changed.revision as string;
      assert.equal(changed.version, 1);
      assert.deepEqual(changed.changedPaths, ['manifest.json']);

      const delta = await sendRoute(target.port, { path: `/__blueprint/project?base=${first}` });
      assert.equal(delta.status, 200);
      assert.deepEqual(delta.headers, JSON_HEADERS);
      const deltaPayload = JSON.parse(delta.text) as { version: number; revision: string; base: string; delta: unknown; bundle?: unknown };
      assert.deepEqual([deltaPayload.version, deltaPayload.revision, deltaPayload.base], [1, second, first]);
      assert.ok(deltaPayload.delta);
      assert.equal(deltaPayload.bundle, undefined);

      const [failed] = await writeUntilEvent(stream, manifestPath, `${JSON.stringify({ ...manifest, schemaVersion: '1.0.0' }, null, 2)}\n`, 'project-error', item => /schema "1\.0\.0"/.test(String(item.message)));
      assert.deepEqual(failed.outdatedFiles, [{ file: 'manifest.json', version: '1.0.0' }]);

      const lastGood = await sendRoute(target.port, { path: '/__blueprint/project' });
      assert.equal(lastGood.status, 200);
      assert.equal((JSON.parse(lastGood.text) as { revision: string }).revision, second);
      assertRoute(await sendRoute(target.port, { method: 'HEAD', path: '/__blueprint/project' }), { status: 200, headers: JSON_HEADERS, text: '' });

      const page = await sendRoute(target.port, { path: '/' });
      assert.equal(page.status, 200);
      assert.deepEqual(page.headers, HTML_HEADERS);
      assert.match(page.text, /window\.__BLUEPRINT_PROJECT_LOAD_ERROR__=\{"message":"[^"]*schema \\"1\.0\.0\\"/);

      const review = await sendRoute(target.port, { path: '/__blueprint/prototype?screen=launch' });
      assert.equal(review.status, 422);
      assert.deepEqual(review.headers, PROBLEM_HEADERS);
      assert.match((JSON.parse(review.text) as { detail: string }).detail, /schema "1\.0\.0"/);

      const postedAt = await postCompleted(target, 'tool-invalid');
      const [event] = await stream.waitForEvents('agent-activity', item => item.toolUseId === 'tool-invalid');
      assert.ok(Date.now() - postedAt >= 190);
      assert.equal(event.revision, second);
      assert.equal(event.projectValid, false);
    } finally {
      stream.close();
      await target.close();
    }
  });
});

describe('serve routes on a project that never loaded', () => {
  let target: ServedProject;
  let error: string;

  before(async () => {
    target = await serveCopy(brokenRoot);
    error = (await readValidatedProject(target.project)).error ?? '';
    assert.notEqual(error, '');
  });

  after(async () => {
    await target?.close();
  });

  it('answers the snapshot routes with 503', async () => {
    assertRoute(await sendRoute(target.port, { path: '/__blueprint/project' }), {
      status: 503,
      headers: PROBLEM_HEADERS,
      text: JSON.stringify({ message: error })
    });
    assertRoute(await sendRoute(target.port, { method: 'HEAD', path: '/__blueprint/project' }), {
      status: 503,
      headers: PROBLEM_HEADERS,
      text: ''
    });
  });

  it('answers an activity event with 409 and the project error', async () => {
    assertRoute(await sendRoute(target.port, {
      method: 'POST',
      path: '/__blueprint/agent-activity',
      headers: { 'x-blueprint-activity-token': target.activityToken },
      body: JSON.stringify({ version: 1, sessionId: 's', toolUseId: 't', toolName: 'n', phase: 'started', emittedAt: new Date().toISOString() })
    }), { status: 409, headers: PLAIN_TEXT_HEADERS, text: error });
  });

  it('answers the review route with 422 and the project error', async () => {
    assertRoute(await sendRoute(target.port, { path: '/__blueprint/prototype?screen=workspace' }), {
      status: 422,
      headers: PROBLEM_HEADERS,
      text: problemBody(422, error)
    });
  });

  it('answers the page with 200 and the error page', async () => {
    for (const routePath of ['/', '/index.html']) {
      const page = await sendRoute(target.port, { path: routePath });
      assert.equal(page.status, 200);
      assert.deepEqual(page.headers, HTML_HEADERS);
      assert.match(page.text, /<main id="blueprint-serve-error" data-reason="invalid">/);
      assert.match(page.text, /<h1>Blueprint cannot load this sidecar<\/h1>/);
      assert.match(page.text, /new EventSource\("\/__blueprint\/events"\)/);
      assert.doesNotMatch(page.text, /__BLUEPRINT_PROJECT_BUNDLE__/);
    }
  });

  it('still answers an asset request with 404', async () => {
    const unknown = createHash('sha256').update('not an asset').digest('hex');
    assertRoute(await sendRoute(target.port, { path: `/__blueprint/assets/${unknown}` }), { status: 404, headers: PLAIN_TEXT_HEADERS, text: 'Not found' });
  });

  it('answers the inspo image route with 404 when the project has no inspo directory', async () => {
    assert.equal(existsSync(path.join(target.project, 'inspo')), false);
    assertRoute(await sendRoute(target.port, { path: '/__blueprint/inspo/ref-1.png' }), { status: 404, headers: PLAIN_TEXT_HEADERS, text: 'Not found' });
  });
});

describe('completed activity deadline', () => {
  it('publishes a completed event with the current revision after 5 s when a reload does not finish', async () => {
    let reads = 0;
    let releaseRead: (() => void) | undefined;
    const read: ProjectReader = async root => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>(resolve => {
          releaseRead = resolve;
        });
      }
      return readValidatedProject(root);
    };
    const target = await serveCopy(umbraRoot, undefined, read);
    const stream = await openStream(target.port);
    try {
      await stream.waitFor(text => text.includes(': blueprint activity stream\n\n'));
      const revision = await currentRevision(target.port);
      const manifestPath = path.join(target.project, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.project.name = 'Slow Reload';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await rewriteUntilSeen(manifestPath, () => releaseRead !== undefined);

      const postedAt = await postCompleted(target, 'tool-deadline');
      const [event] = await stream.waitForEvents('agent-activity', item => item.toolUseId === 'tool-deadline');
      const elapsed = Date.now() - postedAt;
      assert.ok(elapsed >= 5_000, `the deadline event arrived after ${elapsed} ms`);
      assert.equal(event.revision, revision);
      assert.equal(event.projectValid, true);

      releaseRead?.();
      await stream.waitForEvents('project-changed', item => item.revision !== revision);
    } finally {
      releaseRead?.();
      stream.close();
      await target.close();
    }
  });
});

describe('serve change sources with no file events', () => {
  const POLL_WAIT_MS = 5_000;

  it('holds the explore result in settledProject at once after the tool returns, and sends one project-changed event', async () => {
    const target = await serveWithoutFileEvents(umbraRoot);
    const stream = await openStream(target.server.port);
    try {
      await stream.waitFor(text => text.includes(': blueprint activity stream\n\n'));
      const before = target.server.latestProject!().revision;
      await exploreBlueprint({ project: target.project, operation: launchExploration('launch-hero') });
      const settled = await target.server.settledProject!();
      assert.ok(settled, 'settledProject ended at its deadline.');
      assert.ok(settled.bundle?.explorations.explorations.some(exploration => exploration.id === 'launch-hero'), 'settledProject does not hold the new exploration.');
      assert.notEqual(settled.revision, before);
      const [changed] = await stream.waitForEvents('project-changed', () => true);
      assert.equal(changed.revision, settled.revision);
      assert.ok((changed.changedPaths as string[]).includes('explorations/launch-hero.json'));

      const readsBeforeLateEvent = target.reads();
      for (const changedPath of changed.changedPaths as string[]) target.report(changedPath);
      const afterLateEvent = await target.server.settledProject!();
      assert.equal(target.reads(), readsBeforeLateEvent + 1, 'The late file event must start a reload, or this check proves nothing.');
      assert.equal(afterLateEvent?.revision, settled.revision);
      await delay(300);
      assert.equal(stream.events('project-changed').length, 1);
    } finally {
      stream.close();
      await target.close();
    }
  });

  it('holds the migrate result in settledProject at once after the tool returns', async () => {
    const target = await serveWithoutFileEvents(umbraRoot, async project => {
      const manifestPath = path.join(project, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.schemaVersion = '1.0.0';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    });
    try {
      assert.match(target.server.latestProject!().error ?? '', /schema "1\.0\.0"/);
      const migrated = await migrateBlueprint({ project: target.project, dryRun: false });
      assert.deepEqual(migrated.files, ['manifest.json']);
      const settled = await target.server.settledProject!();
      assert.equal(settled?.error, undefined);
      assert.ok(settled?.bundle);
    } finally {
      await target.close();
    }
  });

  it('sends project-changed for a hand edit through the stat poll within 5 s', async () => {
    const target = await serveWithoutFileEvents(umbraRoot);
    const stream = await openStream(target.server.port);
    try {
      await stream.waitFor(text => text.includes(': blueprint activity stream\n\n'));
      await renameProject(target.project, 'Edited With No File Event');
      const editedAt = performance.now();
      while (stream.events('project-changed').length === 0) {
        assert.ok(performance.now() - editedAt < POLL_WAIT_MS, 'No project-changed event arrived within 5 s of the hand edit.');
        await delay(25);
      }
      assert.deepEqual(stream.events('project-changed')[0]?.changedPaths, ['manifest.json']);
      assert.equal(target.server.latestProject!().bundle?.manifest.project.name, 'Edited With No File Event');
    } finally {
      stream.close();
      await target.close();
    }
  });

  it('starts one reload for a hand edit that the watcher and the poll both see', async () => {
    const target = await serveWithoutFileEvents(umbraRoot);
    try {
      const readsBefore = target.reads();
      await renameProject(target.project, 'Seen Twice');
      target.report('manifest.json');
      await target.server.settledProject!();
      assert.equal(target.reads(), readsBefore + 1);
      await delay(POLL_WAIT_MS);
      await target.server.settledProject!();
      assert.equal(target.reads(), readsBefore + 1, 'The poll started a second reload for a change that a reload already read.');
    } finally {
      await target.close();
    }
  });
});

async function serveCopy(
  fixture: string,
  prepare?: (project: string) => Promise<void>,
  read?: ProjectReader
): Promise<ServedProject> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-serve-routes-'));
  const project = path.join(tempDir, 'design', 'blueprint');
  await cp(fixture, project, { recursive: true });
  await prepare?.(project);
  let served: BlueprintServeHandle;
  if (read) {
    await settleFileEvents(project);
    served = await serveBlueprint({ project, port: 0 }, undefined, undefined, read);
  } else {
    served = await serveWatched(project);
  }
  const close = async (): Promise<void> => {
    await served.close();
    await rm(tempDir, { recursive: true, force: true });
  };
  try {
    const runtime = await findLiveBlueprintActivityRuntime(await blueprintServeRuntimeKey(project));
    assert.ok(runtime, 'serve registers a live runtime');
    const page = (await sendRoute(served.port, { path: '/' })).text;
    const canvasToken = /"canvasToken":"([^"]+)"/.exec(page)?.[1] ?? '';
    return { project, served, port: served.port, activityToken: runtime.token, canvasToken, close };
  } catch (error) {
    await close();
    throw error;
  }
}

interface UnwatchedServe {
  project: string;
  server: LocalServeServer;
  reads: () => number;
  report: (changedPath: string) => void;
  close: () => Promise<void>;
}

/** The watcher reports only what the test passes to report, as when FSEvents loses each event. */
async function serveWithoutFileEvents(fixture: string, prepare?: (project: string) => Promise<void>): Promise<UnwatchedServe> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-serve-sources-'));
  const project = path.join(tempDir, 'design', 'blueprint');
  await cp(fixture, project, { recursive: true });
  await prepare?.(project);
  let reads = 0;
  let onChange: ((changedPath: string) => void) | undefined;
  const watch: ProjectWatch = (_projectRoot, report) => {
    onChange = report;
    return () => {
      onChange = undefined;
    };
  };
  const server = await startServeServer(project, 0, undefined, (root, signal) => {
    reads += 1;
    return loadValidatedProject(root, signal);
  }, { watch });
  return {
    project,
    server,
    reads: () => reads,
    report: changedPath => onChange?.(changedPath),
    close: async () => {
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function renameProject(project: string, name: string): Promise<void> {
  const manifestPath = path.join(project, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.project.name = name;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function launchExploration(id: string) {
  return {
    type: 'create' as const,
    id,
    screenId: 'launch',
    state: 'default',
    framePresetId: 'desktop-web-page',
    title: 'Launch hero',
    intent: 'Compare hero directions without changing the canonical canvas.',
    candidateLabels: ['A', 'B', 'C']
  };
}

function sendRoute(port: number, { method = 'GET', path: routePath, headers = {}, body }: RouteRequest): Promise<RouteResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path: routePath,
      agent: false,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }) }
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const received = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, headers: routeHeaders(response), body: received, text: received.toString('utf8') });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

/** The HTTP client changes some targets before it sends them, so this request writes the target to the socket as given. */
function sendRawTarget(port: number, requestTarget: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let received = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error(`serve gave no reply to ${requestTarget} in 5 s`)));
    socket.on('data', (chunk: string) => { received += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(received.split('\r\n')[0] ?? ''));
    socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  });
}

/** The headers that the route sets, in order, so a change of name, value, or order fails the test. */
function routeHeaders(response: IncomingMessage): HeaderPairs {
  const pairs: HeaderPairs = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index]!;
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) pairs.push([name, response.rawHeaders[index + 1]!]);
  }
  return pairs;
}

function assertRoute(actual: RouteResponse, expected: { status: number; headers: HeaderPairs; text: string }): void {
  assert.deepEqual(
    { status: actual.status, headers: actual.headers, text: actual.text },
    { status: expected.status, headers: expected.headers, text: expected.text }
  );
}

function problemBody(status: number, detail: string): string {
  return `${JSON.stringify({ type: 'blueprint/prototype-review-error', title: 'Prototype review unavailable', status, detail })}\n`;
}

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail('The call must throw.');
}

function builtSiteFile(extension: string): string {
  const fileName = readdirSync(path.join(siteRoot, 'assets')).find(name => name.endsWith(extension));
  assert.ok(fileName, `dist/site/assets has no ${extension} file. Run npm run build.`);
  return fileName;
}

async function currentRevision(port: number): Promise<string> {
  return (JSON.parse((await sendRoute(port, { path: '/__blueprint/project' })).text) as { revision: string }).revision;
}

async function postCompleted(target: ServedProject, toolUseId: string): Promise<number> {
  const postedAt = Date.now();
  const accepted = await sendRoute(target.port, {
    method: 'POST',
    path: '/__blueprint/agent-activity',
    headers: { 'x-blueprint-activity-token': target.activityToken },
    body: JSON.stringify({
      version: 1,
      sessionId: 'route-session',
      toolUseId,
      toolName: 'mcp__blueprint__query',
      phase: 'completed',
      emittedAt: new Date().toISOString(),
      toolInput: {}
    })
  });
  assert.equal(accepted.status, 202);
  return postedAt;
}

async function writeUntilEvent(
  stream: Awaited<ReturnType<typeof openStream>>,
  file: string,
  content: string,
  name: string,
  condition: (event: Record<string, unknown>) => boolean
): Promise<Array<Record<string, unknown>>> {
  await writeFile(file, content);
  let answered = false;
  const events = stream.waitForEvents(name, condition).finally(() => {
    answered = true;
  });
  await rewriteUntilSeen(file, () => answered);
  return events;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 50_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('The condition did not hold in time.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function openStream(port: number): Promise<{
  response: IncomingMessage;
  text: () => string;
  waitFor: (condition: (text: string) => boolean) => Promise<void>;
  waitForEvents: (name: string, condition: (event: Record<string, unknown>) => boolean) => Promise<Array<Record<string, unknown>>>;
  events: (name: string) => Array<Record<string, unknown>>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path: '/__blueprint/events', agent: false }, response => {
      let received = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        received += chunk;
      });
      response.on('error', () => undefined);
      const waitFor = async (condition: (text: string) => boolean): Promise<void> => {
        await waitUntil(() => condition(received));
      };
      const events = (name: string, condition: (event: Record<string, unknown>) => boolean): Array<Record<string, unknown>> => received
        .split('\n\n')
        .filter(block => block.startsWith(`event: ${name}\n`))
        .map(block => JSON.parse(block.slice(block.indexOf('data: ') + 'data: '.length)) as Record<string, unknown>)
        .filter(condition);
      resolve({
        response,
        text: () => received,
        waitFor,
        waitForEvents: async (name, condition) => {
          await waitUntil(() => events(name, condition).length > 0);
          return events(name, condition);
        },
        events: name => events(name, () => true),
        close: () => outgoing.destroy()
      });
    });
    outgoing.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
    outgoing.end();
  });
}

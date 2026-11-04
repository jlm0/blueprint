import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  BLUEPRINT_ACTIVITY_POST_PATH,
  findLiveBlueprintActivityRuntime,
  registerBlueprintActivityRuntime
} from '../src/mcp/activity';

describe('Blueprint runtime liveness', () => {
  it('keeps the descriptor of a live runtime that answers slowly', async () => {
    await withProjectRoot(async projectRoot => {
      const server = await listen(1_500);
      const runtime = await registerBlueprintActivityRuntime(projectRoot, activityUrl(server));
      try {
        const found = await findLiveBlueprintActivityRuntime(projectRoot);
        assert.equal(found?.token, runtime.descriptor.token);
        assert.equal(existsSync(runtime.filePath), true);
      } finally {
        await runtime.close();
        await close(server);
      }
    });
  });

  it('keeps the descriptor of a live runtime whose project cannot load', async () => {
    await withProjectRoot(async projectRoot => {
      const server = createServer((_request, response) => response.writeHead(503).end());
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      const runtime = await registerBlueprintActivityRuntime(projectRoot, activityUrl(server));
      try {
        assert.equal((await findLiveBlueprintActivityRuntime(projectRoot))?.token, runtime.descriptor.token);
        assert.equal(existsSync(runtime.filePath), true);
      } finally {
        await runtime.close();
        await close(server);
      }
    });
  });

  it('removes the descriptor at once when nothing listens on its port', async () => {
    await withProjectRoot(async projectRoot => {
      const server = await listen(0);
      const url = activityUrl(server);
      await close(server);
      const runtime = await registerBlueprintActivityRuntime(projectRoot, url);
      try {
        const started = Date.now();
        assert.equal(await findLiveBlueprintActivityRuntime(projectRoot), undefined);
        assert.ok(Date.now() - started < 1_000);
        assert.equal(existsSync(runtime.filePath), false);
      } finally {
        await runtime.close();
      }
    });
  });
});

async function withProjectRoot(fn: (projectRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'blueprint-liveness-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function listen(delayMs: number): Promise<Server> {
  const server = createServer((_request, response) => {
    setTimeout(() => response.writeHead(200).end(), delayMs);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise(resolve => server.close(() => resolve()));
}

function activityUrl(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${BLUEPRINT_ACTIVITY_POST_PATH}`;
}

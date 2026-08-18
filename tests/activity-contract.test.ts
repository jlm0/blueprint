import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import {
  BlueprintActivityHub,
  createBlueprintAgentActivityEvent,
  parseBlueprintHookBridgeEvent,
  resolveActivityFocus,
  selectBlueprintActivityRuntimes,
  type BlueprintActivityRuntimeDescriptor
} from '../src/mcp/activity';

const projectRoot = 'fixtures/red/high-fidelity-prototype/design/blueprint';

describe('Codex activity contract', () => {
  it('resolves typed MCP boundaries and governed source paths to visible canvas focus', async () => {
    const bundle = await loadProjectFromFs(projectRoot);

    assert.deepEqual(resolveActivityFocus(bundle, {
      project: projectRoot,
      query: { type: 'show', boundary: 'section:waitlist/hero' }
    }), {
      boundaryId: 'high-fidelity-red/section/waitlist/hero',
      kind: 'section',
      localId: 'waitlist/hero',
      board: 'screens',
      screenId: 'waitlist'
    });

    const screen = bundle.screens.screens[0];
    assert.ok(screen?.prototype);
    assert.deepEqual(resolveActivityFocus(bundle, {
      command: `sed -n '1,200p' ${screen.prototype.source}`
    }), {
      boundaryId: `high-fidelity-red/screen/${screen.id}`,
      kind: 'screen',
      localId: screen.id,
      board: 'screens',
      screenId: screen.id
    });

    assert.equal(resolveActivityFocus(bundle, { command: 'apply screens.json' }).localId, 'screens');
    assert.equal(resolveActivityFocus(bundle, { command: 'npm test' }).kind, 'project');
  });

  it('creates stable started/completed events and rejects malformed bridge payloads', async () => {
    const bundle = await loadProjectFromFs(projectRoot);
    const parsed = parseBlueprintHookBridgeEvent({
      version: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'mcp__blueprint__query',
      phase: 'started',
      emittedAt: '2026-08-18T12:00:00.000Z',
      toolInput: { project: projectRoot, query: { type: 'show', boundary: 'screen:waitlist' } }
    });
    assert.ok(parsed);
    assert.deepEqual(createBlueprintAgentActivityEvent(bundle, parsed), {
      version: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'mcp__blueprint__query',
      phase: 'started',
      label: 'Codex is looking at Waitlist',
      emittedAt: '2026-08-18T12:00:00.000Z',
      focus: {
        boundaryId: 'high-fidelity-red/screen/waitlist',
        kind: 'screen',
        localId: 'waitlist',
        board: 'screens',
        screenId: 'waitlist'
      }
    });
    assert.equal(parseBlueprintHookBridgeEvent({ version: 1, sessionId: 'missing-fields' }), undefined);
  });

  it('routes an explicit project only to its matching live review runtime', () => {
    const descriptors: BlueprintActivityRuntimeDescriptor[] = [
      descriptor('/workspace/app/design/blueprint', 4100),
      descriptor('/workspace/other/design/blueprint', 4200)
    ];
    assert.deepEqual(
      selectBlueprintActivityRuntimes(descriptors, {
        cwd: '/workspace/app',
        toolInput: { project: 'design/blueprint', query: { type: 'show', boundary: 'screen:home' } }
      }).map(candidate => candidate.activityUrl),
      ['http://127.0.0.1:4100/__blueprint/agent-activity']
    );
  });

  it('collapses duplicate phases from overlapping project and global hooks', async () => {
    const bundle = await loadProjectFromFs(projectRoot);
    const hub = new BlueprintActivityHub();
    const writes: string[] = [];
    const response = {
      on: () => response,
      write: (chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      },
      end: () => undefined
    } as unknown as ServerResponse;
    hub.connect(response);

    const started = createBlueprintAgentActivityEvent(bundle, {
      version: 1,
      sessionId: 'session-duplicate',
      toolUseId: 'tool-duplicate',
      toolName: 'mcp__blueprint__query',
      phase: 'started',
      emittedAt: '2026-08-18T12:00:00.000Z',
      toolInput: { project: projectRoot, query: { type: 'show', boundary: 'screen:waitlist' } }
    });
    hub.publishActivity(started);
    hub.publishActivity({ ...started, emittedAt: '2026-08-18T12:00:00.010Z' });

    const completed = {
      ...started,
      phase: 'completed' as const,
      label: 'Codex finished Waitlist',
      emittedAt: '2026-08-18T12:00:00.020Z'
    };
    hub.publishActivity(completed);
    hub.publishActivity({ ...completed, emittedAt: '2026-08-18T12:00:00.030Z' });

    assert.equal(writes.filter(value => value.startsWith('event: agent-activity')).length, 2);
    hub.close();
  });
});

function descriptor(projectRootValue: string, port: number): BlueprintActivityRuntimeDescriptor {
  return {
    version: 1,
    projectRoot: projectRootValue,
    activityUrl: `http://127.0.0.1:${port}/__blueprint/agent-activity`,
    token: `token-${port}`,
    pid: port,
    createdAt: '2026-08-18T12:00:00.000Z'
  };
}

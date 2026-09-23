import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import { activityFocusesForChangedPaths, activityFocusesForSourceText } from '../src/core/activity';
import { loadProjectFromFs } from '../src/core/load';
import {
  BlueprintActivityHub,
  createBlueprintAgentActivityEvent,
  parseBlueprintHookBridgeEvent,
  resolveActivityFocus,
  resolveActivityFocuses,
  selectBlueprintActivityRuntimes,
  type BlueprintActivityRuntimeDescriptor
} from '../src/mcp/activity';

const projectRoot = 'fixtures/valid/mira-ai/design/blueprint';

describe('Codex activity contract', () => {
  it('resolves typed MCP boundaries and governed source paths to visible canvas focus', async () => {
    const bundle = await loadProjectFromFs(projectRoot);

    assert.deepEqual(resolveActivityFocus(bundle, {
      project: projectRoot,
      query: { type: 'show', boundary: 'section:chat/conversation' }
    }), {
      boundaryId: 'mira-ai/section/chat/conversation',
      kind: 'section',
      localId: 'chat/conversation',
      board: 'screens',
      screenId: 'chat'
    });

    const screen = bundle.screens.screens[0];
    assert.ok(screen?.prototype);
    assert.deepEqual(resolveActivityFocus(bundle, {
      command: `sed -n '1,200p' ${screen.prototype.source}`
    }), {
      boundaryId: `mira-ai/screen/${screen.id}`,
      kind: 'screen',
      localId: screen.id,
      board: 'screens',
      screenId: screen.id
    });

    assert.equal(resolveActivityFocus(bundle, { command: 'apply screens.json' }).localId, 'screens');
    assert.equal(resolveActivityFocus(bundle, { command: 'npm test' }).kind, 'project');
    assert.equal(resolveActivityFocus(bundle, {
      source: `await tools.apply_patch('*** Update File: ${screen.prototype.source}')`
    }).localId, screen.id);
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
      toolInput: { project: projectRoot, query: { type: 'show', boundary: 'screen:chat' } }
    });
    assert.ok(parsed);
    assert.deepEqual(createBlueprintAgentActivityEvent(bundle, parsed), {
      version: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'mcp__blueprint__query',
      phase: 'started',
      label: 'Codex is looking at Chat',
      emittedAt: '2026-08-18T12:00:00.000Z',
      focus: {
        boundaryId: 'mira-ai/screen/chat',
        kind: 'screen',
        localId: 'chat',
        board: 'screens',
        screenId: 'chat'
      },
      focuses: [{
        boundaryId: 'mira-ai/screen/chat',
        kind: 'screen',
        localId: 'chat',
        board: 'screens',
        screenId: 'chat'
      }]
    });
    assert.equal(parseBlueprintHookBridgeEvent({ version: 1, sessionId: 'missing-fields' }), undefined);
  });

  it('focuses every boundary a multi-file edit or shared stylesheet touches', async () => {
    const bundle = await loadProjectFromFs(projectRoot);
    const button = bundle.primitives.primitives.find(primitive => primitive.id === 'button');
    const badge = bundle.primitives.primitives.find(primitive => primitive.id === 'badge');
    assert.ok(button?.prototype && badge?.prototype);
    const buttonCss = button.prototype.styles[0];
    const badgeCss = badge.prototype.styles[0];

    const patch = `*** Update File: design/blueprint/${buttonCss}\n*** Update File: design/blueprint/${badgeCss}`;
    assert.deepEqual(
      resolveActivityFocuses(bundle, { command: patch }).map(focus => focus.boundaryId).sort(),
      ['mira-ai/primitive/badge', 'mira-ai/primitive/button']
    );

    badge.prototype.styles.push(buttonCss);
    assert.deepEqual(
      resolveActivityFocuses(bundle, { command: `apply_patch ${buttonCss}` }).map(focus => focus.boundaryId).sort(),
      ['mira-ai/primitive/badge', 'mira-ai/primitive/button']
    );

    const event = createBlueprintAgentActivityEvent(bundle, {
      version: 1,
      sessionId: 'session-1',
      toolUseId: 'tool-1',
      toolName: 'functions.exec',
      phase: 'started',
      emittedAt: '2026-08-18T12:00:00.000Z',
      toolInput: patch
    });
    assert.equal(event.focus.boundaryId, event.focuses[0]?.boundaryId);
    assert.match(event.label, /^Codex is looking at (Button and Badge|Badge and Button)$/);

    assert.deepEqual(
      activityFocusesForChangedPaths(bundle, [buttonCss, 'screens.json', 'prototype/screens/chat.html']).map(focus => focus.boundaryId),
      ['mira-ai/primitive/button', 'mira-ai/primitive/badge', 'mira-ai/screen/chat']
    );
  });

  it('credits a source path only to the longest governed reference that contains it', async () => {
    const bundle = await loadProjectFromFs(projectRoot);
    const button = bundle.primitives.primitives.find(primitive => primitive.id === 'button');
    const badge = bundle.primitives.primitives.find(primitive => primitive.id === 'badge');
    assert.ok(button?.prototype && badge?.prototype);
    badge.prototype.styles = [`${button.prototype.styles[0]}.theme.css`];
    assert.deepEqual(
      activityFocusesForSourceText(bundle, `edit ${badge.prototype.styles[0]}`).map(focus => focus.boundaryId),
      ['mira-ai/primitive/badge']
    );
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

  it('keeps Desktop wrapper activity inside the repository that owns the sidecar', () => {
    const descriptors: BlueprintActivityRuntimeDescriptor[] = [
      descriptor('/workspace/repo-a/design/blueprint', 4174),
      descriptor('/workspace/repo-b/design/blueprint', 4175)
    ];
    assert.deepEqual(
      selectBlueprintActivityRuntimes(descriptors, {
        cwd: '/workspace/repo-a',
        toolInput: 'await tools.apply_patch("*** Update File: design/blueprint/prototype/screens/home.css")'
      }).map(candidate => candidate.projectRoot),
      ['/workspace/repo-a/design/blueprint']
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
      toolInput: { project: projectRoot, query: { type: 'show', boundary: 'screen:chat' } }
    });
    hub.publishActivity(started);
    hub.publishActivity({ ...started, emittedAt: '2026-08-18T12:00:00.010Z' });

    const completed = {
      ...started,
      phase: 'completed' as const,
      label: 'Codex finished Chat',
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

#!/usr/bin/env node
import {
  BLUEPRINT_ACTIVITY_TOKEN_HEADER,
  readBlueprintActivityRuntimeDescriptors,
  selectBlueprintActivityRuntimes,
  type BlueprintHookBridgeEvent
} from '../mcp/activity';

const maxInputBytes = 512 * 1024;
const maxToolInputBytes = 128 * 1024;

interface CodexHookInput {
  session_id?: unknown;
  turn_id?: unknown;
  hook_event_name?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_use_id?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw) return;
  const input = JSON.parse(raw) as CodexHookInput;
  const event = compactHookEvent(input);
  if (!event) return;

  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const descriptors = selectBlueprintActivityRuntimes(
    await readBlueprintActivityRuntimeDescriptors(),
    { cwd, toolInput: event.toolInput }
  );
  await Promise.allSettled(descriptors.map(async descriptor => {
    await fetch(descriptor.activityUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [BLUEPRINT_ACTIVITY_TOKEN_HEADER]: descriptor.token
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(750)
    });
  }));
}

function compactHookEvent(input: CodexHookInput): BlueprintHookBridgeEvent | undefined {
  if (
    typeof input.session_id !== 'string' ||
    typeof input.tool_name !== 'string' ||
    typeof input.tool_use_id !== 'string' ||
    (input.hook_event_name !== 'PreToolUse' && input.hook_event_name !== 'PostToolUse')
  ) {
    return undefined;
  }
  const failed = input.hook_event_name === 'PostToolUse' && toolResponseFailed(input.tool_response);
  return {
    version: 1,
    sessionId: input.session_id,
    ...(typeof input.turn_id === 'string' ? { turnId: input.turn_id } : {}),
    toolUseId: input.tool_use_id,
    toolName: input.tool_name,
    phase: input.hook_event_name === 'PreToolUse' ? 'started' : failed ? 'failed' : 'completed',
    emittedAt: new Date().toISOString(),
    toolInput: truncateToolInput(input.tool_input)
  };
}

function toolResponseFailed(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (value as Record<string, unknown>).isError === true;
}

function truncateToolInput(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { truncated: true, preview: String(value).slice(0, maxToolInputBytes) };
  }
  if (Buffer.byteLength(serialized) <= maxToolInputBytes) return value;
  return { truncated: true, preview: serialized.slice(0, maxToolInputBytes) };
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value) > maxInputBytes) {
      throw new Error(`Blueprint Codex hook input exceeded ${maxInputBytes} bytes.`);
    }
  }
  return value.trim();
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

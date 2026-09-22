import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import {
  captureBlueprint,
  blueprintServeRuntimeKey,
  exploreBlueprint,
  extractBlueprint,
  indexBlueprint,
  initializeBlueprint,
  promoteBlueprint,
  queryBlueprint,
  readBlueprintSelection,
  restoreBlueprint,
  serveBlueprint,
  validateBlueprint,
  type BlueprintServeHandle
} from './operations';
import {
  captureInputSchema,
  captureOutputSchema,
  exploreInputSchema,
  exploreOutputSchema,
  extractInputSchema,
  extractOutputSchema,
  indexInputSchema,
  indexOutputSchema,
  initInputSchema,
  initOutputSchema,
  promoteInputSchema,
  promoteOutputSchema,
  queryInputSchema,
  queryOutputSchema,
  restoreInputSchema,
  restoreOutputSchema,
  selectionInputSchema,
  selectionOutputSchema,
  serveInputSchema,
  serveOutputSchema,
  validateInputSchema,
  validateOutputSchema
} from './schemas';

export const BLUEPRINT_MCP_SERVER_NAME = 'blueprint';
export const BLUEPRINT_MCP_SERVER_VERSION = '0.1.0';
export const BLUEPRINT_MCP_TOOL_NAMES = [
  'init',
  'validate',
  'index',
  'query',
  'extract',
  'capture',
  'serve',
  'selection',
  'explore',
  'promote',
  'restore'
] as const;

export function createBlueprintMcpServer(): McpServer {
  const server = new McpServer(
    { name: BLUEPRINT_MCP_SERVER_NAME, version: BLUEPRINT_MCP_SERVER_VERSION },
    {
      instructions:
        'Blueprint MCP is the agent-facing control surface for app-owned design sidecars; each repository owns an isolated Blueprint project and stable serve runtime. The Blueprint canvas is the human visual-review surface. Structured JSON and governed HTML/CSS remain source of truth. Use exactly one project path per call. Explorations and canonical history are stored as independent records. Promotion and restoration require explicit compare-and-swap digests.'
    }
  );
  const activeServeHandles = new Map<string, BlueprintServeHandle>();
  const activeServeStarts = new Map<string, Promise<BlueprintServeHandle>>();

  server.registerTool(
    'init',
    {
      title: 'Initialize Blueprint',
      description:
        'Create one app-owned Blueprint sidecar from the governed starter. Refuses a non-empty destination unless force is true; force overwrites colliding starter files but preserves unrelated files.',
      inputSchema: initInputSchema,
      outputSchema: initOutputSchema
    },
    async (input, context) => executeTool(() => initializeBlueprint(input, context.mcpReq.signal))
  );

  server.registerTool(
    'validate',
    {
      title: 'Validate Blueprint',
      description:
        'Validate one Blueprint project in baseline, readiness, or strict mode. When out is provided, also writes the returned JSON to that path. A non-passing validation returns the complete structured report with isError=true.',
      inputSchema: validateInputSchema,
      outputSchema: validateOutputSchema
    },
    async (input, context) =>
      executeTool(async () => {
        const output = await validateBlueprint(input, context.mcpReq.signal);
        return toolResult(output, !output.ok);
      })
  );

  server.registerTool(
    'index',
    {
      title: 'Index Blueprint',
      description:
        'List every stable boundary reference in one Blueprint project. When out is provided, also writes the returned JSON to that path.',
      inputSchema: indexInputSchema,
      outputSchema: indexOutputSchema
    },
    async (input, context) => executeTool(() => indexBlueprint(input, context.mcpReq.signal))
  );

  server.registerTool(
    'query',
    {
      title: 'Query Blueprint',
      description:
        'Run exactly one typed boundary, section, prototype-only, exploration, or canonical-history query against one Blueprint project. When out is provided, also writes the returned JSON to that path.',
      inputSchema: queryInputSchema,
      outputSchema: queryOutputSchema
    },
    async (input, context) => executeTool(() => queryBlueprint(input, context.mcpReq.signal))
  );

  server.registerTool(
    'extract',
    {
      title: 'Extract Blueprint Handoff',
      description:
        'Extract a focused boundary packet or deep transitive handoff packet from one Blueprint project. When out is provided, also writes the returned JSON to that path.',
      inputSchema: extractInputSchema,
      outputSchema: extractOutputSchema
    },
    async (input, context) => executeTool(() => extractBlueprint(input, context.mcpReq.signal))
  );

  server.registerTool(
    'capture',
    {
      title: 'Capture Blueprint Screen',
      description:
        'Capture one screen boundary as a deterministic PNG. Prototype-backed screens accept declared state and viewport selections; legacy screens capture the visible canvas frame.',
      inputSchema: captureInputSchema,
      outputSchema: captureOutputSchema
    },
    async (input, context) => executeTool(() => captureBlueprint(input, context.mcpReq.signal))
  );

  server.registerTool(
    'serve',
    {
      title: 'Serve Blueprint Review',
      description:
        'Start or reuse the loopback-only Blueprint review runtime for one canonical project and return its stable URL. Omitted ports allocate from 4173; separate projects receive separate listeners. Independent MCP connections share the repository runtime; its owning connection closes it.',
      inputSchema: serveInputSchema,
      outputSchema: serveOutputSchema
    },
    async (input, context) =>
      executeTool(async () => {
        const runtimeKey = await blueprintServeRuntimeKey(input.project);
        let handle: BlueprintServeHandle;
        const existing = activeServeHandles.get(runtimeKey);
        if (existing) {
          handle = await serveBlueprint(input, context.mcpReq.signal, existing);
        } else {
          const pending = activeServeStarts.get(runtimeKey);
          if (pending) {
            handle = await serveBlueprint(input, context.mcpReq.signal, await pending);
          } else {
            const start = serveBlueprint(input, context.mcpReq.signal);
            activeServeStarts.set(runtimeKey, start);
            try {
              handle = await start;
              activeServeHandles.set(runtimeKey, handle);
            } finally {
              activeServeStarts.delete(runtimeKey);
            }
          }
        }
        activeServeHandles.set(runtimeKey, handle);
        return toolResult({
          command: handle.command,
          project: handle.project,
          port: handle.port,
          url: handle.url,
          runtime: handle.runtime,
          ...(handle.selection ? { selection: handle.selection } : {})
        });
      })
  );

  server.registerTool(
    'selection',
    {
      title: 'Read Blueprint Canvas Selection',
      description:
        'Return the boundary the person last selected in the served Blueprint canvas, with its enclosing boundaries, owning source files, and a kind:id reference. Resolve "this" or "the selected" in the person\'s feedback with this tool. Returns a null selection when nothing is selected.',
      inputSchema: selectionInputSchema,
      outputSchema: selectionOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input, context) => executeTool(() => readBlueprintSelection(input, context.mcpReq.signal))
  );

  server.registerTool(
    'explore',
    {
      title: 'Manage Blueprint Exploration',
      description:
        'Create one persistent 2-5 candidate exploration from an exact canonical screen condition, or archive one without deleting its candidates or baseline.',
      inputSchema: exploreInputSchema,
      outputSchema: exploreOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input, context) => executeTool(() => exploreBlueprint(input, context.mcpReq.signal))
  );

  server.registerTool(
    'promote',
    {
      title: 'Promote Blueprint Exploration Candidate',
      description:
        'Promote one explicitly selected exploration candidate into the next canonical screen version. Requires the inspected baseline, current-screen, and candidate digests and preserves both prior canonical history and the exploration.',
      inputSchema: promoteInputSchema,
      outputSchema: promoteOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input, context) => executeTool(() => promoteBlueprint(input, context.mcpReq.signal))
  );

  server.registerTool(
    'restore',
    {
      title: 'Restore Blueprint Screen Version',
      description:
        'Restore one inspected canonical screen history version as the current screen while first preserving the outgoing current screen as the next immutable history version.',
      inputSchema: restoreInputSchema,
      outputSchema: restoreOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input, context) => executeTool(() => restoreBlueprint(input, context.mcpReq.signal))
  );

  const closeProtocolServer = server.close.bind(server);
  server.close = async (): Promise<void> => {
    const pending = await Promise.allSettled(activeServeStarts.values());
    const handles = new Set([
      ...activeServeHandles.values(),
      ...pending.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    ]);
    activeServeHandles.clear();
    activeServeStarts.clear();
    const closures = await Promise.allSettled([...handles].map(handle => handle.close()));
    await closeProtocolServer();
    const rejected = closures.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) {
      throw rejected.reason;
    }
  };

  return server;
}

async function executeTool<T extends Record<string, unknown>>(
  operation: () => Promise<T | CallToolResult>
): Promise<CallToolResult> {
  try {
    const result = await operation();
    return isCallToolResult(result) ? result : toolResult(result);
  } catch (error) {
    return toolError(error);
  }
}

function toolResult<T extends Record<string, unknown>>(value: T, isError = false): CallToolResult {
  const text = JSON.stringify(value, null, 2);
  const structuredContent = JSON.parse(text) as Record<string, unknown>;
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    ...(isError ? { isError: true } : {})
  };
}

function toolError(error: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: error instanceof Error ? error.message : String(error)
      }
    ],
    isError: true
  };
}

function isCallToolResult(value: Record<string, unknown> | CallToolResult): value is CallToolResult {
  return Array.isArray((value as CallToolResult).content);
}

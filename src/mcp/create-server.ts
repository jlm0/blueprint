import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import {
  captureBlueprint,
  exploreBlueprint,
  extractBlueprint,
  indexBlueprint,
  initializeBlueprint,
  promoteBlueprint,
  queryBlueprint,
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
  'explore',
  'promote'
] as const;

export function createBlueprintMcpServer(): McpServer {
  const server = new McpServer(
    { name: BLUEPRINT_MCP_SERVER_NAME, version: BLUEPRINT_MCP_SERVER_VERSION },
    {
      instructions:
        'Blueprint MCP is the agent-facing control surface for an app-owned design sidecar; the Blueprint canvas is the human visual-review surface. Structured JSON and governed HTML/CSS remain source of truth. Use exactly one project path per call. Explorations preserve non-canonical alternatives; promotion requires explicit compare-and-swap digests and retains canonical history.'
    }
  );
  const activeServeHandles = new Set<BlueprintServeHandle>();

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
        'Run exactly one typed boundary, section, prototype-only, exploration-list, or exploration-inspection query against one Blueprint project. When out is provided, also writes the returned JSON to that path.',
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
        'Start the existing loopback-only Blueprint review server for one project and return its URL. The listener remains alive for this MCP connection and closes when the connection closes.',
      inputSchema: serveInputSchema,
      outputSchema: serveOutputSchema
    },
    async (input, context) =>
      executeTool(async () => {
        const handle = await serveBlueprint(input, context.mcpReq.signal);
        activeServeHandles.add(handle);
        return toolResult({
          command: handle.command,
          project: handle.project,
          port: handle.port,
          url: handle.url,
          ...(handle.selection ? { selection: handle.selection } : {})
        });
      })
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

  const closeProtocolServer = server.close.bind(server);
  server.close = async (): Promise<void> => {
    const handles = [...activeServeHandles];
    activeServeHandles.clear();
    const closures = await Promise.allSettled(handles.map(handle => handle.close()));
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

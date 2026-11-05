import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import {
  captureBlueprint,
  blueprintServeRuntimeKey,
  exploreBlueprint,
  extractBlueprint,
  indexBlueprint,
  initializeBlueprint,
  inspoBlueprint,
  migrateBlueprint,
  promoteBlueprint,
  queryBlueprint,
  readBlueprintSelection,
  restoreBlueprint,
  serveBlueprint,
  validateBlueprint,
  type BlueprintServeHandle,
  artifactSummary
} from './operations';
import { withCrashFix } from './crash-text';
import {
  captureInputSchema,
  captureOutputSchema,
  exploreInputSchema,
  exploreOutputSchema,
  extractInputSchema,
  indexInputSchema,
  initInputSchema,
  initOutputSchema,
  inspoInputSchema,
  inspoOutputSchema,
  migrateInputSchema,
  promoteInputSchema,
  promoteOutputSchema,
  queryInputSchema,
  restoreInputSchema,
  restoreOutputSchema,
  selectionInputSchema,
  selectionOutputSchema,
  serveInputSchema,
  serveOutputSchema,
  validateInputSchema,
  validateToolOutputSchema,
  migrateToolOutputSchema,
  indexToolOutputSchema,
  queryToolOutputSchema,
  extractToolOutputSchema,
  withArgumentFixes,
  type ArtifactSummary
} from './schemas';

export const BLUEPRINT_MCP_SERVER_NAME = 'blueprint';
export const BLUEPRINT_MCP_SERVER_VERSION = '0.1.1';
export const BLUEPRINT_MCP_TOOL_NAMES = [
  'init',
  'inspo',
  'validate',
  'migrate',
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
        'Blueprint MCP is the agent-facing control surface for app-owned design sidecars; each repository owns an isolated Blueprint project and stable serve runtime. The Blueprint canvas is the human visual-review surface. Structured JSON and governed HTML/CSS remain source of truth. Primitives, components, screens, and tokens have fixed shapes, described in the AGENTS.md of each sidecar; contract errors end with "Fix:" and the exact change to make. A sidecar made with init start "inspo" begins with an inspo board and no brand: save the image links and words of the person with the inspo tool, propose directions, and write brand.json only after the person approves a direction. Start with validate, then index, then focused query calls. Call serve when a person needs to see the work, and call selection to resolve what they selected in the canvas. On a sidecar with a file on an older schema, validate reports each file on an older schema and serve shows a notice, and every other tool refuses it until migrate runs: run migrate, then fix what it reports. Use exactly one project path per call. Explorations and canonical history are stored as independent records. Promotion and restoration require explicit compare-and-swap digests.'
    }
  );
  const activeServeHandles = new Map<string, BlueprintServeHandle>();
  const activeServeStarts = new Map<string, Promise<BlueprintServeHandle>>();

  server.registerTool(
    'init',
    {
      title: 'Initialize Blueprint',
      description:
        'Create one app-owned Blueprint sidecar from the governed starter. Refuses a non-empty destination unless force is true; force overwrites colliding starter files but preserves unrelated files. Pass start "inspo" for a new product.',
      inputSchema: withArgumentFixes('init', initInputSchema),
      outputSchema: initOutputSchema
    },
    async (input, context) => executeTool(() => initializeBlueprint(input, context.mcpReq.signal))
  );

  server.registerTool(
    'inspo',
    {
      title: 'Edit Blueprint Inspo',
      description:
        'Edit the inspo board of one Blueprint sidecar. The board is the first step of a new product. add downloads the image link that the person pastes into inspo/, which git ignores, and saves the link with the note of the person. update changes aspects, stance, note, or reading. remove deletes an entry. sync downloads each missing image again. direction proposes or approves what the brand takes from the board for one aspect. A changed statement or entryIds returns the direction to proposed unless the call passes status, and a sidecar with brand.json needs an approved direction. Keep each note as the person wrote it. The tool refuses a sidecar that has brand.json and no inspo.json.',
      inputSchema: withArgumentFixes('inspo', inspoInputSchema),
      outputSchema: inspoOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input, context) => executeTool(() => inspoBlueprint(input, context.mcpReq.signal))
  );

  server.registerTool(
    'validate',
    {
      title: 'Validate Blueprint',
      description:
        'Validate one Blueprint project in baseline, readiness, or strict mode. When out is provided, writes the full JSON to that path and returns only a summary with counts. A non-passing validation returns isError=true. In readiness mode ok true means no blockers, so read readiness.tier: pending and unresolved are not ready.',
      inputSchema: withArgumentFixes('validate', validateInputSchema),
      outputSchema: validateToolOutputSchema
    },
    async (input, context) =>
      executeTool(async () => {
        const output = await validateBlueprint(input, context.mcpReq.signal);
        return toolResult(await summarizeWhenWritten('validate', input, output), !output.ok);
      })
  );

  server.registerTool(
    'migrate',
    {
      title: 'Migrate Blueprint',
      description:
        'Upgrade one Blueprint project to the current schema in place. Applies every mechanical change itself, writes all files in one transaction, and returns the changes plus validation of the result; each remaining validation error is a decision left to the agent, with its exact fix. dryRun reports the same without writing. A project already on the current schema is left unchanged. When out is provided, writes the full JSON to that path and returns only a summary with counts.',
      inputSchema: withArgumentFixes('migrate', migrateInputSchema),
      outputSchema: migrateToolOutputSchema
    },
    async (input, context) => executeTool(async () => summarizeWhenWritten('migrate', input, await migrateBlueprint(input, context.mcpReq.signal)))
  );

  server.registerTool(
    'index',
    {
      title: 'Index Blueprint',
      description:
        'List every stable boundary reference in one Blueprint project. When out is provided, writes the full JSON to that path and returns only a summary with counts.',
      inputSchema: withArgumentFixes('index', indexInputSchema),
      outputSchema: indexToolOutputSchema
    },
    async (input, context) => executeTool(async () => summarizeWhenWritten('index', input, await indexBlueprint(input, context.mcpReq.signal)))
  );

  server.registerTool(
    'query',
    {
      title: 'Query Blueprint',
      description:
        'Run exactly one typed boundary, section, prototype-only, exploration, or canonical-history query against one Blueprint project. When out is provided, writes the full JSON to that path and returns only a summary with counts.',
      inputSchema: withArgumentFixes('query', queryInputSchema),
      outputSchema: queryToolOutputSchema
    },
    async (input, context) => executeTool(async () => summarizeWhenWritten('query', input, await queryBlueprint(input, context.mcpReq.signal)))
  );

  server.registerTool(
    'extract',
    {
      title: 'Extract Blueprint Handoff',
      description:
        'Extract a focused boundary packet or deep transitive handoff packet from one Blueprint project. The focused packet equals query show. When out is provided, writes the full JSON to that path and returns only a summary with counts.',
      inputSchema: withArgumentFixes('extract', extractInputSchema),
      outputSchema: extractToolOutputSchema
    },
    async (input, context) => executeTool(async () => summarizeWhenWritten('extract', input, await extractBlueprint(input, context.mcpReq.signal)))
  );

  server.registerTool(
    'capture',
    {
      title: 'Capture Blueprint Boundary',
      description:
        'Capture one screen in a named state and declared viewport, or one component or primitive in a named state cropped to its own box, as a deterministic PNG.',
      inputSchema: withArgumentFixes('capture', captureInputSchema),
      outputSchema: captureOutputSchema
    },
    async (input, context) => executeTool(() => captureBlueprint(input, context.mcpReq.signal))
  );

  server.registerTool(
    'serve',
    {
      title: 'Serve Blueprint Review',
      description:
        'Start or reuse the loopback-only Blueprint review runtime for one canonical project and return its stable URL. Pass focus with a kind:id boundary to get a URL that opens that boundary\'s page, so the person lands on what changed. Omitted ports allocate from 4173; separate projects receive separate listeners. Independent MCP connections share the repository runtime; its owning connection closes it.',
      inputSchema: withArgumentFixes('serve', serveInputSchema),
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
          ...(handle.focus ? { focus: handle.focus } : {}),
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
      inputSchema: withArgumentFixes('selection', selectionInputSchema),
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
      inputSchema: withArgumentFixes('explore', exploreInputSchema),
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
      inputSchema: withArgumentFixes('promote', promoteInputSchema),
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
      inputSchema: withArgumentFixes('restore', restoreInputSchema),
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

function summarizeWhenWritten(
  command: ArtifactSummary['command'],
  input: { project: string; out?: string },
  output: Record<string, unknown>
): Promise<Record<string, unknown>> | Record<string, unknown> {
  return input.out ? artifactSummary(command, { project: input.project, out: input.out }, output) : output;
}

function toolResult<T extends Record<string, unknown>>(value: T, isError = false): CallToolResult {
  const text = JSON.stringify(value);
  const structuredContent = JSON.parse(text) as Record<string, unknown>;
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    ...(isError ? { isError: true } : {})
  };
}

const NATIVE_ERROR_FIXES: Readonly<Record<string, (file: string) => string>> = {
  EACCES: file => `grant this process access to ${file}, or pass a path that it can use`,
  EEXIST: file => `pass a path that does not use ${file} as a directory`,
  EISDIR: file => `pass the path of a file, not the directory ${file}`,
  ELOOP: file => `remove the symbolic link that loops in ${file}`,
  ENAMETOOLONG: file => `pass a path that is shorter than ${file}`,
  ENOENT: file => `create ${file}, or pass a path that exists`,
  ENOSPC: file => `free disk space on the volume that holds ${file}`,
  ENOTDIR: file => `pass a path in which each parent of ${file} is a directory`,
  EPERM: file => `grant this process access to ${file}, or pass a path that it can use`,
  EROFS: file => `pass a path on a writable volume, not ${file}`
};

/** Node writes file system errors with no repair, and these reach an agent through an `out` or `project` path. */
export function toolErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { code, path, dest } = error as NodeJS.ErrnoException & { dest?: string };
  const file = dest ?? path;
  const fix = code && file ? NATIVE_ERROR_FIXES[code] : undefined;
  return fix && file ? `${error.message}. Fix: ${fix(file)}.` : withCrashFix(error);
}

function toolError(error: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: toolErrorText(error)
      }
    ],
    isError: true
  };
}

function isCallToolResult(value: Record<string, unknown> | CallToolResult): value is CallToolResult {
  return Array.isArray((value as CallToolResult).content);
}

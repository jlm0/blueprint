import * as z from 'zod/v4';

const nonEmptyString = z.string().min(1);
const projectPathSchema = nonEmptyString.describe('Path to one app-owned design/blueprint project. Relative paths resolve from the MCP server process working directory.');
const outputPathSchema = nonEmptyString.describe('Optional file path that receives the same structured JSON returned by the tool. Existing files are overwritten.');

export const boundaryKindSchema = z.enum([
  'project',
  'board',
  'token-group',
  'primitive',
  'state-set',
  'component',
  'screen',
  'section'
]);

export const boundarySelectorSchema = z
  .string()
  .regex(/^(project|board|token-group|primitive|state-set|component|screen|section):.+$/)
  .describe('Boundary selector in kind:id form.');

export const screenBoundarySelectorSchema = z
  .string()
  .regex(/^screen:.+$/)
  .describe('Screen boundary selector in screen:id form.');

export const initInputSchema = z
  .object({
    projectId: nonEmptyString.describe('Stable project identifier written into every structured Blueprint file.'),
    name: nonEmptyString.describe('Project display name written into the Blueprint manifest.'),
    out: nonEmptyString.describe('Destination design/blueprint directory.'),
    force: z.boolean().default(false).describe('Overwrite colliding starter files in place while preserving unrelated destination files.')
  })
  .strict();

export const validateInputSchema = z
  .object({
    project: projectPathSchema,
    mode: z.enum(['baseline', 'readiness', 'strict']).default('baseline'),
    out: outputPathSchema.optional()
  })
  .strict();

export const indexInputSchema = z
  .object({
    project: projectPathSchema,
    out: outputPathSchema.optional()
  })
  .strict();

const boundaryQuerySchema = z
  .object({
    type: z.enum(['show', 'uses', 'used-by']),
    boundary: boundarySelectorSchema
  })
  .strict();

const sectionsQuerySchema = z
  .object({
    type: z.literal('sections'),
    screen: nonEmptyString.describe('Unprefixed screen ID.')
  })
  .strict();

const prototypeOnlyQuerySchema = z
  .object({
    type: z.literal('prototype-only')
  })
  .strict();

const explorationsQuerySchema = z
  .object({
    type: z.literal('explorations'),
    screenId: nonEmptyString.optional(),
    lifecycle: z.enum(['active', 'archived', 'promoted']).optional()
  })
  .strict();

const explorationQuerySchema = z
  .object({
    type: z.literal('exploration'),
    explorationId: nonEmptyString
  })
  .strict();

export const querySpecSchema = z.union([
  boundaryQuerySchema,
  sectionsQuerySchema,
  prototypeOnlyQuerySchema,
  explorationsQuerySchema,
  explorationQuerySchema
]);

export const queryInputSchema = z
  .object({
    project: projectPathSchema,
    query: querySpecSchema,
    out: outputPathSchema.optional()
  })
  .strict();

export const extractInputSchema = z
  .object({
    project: projectPathSchema,
    boundary: boundarySelectorSchema,
    mode: z.enum(['focused', 'deep']).default('focused'),
    out: outputPathSchema.optional()
  })
  .strict();

export const captureInputSchema = z
  .object({
    project: projectPathSchema,
    boundary: screenBoundarySelectorSchema,
    state: nonEmptyString.optional(),
    viewport: nonEmptyString.optional(),
    out: nonEmptyString.describe('PNG destination path. Existing files are overwritten.')
  })
  .strict();

export const serveInputSchema = z
  .object({
    project: projectPathSchema.default('design/blueprint'),
    port: z.number().int().min(0).max(65535).default(4173),
    explorationId: nonEmptyString.optional().describe('Saved exploration to open as an isolated Screens review view.')
  })
  .strict();

const createExplorationOperationSchema = z
  .object({
    type: z.literal('create'),
    id: nonEmptyString.optional(),
    screenId: nonEmptyString,
    state: nonEmptyString,
    framePresetId: nonEmptyString,
    title: nonEmptyString,
    intent: nonEmptyString,
    candidateLabels: z.array(nonEmptyString).min(2).max(5)
  })
  .strict();

const archiveExplorationOperationSchema = z
  .object({
    type: z.literal('archive'),
    explorationId: nonEmptyString
  })
  .strict();

export const exploreInputSchema = z
  .object({
    project: projectPathSchema,
    operation: z.union([createExplorationOperationSchema, archiveExplorationOperationSchema])
  })
  .strict();

const sha256DigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe('Lowercase hexadecimal SHA-256 digest returned by an exploration inspection query.');

export const promoteInputSchema = z
  .object({
    project: projectPathSchema,
    explorationId: nonEmptyString,
    candidateId: nonEmptyString,
    expectedBaseDigest: sha256DigestSchema,
    expectedCurrentDigest: sha256DigestSchema,
    expectedCandidateDigest: sha256DigestSchema
  })
  .strict();

export const validationResultSchema = z
  .object({
    ok: z.boolean(),
    errors: z.array(z.string())
  })
  .strict();

const readinessItemSchema = z
  .object({
    path: z.string(),
    severity: z.enum(['ready', 'pending', 'unresolved', 'blocker']),
    source: z.enum(['resolved', 'declared', 'declared-missing-artifact', 'synthesized-missing']),
    message: z.string(),
    artifactRef: z.string().optional(),
    artifactExists: z.boolean().optional()
  })
  .strict();

export const readinessReportSchema = z
  .object({
    projectId: z.string(),
    fidelityTier: z.enum(['baseline-compatible', 'high-fidelity']),
    prototypeSources: z.array(z.string()),
    tier: z.enum(['ready', 'pending', 'unresolved', 'blocked']),
    items: z.array(readinessItemSchema),
    blockers: z.array(readinessItemSchema)
  })
  .strict();

export const initOutputSchema = z
  .object({
    command: z.literal('init'),
    projectId: z.string(),
    name: z.string(),
    out: z.string(),
    files: z.array(z.string()),
    validation: validationResultSchema
  })
  .strict();

const validationOutputBaseSchema = z.object({
  command: z.literal('validate'),
  project: z.string(),
  projectId: z.string(),
  ok: z.boolean(),
  errors: z.array(z.string())
});

export const validateOutputSchema = z.union([
  validationOutputBaseSchema.extend({ mode: z.enum(['baseline', 'strict']) }).strict(),
  validationOutputBaseSchema.extend({ mode: z.literal('readiness'), readiness: readinessReportSchema }).strict()
]);

export const boundaryReferenceSchema = z
  .object({
    id: z.string(),
    kind: boundaryKindSchema,
    projectId: z.string(),
    localId: z.string(),
    name: z.string()
  })
  .strict();

const styleEvidenceSchema = z
  .object({
    styleRef: z.string(),
    status: z.enum(['source', 'linked-artifact-pending', 'unresolved']),
    sourceAnchor: z.string().optional(),
    artifactRef: z.string().optional(),
    renderedSnippet: z.string().optional(),
    notes: z.array(z.string()).optional()
  })
  .strict();

const renderingSchema = z.union([
  z.object({ mode: z.literal('canonical-app-owned'), source: z.string(), fallbackUsed: z.literal(false) }).strict(),
  z.object({ mode: z.literal('legacy-fallback'), fallbackUsed: z.literal(true), reason: z.literal('no-canonical-prototype-source') }).strict()
]);

export const boundaryPacketSchema = z
  .object({
    id: z.string(),
    kind: boundaryKindSchema,
    projectId: z.string(),
    sourceFiles: z.array(z.string()),
    data: z.json(),
    styleRefs: z.array(z.string()),
    styleEvidence: z.array(styleEvidenceSchema),
    dependencies: z
      .object({
        uses: z.array(boundaryReferenceSchema),
        usedBy: z.array(boundaryReferenceSchema)
      })
      .strict(),
    notes: z.array(z.string()),
    prototypeOnly: z.boolean(),
    implementationHints: z.array(z.string()),
    rendering: renderingSchema.optional()
  })
  .strict();

export const queryResultSchema = z
  .object({
    query: z.string(),
    projectId: z.string(),
    results: z.array(z.json())
  })
  .strict();

export const queryOutputSchema = z.union([boundaryPacketSchema, queryResultSchema]);

export const indexOutputSchema = z
  .object({
    command: z.literal('index'),
    project: z.string(),
    projectId: z.string(),
    results: z.array(boundaryReferenceSchema)
  })
  .strict();

const resolvedTokenSchema = z
  .object({
    id: z.string(),
    groupId: z.string(),
    tokenId: z.string(),
    name: z.string(),
    type: z.enum(['color', 'space', 'radius', 'typography', 'shadow', 'motion']),
    value: z.string(),
    description: z.string(),
    styleRef: z.string()
  })
  .strict();

const tokenUsageSchema = z
  .object({
    tokenId: z.string(),
    role: z.string(),
    boundaryId: z.string(),
    boundaryKind: boundaryKindSchema,
    styleRef: z.string()
  })
  .strict();

export const deepHandoffPacketSchema = boundaryPacketSchema.extend({
  extraction: z
    .object({
      mode: z.literal('deep'),
      selected: boundaryReferenceSchema,
      includedBoundaryIds: z.array(z.string()),
      cycles: z.array(
        z.object({ from: z.string(), to: z.string(), path: z.array(z.string()), reason: z.string() }).strict()
      ),
      unsupportedReferences: z.array(z.string())
    })
    .strict(),
  boundaries: z.array(boundaryPacketSchema),
  resolvedTokens: z.array(resolvedTokenSchema),
  tokenUsage: z.array(tokenUsageSchema)
}).strict();

export const extractOutputSchema = z.union([boundaryPacketSchema, deepHandoffPacketSchema]);

const captureOutputBaseSchema = z.object({
  command: z.literal('capture'),
  project: z.string(),
  projectId: z.string(),
  boundary: z.string(),
  out: z.string(),
  mediaType: z.literal('image/png')
});

const sourceFocusedCaptureSchema = captureOutputBaseSchema.extend({
  state: z.string(),
  viewport: z.string(),
  reviewCondition: z.string(),
  dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  source: z
    .object({
      context: z.literal('source-focused'),
      captureTarget: z.literal('compiled-prototype-document'),
      method: z.literal('browser-page-screenshot'),
      editorChrome: z.literal(false),
      readiness: z.object({ fonts: z.literal('ready'), images: z.literal('decoded'), layout: z.literal('stable') }).strict(),
      observedBoundaryIds: z.array(z.string())
    })
    .strict()
}).strict();

const canvasCaptureSchema = captureOutputBaseSchema.extend({
  source: z
    .object({
      board: z.literal('screens'),
      captureTarget: z.literal('screen-frame'),
      method: z.literal('browser-rendered-frame-save'),
      preDownloadDomAssertion: z.literal('passed'),
      visibleSectionBoundaries: z.array(z.string())
    })
    .strict()
}).strict();

export const captureOutputSchema = z.union([sourceFocusedCaptureSchema, canvasCaptureSchema]);

export const serveOutputSchema = z
  .object({
    command: z.literal('serve'),
    project: z.string(),
    port: z.number().int().min(0).max(65535),
    url: z.string().url(),
    selection: z
      .object({
        kind: z.literal('exploration'),
        explorationId: z.string(),
        screenId: z.string()
      })
      .strict()
      .optional()
  })
  .strict();

const explorationPrototypeOutputSchema = z
  .object({
    source: z.string(),
    styles: z.array(z.string()),
    assetRefs: z.array(z.string())
  })
  .strict();

const explorationOutputSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    intent: z.string(),
    lifecycle: z.enum(['active', 'archived', 'promoted']),
    target: z
      .object({
        screenId: z.string(),
        state: z.string(),
        framePresetId: z.string(),
        baseDigest: sha256DigestSchema,
        baseline: z
          .object({
            screen: z.json(),
            prototype: explorationPrototypeOutputSchema
          })
          .strict()
      })
      .strict(),
    candidates: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          prototype: explorationPrototypeOutputSchema
        })
        .strict()
    ),
    selectedCandidateId: z.string().optional(),
    promotedScreenId: z.string().optional()
  })
  .strict();

export const exploreOutputSchema = z
  .object({
    command: z.literal('explore'),
    operation: z.enum(['create', 'archive']),
    project: z.string(),
    projectId: z.string(),
    exploration: explorationOutputSchema
  })
  .strict();

const promotedScreenOutputSchema = z
  .object({
    id: z.string(),
    boundaryId: z.string(),
    version: z.number().int().positive()
  })
  .strict();

export const promoteOutputSchema = z
  .object({
    command: z.literal('promote'),
    project: z.string(),
    projectId: z.string(),
    explorationId: z.string(),
    candidateId: z.string(),
    promotedScreen: promotedScreenOutputSchema,
    historicalScreen: promotedScreenOutputSchema,
    exploration: explorationOutputSchema
  })
  .strict();

export type InitInput = z.infer<typeof initInputSchema>;
export type ValidateInput = z.infer<typeof validateInputSchema>;
export type IndexInput = z.infer<typeof indexInputSchema>;
export type QueryInput = z.infer<typeof queryInputSchema>;
export type ExtractInput = z.infer<typeof extractInputSchema>;
export type CaptureInput = z.infer<typeof captureInputSchema>;
export type ServeInput = z.infer<typeof serveInputSchema>;
export type ExploreInput = z.infer<typeof exploreInputSchema>;
export type PromoteInput = z.infer<typeof promoteInputSchema>;

export type InitOutput = z.infer<typeof initOutputSchema>;
export type ValidateOutput = z.infer<typeof validateOutputSchema>;
export type IndexOutput = z.infer<typeof indexOutputSchema>;
export type QueryOutput = z.infer<typeof queryOutputSchema>;
export type ExtractOutput = z.infer<typeof extractOutputSchema>;
export type CaptureOutput = z.infer<typeof captureOutputSchema>;
export type ServeOutput = z.infer<typeof serveOutputSchema>;
export type ExploreOutput = z.infer<typeof exploreOutputSchema>;
export type PromoteOutput = z.infer<typeof promoteOutputSchema>;

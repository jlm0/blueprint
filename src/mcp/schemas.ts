import * as z from 'zod/v4';

const nonEmptyString = z.string().min(1);
const projectPathSchema = nonEmptyString.describe('Path to one app-owned design/blueprint project. Relative paths resolve from the MCP server process working directory.');
const outputPathSchema = nonEmptyString.describe('Optional file path that receives the same structured JSON returned by the tool. Existing files are overwritten.');

export const boundaryKindSchema = z.enum([
  'project',
  'board',
  'token-group',
  'primitive',
  'component',
  'screen',
  'section'
]);

export const boundarySelectorSchema = z
  .string()
  .regex(/^(project|board|token-group|primitive|component|screen|section):.+$/)
  .describe('Boundary selector in kind:id form.');

export const capturableBoundarySelectorSchema = z
  .string()
  .regex(/^(screen|component|primitive):.+$/)
  .describe('Screen, component, or primitive boundary selector in kind:id form.');

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

export const migrateInputSchema = z
  .object({
    project: projectPathSchema,
    dryRun: z.boolean().default(false).describe('Report every change and what validate would then report, without writing anything.'),
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

const historyQuerySchema = z
  .object({
    type: z.literal('history'),
    screenId: nonEmptyString.optional()
  })
  .strict();

const historyVersionQuerySchema = z
  .object({
    type: z.literal('history-version'),
    screenId: nonEmptyString,
    version: z.number().int().positive()
  })
  .strict();

export const querySpecSchema = z.union([
  boundaryQuerySchema,
  sectionsQuerySchema,
  prototypeOnlyQuerySchema,
  explorationsQuerySchema,
  explorationQuerySchema,
  historyQuerySchema,
  historyVersionQuerySchema
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
    boundary: capturableBoundarySelectorSchema,
    state: nonEmptyString.optional().describe('Declared state to render. Defaults to the first declared state.'),
    viewport: nonEmptyString.optional().describe(
      'Declared frame preset. Screens render in its review condition; components and primitives take its width instead of the 1280 px default.'
    ),
    variant: nonEmptyString.optional().describe('Declared primitive or component variant. Defaults to its default variant.'),
    size: nonEmptyString.optional().describe('Declared primitive or component size. Defaults to its default size.'),
    out: nonEmptyString.describe('PNG destination path. Existing files are overwritten.')
  })
  .strict();

export const serveInputSchema = z
  .object({
    project: projectPathSchema.default('design/blueprint'),
    port: z.number().int().min(0).max(65535).optional().describe(
      'Stable port for this project runtime. When omitted, Blueprint starts at 4173 and selects the next available port.'
    ),
    explorationId: nonEmptyString.optional().describe('Saved exploration to open as an isolated Screens review view.'),
    focus: boundarySelectorSchema.optional().describe(
      'Boundary the returned URL opens, such as component:web-header, screen:home, token-group:color, or project:root for the brand. Cannot be combined with explorationId.'
    )
  })
  .strict()
  .refine(input => !(input.explorationId && input.focus), { message: 'Pass either explorationId or focus, not both.' });

export const selectionInputSchema = z
  .object({
    project: projectPathSchema.default('design/blueprint')
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

export const restoreInputSchema = z
  .object({
    project: projectPathSchema,
    screenId: nonEmptyString,
    version: z.number().int().positive(),
    expectedCurrentDigest: sha256DigestSchema,
    expectedVersionDigest: sha256DigestSchema
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

const designFindingSchema = z
  .object({
    boundaryId: z.string(),
    kind: boundaryKindSchema,
    localId: z.string(),
    rule: z.enum(['local-value', 'native-control', 'section-marker', 'contrast', 'primitive-set']),
    location: z.string(),
    message: z.string()
  })
  .strict();

const proseAdvisorySchema = z
  .object({
    boundaryId: z.string(),
    kind: z.enum(['primitive', 'component', 'token-group', 'page', 'screen', 'section']),
    localId: z.string(),
    field: z.string().describe('Path below the boundary, such as "description", "states.loading.description", or "uses[0].reason". A page reports against the screens board.'),
    rule: z.enum(['passive-voice', 'present-perfect', 'synonym-rotation']),
    match: z.string(),
    message: z.string()
  })
  .strict();

const validationOutputBaseSchema = z.object({
  command: z.literal('validate'),
  project: z.string(),
  projectId: z.string(),
  ok: z.boolean(),
  errors: z.array(z.string()),
  findings: z.array(designFindingSchema).describe(
    'Design findings the canvas marks on boundaries, each fixable in the source named by location. Strict validation rejects them.'
  ),
  prose: z.array(proseAdvisorySchema).describe(
    'Wording advisories on the prose an app writes for its primitives, components, token groups, pages, screens, and sections. They never fail validation. Rewrite each one, unless the wording is deliberate, such as "selected" used as an adjective.'
  )
});

export const validateOutputSchema = z.union([
  validationOutputBaseSchema.extend({ mode: z.enum(['baseline', 'strict']) }).strict(),
  validationOutputBaseSchema.extend({ mode: z.literal('readiness'), readiness: readinessReportSchema }).strict()
]);

export const migrateOutputSchema = z
  .object({
    command: z.literal('migrate'),
    project: z.string(),
    projectId: z.string(),
    dryRun: z.boolean(),
    fromVersion: z.string(),
    toVersion: z.string(),
    upToDate: z.boolean().describe('True when the project already reads the current schema and nothing changed.'),
    changes: z.array(z.string()).describe('Every mechanical change, one per line.'),
    files: z.array(z.string()).describe('Project files written, or that a real run would write.'),
    validation: validationResultSchema.describe(
      'Validation of the migrated project. Each error is a decision left to the agent and ends with "Fix:" and the exact change to make.'
    )
  })
  .strict();

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

const renderingSchema = z.object({ mode: z.literal('canonical-app-owned'), source: z.string() }).strict();

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

const declaredGroupFields = {
  id: z.string(),
  name: z.string(),
  description: z.string().optional()
};

export const indexOutputSchema = z
  .object({
    command: z.literal('index'),
    project: z.string(),
    projectId: z.string(),
    results: z.array(boundaryReferenceSchema),
    pages: z.array(z.object({ ...declaredGroupFields, screens: z.array(z.string()) }).strict())
      .describe('Declared screen pages with their screens. Declare a new page in screens.json before placing a screen on it.'),
    componentGroups: z.array(z.object({ ...declaredGroupFields, components: z.array(z.string()) }).strict())
      .describe('Declared component groups with their components. Declare a new group in components.json before using it.')
  })
  .strict();

const resolvedTokenSchema = z
  .object({
    id: z.string(),
    groupId: z.string(),
    tokenId: z.string(),
    name: z.string(),
    type: z.enum(['color', 'space', 'size', 'radius', 'typography', 'shadow', 'motion']),
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
  tokenUsage: z.array(tokenUsageSchema),
  brand: z.json().optional()
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

const reusableCaptureSchema = captureOutputBaseSchema.extend({
  state: z.string(),
  variant: z.string().optional(),
  size: z.string().optional(),
  viewport: z.string().optional(),
  dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  source: sourceFocusedCaptureSchema.shape.source
}).strict();

export const captureOutputSchema = z.union([sourceFocusedCaptureSchema, reusableCaptureSchema]);

export const serveOutputSchema = z
  .object({
    command: z.literal('serve'),
    project: z.string(),
    port: z.number().int().min(0).max(65535),
    url: z.string().url(),
    runtime: z.enum(['started', 'reused']),
    focus: z.string().optional(),
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

const selectedBoundarySchema = z
  .object({
    boundaryId: z.string(),
    kind: boundaryKindSchema,
    localId: z.string(),
    label: z.string()
  })
  .strict();

export const selectionOutputSchema = z
  .object({
    command: z.literal('selection'),
    project: z.string(),
    selection: selectedBoundarySchema
      .extend({
        context: z.array(selectedBoundarySchema).describe('Enclosing boundaries, innermost first.'),
        screenId: z.string().optional(),
        state: z.string().optional(),
        framePresetId: z.string().optional(),
        explorationId: z.string().optional(),
        explorationRole: z.enum(['current', 'version', 'baseline', 'candidate']).optional(),
        candidateId: z.string().optional().describe('Exploration candidate the selection was made in; pass it to promote when the person chooses it.'),
        historyVersion: z.number().int().positive().optional(),
        reference: z.string().describe('The boundary and its enclosing boundaries in kind:id form, as copied by the canvas.'),
        files: z.array(z.string()).describe('Sidecar-relative prototype source and style files that own the selected boundary.'),
        selectedAt: z.string(),
        revision: z.string()
      })
      .strict()
      .nullable()
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

const canonicalScreenMutationOutputSchema = z
  .object({
    id: z.string(),
    boundaryId: z.string()
  })
  .strict();

const historicalVersionOutputSchema = z
  .object({
    screenId: z.string(),
    version: z.number().int().positive(),
    state: z.string(),
    framePresetId: z.string()
  })
  .strict();

export const promoteOutputSchema = z
  .object({
    command: z.literal('promote'),
    project: z.string(),
    projectId: z.string(),
    explorationId: z.string(),
    candidateId: z.string(),
    promotedScreen: canonicalScreenMutationOutputSchema,
    historicalVersion: historicalVersionOutputSchema,
    exploration: explorationOutputSchema
  })
  .strict();

export const restoreOutputSchema = z
  .object({
    command: z.literal('restore'),
    project: z.string(),
    projectId: z.string(),
    restoredFromVersion: z.number().int().positive(),
    restoredScreen: canonicalScreenMutationOutputSchema,
    historicalVersion: historicalVersionOutputSchema
  })
  .strict();

export type InitInput = z.infer<typeof initInputSchema>;
export type ValidateInput = z.infer<typeof validateInputSchema>;
export type MigrateInput = z.infer<typeof migrateInputSchema>;
export type IndexInput = z.infer<typeof indexInputSchema>;
export type QueryInput = z.infer<typeof queryInputSchema>;
export type ExtractInput = z.infer<typeof extractInputSchema>;
export type CaptureInput = z.infer<typeof captureInputSchema>;
export type ServeInput = z.infer<typeof serveInputSchema>;
export type SelectionInput = z.infer<typeof selectionInputSchema>;
export type ExploreInput = z.infer<typeof exploreInputSchema>;
export type PromoteInput = z.infer<typeof promoteInputSchema>;
export type RestoreInput = z.infer<typeof restoreInputSchema>;

export type InitOutput = z.infer<typeof initOutputSchema>;
export type ValidateOutput = z.infer<typeof validateOutputSchema>;
export type MigrateOutput = z.infer<typeof migrateOutputSchema>;
export type IndexOutput = z.infer<typeof indexOutputSchema>;
export type QueryOutput = z.infer<typeof queryOutputSchema>;
export type ExtractOutput = z.infer<typeof extractOutputSchema>;
export type CaptureOutput = z.infer<typeof captureOutputSchema>;
export type ServeOutput = z.infer<typeof serveOutputSchema>;
export type SelectionOutput = z.infer<typeof selectionOutputSchema>;
export type ExploreOutput = z.infer<typeof exploreOutputSchema>;
export type PromoteOutput = z.infer<typeof promoteOutputSchema>;
export type RestoreOutput = z.infer<typeof restoreOutputSchema>;

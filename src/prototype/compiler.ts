import type {
  BlueprintProjectBundle,
  CanvasProjectBundle,
  FramePreset,
  PrototypeAsset,
  PrototypeSourceGraphIssue,
  PrototypeUseDeclaration,
  ReusableDefinition,
  ReusableKind,
  ReviewCondition,
  ScreenDefinition
} from '../core/types';
import { brandMarkSourceIssues } from '../core/brand-lint';
import { cssHasImport, rewriteCssUrls } from '../core/css';
import { axisIds } from '../core/reusable-contract';
import {
  applyMarkupEdits,
  collectInvocationSlots,
  elementCloseIndex,
  firstOpenTag,
  isDefaultSlot,
  iterateUseElements,
  listMarkupTokens,
  listOpenTags,
  listPossibleOpenTags,
  listSectionTags,
  outerSvgMarkup,
  parseUseAttributes,
  quotedAttribute,
  setTagAttribute,
  slotContentAccepts,
  useTagAttributes,
  type MarkupAttribute,
  type MarkupEdit,
  type OpenTag,
  type SectionTag,
  type UseElement
} from '../core/markup';
import { PROTOTYPE_ASSET_PATH_PREFIX } from './host-policy';

/**
 * Identifies the canonical source boundary to compile.
 * @see {@linkcode compilePrototypeDocument}
 */
export type PrototypeCompileTarget =
  | { kind: 'primitive'; id: string }
  | { kind: 'component'; id: string }
  | { kind: 'screen'; id: string };

/**
 * Inputs for one deterministic, browser-native prototype document.
 * @see {@linkcode compilePrototypeDocument}
 */
export interface CompilePrototypeDocumentOptions {
  /** Fully loaded sidecar contract and governed source contents. */
  bundle: BlueprintProjectBundle;
  /** Canonical primitive, component, or screen to render. */
  target: PrototypeCompileTarget;
  /** Declared target state. The first declared state is used when omitted. */
  state?: string;
  /** Declared reusable variant (primitive and component targets only); the variant default when omitted. */
  variant?: string;
  /** Declared reusable size (primitive and component targets only); the size default when omitted. */
  size?: string;
  /** Frame preset the screen renders in; exposes its safe-area insets as `--blueprint-safe-area-*`. */
  framePreset?: FramePreset;
}

/** Only the live canvas links assets, because capture, handoff, and MCP documents must stay self-contained. */
export interface CompileLinkedPrototypeDocumentOptions extends Omit<CompilePrototypeDocumentOptions, 'bundle'> {
  bundle: CanvasProjectBundle;
  assetOrigin: string;
}

/**
 * One mechanically observed reusable-boundary instantiation.
 * @see {@linkcode CompiledPrototypeDocument.observedUses}
 */
export interface ObservedPrototypeUse {
  /** Boundary containing the `<blueprint-use>` declaration. */
  sourceBoundaryId: string;
  /** Instantiated canonical boundary ID. */
  targetBoundaryId: string;
  /** Reusable boundary category. */
  kind: 'primitive' | 'component';
  /** App-owned local reusable-boundary ID. */
  id: string;
  /** Variant selected for this instance, the reusable's default when the placement names none. */
  variant: string;
  /** Size selected for this instance, the reusable's default when the placement names none. */
  size: string;
  /** Deterministic state selected for this instance. */
  state: string;
}

/**
 * One brand mark placed with `<blueprint-use kind="brand-mark">`.
 * @see {@linkcode CompiledPrototypeDocument.brandMarks}
 */
export interface PlacedBrandMark {
  /** Boundary whose source placed the mark. */
  sourceBoundaryId: string;
  /** Mark ID declared in brand.json. */
  id: string;
  /** Declared variant, when the placement picks one. */
  variant?: string;
}

/** Complete isolated document and evidence produced by {@linkcode compilePrototypeDocument}. */
export interface CompiledPrototypeDocument {
  /** Complete HTML document suitable for a sandboxed iframe `srcdoc`. */
  html: string;
  /** Canonical boundary ID rendered at the document root. */
  targetBoundaryId: string;
  /** Resolved target state. */
  state: string;
  /** Reusable boundaries encountered in deterministic document order. */
  observedUses: ObservedPrototypeUse[];
  /** Brand marks placed in deterministic document order. */
  brandMarks: PlacedBrandMark[];
}

/**
 * Optional URL-level selectors used to choose one declared screen review condition.
 * @see {@linkcode selectPrototypeReviewCondition}
 */
export interface PrototypeReviewSelectionRequest {
  /** Declared screen state to render. */
  state?: string;
  /** Declared frame preset ID or review-condition ID to render. */
  viewport?: string;
}

/**
 * Deterministic screen state and frame selected from the sidecar contract.
 * @see {@linkcode selectPrototypeReviewCondition}
 */
export interface SelectedPrototypeReviewCondition {
  /** Stable review-condition ID. */
  conditionId: string;
  /** Declared frame preset ID. */
  framePresetId: string;
  /** Declared screen state. */
  state: string;
}

interface SourceBoundary {
  kind: PrototypeCompileTarget['kind'];
  id: string;
  name: string;
  prototype: { source: string; styles: string[]; assetRefs?: string[] };
  /** Reusables the source renders, checked against what it actually renders. */
  renderedUses: PrototypeUseDeclaration[];
  states: string[];
  defaultState: string;
  /** The full definition, for primitive and component boundaries. */
  reusable?: ReusableDefinition;
}

interface CompilerContext {
  bundle: CanvasProjectBundle;
  session: CompileSession;
  allowedAssetRefs: Set<string>;
  recorders: FragmentRecord[];
  observedUses: ObservedPrototypeUse[];
  observedUseKeysBySource: Map<string, Set<string>>;
  brandMarks: PlacedBrandMark[];
  styleRefs: string[];
  styleRefSet: Set<string>;
}

/** State shared by the documents compiled in one call, such as one validation pass. */
interface CompileSession {
  fragments: Map<string, CompiledFragment>;
  preparedSources: Map<string, PreparedSource>;
}

/** Each document must check the asset values again, because documents declare different assets. */
interface PreparedSource {
  source: string;
  markup: string;
  assetValues: string[];
}

/**
 * An asset token stands in for each asset data URL until the document is complete, so the
 * expansion passes never scan or copy base64 text. The token holds the asset ref, so it does
 * not depend on compile order. U+FDD0 and U+FDD1 are noncharacters that sources must not hold.
 */
const ASSET_TOKEN_START = '\uFDD0';
const ASSET_TOKEN_END = '\uFDD1';
const ASSET_TOKEN_PATTERN = /\uFDD0([0-9a-f]+)\uFDD1/g;

/** Everything a nested compile did to its document, so a later identical compile can replay it. */
interface FragmentRecord {
  events: CompileEvent[];
  boundaryIds: Set<string>;
  assetRefs: Set<string>;
}

/** A fragment keeps its section tags, so a screen need not read its whole document again to find them. */
interface RenderedFragment {
  fragment: string;
  sections: SectionTag[];
}

interface CompiledFragment extends FragmentRecord, RenderedFragment {}

type CompileEvent =
  | { kind: 'styles'; styleRefs: string[] }
  | { kind: 'use'; use: ObservedPrototypeUse }
  | { kind: 'brand-mark'; mark: PlacedBrandMark }
  | { kind: 'rendered-uses'; boundary: SourceBoundary; boundaryId: string };

interface ForwardedInvocationAttributes {
  className?: string;
  variant?: string;
  size?: string;
  href?: string;
  section?: string;
}

const SLOT_AUTHOR_ATTRIBUTE = 'data-blueprint-slot-author';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type CompileInput = Omit<CompilePrototypeDocumentOptions, 'bundle'> & { bundle: CanvasProjectBundle };

type AssetOutput =
  | { kind: 'tokens' }
  | { kind: 'inline' }
  | { kind: 'linked'; assetSource: string };

function prototypeContentSecurityPolicy(assetSource?: string): string {
  const assets = assetSource ? `data: ${assetSource}` : 'data:';
  return [
    "default-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    `img-src ${assets}`,
    `font-src ${assets}`,
    "style-src 'unsafe-inline'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'"
  ].join('; ');
}

export const PROTOTYPE_CONTENT_SECURITY_POLICY = prototypeContentSecurityPolicy();

/**
 * Compiles a governed app-owned source graph into a complete no-script document.
 * With `assetOrigin`, each linked asset resolves to its review server URL and the
 * document policy admits that asset route; without it, every asset is a data URL.
 *
 * @throws {Error} When a source, state, reusable use, slot, asset, asset origin, or host policy is invalid.
 */
export function compilePrototypeDocument(
  options: CompilePrototypeDocumentOptions | CompileLinkedPrototypeDocumentOptions
): CompiledPrototypeDocument {
  const output: AssetOutput = 'assetOrigin' in options
    ? { kind: 'linked', assetSource: reviewServerAssetSource(options.assetOrigin) }
    : { kind: 'inline' };
  return compileDocument(options, createCompileSession(), output);
}

export function prototypeAssetUrl(asset: PrototypeAsset, assetOrigin: string): string {
  return 'sha256' in asset ? linkedAssetUrl(reviewServerAssetSource(assetOrigin), asset.sha256) : assetDataUrl(asset);
}

function reviewServerAssetSource(origin: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== origin) {
    throw new Error(`Prototype asset origin "${origin}" must be an exact http or https origin, such as http://127.0.0.1:4173. Fix: pass an origin with no path, such as http://127.0.0.1:4173.`);
  }
  return `${origin}${PROTOTYPE_ASSET_PATH_PREFIX}`;
}

function linkedAssetUrl(assetSource: string, sha256: string): string {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`Prototype asset hash "${sha256}" must be 64 lowercase hex characters. Fix: call the tool again, so that Blueprint reads the asset file and computes its hash.`);
  }
  return `${assetSource}${sha256}`;
}

function assetDataUrl(asset: { mediaType: string; base64: string }): string {
  return `data:${asset.mediaType};base64,${asset.base64}`;
}

function createCompileSession(): CompileSession {
  return { fragments: new Map(), preparedSources: new Map() };
}

function compileDocument(options: CompileInput, session: CompileSession, output: AssetOutput): CompiledPrototypeDocument {
  return compileDocumentOutput(options, session, output).compiled;
}

function compileDocumentOutput(options: CompileInput, session: CompileSession, output: AssetOutput): { compiled: CompiledPrototypeDocument; sheets: string[]; body: string } {
  assertIsolatedHostPolicy(options.bundle);
  const boundary = resolveBoundary(options.bundle, options.target);
  const state = resolveState(boundary, options.state);
  const allowedAssetRefs = new Set(
    boundary.kind === 'screen'
      ? boundary.prototype.assetRefs ?? []
      : options.bundle.screens.screens.flatMap(screen => screen.prototype?.assetRefs ?? [])
  );
  const context: CompilerContext = {
    bundle: options.bundle,
    session,
    allowedAssetRefs,
    recorders: [],
    observedUses: [],
    observedUseKeysBySource: new Map(),
    brandMarks: [],
    styleRefs: [],
    styleRefSet: new Set()
  };
  const { fragment } = compileBoundaryFragment(context, boundary, state, '', [], resolveTopLevelAxes(boundary, options.variant, options.size));
  const sheets = context.styleRefs.map(styleRef => loadAndRewriteStyle(context, styleRef));
  const appCss = sheets.join('\n\n');
  const tokenCss = createTokenCss(options.bundle);
  const targetBoundaryId = boundaryId(options.bundle, boundary);
  const title = `${options.bundle.manifest.project.name} · ${boundary.name}`;
  const html = [
    '<!doctype html>',
    `<html lang="en" data-blueprint-state="${escapeAttribute(state)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(output.kind === 'linked' ? prototypeContentSecurityPolicy(output.assetSource) : PROTOTYPE_CONTENT_SECURITY_POLICY)}">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style data-blueprint-app-styles>${safeStyleText(baseDocumentCss())}\n${safeStyleText(safeAreaCss(options.framePreset))}\n${safeStyleText(specimenCanvasCss(options.bundle, boundary))}\n${safeStyleText(appCss)}</style>`,
    `<style data-blueprint-token-overrides>${safeStyleText(tokenCss)}</style>`,
    '</head>',
    `<body>${fragment}</body>`,
    '</html>'
  ].join('');

  return {
    compiled: {
      html: resolveAssetTokens(context, html, output),
      targetBoundaryId,
      state,
      observedUses: context.observedUses,
      brandMarks: context.brandMarks
    },
    sheets,
    body: fragment
  };
}

/**
 * Compiles every declared canonical boundary/state without a browser so validation,
 * readiness, the canvas, and MCP share one governed-source contract.
 */
export function inspectPrototypeSourceGraph(bundle: CanvasProjectBundle): PrototypeSourceGraphIssue[] {
  const targets = listPrototypeCompileTargets(bundle);
  const issues: PrototypeSourceGraphIssue[] = [];
  const session = createCompileSession();
  for (const candidate of targets) {
    try {
      compileDocument({ bundle, target: candidate.target, state: candidate.state }, session, { kind: 'tokens' });
    } catch (error) {
      const localBoundaryId = `${bundle.manifest.project.id}/${candidate.target.kind}/${candidate.target.id}`;
      const message = error instanceof Error ? error.message : String(error);
      issues.push({
        boundaryId: localBoundaryId,
        state: candidate.state,
        message: message.includes('Fix:') ? message : `${message}. Fix: correct each shape error that validate reports, then validate again.`
      });
    }
  }
  return issues;
}

/**
 * Compiles documents that share fragment work and keep their asset tokens. The output of a
 * target does not depend on compile order, so equal output means equal rendered source.
 */
export function createPrototypeOutputCompiler(bundle: CanvasProjectBundle): (target: PrototypeCompileTarget, state?: string) => string {
  const compile = createPrototypeDocumentCompiler(bundle);
  return (target, state) => compile({ target, state }).html;
}

/** A caller can compare the parts that can paint, because the whole document also holds what cannot. */
export interface PrototypeDocumentOutput {
  html: string;
  state: string;
  sheets: string[];
  body: string;
  /** A token holds the asset ref and not the bytes, so a caller must compare the bytes of each asset in this list. */
  assetRefs: string[];
}

/** Each snapshot needs its own compiler, because the fragment cache does not check the snapshot. */
export function createPrototypeDocumentCompiler(bundle: CanvasProjectBundle): (options: Omit<CompilePrototypeDocumentOptions, 'bundle'>) => PrototypeDocumentOutput {
  const session = createCompileSession();
  return options => {
    const { compiled, sheets, body } = compileDocumentOutput({ ...options, bundle }, session, { kind: 'tokens' });
    const assetRefs = new Set(Array.from(compiled.html.matchAll(ASSET_TOKEN_PATTERN), match => textFromHex(match[1])));
    return { html: compiled.html, state: compiled.state, sheets, body, assetRefs: [...assetRefs] };
  };
}

/** Every declared canonical boundary and state that a sidecar can compile. */
export function listPrototypeCompileTargets(bundle: CanvasProjectBundle): Array<{ target: PrototypeCompileTarget; state: string }> {
  const targets: Array<{ target: PrototypeCompileTarget; state: string }> = [];
  for (const primitive of bundle.primitives.primitives) {
    if (primitive.prototype) {
      for (const state of axisIds(primitive.states)) {
        targets.push({ target: { kind: 'primitive', id: primitive.id }, state });
      }
    }
  }
  for (const component of bundle.components.components) {
    for (const state of axisIds(component.states)) {
      targets.push({ target: { kind: 'component', id: component.id }, state });
    }
  }
  for (const screen of bundle.screens.screens) {
    if (screen.prototype) {
      const reviewStates = new Set(screen.prototype.reviewConditions.map(condition => condition.state));
      for (const state of new Set([...screen.prototype.states, ...reviewStates])) {
        targets.push({ target: { kind: 'screen', id: screen.id }, state });
      }
    }
  }
  return targets;
}

/**
 * Resolves URL-level state and viewport intent to one declared screen condition.
 *
 * @throws {Error} When the requested combination is not declared by the screen.
 */
export function selectPrototypeReviewCondition(
  screen: ScreenDefinition,
  request: PrototypeReviewSelectionRequest = {}
): SelectedPrototypeReviewCondition {
  if (!screen.prototype) {
    throw new Error(`Screen "${screen.id}" has no browser-native prototype review conditions. Fix: add prototype.reviewConditions to screen "${screen.id}" in screens.json.`);
  }
  const conditions = screen.prototype.reviewConditions;
  const requestedById = request.viewport
    ? conditions.find(condition => condition.id === request.viewport)
    : undefined;
  let selected: ReviewCondition | undefined;

  if (requestedById) {
    if (request.state && requestedById.state !== request.state) {
      throw new Error(
        `Screen "${screen.id}" review condition "${requestedById.id}" uses state "${requestedById.state}", not "${request.state}". Fix: pass state "${requestedById.state}" with this viewport, or pass another viewport.`
      );
    }
    selected = requestedById;
  } else if (request.state || request.viewport) {
    selected = conditions.find(condition =>
      (!request.state || condition.state === request.state) &&
      (!request.viewport || condition.framePresetId === request.viewport)
    );
  } else {
    const defaultState = screen.prototype.states[0];
    selected = conditions.find(condition => condition.framePresetId === screen.framePresetId && condition.state === defaultState)
      ?? conditions.find(condition => condition.framePresetId === screen.framePresetId)
      ?? conditions[0];
  }

  if (!selected) {
    const selection = [request.state ? `state="${request.state}"` : '', request.viewport ? `viewport="${request.viewport}"` : '']
      .filter(Boolean)
      .join(', ');
    throw new Error(`Screen "${screen.id}" does not declare a review condition for ${selection || 'its default frame'}. Fix: ${conditions.length > 0 ? `pass a state and viewport from this list: ${conditions.map(condition => `${condition.state} at ${condition.framePresetId}`).join(', ')}. Or add` : 'add'} the pair to prototype.reviewConditions of this screen.`);
  }
  return {
    conditionId: selected.id,
    framePresetId: selected.framePresetId,
    state: selected.state
  };
}

function resolveTopLevelAxes(boundary: SourceBoundary, variant: string | undefined, size: string | undefined): ForwardedInvocationAttributes {
  if (!boundary.reusable) {
    if (variant || size) {
      throw new Error(`${boundary.kind} "${boundary.id}" cannot receive a ${variant ? 'variant' : 'size'}; only primitives and components have them. Fix: remove variant and size from this call.`);
    }
    return {};
  }
  const declaredVariant = declaredAxisValue(boundary, 'variant', variant);
  const declaredSize = declaredAxisValue(boundary, 'size', size);
  return { ...(declaredVariant ? { variant: declaredVariant } : {}), ...(declaredSize ? { size: declaredSize } : {}) };
}

function declaredAxisValue(boundary: SourceBoundary, axis: 'variant' | 'size', value: string | undefined): string | undefined {
  if (value === undefined || !boundary.reusable) return value;
  const declared = axisIds(axis === 'variant' ? boundary.reusable.variants : boundary.reusable.sizes);
  const match = declaredCopy(declared, value);
  if (match === undefined) {
    throw new Error(`${boundary.kind} "${boundary.id}" does not declare ${axis} "${value}"; ${declared.length > 0 ? `it declares ${declared.map(id => `"${id}"`).join(', ')}. Fix: pass one of those ids, or add` : 'it declares none. Fix: add'} "${value}" to ${axis}s.values of ${boundary.kind} "${boundary.id}".`);
  }
  return match;
}

/**
 * Returns the contract's own copy of a value. A value parsed from markup is a
 * slice that keeps its whole source fragment in memory for as long as it lives.
 */
function declaredCopy(declared: readonly string[], value: string): string | undefined {
  return declared.find(candidate => candidate === value);
}

/** Every reusable root carries all three axes, so its CSS can select on each one. */
function resolveReusableAxes(boundary: SourceBoundary, state: string, attributes: ForwardedInvocationAttributes): ForwardedInvocationAttributes {
  const reusable = boundary.reusable;
  if (!reusable) return attributes;
  const variant = attributes.variant ?? reusable.variants.default;
  const size = attributes.size ?? reusable.sizes.default;
  for (const combination of reusable.unsupported ?? []) {
    const value = combination.axis === 'variant' ? variant : size;
    if (combination.value === value && combination.state === state) {
      throw new Error(`${boundary.kind} "${boundary.id}" does not support ${combination.axis} "${value}" in state "${state}": ${combination.reason} Fix: pass another ${combination.axis} or state, or remove this pair from unsupported on ${boundary.kind} "${boundary.id}".`);
    }
  }
  return { ...attributes, variant, size };
}

/**
 * Reuses a nested compile with the same inputs from earlier in the session and
 * replays its effects in order. A document root is never reused.
 */
function compileBoundaryFragment(
  context: CompilerContext,
  boundary: SourceBoundary,
  state: string,
  invocationChildren: string,
  stack: string[],
  invocationAttributes: ForwardedInvocationAttributes
): RenderedFragment {
  if (stack.length === 0) {
    return compileFragmentSource(context, boundary, state, invocationChildren, stack, invocationAttributes);
  }
  const key = JSON.stringify([boundary.kind, boundary.id, state, invocationAttributes, invocationChildren]);
  const cached = context.session.fragments.get(key);
  if (cached && canReuseFragment(context, cached, stack)) {
    for (const outer of context.recorders) {
      for (const id of cached.boundaryIds) outer.boundaryIds.add(id);
      for (const ref of cached.assetRefs) outer.assetRefs.add(ref);
    }
    for (const event of cached.events) {
      emit(context, event);
    }
    return cached;
  }
  const record: FragmentRecord = { events: [], boundaryIds: new Set(), assetRefs: new Set() };
  context.recorders.push(record);
  let rendered: RenderedFragment;
  try {
    rendered = compileFragmentSource(context, boundary, state, invocationChildren, stack, invocationAttributes);
  } finally {
    context.recorders.pop();
  }
  context.session.fragments.set(key, { ...record, ...rendered });
  return rendered;
}

/** A reused fragment must still fail where a fresh compile would: on a cycle through the stack or an asset this document does not declare. */
function canReuseFragment(context: CompilerContext, cached: CompiledFragment, stack: string[]): boolean {
  return !stack.some(id => cached.boundaryIds.has(id)) && [...cached.assetRefs].every(ref => context.allowedAssetRefs.has(ref));
}

function emit(context: CompilerContext, event: CompileEvent): void {
  if (event.kind === 'styles') {
    addStyleRefs(context, event.styleRefs);
  } else if (event.kind === 'use') {
    recordObservedUse(context, { ...event.use });
  } else if (event.kind === 'brand-mark') {
    context.brandMarks.push({ ...event.mark });
  } else {
    assertRenderedUses(event.boundary, context.observedUseKeysBySource.get(event.boundaryId));
  }
  for (const record of context.recorders) {
    record.events.push(event);
  }
}

function compileFragmentSource(
  context: CompilerContext,
  boundary: SourceBoundary,
  state: string,
  invocationChildren: string,
  stack: string[],
  invocationAttributes: ForwardedInvocationAttributes
): RenderedFragment {
  const currentBoundaryId = boundaryId(context.bundle, boundary);
  for (const record of context.recorders) {
    record.boundaryIds.add(currentBoundaryId);
  }
  if (stack.includes(currentBoundaryId)) {
    throw new Error(`Prototype composition cycle detected: ${[...stack, currentBoundaryId].join(' -> ')}. Fix: remove one <blueprint-use> in this chain, so that no boundary renders itself.`);
  }

  emit(context, { kind: 'styles', styleRefs: boundary.prototype.styles });
  let fragment = prepareSource(context, boundary, currentBoundaryId);
  fragment = applySlots(fragment, invocationChildren, boundary, currentBoundaryId);
  fragment = selectFragmentState(fragment, state);
  fragment = applyInvocationAttributes(fragment, resolveReusableAxes(boundary, state, invocationAttributes), boundary);

  const nextStack = [...stack, currentBoundaryId];
  const ownSections = listSectionTags(fragment);
  const expansions: MarkupEdit[] = [];
  const nestedSections: SectionTag[][] = [];
  for (const use of iterateUseElements(fragment)) {
    const rendered = expandUse(context, boundary, currentBoundaryId, use, nextStack);
    expansions.push({ start: use.start, end: use.end, text: rendered.fragment });
    nestedSections.push(rendered.sections);
  }
  const sections = composeSections(ownSections, expansions, nestedSections);
  fragment = applyMarkupEdits(fragment, expansions);

  emit(context, { kind: 'rendered-uses', boundary, boundaryId: currentBoundaryId });
  const rendered = boundary.kind === 'screen'
    ? { fragment: applySectionMetadata(context.bundle, boundary, fragment, sections), sections: [] }
    : { fragment, sections };
  return applyBoundaryMetadata(rendered, boundary, currentBoundaryId, state);
}

/** The passes that read only the source itself run once in a session, because each document repeats them on the same text. */
function prepareSource(context: CompilerContext, boundary: SourceBoundary, currentBoundaryId: string): string {
  const sourceRef = boundary.prototype.source;
  const author = `${boundary.kind}:${boundary.id}`;
  const prepared = context.session.preparedSources.get(author);
  if (prepared && prepared.source === context.bundle.prototypeSourceContents[sourceRef]) {
    for (const value of prepared.assetValues) {
      assetToken(context, sourceRef, value);
    }
    return prepared.markup;
  }
  const source = requireSource(context.bundle, sourceRef, `${currentBoundaryId} prototype source`);
  assertNoExecutableMarkup(source, sourceRef);
  assertAssetAttributesDeclared(source, sourceRef);
  if (source.includes(SLOT_AUTHOR_ATTRIBUTE)) {
    throw new Error(`Prototype source "${sourceRef}" cannot contain the reserved "${SLOT_AUTHOR_ATTRIBUTE}" attribute. Fix: remove ${SLOT_AUTHOR_ATTRIBUTE} from this source, because the compiler writes it.`);
  }
  const assetValues: string[] = [];
  let markup = rewriteHtmlAssetRefs(context, source, sourceRef, assetValues);
  markup = rewriteNavigationAttributes(markup, sourceRef);
  markup = markSlotAuthor(markup, author);
  context.session.preparedSources.set(author, { source, markup, assetValues });
  return markup;
}

/** A tag inside a use moved into the fragment of that use, so only that fragment reports it. */
function composeSections(own: SectionTag[], expansions: MarkupEdit[], nested: SectionTag[][]): SectionTag[] {
  const sections: SectionTag[] = [];
  let shift = 0;
  let ownIndex = 0;
  const pushShifted = (tag: SectionTag, by: number): void => {
    sections.push({ start: tag.start + by, end: tag.end + by, id: tag.id });
  };
  expansions.forEach((expansion, index) => {
    for (; ownIndex < own.length && own[ownIndex].start < expansion.end; ownIndex += 1) {
      if (own[ownIndex].start < expansion.start) {
        pushShifted(own[ownIndex], shift);
      }
    }
    for (const tag of nested[index]) {
      pushShifted(tag, expansion.start + shift);
    }
    shift += expansion.text.length - (expansion.end - expansion.start);
  });
  for (; ownIndex < own.length; ownIndex += 1) {
    pushShifted(own[ownIndex], shift);
  }
  return sections;
}

function expandUse(
  context: CompilerContext,
  boundary: SourceBoundary,
  currentBoundaryId: string,
  use: UseElement,
  nextStack: string[]
): RenderedFragment {
  const useAttributes = parseUseAttributes(use.attributes, currentBoundaryId);
  const slotAuthor = useAttributes.get(SLOT_AUTHOR_ATTRIBUTE);
  useAttributes.delete(SLOT_AUTHOR_ATTRIBUTE);
  const kind = requiredParsedUseAttribute(useAttributes, 'kind', currentBoundaryId);
  if (kind === 'brand-mark') {
    const placedBy = slotAuthor ? `${context.bundle.manifest.project.id}/${slotAuthor.replace(':', '/')}` : currentBoundaryId;
    const fragment = renderBrandMark(context, useAttributes, use.children, placedBy);
    return { fragment, sections: listSectionTags(fragment) };
  }
  if (kind !== 'primitive' && kind !== 'component') {
    throw new Error(`${currentBoundaryId} uses unsupported reusable boundary kind "${kind}". Fix: set kind on this <blueprint-use> to "primitive", "component", or "brand-mark".`);
  }
  const id = requiredParsedUseAttribute(useAttributes, 'ref', currentBoundaryId);
  const owner = creditedBoundary(context.bundle, boundary, slotAuthor, { kind, id });
  const target = resolveBoundary(context.bundle, { kind, id });
  const targetState = resolveState(target, useAttributes.get('state'));
  const forwardedAttributes = resolveForwardedInvocationAttributes(useAttributes, target);
  const axes = resolveReusableAxes(target, targetState, forwardedAttributes);
  emit(context, {
    kind: 'use',
    use: {
      sourceBoundaryId: boundaryId(context.bundle, owner),
      targetBoundaryId: boundaryId(context.bundle, target),
      kind,
      id: target.id,
      variant: axes.variant ?? 'default',
      size: axes.size ?? 'default',
      state: targetState
    }
  });
  return compileBoundaryFragment(context, target, targetState, use.children, nextStack, forwardedAttributes);
}

function recordObservedUse(context: CompilerContext, use: ObservedPrototypeUse): void {
  context.observedUses.push(use);
  const fromSource = context.observedUseKeysBySource.get(use.sourceBoundaryId);
  if (fromSource) {
    fromSource.add(useKey(use));
  } else {
    context.observedUseKeysBySource.set(use.sourceBoundaryId, new Set([useKey(use)]));
  }
}

function useKey(use: PrototypeUseDeclaration): string {
  return `${use.kind}:${use.id}`;
}

/**
 * Tags every `<blueprint-use>` nested inside another use with the boundary whose
 * source wrote it, so slot content keeps its author after it moves into a container.
 */
function markSlotAuthor(markup: string, author: string): string {
  const edits: MarkupEdit[] = [];
  const authorAttribute = ` ${SLOT_AUTHOR_ATTRIBUTE}="${escapeAttribute(author)}"`;
  for (const use of iterateUseElements(markup)) {
    if (!use.hasNestedUse) continue;
    const tokens = listMarkupTokens(markup);
    const open = tokens[use.openIndex] as OpenTag;
    edits.push({ start: open.start, end: open.end, text: `<blueprint-use${use.attributes}>` });
    for (let index = use.openIndex + 1; index < use.closeIndex; index += 1) {
      const token = tokens[index];
      if (token.kind === 'open' && token.name === 'blueprint-use') {
        const closing = token.selfClosing ? '</blueprint-use>' : '';
        edits.push({ start: token.start, end: token.end, text: `<blueprint-use${authorAttribute}${useTagAttributes(markup, token)}>${closing}` });
      } else if (token.kind === 'close' && token.name === 'blueprint-use') {
        edits.push({ start: token.start, end: token.end, text: '</blueprint-use>' });
      }
    }
    const close = tokens[use.closeIndex];
    edits.push({ start: close.start, end: close.end, text: '</blueprint-use>' });
  }
  return applyMarkupEdits(markup, edits);
}

/**
 * A container that declares a slotted reusable always renders it, so it keeps the
 * credit; otherwise the reusable belongs to the boundary that wrote the slot content.
 */
function creditedBoundary(
  bundle: CanvasProjectBundle,
  container: SourceBoundary,
  slotAuthor: string | undefined,
  use: PrototypeUseDeclaration
): SourceBoundary {
  if (!slotAuthor || declaresUse(container, use)) {
    assertDeclaredUse(container, use);
    return container;
  }
  const separator = slotAuthor.indexOf(':');
  const author = resolveBoundary(bundle, {
    kind: slotAuthor.slice(0, separator) as PrototypeCompileTarget['kind'],
    id: slotAuthor.slice(separator + 1)
  });
  if (!declaresUse(author, use)) {
    throw new Error(
      `${author.kind} "${author.id}" renders undeclared ${use.kind} "${use.id}" inside ${container.kind} "${container.id}". ` +
      `Declare it on ${author.kind} "${author.id}", or on ${container.kind} "${container.id}" if every instance contains it. Fix: ${declareUseFix(author, use)}`
    );
  }
  return author;
}

function applySectionMetadata(bundle: CanvasProjectBundle, boundary: SourceBoundary, fragment: string, sections: SectionTag[]): string {
  const sectionIds = new Set(bundle.screens.screens.find(screen => screen.id === boundary.id)?.sections.map(section => section.id) ?? []);
  const marked = new Set<string>();
  const edits: MarkupEdit[] = [];
  for (const { start, end, id: sectionId } of sections) {
    if (!sectionIds.has(sectionId)) {
      throw new Error(`screen "${boundary.id}" marks undeclared section "${sectionId}". Fix: add section "${sectionId}" to screen "${boundary.id}" in screens.json, or remove this data-blueprint-section marker from its source.`);
    }
    if (marked.has(sectionId)) {
      throw new Error(`screen "${boundary.id}" marks section "${sectionId}" more than once. Fix: keep one data-blueprint-section="${sectionId}" marker in the source of screen "${boundary.id}".`);
    }
    marked.add(sectionId);
    const sectionBoundaryId = `${bundle.manifest.project.id}/section/${boundary.id}/${sectionId}`;
    edits.push({ start, end, text: setRootAttribute(fragment.slice(start, end), 'data-blueprint-section-boundary-id', sectionBoundaryId) });
  }
  return applyMarkupEdits(fragment, edits);
}

function resolveBoundary(bundle: CanvasProjectBundle, target: PrototypeCompileTarget): SourceBoundary {
  if (target.kind === 'primitive') {
    const primitive = bundle.primitives.primitives.find(candidate => candidate.id === target.id);
    if (!primitive) {
      throw new Error(`Unknown prototype primitive "${target.id}". Fix: add "${target.id}" to primitives.json, or use the id of a primitive that it declares.`);
    }
    if (!primitive.prototype) {
      throw new Error(`Primitive "${target.id}" has no canonical prototype source. Fix: add prototype with source and styles to primitive "${target.id}" in primitives.json.`);
    }
    return primitiveBoundary(primitive);
  }
  if (target.kind === 'component') {
    const component = bundle.components.components.find(candidate => candidate.id === target.id);
    if (!component) {
      throw new Error(`Unknown prototype component "${target.id}". Fix: add "${target.id}" to components.json, or use the id of a component that it declares.`);
    }
    return componentBoundary(component);
  }
  const screen = bundle.screens.screens.find(candidate => candidate.id === target.id);
  if (!screen) {
    throw new Error(`Unknown prototype screen "${target.id}". Fix: add "${target.id}" to screens.json, or use the id of a screen that it declares.`);
  }
  if (!screen.prototype) {
    throw new Error(`Screen "${target.id}" has no browser-native prototype source. Fix: add prototype with source, styles, states, assetRefs, and reviewConditions to screen "${target.id}" in screens.json.`);
  }
  return screenBoundary(screen);
}

function primitiveBoundary(primitive: ReusableDefinition): SourceBoundary {
  if (!primitive.prototype) {
    throw new Error(`Primitive "${primitive.id}" is missing its canonical prototype source. Fix: add prototype with source and styles to primitive "${primitive.id}" in primitives.json.`);
  }
  return reusableBoundary('primitive', primitive);
}

function componentBoundary(component: ReusableDefinition): SourceBoundary {
  return reusableBoundary('component', component);
}

function reusableBoundary(kind: ReusableKind, reusable: ReusableDefinition): SourceBoundary {
  return {
    kind,
    id: reusable.id,
    name: reusable.name,
    prototype: reusable.prototype,
    renderedUses: (reusable.uses ?? []).map(use => ({ kind: use.kind, id: use.id })),
    states: axisIds(reusable.states),
    defaultState: reusable.states?.default,
    reusable
  };
}

function screenBoundary(screen: ScreenDefinition): SourceBoundary {
  if (!screen.prototype) {
    throw new Error(`Screen "${screen.id}" is missing its browser-native prototype source. Fix: add prototype with source, styles, states, assetRefs, and reviewConditions to screen "${screen.id}" in screens.json.`);
  }
  const uses = screen.sections.flatMap(section => section.uses);
  return {
    kind: 'screen',
    id: screen.id,
    name: screen.name,
    prototype: screen.prototype,
    renderedUses: screen.prototype.renderedUses ?? uses.flatMap(use => (
      use.kind === 'primitive' || use.kind === 'component' ? [{ kind: use.kind, id: use.id }] : []
    )),
    states: screen.prototype.states,
    defaultState: screen.prototype.states[0]
  };
}

function statesField(boundary: SourceBoundary): string {
  return boundary.reusable ? 'states.values' : 'prototype.states';
}

function resolveState(boundary: SourceBoundary, requestedState: string | undefined): string {
  const state = requestedState ?? boundary.defaultState;
  if (!state) {
    throw new Error(`${boundary.kind} "${boundary.id}" has no declared prototype state. Fix: add a state to ${statesField(boundary)} of ${boundary.kind} "${boundary.id}".`);
  }
  const declared = declaredCopy(boundary.states, state);
  if (declared === undefined) {
    throw new Error(`${boundary.kind} "${boundary.id}" does not declare prototype state "${state}". Fix: ${boundary.states.length > 0 ? `pass one of these states: ${boundary.states.join(', ')}. Or add` : 'add'} "${state}" to ${statesField(boundary)} of ${boundary.kind} "${boundary.id}".`);
  }
  return declared;
}

function assertIsolatedHostPolicy(bundle: CanvasProjectBundle): void {
  const policy = bundle.manifest.prototypeHost;
  if (!policy || policy.network !== 'deny' || policy.scripts !== 'none') {
    throw new Error('Canonical prototype compilation requires prototypeHost.network="deny" and prototypeHost.scripts="none". Fix: set prototypeHost.network to "deny" and prototypeHost.scripts to "none" in manifest.json.');
  }
}

function addStyleRefs(context: CompilerContext, styleRefs: string[]): void {
  for (const styleRef of styleRefs) {
    if (!context.styleRefSet.has(styleRef)) {
      context.styleRefSet.add(styleRef);
      context.styleRefs.push(styleRef);
    }
  }
}

function loadAndRewriteStyle(context: CompilerContext, styleRef: string): string {
  const css = requireSource(context.bundle, styleRef, `prototype stylesheet ${styleRef}`);
  if (cssHasImport(css)) {
    throw new Error(`Prototype stylesheet "${styleRef}" cannot import external or undeclared stylesheets. Fix: remove each @import from this stylesheet, and add each imported file to prototype.styles.`);
  }
  return rewriteCssUrls(css, value => `url("${assetToken(context, styleRef, value)}")`);
}

function rewriteHtmlAssetRefs(context: CompilerContext, html: string, sourceRef: string, assetValues: string[]): string {
  for (const tag of listPossibleOpenTags(html)) {
    for (const attribute of tag.attributes.filter(isAssetAttribute)) {
      if (!attribute.quote) {
        throw new Error(`Prototype source "${sourceRef}" has an unquoted ${attribute.name} value "${attribute.value}". Fix: put double quotes around the value.`);
      }
      assetValues.push(attribute.value);
      assetToken(context, sourceRef, attribute.value);
    }
  }
  const edits: MarkupEdit[] = [];
  for (const tag of listOpenTags(html)) {
    for (const attribute of tag.attributes.filter(isAssetAttribute)) {
      edits.push({ start: attribute.valueStart, end: attribute.valueEnd, text: assetToken(context, sourceRef, attribute.value) });
    }
  }
  return applyMarkupEdits(html, edits);
}

function isAssetAttribute(attribute: MarkupAttribute): boolean {
  return attribute.hasValue && (attribute.name === 'src' || attribute.name === 'poster');
}

function rewriteNavigationAttributes(html: string, sourceRef: string): string {
  const realTagStarts = new Set(listOpenTags(html).map(tag => tag.start));
  for (const tag of listPossibleOpenTags(html)) {
    if (navigationHref(tag, sourceRef) && !realTagStarts.has(tag.start)) {
      throw new Error(`Prototype source "${sourceRef}" holds a navigation href in a comment, text, an attribute value, or a cut-off tag, where a browser can read a live link. Fix: delete that link from the source.`);
    }
  }
  const edits: MarkupEdit[] = [];
  for (const tag of listOpenTags(html)) {
    const href = navigationHref(tag, sourceRef);
    if (href) {
      edits.push({ start: href.nameEnd - 'href'.length, end: href.end, text: `data-blueprint-href="${escapeAttribute(href.value)}"` });
    }
  }
  return applyMarkupEdits(html, edits);
}

function navigationHref(tag: OpenTag, sourceRef: string): MarkupAttribute | undefined {
  if (tag.name !== 'a' && tag.name !== 'area') return undefined;
  const hrefs = tag.attributes.filter(attribute => (attribute.name === 'href' || attribute.name === 'xlink:href') && attribute.hasValue);
  if (hrefs.length === 0) return undefined;
  if (hrefs.length !== 1 || !hrefs[0].quote) {
    throw new Error(`Prototype source "${sourceRef}" contains malformed or duplicate navigation href markup. Fix: give each <${tag.name}> one href in double quotes.`);
  }
  if (!isSafePrototypeHref(hrefs[0].value)) {
    throw new Error(`Prototype source "${sourceRef}" contains unsafe href "${hrefs[0].value}". Fix: change this href to a value that starts with /, #, ./, or ../.`);
  }
  return hrefs[0];
}

function assetToken(context: CompilerContext, sourceRef: string, value: string): string {
  const assetRef = resolveRelativeRef(sourceRef, value);
  if (!context.allowedAssetRefs.has(assetRef)) {
    throw new Error(`Prototype resource "${value}" from "${sourceRef}" is not a declared controlled asset. Fix: add "${assetRef}" to prototype.assetRefs of the screen that renders it, and keep the file in a prototypeHost.assetRoots directory.`);
  }
  if (!context.bundle.prototypeAssetContents[assetRef]) {
    throw new Error(`Declared prototype asset "${assetRef}" is missing from the loaded bundle. Fix: add the file "${assetRef}" to the project, or remove it from prototype.assetRefs.`);
  }
  for (const record of context.recorders) {
    record.assetRefs.add(assetRef);
  }
  return `${ASSET_TOKEN_START}${hexFromText(assetRef)}${ASSET_TOKEN_END}`;
}

function hexFromText(text: string): string {
  return Array.from(new TextEncoder().encode(text), byte => byte.toString(16).padStart(2, '0')).join('');
}

function textFromHex(hex: string): string {
  return new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], pair => Number.parseInt(pair, 16)));
}

function resolveAssetTokens(context: CompilerContext, html: string, output: AssetOutput): string {
  if (output.kind === 'tokens') return html;
  return html.replace(ASSET_TOKEN_PATTERN, (_token, hex: string) => {
    const assetRef = textFromHex(hex);
    const asset = context.bundle.prototypeAssetContents[assetRef];
    if ('base64' in asset) return assetDataUrl(asset);
    if (output.kind === 'linked') return linkedAssetUrl(output.assetSource, asset.sha256);
    throw new Error(`Prototype asset "${assetRef}" is a review server link, so a self-contained document cannot inline it. Fix: compile with linked output, or load the project from its files so that the asset holds its bytes.`);
  });
}

function resolveRelativeRef(sourceRef: string, value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    trimmed.startsWith('#') ||
    trimmed.includes('://') ||
    /^[a-z][a-z\d+.-]*:/i.test(trimmed) ||
    /[?#]/.test(trimmed)
  ) {
    throw new Error(`Prototype resource URL "${value}" must be a controlled relative path without query or fragment parts. Fix: copy the file into a prototypeHost.assetRoots directory, and write its relative path with no query or fragment.`);
  }
  const normalizedInput = trimmed.replace(/\\/g, '/');
  let decodedInput: string;
  try {
    decodedInput = decodeURIComponent(normalizedInput);
  } catch {
    throw new Error(`Prototype resource URL "${value}" contains invalid escaping. Fix: rewrite "${value}" with valid percent escapes, or write the plain file path.`);
  }
  const parts = sourceRef.split('/').slice(0, -1);
  for (const segment of decodedInput.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (parts.length === 0) {
        throw new Error(`Prototype resource URL "${value}" escapes the app-owned sidecar root. Fix: copy the file into a prototypeHost.assetRoots directory, and remove the ".." segments that leave the project.`);
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function createTokenCss(bundle: CanvasProjectBundle): string {
  const declarations: string[] = [];
  const seen = new Set<string>();
  for (const group of bundle.tokens.tokenGroups) {
    for (const token of group.tokens) {
      if (!/^--[a-zA-Z0-9_-]+$/.test(token.styleRef)) {
        throw new Error(`Token "${group.id}.${token.id}" styleRef "${token.styleRef}" must be a CSS custom property. Fix: set styleRef of this token in tokens.json to a name such as "--${group.id}-${token.id}".`);
      }
      if (seen.has(token.styleRef)) {
        throw new Error(`Token CSS custom property "${token.styleRef}" is declared more than once. Fix: set styleRef of token "${group.id}.${token.id}" in tokens.json to a name that no other token uses.`);
      }
      if (/[;{}]|<\/style/i.test(token.value)) {
        throw new Error(`Token "${group.id}.${token.id}" contains an unsafe CSS value. Fix: remove each ";", "{", "}", and "</style" from the value of this token in tokens.json.`);
      }
      seen.add(token.styleRef);
      declarations.push(`  ${token.styleRef}: ${token.value};`);
    }
  }
  return `:root {\n${declarations.join('\n')}\n}`;
}

function applySlots(template: string, invocationChildren: string, boundary: SourceBoundary, label: string): string {
  const slotContent = collectInvocationSlots(invocationChildren);
  const slots = boundary.reusable?.slots ?? [];
  const declaredSlots = slots.map(slot => slot.id);
  for (const [name, content] of slotContent) {
    const slot = slots.find(candidate => candidate.id === name);
    if (!slot) {
      if (name === 'default' && !boundary.reusable) continue;
      throw new Error(name === 'default'
        ? `${label} received content outside any named slot, but declares no "default" slot. Fix: ${declaredSlots.length > 0 ? `add slot="<id>" to the content, with one of these slot ids: ${declaredSlots.join(', ')}. Or add` : 'add'} a "default" slot to this boundary.`
        : `${label} received undeclared slot "${name}". Fix: ${declaredSlots.length > 0 ? `use one of these slot ids: ${declaredSlots.join(', ')}. Or add` : 'add'} "${name}" to the slots of this boundary.`);
    }
    const refused = slotContentAccepts(content).filter(accept => !slot.accepts.includes(accept));
    if (refused.length > 0) {
      throw new Error(
        `${label} slot "${name}" received ${refused.join(', ')}, which it does not accept; it accepts ${slot.accepts.join(', ')}. Fix: replace that content with what the slot accepts, or add ${refused.join(', ')} to the accepts list of slot "${name}".`
      );
    }
  }

  let result = template;
  for (const slotName of declaredSlots.filter(id => id !== 'default')) {
    const content = slotContent.get(slotName);
    result = replaceNamedSlotElements(result, slotName, content);
    result = replaceDataSlotContents(result, slotName, content);
  }
  const defaultContent = slotContent.get('default');
  const hadDefaultPlaceholder = listOpenTags(result).some(tag => tag.name === 'slot');
  result = replaceDefaultSlotElements(result, defaultContent);
  if (defaultContent && !hadDefaultPlaceholder) {
    throw new Error(`${label} received default slot content but declares no default slot placeholder. Fix: add a <slot> element to the source of this boundary, or remove the content from this <blueprint-use>.`);
  }
  return result;
}

function replaceNamedSlotElements(template: string, name: string, content: string | undefined): string {
  return replaceSlotElements(template, tag => quotedAttribute(tag, 'name')?.value === name, content);
}

function replaceDefaultSlotElements(template: string, content: string | undefined): string {
  return replaceSlotElements(template, isDefaultSlot, content);
}

function replaceSlotElements(template: string, matches: (tag: OpenTag) => boolean, content: string | undefined): string {
  const tokens = listMarkupTokens(template);
  const edits: MarkupEdit[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const tag = tokens[index];
    if (tag.kind !== 'open' || tag.name !== 'slot' || !matches(tag)) continue;
    if (tag.selfClosing) {
      edits.push({ start: tag.start, end: tag.end, text: content ?? '' });
      continue;
    }
    const closeIndex = elementCloseIndex(tokens, index);
    if (closeIndex === -1) continue;
    const close = tokens[closeIndex];
    edits.push({ start: tag.start, end: close.end, text: content ?? template.slice(tag.end, close.start) });
    index = closeIndex;
  }
  return applyMarkupEdits(template, edits);
}

function replaceDataSlotContents(template: string, name: string, content: string | undefined): string {
  if (content === undefined) {
    return template;
  }
  const tokens = listMarkupTokens(template);
  const edits: MarkupEdit[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const tag = tokens[index];
    if (tag.kind !== 'open' || quotedAttribute(tag, 'data-blueprint-slot')?.value !== name) continue;
    const closeIndex = elementCloseIndex(tokens, index);
    if (closeIndex !== -1) {
      edits.push({ start: tag.end, end: tokens[closeIndex].start, text: content });
      index = closeIndex;
    } else if (tag.selfClosing) {
      edits.push({ start: tag.start, end: tag.end, text: content });
    }
  }
  return applyMarkupEdits(template, edits);
}

function requiredParsedUseAttribute(attributes: Map<string, string>, name: string, boundary: string): string {
  const value = attributes.get(name);
  if (!value) {
    throw new Error(`${boundary} contains <blueprint-use> without required "${name}". Fix: add ${name}="<value>" to this <blueprint-use>.`);
  }
  return value;
}

function resolveForwardedInvocationAttributes(
  attributes: Map<string, string>,
  target: SourceBoundary
): ForwardedInvocationAttributes {
  const allowed = new Set(['kind', 'ref', 'state', 'class', 'variant', 'size', 'href', 'data-blueprint-section']);
  for (const name of attributes.keys()) {
    if (!allowed.has(name) || name.startsWith('on') || name === 'style') {
      throw new Error(`${target.kind} "${target.id}" received unsupported <blueprint-use> attribute "${name}". Fix: remove "${name}" from this <blueprint-use>. It takes ${[...allowed].join(', ')}.`);
    }
  }
  const className = attributes.get('class');
  if (className && !/^[a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)*$/.test(className)) {
    throw new Error(`${target.kind} "${target.id}" received an unsafe class invocation attribute. Fix: write class as names of letters, digits, hyphens, and underscores, with spaces between them.`);
  }
  const variant = declaredAxisValue(target, 'variant', attributes.get('variant'));
  const size = declaredAxisValue(target, 'size', attributes.get('size'));
  const href = attributes.get('href');
  if (href && !isSafePrototypeHref(href)) {
    throw new Error(`${target.kind} "${target.id}" received unsafe href "${href}". Fix: change this href to a value that starts with /, #, ./, or ../.`);
  }
  const section = attributes.get('data-blueprint-section');
  return {
    ...(className ? { className } : {}),
    ...(variant ? { variant } : {}),
    ...(size ? { size } : {}),
    ...(href ? { href } : {}),
    ...(section ? { section } : {})
  };
}

const BRAND_MARK_USE_ATTRIBUTES = new Set(['kind', 'ref', 'variant', 'class', 'aria-label', 'aria-hidden']);

/**
 * Inlines the brand.json mark source so every placement redraws when the mark or
 * its variant tokens change; variants recolor through `color` and `--brand-accent`.
 */
function renderBrandMark(
  context: CompilerContext,
  attributes: Map<string, string>,
  children: string,
  placedBy: string
): string {
  const id = requiredParsedUseAttribute(attributes, 'ref', placedBy);
  const brand = context.bundle.brand;
  const mark = brand?.marks.find(candidate => candidate.id === id);
  if (!brand || !mark) {
    throw new Error(`${placedBy} places brand mark "${id}", which brand.json does not declare. Fix: add mark "${id}" to brand.json, or set ref to a mark that it declares${brand?.marks.length ? `: ${brand.marks.map(candidate => candidate.id).join(', ')}` : ''}.`);
  }
  for (const name of attributes.keys()) {
    if (!BRAND_MARK_USE_ATTRIBUTES.has(name)) {
      throw new Error(`Brand mark "${id}" received unsupported <blueprint-use> attribute "${name}". Fix: remove "${name}" from this <blueprint-use>. It takes ${[...BRAND_MARK_USE_ATTRIBUTES].join(', ')}.`);
    }
  }
  if (children.trim()) {
    throw new Error(`Brand mark "${id}" cannot receive slot content; it always draws its brand.json source. Fix: remove the content inside this <blueprint-use>.`);
  }
  const className = attributes.get('class');
  if (className && !/^[a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)*$/.test(className)) {
    throw new Error(`Brand mark "${id}" received an unsafe class invocation attribute. Fix: write class as names of letters, digits, hyphens, and underscores, with spaces between them.`);
  }
  const hidden = attributes.get('aria-hidden');
  if (hidden !== undefined && hidden !== 'true') {
    throw new Error(`Brand mark "${id}" accepts only aria-hidden="true". Fix: set aria-hidden to "true", or remove it.`);
  }
  const variantId = attributes.get('variant');
  const variant = variantId === undefined ? undefined : mark.variants.find(candidate => candidate.id === variantId);
  if (variantId !== undefined && !variant) {
    throw new Error(`Brand mark "${id}" does not declare variant "${variantId}". Fix: set variant to one of ${mark.variants.map(candidate => candidate.id).join(', ')}. Or add "${variantId}" to this mark in brand.json.`);
  }

  const source = requireSource(context.bundle, mark.source, `Brand mark "${id}" source`);
  const issue = brandMarkSourceIssues(source)[0];
  if (issue) {
    throw new Error(`Brand mark "${id}" source "${mark.source}" ${issue}`);
  }
  const svg = scopeSvgIds(outerSvgMarkup(source), `bp-brand-${id}-`);
  if (!svg) {
    throw new Error(`Brand mark "${id}" source "${mark.source}" has no <svg> element. Fix: write "${mark.source}" as one <svg> element with a viewBox.`);
  }
  emit(context, { kind: 'brand-mark', mark: { sourceBoundaryId: placedBy, id: mark.id, ...(variant ? { variant: variant.id } : {}) } });

  const rootTag = firstOpenTag(svg) as OpenTag;
  let root = withoutRootSize(`<svg${svg.slice(rootTag.nameEnd, rootTag.end)}`);
  const existingClass = quotedAttribute(firstOpenTag(root) as OpenTag, 'class')?.value ?? '';
  const classes = [...new Set(`${existingClass} ${className ?? ''}`.trim().split(/\s+/).filter(Boolean))].join(' ');
  if (classes) {
    root = setRootAttribute(root, 'class', classes);
  }
  root = setRootAttribute(root, 'height', '1em');
  root = setRootAttribute(root, 'data-blueprint-brand-mark', id);
  if (variant) {
    root = setRootAttribute(root, 'data-blueprint-brand-variant', variant.id);
    const accent = variant.accent ? `var(${colorTokenStyleRef(context.bundle, variant.accent, id)})` : 'currentColor';
    const existingStyle = quotedAttribute(firstOpenTag(root) as OpenTag, 'style')?.value;
    const declarations = `color:var(${colorTokenStyleRef(context.bundle, variant.foreground, id)});--brand-accent:${accent}`;
    root = setRootAttribute(root, 'style', existingStyle ? `${existingStyle.replace(/;?\s*$/, ';')}${declarations}` : declarations);
  }
  if (hidden) {
    root = setRootAttribute(root, 'aria-hidden', 'true');
  } else {
    root = setRootAttribute(root, 'role', 'img');
    root = setRootAttribute(root, 'aria-label', attributes.get('aria-label') ?? brand.name);
  }
  return `${root}${svg.slice(rootTag.end)}`;
}

/** A placed mark sizes from `1em`, so the width and height of its source must not apply. */
function withoutRootSize(root: string): string {
  const edits: MarkupEdit[] = [];
  for (const attribute of (firstOpenTag(root) as OpenTag).attributes) {
    if ((attribute.name === 'width' || attribute.name === 'height') && attribute.quote && root[attribute.nameStart - 1].trim() === '') {
      edits.push({ start: attribute.nameStart - 1, end: attribute.end, text: '' });
    }
  }
  return applyMarkupEdits(root, edits);
}

function colorTokenStyleRef(bundle: CanvasProjectBundle, ref: string, markId: string): string {
  const separator = ref.indexOf('.');
  const token = bundle.tokens.tokenGroups
    .find(group => group.id === ref.slice(0, separator))
    ?.tokens.find(candidate => candidate.id === ref.slice(separator + 1));
  if (!token) {
    throw new Error(`Brand mark "${markId}" variant references undeclared color token "${ref}". Fix: add "${ref}" to tokens.json, or set this variant in brand.json to a declared color token.`);
  }
  return token.styleRef;
}

/** Prefixes a mark's internal IDs so two inlined marks never resolve each other's clip paths or gradients. */
function scopeSvgIds(svg: string, prefix: string): string {
  const attributes = listOpenTags(svg).flatMap(tag => tag.attributes).filter(attribute => attribute.quote);
  const ids = new Set(attributes.filter(attribute => attribute.name === 'id').map(attribute => attribute.value));
  if (ids.size === 0) {
    return svg;
  }
  const scoped = (id: string): string => (ids.has(id) ? `${prefix}${id}` : id);
  const edits: MarkupEdit[] = [];
  for (const attribute of attributes) {
    if (attribute.name === 'id') {
      edits.push({ start: attribute.valueStart, end: attribute.valueEnd, text: scoped(attribute.value) });
    } else if ((attribute.name === 'href' || attribute.name === 'xlink:href') && attribute.value.startsWith('#')) {
      edits.push({ start: attribute.valueStart + 1, end: attribute.valueEnd, text: scoped(attribute.value.slice(1)) });
    }
  }
  return applyMarkupEdits(svg, edits)
    .replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/gi, (_match, quote: string, id: string) => `url(${quote}#${scoped(id)}${quote})`);
}

function applyInvocationAttributes(
  fragment: string,
  attributes: ForwardedInvocationAttributes,
  boundary: SourceBoundary
): string {
  if (!attributes.className && !attributes.variant && !attributes.size && !attributes.href && !attributes.section) {
    return fragment;
  }
  const rootTag = firstOpenTag(fragment);
  if (!rootTag) {
    throw new Error(`${boundary.kind} "${boundary.id}" prototype source has no root element for invocation attributes. Fix: put the source of ${boundary.kind} "${boundary.id}" inside one root element.`);
  }
  let root = fragment.slice(rootTag.start, rootTag.end);
  if (attributes.className) {
    const existingClass = quotedAttribute(rootTag, 'class')?.value;
    const merged = existingClass === undefined
      ? attributes.className
      : [...new Set(`${existingClass} ${attributes.className}`.trim().split(/\s+/))].join(' ');
    root = setRootAttribute(root, 'class', merged);
  }
  if (attributes.variant) {
    root = setRootAttribute(root, 'data-blueprint-variant', attributes.variant);
  }
  if (attributes.size) {
    root = setRootAttribute(root, 'data-blueprint-size', attributes.size);
  }
  if (attributes.href) {
    if (rootTag.name !== 'a') {
      throw new Error(`${boundary.kind} "${boundary.id}" cannot receive href because its root element is <${fragment.slice(rootTag.start + 1, rootTag.nameEnd)}>. Fix: make <a> the root element of this source, or remove href from this <blueprint-use>.`);
    }
    root = setRootAttribute(root, 'data-blueprint-href', attributes.href);
  }
  if (attributes.section) {
    root = setRootAttribute(root, 'data-blueprint-section', attributes.section);
  }
  return replaceOpenTag(fragment, rootTag, root);
}

function replaceOpenTag(fragment: string, tag: OpenTag, openTag: string): string {
  return `${fragment.slice(0, tag.start)}${openTag}${fragment.slice(tag.end)}`;
}

function setRootAttribute(openTag: string, name: string, value: string): string {
  return setTagAttribute(openTag, name, `${name}="${escapeAttribute(value)}"`);
}

function isSafePrototypeHref(href: string): boolean {
  return (
    href.length > 0 &&
    !/[\u0000-\u001f\u007f\\]/.test(href) &&
    !href.startsWith('//') &&
    !/^[a-z][a-z\d+.-]*:/i.test(href) &&
    (href.startsWith('/') || href.startsWith('#') || href.startsWith('./') || href.startsWith('../'))
  );
}

function declaresUse(boundary: SourceBoundary, use: PrototypeUseDeclaration): boolean {
  return boundary.renderedUses.some(dependency => dependency.kind === use.kind && dependency.id === use.id);
}

function declareUseFix(boundary: SourceBoundary, use: PrototypeUseDeclaration): string {
  const entry = `{ "kind": "${use.kind}", "id": "${use.id}", "reason": "<why>" }`;
  return boundary.kind === 'screen'
    ? `add ${entry} to the uses of a section on screen "${boundary.id}". If the screen has prototype.renderedUses, add the use there too.`
    : `add ${entry} to the uses of ${boundary.kind} "${boundary.id}".`;
}

function assertDeclaredUse(boundary: SourceBoundary, use: PrototypeUseDeclaration): void {
  if (!declaresUse(boundary, use)) {
    throw new Error(`${boundary.kind} "${boundary.id}" renders undeclared ${use.kind} "${use.id}". Fix: ${declareUseFix(boundary, use)}`);
  }
}

function assertRenderedUses(boundary: SourceBoundary, observedKeys: ReadonlySet<string> | undefined): void {
  const declaredKeys = new Set(boundary.renderedUses.map(useKey));
  const matches = (observedKeys?.size ?? 0) === declaredKeys.size && [...declaredKeys].every(key => observedKeys?.has(key));
  if (!matches) {
    const rendered = [...(observedKeys ?? [])].sort().join(', ');
    throw new Error(
      `${boundary.kind} "${boundary.id}" rendered uses do not match its declared reusable dependencies. Fix: ${rendered ? `make the uses of this ${boundary.kind} list exactly what its source renders: ${rendered}` : `remove each entry from the uses of this ${boundary.kind}, because its source renders no reusable`}.`
    );
  }
}

function applyBoundaryMetadata(
  { fragment, sections }: RenderedFragment,
  boundary: SourceBoundary,
  currentBoundaryId: string,
  state: string
): RenderedFragment {
  const rootTag = firstOpenTag(fragment);
  if (!rootTag) {
    throw new Error(`${boundary.kind} "${boundary.id}" prototype source has no root element for boundary metadata. Fix: put the source of ${boundary.kind} "${boundary.id}" inside one root element.`);
  }
  let root = fragment.slice(rootTag.start, rootTag.end);
  root = setRootAttribute(root, 'data-blueprint-boundary-id', currentBoundaryId);
  root = setRootAttribute(root, 'data-blueprint-boundary-kind', boundary.kind);
  root = setRootAttribute(root, 'data-blueprint-boundary-local-id', boundary.id);
  root = setRootAttribute(root, 'data-blueprint-boundary-state', state);
  const growth = root.length - (rootTag.end - rootTag.start);
  return {
    fragment: replaceOpenTag(fragment, rootTag, root),
    sections: sections.map(tag => ({
      start: tag.start > rootTag.start ? tag.start + growth : tag.start,
      end: tag.end + growth,
      id: tag.id
    }))
  };
}

function selectFragmentState(fragment: string, state: string): string {
  const rootTag = firstOpenTag(fragment, tag => tag.name !== 'blueprint-use');
  if (!rootTag) {
    return fragment;
  }
  return replaceOpenTag(fragment, rootTag, setRootAttribute(fragment.slice(rootTag.start, rootTag.end), 'data-blueprint-state', state));
}

const EXECUTABLE_ELEMENTS = new Set(['script', 'iframe', 'object', 'embed', 'meta', 'base', 'link']);
const FORM_TARGET_ATTRIBUTES = new Set(['action', 'formaction']);
const EVENT_HANDLER_NAME = /^on[a-z]+$/;
const MEDIA_ELEMENTS = new Set(['video', 'audio']);
const SVG_RESOURCE_ELEMENTS = new Set(['image', 'feimage', 'use', 'mpath', 'tref']);

function bypassingAssetAttribute(tag: OpenTag): MarkupAttribute | undefined {
  return tag.attributes.find(attribute => attribute.hasValue && (
    attribute.name === 'srcset'
    || attribute.name === 'imagesrcset'
    || attribute.name === 'background'
    || ((attribute.name === 'href' || attribute.name === 'xlink:href') && SVG_RESOURCE_ELEMENTS.has(tag.name) && !attribute.value.startsWith('#'))
  ));
}

function assertAssetAttributesDeclared(source: string, sourceRef: string): void {
  for (const tag of listPossibleOpenTags(source)) {
    const attribute = bypassingAssetAttribute(tag);
    if (attribute) {
      throw new Error(`Prototype source "${sourceRef}" has ${attribute.name}="${attribute.value}" on <${tag.name}>, which loads a file without an asset declaration. Fix: delete ${attribute.name} from this tag, and show the file through src on an <img> with the file in prototype.assetRefs.`);
    }
  }
}

function assertNoExecutableMarkup(source: string, sourceRef: string): void {
  const tags = listPossibleOpenTags(source);
  const isExecutable = (tag: OpenTag): boolean => EXECUTABLE_ELEMENTS.has(tag.name) || tag.attributes.some(attribute => (
    attribute.hasValue && (EVENT_HANDLER_NAME.test(attribute.name) || FORM_TARGET_ATTRIBUTES.has(attribute.name))
  ));
  if (tags.some(isExecutable)) {
    throw new Error(`Prototype source "${sourceRef}" contains executable, navigation, form, or nested browsing content. Fix: remove these tags, or their on* and form action attributes: ${[...new Set(tags.filter(isExecutable).map(tag => `<${tag.name}>`))].join(', ')}.`);
  }
  // Media elements compile fine but the CSP (default-src 'none', no media-src) blocks
  // playback at runtime; reject them here so authors get a clear compile error instead
  // of a silently dead element. <picture> stays allowed: it renders static imagery.
  if (tags.some(tag => MEDIA_ELEMENTS.has(tag.name))) {
    throw new Error(
      `Prototype source "${sourceRef}" contains media content (<video>/<audio>) that the isolated prototype host cannot play; use static imagery or SMIL-animated SVG assets instead. Fix: replace each <video> and <audio> in this source with an <img> or an SVG asset.`
    );
  }
}

function requireSource(bundle: CanvasProjectBundle, sourceRef: string, label: string): string {
  const source = bundle.prototypeSourceContents[sourceRef];
  if (source === undefined) {
    throw new Error(`${label} "${sourceRef}" is missing from the loaded bundle. Fix: add the file "${sourceRef}" to the project, or remove the ref that names it.`);
  }
  if (source.includes(ASSET_TOKEN_START) || source.includes(ASSET_TOKEN_END)) {
    throw new Error(`${label} "${sourceRef}" contains a reserved noncharacter, U+FDD0 or U+FDD1. Fix: delete that character from the source.`);
  }
  return source;
}

function boundaryId(bundle: CanvasProjectBundle, boundary: Pick<SourceBoundary, 'kind' | 'id'>): string {
  return `${bundle.manifest.project.id}/${boundary.kind}/${boundary.id}`;
}

function safeAreaCss(preset: FramePreset | undefined): string {
  const insets = { top: 0, right: 0, bottom: 0, left: 0, ...preset?.safeArea };
  const declarations = (['top', 'right', 'bottom', 'left'] as const).map(side => {
    const inset = insets[side];
    if (!Number.isFinite(inset) || inset < 0) {
      throw new Error(`Frame preset "${preset?.id}" safe-area ${side} must be a non-negative number. Fix: set safeArea.${side} of this preset in manifest.json to 0 or a higher number.`);
    }
    return `--blueprint-safe-area-${side}:${inset}px;`;
  });
  return `:root{${declarations.join('')}}`;
}

function baseDocumentCss(): string {
  return 'html,body{margin:0;min-width:100%;min-height:100%;}body{min-height:100vh;}';
}

/**
 * Primitive specimens review on the app's own canvas color so the board stage
 * and the compiled document paint one seamless surface; screens paint their own.
 */
function specimenCanvasCss(bundle: CanvasProjectBundle, boundary: SourceBoundary): string {
  if (boundary.kind !== 'primitive' && boundary.kind !== 'component') {
    return '';
  }
  const canvas = bundle.tokens.tokenGroups
    .find(group => group.id === 'color')
    ?.tokens.find(token => token.id === 'background');
  if (!canvas) return '';
  const styleRefs = new Set(bundle.tokens.tokenGroups.flatMap(group => group.tokens.map(token => token.styleRef)));
  // Specimens render outside any screen, so they take the text color and face a screen body would give them.
  const inherited = [
    styleRefs.has('--app-color-foreground') ? 'color:var(--app-color-foreground);' : '',
    styleRefs.has('--app-font-sans') ? 'font-family:var(--app-font-sans);' : ''
  ].join('');
  // Padding keeps overflowing decorations (slider thumbs, focus halos, glows)
  // from clipping against the measured cell edge.
  return `html,body{background:var(${canvas.styleRef});}body{box-sizing:border-box;padding:12px;${inherited}}`;
}

function safeStyleText(css: string): string {
  if (css.includes('</') && css.toLowerCase().includes('</style')) {
    throw new Error('Prototype stylesheet contains an unsafe closing style tag. Fix: remove "</style" from the stylesheet.');
  }
  return css;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


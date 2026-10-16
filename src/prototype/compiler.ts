import type {
  BlueprintProjectBundle,
  FramePreset,
  PrototypeUseDeclaration,
  ReusableDefinition,
  ReusableKind,
  ReviewCondition,
  ScreenDefinition
} from '../core/types';
import { brandMarkSourceIssues } from '../core/brand-lint';
import { axisIds } from '../core/reusable-contract';

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

/** One deterministic source-graph error found before mounting or capture. */
export interface PrototypeSourceGraphIssue {
  /** Canonical boundary and state that could not compile. */
  boundaryId: string;
  /** Declared state or review-condition state inspected. */
  state: string;
  /** Actionable compiler diagnostic. */
  message: string;
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
  bundle: BlueprintProjectBundle;
  allowedAssetRefs: Set<string>;
  observedUses: ObservedPrototypeUse[];
  brandMarks: PlacedBrandMark[];
  styleRefs: string[];
  styleRefSet: Set<string>;
}

interface UseElement {
  start: number;
  end: number;
  attributes: string;
  children: string;
}

interface ForwardedInvocationAttributes {
  className?: string;
  variant?: string;
  size?: string;
  href?: string;
  section?: string;
}

const SLOT_AUTHOR_ATTRIBUTE = 'data-blueprint-slot-author';
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

export const PROTOTYPE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "img-src data:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'"
].join('; ');

/**
 * Compiles a governed app-owned source graph into a complete no-script document.
 *
 * @throws {Error} When a source, state, reusable use, slot, asset, or host policy is invalid.
 */
export function compilePrototypeDocument(options: CompilePrototypeDocumentOptions): CompiledPrototypeDocument {
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
    allowedAssetRefs,
    observedUses: [],
    brandMarks: [],
    styleRefs: [],
    styleRefSet: new Set()
  };
  const fragment = compileBoundaryFragment(context, boundary, state, '', [], resolveTopLevelAxes(boundary, options.variant, options.size));
  const appCss = context.styleRefs.map(styleRef => loadAndRewriteStyle(context, styleRef)).join('\n\n');
  const tokenCss = createTokenCss(options.bundle);
  const targetBoundaryId = boundaryId(options.bundle, boundary);
  const title = `${options.bundle.manifest.project.name} · ${boundary.name}`;
  const html = [
    '<!doctype html>',
    `<html lang="en" data-blueprint-state="${escapeAttribute(state)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(PROTOTYPE_CONTENT_SECURITY_POLICY)}">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style data-blueprint-app-styles>${safeStyleText(baseDocumentCss())}\n${safeStyleText(safeAreaCss(options.framePreset))}\n${safeStyleText(specimenCanvasCss(options.bundle, boundary))}\n${safeStyleText(appCss)}</style>`,
    `<style data-blueprint-token-overrides>${safeStyleText(tokenCss)}</style>`,
    '</head>',
    `<body>${fragment}</body>`,
    '</html>'
  ].join('');

  return {
    html,
    targetBoundaryId,
    state,
    observedUses: context.observedUses,
    brandMarks: context.brandMarks
  };
}

/**
 * Compiles every declared canonical boundary/state without a browser so validation,
 * readiness, the canvas, and MCP share one governed-source contract.
 */
export function inspectPrototypeSourceGraph(bundle: BlueprintProjectBundle): PrototypeSourceGraphIssue[] {
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

  const issues: PrototypeSourceGraphIssue[] = [];
  for (const candidate of targets) {
    try {
      compilePrototypeDocument({ bundle, target: candidate.target, state: candidate.state });
    } catch (error) {
      const localBoundaryId = `${bundle.manifest.project.id}/${candidate.target.kind}/${candidate.target.id}`;
      issues.push({
        boundaryId: localBoundaryId,
        state: candidate.state,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return issues;
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
    throw new Error(`Screen "${screen.id}" has no browser-native prototype review conditions.`);
  }
  const conditions = screen.prototype.reviewConditions;
  const requestedById = request.viewport
    ? conditions.find(condition => condition.id === request.viewport)
    : undefined;
  let selected: ReviewCondition | undefined;

  if (requestedById) {
    if (request.state && requestedById.state !== request.state) {
      throw new Error(
        `Screen "${screen.id}" review condition "${requestedById.id}" uses state "${requestedById.state}", not "${request.state}".`
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
    throw new Error(`Screen "${screen.id}" does not declare a review condition for ${selection || 'its default frame'}.`);
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
      throw new Error(`${boundary.kind} "${boundary.id}" cannot receive a ${variant ? 'variant' : 'size'}; only primitives and components have them.`);
    }
    return {};
  }
  assertDeclaredAxisValue(boundary, 'variant', variant);
  assertDeclaredAxisValue(boundary, 'size', size);
  return { ...(variant ? { variant } : {}), ...(size ? { size } : {}) };
}

function assertDeclaredAxisValue(boundary: SourceBoundary, axis: 'variant' | 'size', value: string | undefined): void {
  if (value === undefined || !boundary.reusable) return;
  const declared = axisIds(axis === 'variant' ? boundary.reusable.variants : boundary.reusable.sizes);
  if (!declared.includes(value)) {
    throw new Error(`${boundary.kind} "${boundary.id}" does not declare ${axis} "${value}"; it declares ${declared.map(id => `"${id}"`).join(', ')}.`);
  }
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
      throw new Error(`${boundary.kind} "${boundary.id}" does not support ${combination.axis} "${value}" in state "${state}": ${combination.reason}`);
    }
  }
  return { ...attributes, variant, size };
}

function compileBoundaryFragment(
  context: CompilerContext,
  boundary: SourceBoundary,
  state: string,
  invocationChildren: string,
  stack: string[],
  invocationAttributes: ForwardedInvocationAttributes
): string {
  const currentBoundaryId = boundaryId(context.bundle, boundary);
  if (stack.includes(currentBoundaryId)) {
    throw new Error(`Prototype composition cycle detected: ${[...stack, currentBoundaryId].join(' -> ')}.`);
  }

  addStyleRefs(context, boundary.prototype.styles);
  const source = requireSource(context.bundle, boundary.prototype.source, `${currentBoundaryId} prototype source`);
  assertNoExecutableMarkup(source, boundary.prototype.source);
  if (source.includes(SLOT_AUTHOR_ATTRIBUTE)) {
    throw new Error(`Prototype source "${boundary.prototype.source}" cannot contain the reserved "${SLOT_AUTHOR_ATTRIBUTE}" attribute.`);
  }
  let fragment = rewriteHtmlAssetRefs(context, source, boundary.prototype.source);
  fragment = rewriteNavigationAttributes(fragment, boundary.prototype.source);
  fragment = markSlotAuthor(fragment, `${boundary.kind}:${boundary.id}`);
  fragment = applySlots(fragment, invocationChildren, boundary, currentBoundaryId);
  fragment = selectFragmentState(fragment, state);
  fragment = applyInvocationAttributes(fragment, resolveReusableAxes(boundary, state, invocationAttributes), boundary);

  const nextStack = [...stack, currentBoundaryId];
  while (true) {
    const use = findFirstUseElement(fragment);
    if (!use) {
      break;
    }
    const useAttributes = parseUseAttributes(use.attributes, currentBoundaryId);
    const slotAuthor = useAttributes.get(SLOT_AUTHOR_ATTRIBUTE);
    useAttributes.delete(SLOT_AUTHOR_ATTRIBUTE);
    const kind = requiredParsedUseAttribute(useAttributes, 'kind', currentBoundaryId);
    if (kind === 'brand-mark') {
      const placedBy = slotAuthor ? `${context.bundle.manifest.project.id}/${slotAuthor.replace(':', '/')}` : currentBoundaryId;
      const rendered = renderBrandMark(context, useAttributes, use.children, placedBy);
      fragment = `${fragment.slice(0, use.start)}${rendered}${fragment.slice(use.end)}`;
      continue;
    }
    if (kind !== 'primitive' && kind !== 'component') {
      throw new Error(`${currentBoundaryId} uses unsupported reusable boundary kind "${kind}".`);
    }
    const id = requiredParsedUseAttribute(useAttributes, 'ref', currentBoundaryId);
    const owner = creditedBoundary(context.bundle, boundary, slotAuthor, { kind, id });
    const target = resolveBoundary(context.bundle, { kind, id });
    const targetState = resolveState(target, useAttributes.get('state'));
    const forwardedAttributes = resolveForwardedInvocationAttributes(useAttributes, target);
    const targetBoundaryId = boundaryId(context.bundle, target);
    const axes = resolveReusableAxes(target, targetState, forwardedAttributes);
    context.observedUses.push({
      sourceBoundaryId: boundaryId(context.bundle, owner),
      targetBoundaryId,
      kind,
      id,
      variant: axes.variant ?? 'default',
      size: axes.size ?? 'default',
      state: targetState
    });
    const rendered = compileBoundaryFragment(context, target, targetState, use.children, nextStack, forwardedAttributes);
    fragment = `${fragment.slice(0, use.start)}${rendered}${fragment.slice(use.end)}`;
  }

  assertRenderedUses(boundary, context.observedUses.filter(use => use.sourceBoundaryId === currentBoundaryId));
  if (boundary.kind === 'screen') {
    fragment = applySectionMetadata(context.bundle, boundary, fragment);
  }
  return applyBoundaryMetadata(fragment, boundary, currentBoundaryId, state);
}

/**
 * Tags every `<blueprint-use>` nested inside another use with the boundary whose
 * source wrote it, so slot content keeps its author after it moves into a container.
 */
function markSlotAuthor(markup: string, author: string, nested = false): string {
  let output = '';
  let rest = markup;
  for (let use = findFirstUseElement(rest); use; use = findFirstUseElement(rest)) {
    const children = /<blueprint-use\b/i.test(use.children) ? markSlotAuthor(use.children, author, true) : use.children;
    const attributes = nested ? ` ${SLOT_AUTHOR_ATTRIBUTE}="${escapeAttribute(author)}"${use.attributes}` : use.attributes;
    const marked = nested || children !== use.children
      ? `<blueprint-use${attributes}>${children}</blueprint-use>`
      : rest.slice(use.start, use.end);
    output += `${rest.slice(0, use.start)}${marked}`;
    rest = rest.slice(use.end);
  }
  return `${output}${rest}`;
}

/**
 * A container that declares a slotted reusable always renders it, so it keeps the
 * credit; otherwise the reusable belongs to the boundary that wrote the slot content.
 */
function creditedBoundary(
  bundle: BlueprintProjectBundle,
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
      `Declare it on ${author.kind} "${author.id}", or on ${container.kind} "${container.id}" if every instance contains it.`
    );
  }
  return author;
}

/**
 * Lists the section IDs a screen source marks with `data-blueprint-section`,
 * including markers forwarded through `<blueprint-use>`.
 */
export function findSectionMarkers(source: string): string[] {
  return [...source.matchAll(sectionMarkerPattern())].map(match => match[4]);
}

function sectionMarkerPattern(): RegExp {
  return /<([a-zA-Z][\w:-]*)(\s[^>]*?\bdata-blueprint-section\s*=\s*(['"])(.*?)\3[^>]*)>/g;
}

function applySectionMetadata(bundle: BlueprintProjectBundle, boundary: SourceBoundary, fragment: string): string {
  const sectionIds = new Set(bundle.screens.screens.find(screen => screen.id === boundary.id)?.sections.map(section => section.id) ?? []);
  const marked = new Set<string>();
  return fragment.replace(sectionMarkerPattern(), (_tag, tagName: string, attributes: string, _quote: string, sectionId: string) => {
    if (!sectionIds.has(sectionId)) {
      throw new Error(`screen "${boundary.id}" marks undeclared section "${sectionId}".`);
    }
    if (marked.has(sectionId)) {
      throw new Error(`screen "${boundary.id}" marks section "${sectionId}" more than once.`);
    }
    marked.add(sectionId);
    const sectionBoundaryId = `${bundle.manifest.project.id}/section/${boundary.id}/${sectionId}`;
    return `<${tagName}${setRootAttribute(attributes, 'data-blueprint-section-boundary-id', sectionBoundaryId)}>`;
  });
}

function resolveBoundary(bundle: BlueprintProjectBundle, target: PrototypeCompileTarget): SourceBoundary {
  if (target.kind === 'primitive') {
    const primitive = bundle.primitives.primitives.find(candidate => candidate.id === target.id);
    if (!primitive) {
      throw new Error(`Unknown prototype primitive "${target.id}".`);
    }
    if (!primitive.prototype) {
      throw new Error(`Primitive "${target.id}" has no canonical prototype source.`);
    }
    return primitiveBoundary(primitive);
  }
  if (target.kind === 'component') {
    const component = bundle.components.components.find(candidate => candidate.id === target.id);
    if (!component) {
      throw new Error(`Unknown prototype component "${target.id}".`);
    }
    return componentBoundary(component);
  }
  const screen = bundle.screens.screens.find(candidate => candidate.id === target.id);
  if (!screen) {
    throw new Error(`Unknown prototype screen "${target.id}".`);
  }
  if (!screen.prototype) {
    throw new Error(`Screen "${target.id}" has no browser-native prototype source.`);
  }
  return screenBoundary(screen);
}

function primitiveBoundary(primitive: ReusableDefinition): SourceBoundary {
  if (!primitive.prototype) {
    throw new Error(`Primitive "${primitive.id}" is missing its canonical prototype source.`);
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
    throw new Error(`Screen "${screen.id}" is missing its browser-native prototype source.`);
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

function resolveState(boundary: SourceBoundary, requestedState: string | undefined): string {
  const state = requestedState ?? boundary.defaultState;
  if (!state) {
    throw new Error(`${boundary.kind} "${boundary.id}" has no declared prototype state.`);
  }
  if (!boundary.states.includes(state)) {
    throw new Error(`${boundary.kind} "${boundary.id}" does not declare prototype state "${state}".`);
  }
  return state;
}

function assertIsolatedHostPolicy(bundle: BlueprintProjectBundle): void {
  const policy = bundle.manifest.prototypeHost;
  if (!policy || policy.network !== 'deny' || policy.scripts !== 'none') {
    throw new Error('Canonical prototype compilation requires prototypeHost.network="deny" and prototypeHost.scripts="none".');
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
  if (/@import\b/i.test(css)) {
    throw new Error(`Prototype stylesheet "${styleRef}" cannot import external or undeclared stylesheets.`);
  }
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_match, _quote: string, value: string) => {
    const dataUrl = resolveAssetDataUrl(context, styleRef, value.trim());
    return `url("${dataUrl}")`;
  });
}

function rewriteHtmlAssetRefs(context: CompilerContext, html: string, sourceRef: string): string {
  return html.replace(/(\b(?:src|poster)\s*=\s*)(['"])(.*?)\2/gi, (_match, prefix: string, quote: string, value: string) => {
    const dataUrl = resolveAssetDataUrl(context, sourceRef, value);
    return `${prefix}${quote}${dataUrl}${quote}`;
  });
}

function rewriteNavigationAttributes(html: string, sourceRef: string): string {
  return html.replace(/<(a|area)\b([^>]*)>/gi, (openingTag, _tagName: string, attributes: string) => {
    const hrefMatches = [...attributes.matchAll(/\bhref\s*=\s*(['"])(.*?)\1/gi)];
    if (!/\bhref\s*=/i.test(attributes)) {
      return openingTag;
    }
    if (hrefMatches.length !== 1) {
      throw new Error(`Prototype source "${sourceRef}" contains malformed or duplicate navigation href markup.`);
    }
    const href = hrefMatches[0];
    if (!isSafePrototypeHref(href[2])) {
      throw new Error(`Prototype source "${sourceRef}" contains unsafe href "${href[2]}".`);
    }
    return openingTag.replace(href[0], `data-blueprint-href="${escapeAttribute(href[2])}"`);
  });
}

function resolveAssetDataUrl(context: CompilerContext, sourceRef: string, value: string): string {
  const assetRef = resolveRelativeRef(sourceRef, value);
  if (!context.allowedAssetRefs.has(assetRef)) {
    throw new Error(`Prototype resource "${value}" from "${sourceRef}" is not a declared controlled asset.`);
  }
  const asset = context.bundle.prototypeAssetContents[assetRef];
  if (!asset) {
    throw new Error(`Declared prototype asset "${assetRef}" is missing from the loaded bundle.`);
  }
  return `data:${asset.mediaType};base64,${asset.base64}`;
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
    throw new Error(`Prototype resource URL "${value}" must be a controlled relative path without query or fragment parts.`);
  }
  const normalizedInput = trimmed.replace(/\\/g, '/');
  let decodedInput: string;
  try {
    decodedInput = decodeURIComponent(normalizedInput);
  } catch {
    throw new Error(`Prototype resource URL "${value}" contains invalid escaping.`);
  }
  const parts = sourceRef.split('/').slice(0, -1);
  for (const segment of decodedInput.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (parts.length === 0) {
        throw new Error(`Prototype resource URL "${value}" escapes the app-owned sidecar root.`);
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function createTokenCss(bundle: BlueprintProjectBundle): string {
  const declarations: string[] = [];
  const seen = new Set<string>();
  for (const group of bundle.tokens.tokenGroups) {
    for (const token of group.tokens) {
      if (!/^--[a-zA-Z0-9_-]+$/.test(token.styleRef)) {
        throw new Error(`Token "${group.id}.${token.id}" styleRef "${token.styleRef}" must be a CSS custom property.`);
      }
      if (seen.has(token.styleRef)) {
        throw new Error(`Token CSS custom property "${token.styleRef}" is declared more than once.`);
      }
      if (/[;{}]|<\/style/i.test(token.value)) {
        throw new Error(`Token "${group.id}.${token.id}" contains an unsafe CSS value.`);
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
        ? `${label} received content outside any named slot, but declares no "default" slot.`
        : `${label} received undeclared slot "${name}".`);
    }
    const refused = slotContentAccepts(content).filter(accept => !slot.accepts.includes(accept));
    if (refused.length > 0) {
      throw new Error(
        `${label} slot "${name}" received ${refused.join(', ')}, which it does not accept; it accepts ${slot.accepts.join(', ')}.`
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
  const hadDefaultPlaceholder = /<slot(?:\s[^>]*)?>/i.test(result);
  result = replaceDefaultSlotElements(result, defaultContent);
  if (defaultContent && !hadDefaultPlaceholder) {
    throw new Error(`${label} received default slot content but declares no default slot placeholder.`);
  }
  return result;
}

/** One `<blueprint-use>` found in markup, with the content it passes to each slot. */
export interface UsePlacement {
  kind: string;
  ref: string;
  attributes: Map<string, string>;
  slots: Map<string, string>;
}

/** Every `<blueprint-use>` in the markup, outer placements before the ones nested in their slots. */
export function listUsePlacements(markup: string): UsePlacement[] {
  const placements: UsePlacement[] = [];
  let rest = markup;
  for (let use = findFirstUseElement(rest); use; use = findFirstUseElement(rest)) {
    const attributes = parseUseAttributes(use.attributes, 'markup');
    placements.push({
      kind: attributes.get('kind') ?? '',
      ref: attributes.get('ref') ?? '',
      attributes,
      slots: collectInvocationSlots(use.children)
    });
    placements.push(...listUsePlacements(use.children));
    rest = rest.slice(use.end);
  }
  return placements;
}

/** The default content each slot of a reusable source holds, keyed by slot id; a bare `<slot>` is `default`. */
export function sourceSlotContents(source: string): Map<string, string> {
  const contents = new Map<string, string>();
  const dataSlot = /<([a-zA-Z][\w:-]*)\b[^>]*\bdata-blueprint-slot\s*=\s*(['"])([^'"]+)\2[^>]*>/gi;
  for (let open = dataSlot.exec(source); open; open = dataSlot.exec(source)) {
    const openEnd = open.index + open[0].length - 1;
    const end = findElementEnd(source, open[1], open.index, openEnd);
    const inner = end === openEnd + 1 ? '' : source.slice(openEnd + 1, source.lastIndexOf('<', end - 1));
    contents.set(open[3], `${contents.get(open[3]) ?? ''}${inner}`);
  }
  for (const match of source.matchAll(/<slot\b([^>]*)>([\s\S]*?)<\/slot\s*>|<slot\b([^>]*?)\s*\/>/gi)) {
    const attributes = match[1] ?? match[3] ?? '';
    const id = /\bname\s*=\s*(['"])([^'"]+)\1/i.exec(attributes)?.[2] ?? 'default';
    contents.set(id, `${contents.get(id) ?? ''}${match[2] ?? ''}`);
  }
  return contents;
}

/** What slot content is: `text`, `graphic`, `brand-mark`, or the `primitive:<id>` and `component:<id>` it places. */
export function slotContentAccepts(content: string): string[] {
  const accepts = new Set<string>();
  let rest = '';
  let remaining = content;
  for (let use = findFirstUseElement(remaining); use; use = findFirstUseElement(remaining)) {
    const attributes = parseUseAttributes(use.attributes, 'slot content');
    const kind = attributes.get('kind');
    accepts.add(kind === 'brand-mark' ? 'brand-mark' : `${kind}:${attributes.get('ref')}`);
    rest += remaining.slice(0, use.start);
    remaining = remaining.slice(use.end);
  }
  rest += remaining;
  const withoutGraphics = rest
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, () => {
      accepts.add('graphic');
      return '';
    })
    .replace(/<(?:img|picture)\b[^>]*>/gi, () => {
      accepts.add('graphic');
      return '';
    });
  if (withoutGraphics.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()) {
    accepts.add('text');
  }
  return [...accepts].sort();
}

/** Slot attributes inside a nested `<blueprint-use>` belong to that use, so the scan skips over it. */
function collectInvocationSlots(children: string): Map<string, string> {
  const slots = new Map<string, string>();
  const openPattern = /<([a-zA-Z][\w:-]*)/g;
  let remaining = '';
  let cursor = 0;
  for (let open = openPattern.exec(children); open; open = openPattern.exec(children)) {
    const tagName = open[1];
    if (tagName.toLowerCase() === 'blueprint-use') {
      openPattern.lastIndex = open.index + (findFirstUseElement(children.slice(open.index))?.end ?? 1);
      continue;
    }
    const openEnd = findTagEnd(children, open.index);
    const name = /\sslot\s*=\s*(['"])([^'"]+)\1/i.exec(children.slice(open.index, openEnd + 1))?.[2];
    if (!name) {
      openPattern.lastIndex = openEnd + 1;
      continue;
    }
    const end = findElementEnd(children, tagName, open.index, openEnd);
    appendSlot(slots, name, stripSlotAttribute(children.slice(open.index, end)));
    remaining += children.slice(cursor, open.index);
    cursor = end;
    openPattern.lastIndex = end;
  }
  remaining += children.slice(cursor);
  if (remaining.trim()) {
    appendSlot(slots, 'default', remaining.trim());
  }
  return slots;
}

function findElementEnd(html: string, tagName: string, openStart: number, openEnd: number): number {
  if (VOID_ELEMENTS.has(tagName.toLowerCase()) || /\/\s*>$/.test(html.slice(openStart, openEnd + 1))) {
    return openEnd + 1;
  }
  const tagPattern = new RegExp(`<(/?)${escapeRegExp(tagName)}(?=[\\s/>])`, 'gi');
  tagPattern.lastIndex = openEnd + 1;
  let depth = 1;
  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    const tagEnd = findTagEnd(html, match.index);
    if (match[1]) {
      depth -= 1;
      if (depth === 0) {
        return tagEnd + 1;
      }
    } else if (!/\/\s*>$/.test(html.slice(match.index, tagEnd + 1))) {
      depth += 1;
    }
    tagPattern.lastIndex = tagEnd + 1;
  }
  return openEnd + 1;
}

function appendSlot(slots: Map<string, string>, name: string, content: string): void {
  const previous = slots.get(name);
  slots.set(name, previous ? `${previous}${content}` : content);
}

function stripSlotAttribute(markup: string): string {
  return markup.replace(/\s+slot\s*=\s*(['"])[^'"]+\1/i, '');
}

function replaceNamedSlotElements(template: string, name: string, content: string | undefined): string {
  const escapedName = escapeRegExp(name);
  const paired = new RegExp(`<slot\\b([^>]*\\bname\\s*=\\s*(['"])${escapedName}\\2[^>]*)>([\\s\\S]*?)<\\/slot\\s*>`, 'gi');
  const selfClosing = new RegExp(`<slot\\b([^>]*\\bname\\s*=\\s*(['"])${escapedName}\\2[^>]*)\\s*\\/>`, 'gi');
  return template
    .replace(paired, (_full, _attributes: string, _quote: string, fallback: string) => content ?? fallback)
    .replace(selfClosing, content ?? '');
}

function replaceDataSlotContents(template: string, name: string, content: string | undefined): string {
  if (content === undefined) {
    return template;
  }
  const escapedName = escapeRegExp(name);
  const openPattern = new RegExp(`<([a-zA-Z][\\w:-]*)\\b[^>]*\\bdata-blueprint-slot\\s*=\\s*(['"])${escapedName}\\2[^>]*>`, 'gi');
  let result = '';
  let cursor = 0;
  for (let open = openPattern.exec(template); open; open = openPattern.exec(template)) {
    const openEnd = open.index + open[0].length - 1;
    const end = findElementEnd(template, open[1], open.index, openEnd);
    if (end === openEnd + 1) {
      result += `${template.slice(cursor, open.index)}${/\/\s*>$/.test(open[0]) ? content : open[0]}`;
    } else {
      const close = template.slice(template.lastIndexOf('<', end - 1), end);
      result += `${template.slice(cursor, openEnd + 1)}${content}${close}`;
    }
    cursor = end;
    openPattern.lastIndex = end;
  }
  return `${result}${template.slice(cursor)}`;
}

function replaceDefaultSlotElements(template: string, content: string | undefined): string {
  const paired = /<slot(?![^>]*\bname\s*=)[^>]*>([\s\S]*?)<\/slot\s*>/gi;
  const selfClosing = /<slot(?![^>]*\bname\s*=)[^>]*\s*\/>/gi;
  return template
    .replace(paired, (_full, fallback: string) => content ?? fallback)
    .replace(selfClosing, content ?? '');
}

function findFirstUseElement(html: string): UseElement | undefined {
  const openPattern = /<blueprint-use\b/ig;
  const open = openPattern.exec(html);
  if (!open) {
    return undefined;
  }
  const openEnd = findTagEnd(html, open.index);
  const openTag = html.slice(open.index, openEnd + 1);
  const attributes = openTag.slice('<blueprint-use'.length, openTag.endsWith('/>') ? -2 : -1);
  if (/\/\s*>$/.test(openTag)) {
    return { start: open.index, end: openEnd + 1, attributes, children: '' };
  }

  const tagPattern = /<\/?blueprint-use\b/ig;
  tagPattern.lastIndex = openEnd + 1;
  let depth = 1;
  while (true) {
    const match = tagPattern.exec(html);
    if (!match) {
      throw new Error('Prototype source contains an unclosed <blueprint-use> element.');
    }
    const tagEnd = findTagEnd(html, match.index);
    const tag = html.slice(match.index, tagEnd + 1);
    if (tag.startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        return {
          start: open.index,
          end: tagEnd + 1,
          attributes,
          children: html.slice(openEnd + 1, match.index)
        };
      }
    } else if (!/\/\s*>$/.test(tag)) {
      depth += 1;
    }
    tagPattern.lastIndex = tagEnd + 1;
  }
}

function findTagEnd(html: string, start: number): number {
  let quote: string | undefined;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  throw new Error('Prototype source contains an unclosed HTML tag.');
}

function requiredParsedUseAttribute(attributes: Map<string, string>, name: string, boundary: string): string {
  const value = attributes.get(name);
  if (!value) {
    throw new Error(`${boundary} contains <blueprint-use> without required "${name}".`);
  }
  return value;
}

function parseUseAttributes(attributes: string, boundary: string): Map<string, string> {
  const parsed = new Map<string, string>();
  const attributePattern = /([^\s=/>]+)\s*=\s*(['"])(.*?)\2/g;
  let cursor = 0;
  while (true) {
    const match = attributePattern.exec(attributes);
    if (!match) {
      break;
    }
    if (attributes.slice(cursor, match.index).trim()) {
      throw new Error(`${boundary} contains a malformed or unquoted <blueprint-use> attribute.`);
    }
    const name = match[1].toLowerCase();
    if (parsed.has(name)) {
      throw new Error(`${boundary} contains duplicate <blueprint-use> attribute "${name}".`);
    }
    parsed.set(name, match[3]);
    cursor = match.index + match[0].length;
  }
  if (attributes.slice(cursor).trim()) {
    throw new Error(`${boundary} contains a malformed or unquoted <blueprint-use> attribute.`);
  }
  return parsed;
}

function resolveForwardedInvocationAttributes(
  attributes: Map<string, string>,
  target: SourceBoundary
): ForwardedInvocationAttributes {
  const allowed = new Set(['kind', 'ref', 'state', 'class', 'variant', 'size', 'href', 'data-blueprint-section']);
  for (const name of attributes.keys()) {
    if (!allowed.has(name) || name.startsWith('on') || name === 'style') {
      throw new Error(`${target.kind} "${target.id}" received unsupported <blueprint-use> attribute "${name}".`);
    }
  }
  const className = attributes.get('class');
  if (className && !/^[a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)*$/.test(className)) {
    throw new Error(`${target.kind} "${target.id}" received an unsafe class invocation attribute.`);
  }
  const variant = attributes.get('variant');
  assertDeclaredAxisValue(target, 'variant', variant);
  const size = attributes.get('size');
  assertDeclaredAxisValue(target, 'size', size);
  const href = attributes.get('href');
  if (href && !isSafePrototypeHref(href)) {
    throw new Error(`${target.kind} "${target.id}" received unsafe href "${href}".`);
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
    throw new Error(`${placedBy} places brand mark "${id}", which brand.json does not declare.`);
  }
  for (const name of attributes.keys()) {
    if (!BRAND_MARK_USE_ATTRIBUTES.has(name)) {
      throw new Error(`Brand mark "${id}" received unsupported <blueprint-use> attribute "${name}".`);
    }
  }
  if (children.trim()) {
    throw new Error(`Brand mark "${id}" cannot receive slot content; it always draws its brand.json source.`);
  }
  const className = attributes.get('class');
  if (className && !/^[a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)*$/.test(className)) {
    throw new Error(`Brand mark "${id}" received an unsafe class invocation attribute.`);
  }
  const hidden = attributes.get('aria-hidden');
  if (hidden !== undefined && hidden !== 'true') {
    throw new Error(`Brand mark "${id}" accepts only aria-hidden="true".`);
  }
  const variantId = attributes.get('variant');
  const variant = variantId === undefined ? undefined : mark.variants.find(candidate => candidate.id === variantId);
  if (variantId !== undefined && !variant) {
    throw new Error(`Brand mark "${id}" does not declare variant "${variantId}".`);
  }

  const source = requireSource(context.bundle, mark.source, `Brand mark "${id}" source`);
  const issue = brandMarkSourceIssues(source)[0];
  if (issue) {
    throw new Error(`Brand mark "${id}" source "${mark.source}" ${issue}`);
  }
  const svg = scopeSvgIds(/<svg\b[\s\S]*<\/svg\s*>/i.exec(source)?.[0] ?? '', `bp-brand-${id}-`);
  if (!svg) {
    throw new Error(`Brand mark "${id}" source "${mark.source}" has no <svg> element.`);
  }
  context.brandMarks.push({ sourceBoundaryId: placedBy, id, ...(variantId ? { variant: variantId } : {}) });

  const rootEnd = findTagEnd(svg, 0);
  let rootAttributes = svg.slice('<svg'.length, rootEnd).replace(/\s(?:width|height)\s*=\s*(['"]).*?\1/gi, '');
  const existingClass = /\sclass\s*=\s*(['"])(.*?)\1/i.exec(rootAttributes)?.[2] ?? '';
  const classes = [...new Set(`${existingClass} ${className ?? ''}`.trim().split(/\s+/).filter(Boolean))].join(' ');
  if (classes) {
    rootAttributes = setRootAttribute(rootAttributes, 'class', classes);
  }
  rootAttributes = setRootAttribute(rootAttributes, 'height', '1em');
  rootAttributes = setRootAttribute(rootAttributes, 'data-blueprint-brand-mark', id);
  if (variant) {
    rootAttributes = setRootAttribute(rootAttributes, 'data-blueprint-brand-variant', variant.id);
    const accent = variant.accent ? `var(${colorTokenStyleRef(context.bundle, variant.accent, id)})` : 'currentColor';
    const existingStyle = /\sstyle\s*=\s*(['"])(.*?)\1/i.exec(rootAttributes)?.[2];
    const declarations = `color:var(${colorTokenStyleRef(context.bundle, variant.foreground, id)});--brand-accent:${accent}`;
    rootAttributes = setRootAttribute(rootAttributes, 'style', existingStyle ? `${existingStyle.replace(/;?\s*$/, ';')}${declarations}` : declarations);
  }
  if (hidden) {
    rootAttributes = setRootAttribute(rootAttributes, 'aria-hidden', 'true');
  } else {
    rootAttributes = setRootAttribute(rootAttributes, 'role', 'img');
    rootAttributes = setRootAttribute(rootAttributes, 'aria-label', attributes.get('aria-label') ?? brand.name);
  }
  return `<svg${rootAttributes}>${svg.slice(rootEnd + 1)}`;
}

function colorTokenStyleRef(bundle: BlueprintProjectBundle, ref: string, markId: string): string {
  const separator = ref.indexOf('.');
  const token = bundle.tokens.tokenGroups
    .find(group => group.id === ref.slice(0, separator))
    ?.tokens.find(candidate => candidate.id === ref.slice(separator + 1));
  if (!token) {
    throw new Error(`Brand mark "${markId}" variant references undeclared color token "${ref}".`);
  }
  return token.styleRef;
}

/** Prefixes a mark's internal IDs so two inlined marks never resolve each other's clip paths or gradients. */
function scopeSvgIds(svg: string, prefix: string): string {
  const ids = new Set([...svg.matchAll(/\sid\s*=\s*(['"])(.*?)\1/gi)].map(match => match[2]));
  if (ids.size === 0) {
    return svg;
  }
  const scoped = (id: string): string => (ids.has(id) ? `${prefix}${id}` : id);
  return svg
    .replace(/(\sid\s*=\s*)(['"])(.*?)\2/gi, (_match, lead: string, quote: string, id: string) => `${lead}${quote}${scoped(id)}${quote}`)
    .replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/gi, (_match, quote: string, id: string) => `url(${quote}#${scoped(id)}${quote})`)
    .replace(/(\s(?:xlink:)?href\s*=\s*)(['"])#(.*?)\2/gi, (_match, lead: string, quote: string, id: string) => `${lead}${quote}#${scoped(id)}${quote}`);
}

function applyInvocationAttributes(
  fragment: string,
  attributes: ForwardedInvocationAttributes,
  boundary: SourceBoundary
): string {
  if (!attributes.className && !attributes.variant && !attributes.size && !attributes.href && !attributes.section) {
    return fragment;
  }
  const rootPattern = /<([a-zA-Z][\w:-]*)([^>]*)>/;
  const match = rootPattern.exec(fragment);
  if (!match) {
    throw new Error(`${boundary.kind} "${boundary.id}" prototype source has no root element for invocation attributes.`);
  }
  const tagName = match[1];
  let rootAttributes = match[2];
  if (attributes.className) {
    const existingClass = /\bclass\s*=\s*(['"])(.*?)\1/i.exec(rootAttributes);
    if (existingClass) {
      const merged = [...new Set(`${existingClass[2]} ${attributes.className}`.trim().split(/\s+/))].join(' ');
      rootAttributes = rootAttributes.replace(existingClass[0], `class="${escapeAttribute(merged)}"`);
    } else {
      rootAttributes += ` class="${escapeAttribute(attributes.className)}"`;
    }
  }
  if (attributes.variant) {
    rootAttributes = setRootAttribute(rootAttributes, 'data-blueprint-variant', attributes.variant);
  }
  if (attributes.size) {
    rootAttributes = setRootAttribute(rootAttributes, 'data-blueprint-size', attributes.size);
  }
  if (attributes.href) {
    if (tagName.toLowerCase() !== 'a') {
      throw new Error(`${boundary.kind} "${boundary.id}" cannot receive href because its root element is <${tagName}>.`);
    }
    rootAttributes = setRootAttribute(rootAttributes, 'data-blueprint-href', attributes.href);
  }
  if (attributes.section) {
    rootAttributes = setRootAttribute(rootAttributes, 'data-blueprint-section', attributes.section);
  }
  const openingTag = `<${tagName}${rootAttributes}>`;
  return `${fragment.slice(0, match.index)}${openingTag}${fragment.slice(match.index + match[0].length)}`;
}

function setRootAttribute(attributes: string, name: string, value: string): string {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(['"])(.*?)\\1`, 'i');
  const serialized = `${name}="${escapeAttribute(value)}"`;
  return pattern.test(attributes) ? attributes.replace(pattern, serialized) : `${attributes} ${serialized}`;
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

function assertDeclaredUse(boundary: SourceBoundary, use: PrototypeUseDeclaration): void {
  if (!declaresUse(boundary, use)) {
    throw new Error(`${boundary.kind} "${boundary.id}" renders undeclared ${use.kind} "${use.id}".`);
  }
}

function assertRenderedUses(boundary: SourceBoundary, observed: ObservedPrototypeUse[]): void {
  const observedKeys = [...new Set(observed.map(use => `${use.kind}:${use.id}`))].sort();
  const declaredKeys = [...new Set(boundary.renderedUses.map(use => `${use.kind}:${use.id}`))].sort();
  if (observedKeys.join('\n') !== declaredKeys.join('\n')) {
    throw new Error(
      `${boundary.kind} "${boundary.id}" rendered uses do not match its declared reusable dependencies.`
    );
  }
}

function applyBoundaryMetadata(
  fragment: string,
  boundary: SourceBoundary,
  currentBoundaryId: string,
  state: string
): string {
  const rootPattern = /<([a-zA-Z][\w:-]*)([^>]*)>/;
  const root = rootPattern.exec(fragment);
  if (!root) {
    throw new Error(`${boundary.kind} "${boundary.id}" prototype source has no root element for boundary metadata.`);
  }
  let attributes = root[2];
  attributes = setRootAttribute(attributes, 'data-blueprint-boundary-id', currentBoundaryId);
  attributes = setRootAttribute(attributes, 'data-blueprint-boundary-kind', boundary.kind);
  attributes = setRootAttribute(attributes, 'data-blueprint-boundary-local-id', boundary.id);
  attributes = setRootAttribute(attributes, 'data-blueprint-boundary-state', state);
  const openingTag = `<${root[1]}${attributes}>`;
  return `${fragment.slice(0, root.index)}${openingTag}${fragment.slice(root.index + root[0].length)}`;
}

function selectFragmentState(fragment: string, state: string): string {
  const rootPattern = /<(?!blueprint-use\b)([a-zA-Z][\w:-]*)([^>]*)>/i;
  const root = rootPattern.exec(fragment);
  if (!root) {
    return fragment;
  }
  const statePattern = /\bdata-blueprint-state\s*=\s*(['"])[^'"]*\1/i;
  const attributes = statePattern.test(root[2])
    ? root[2].replace(statePattern, `data-blueprint-state="${escapeAttribute(state)}"`)
    : `${root[2]} data-blueprint-state="${escapeAttribute(state)}"`;
  const openingTag = `<${root[1]}${attributes}>`;
  return `${fragment.slice(0, root.index)}${openingTag}${fragment.slice(root.index + root[0].length)}`;
}

function assertNoExecutableMarkup(source: string, sourceRef: string): void {
  if (
    /<\s*script\b/i.test(source) ||
    /\son[a-z]+\s*=/i.test(source) ||
    /<\s*(?:iframe|object|embed)\b/i.test(source) ||
    /<\s*(?:meta|base|link)\b/i.test(source) ||
    /\s(?:action|formaction)\s*=/i.test(source)
  ) {
    throw new Error(`Prototype source "${sourceRef}" contains executable, navigation, form, or nested browsing content.`);
  }
  // Media elements compile fine but the CSP (default-src 'none', no media-src) blocks
  // playback at runtime; reject them here so authors get a clear compile error instead
  // of a silently dead element. <picture> stays allowed: it renders static imagery.
  if (/<\s*(?:video|audio)\b/i.test(source)) {
    throw new Error(
      `Prototype source "${sourceRef}" contains media content (<video>/<audio>) that the isolated prototype host cannot play; use static imagery or SMIL-animated SVG assets instead.`
    );
  }
}

function requireSource(bundle: BlueprintProjectBundle, sourceRef: string, label: string): string {
  const source = bundle.prototypeSourceContents[sourceRef];
  if (source === undefined) {
    throw new Error(`${label} "${sourceRef}" is missing from the loaded bundle.`);
  }
  return source;
}

function boundaryId(bundle: BlueprintProjectBundle, boundary: Pick<SourceBoundary, 'kind' | 'id'>): string {
  return `${bundle.manifest.project.id}/${boundary.kind}/${boundary.id}`;
}

function safeAreaCss(preset: FramePreset | undefined): string {
  const insets = { top: 0, right: 0, bottom: 0, left: 0, ...preset?.safeArea };
  const declarations = (['top', 'right', 'bottom', 'left'] as const).map(side => {
    const inset = insets[side];
    if (!Number.isFinite(inset) || inset < 0) {
      throw new Error(`Frame preset "${preset?.id}" safe-area ${side} must be a non-negative number.`);
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
function specimenCanvasCss(bundle: BlueprintProjectBundle, boundary: SourceBoundary): string {
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
  if (/<\/style/i.test(css)) {
    throw new Error('Prototype stylesheet contains an unsafe closing style tag.');
  }
  return css;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

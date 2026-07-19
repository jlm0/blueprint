import type {
  BlueprintProjectBundle,
  BoundaryDependency,
  ComponentDefinition,
  PrimitiveDefinition,
  PrototypeSource,
  PrototypeUseDeclaration,
  ReviewCondition,
  ScreenDefinition
} from '../core/types';

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
  /** Declared primitive variant (primitive targets only), e.g. for variant × state review matrices. */
  variant?: string;
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
  /** Deterministic state selected for this instance. */
  state: string;
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
  prototype: PrototypeSource & { slots?: string[]; assetRefs?: string[] };
  uses: BoundaryDependency[];
}

interface CompilerContext {
  bundle: BlueprintProjectBundle;
  allowedAssetRefs: Set<string>;
  observedUses: ObservedPrototypeUse[];
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
  href?: string;
}

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
    styleRefs: [],
    styleRefSet: new Set()
  };
  const fragment = compileBoundaryFragment(context, boundary, state, '', [], resolveTopLevelVariant(boundary, options.variant));
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
    `<style data-blueprint-app-styles>${safeStyleText(baseDocumentCss())}\n${safeStyleText(specimenCanvasCss(options.bundle, boundary))}\n${safeStyleText(appCss)}</style>`,
    `<style data-blueprint-token-overrides>${safeStyleText(tokenCss)}</style>`,
    '</head>',
    `<body>${fragment}</body>`,
    '</html>'
  ].join('');

  return {
    html,
    targetBoundaryId,
    state,
    observedUses: context.observedUses
  };
}

/**
 * Compiles every declared canonical boundary/state without a browser so validation,
 * readiness, the canvas, and the CLI share one governed-source contract.
 */
export function inspectPrototypeSourceGraph(bundle: BlueprintProjectBundle): PrototypeSourceGraphIssue[] {
  const targets: Array<{ target: PrototypeCompileTarget; state: string }> = [];
  for (const primitive of bundle.primitives.primitives) {
    if (primitive.prototype) {
      for (const state of primitive.prototype.states) {
        targets.push({ target: { kind: 'primitive', id: primitive.id }, state });
      }
    }
  }
  for (const component of bundle.components.components) {
    for (const state of component.prototype.states) {
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

function resolveTopLevelVariant(boundary: SourceBoundary, variant: string | undefined): ForwardedInvocationAttributes {
  if (!variant) {
    return {};
  }
  if (boundary.kind !== 'primitive') {
    throw new Error(`${boundary.kind} "${boundary.id}" cannot receive a primitive variant.`);
  }
  const primitive = boundary.prototype as PrimitiveDefinition['prototype'];
  if (!primitive?.variants.includes(variant)) {
    throw new Error(`Primitive "${boundary.id}" does not declare variant "${variant}".`);
  }
  return { variant };
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
  let fragment = rewriteHtmlAssetRefs(context, source, boundary.prototype.source);
  fragment = rewriteNavigationAttributes(fragment, boundary.prototype.source);
  fragment = applySlots(fragment, invocationChildren, boundary.prototype.slots ?? [], currentBoundaryId);
  fragment = selectFragmentState(fragment, state);
  fragment = applyInvocationAttributes(fragment, invocationAttributes, boundary);

  const nextStack = [...stack, currentBoundaryId];
  while (true) {
    const use = findFirstUseElement(fragment);
    if (!use) {
      break;
    }
    const useAttributes = parseUseAttributes(use.attributes, currentBoundaryId);
    const kind = requiredParsedUseAttribute(useAttributes, 'kind', currentBoundaryId);
    if (kind !== 'primitive' && kind !== 'component') {
      throw new Error(`${currentBoundaryId} uses unsupported reusable boundary kind "${kind}".`);
    }
    const id = requiredParsedUseAttribute(useAttributes, 'ref', currentBoundaryId);
    assertDeclaredUse(boundary, { kind, id });
    const target = resolveBoundary(context.bundle, { kind, id });
    const targetState = resolveState(target, useAttributes.get('state'));
    const forwardedAttributes = resolveForwardedInvocationAttributes(useAttributes, target);
    const targetBoundaryId = boundaryId(context.bundle, target);
    context.observedUses.push({
      sourceBoundaryId: currentBoundaryId,
      targetBoundaryId,
      kind,
      id,
      state: targetState
    });
    const rendered = compileBoundaryFragment(context, target, targetState, use.children, nextStack, forwardedAttributes);
    fragment = `${fragment.slice(0, use.start)}${rendered}${fragment.slice(use.end)}`;
  }

  assertRenderedUses(boundary, context.observedUses.filter(use => use.sourceBoundaryId === currentBoundaryId));
  return applyBoundaryMetadata(fragment, boundary, currentBoundaryId, state);
}

function resolveBoundary(bundle: BlueprintProjectBundle, target: PrototypeCompileTarget): SourceBoundary {
  if (target.kind === 'primitive') {
    const primitive = bundle.primitives.primitives.find(candidate => candidate.id === target.id);
    if (!primitive) {
      throw new Error(`Unknown prototype primitive "${target.id}".`);
    }
    if (!primitive.prototype) {
      throw new Error(`Primitive "${target.id}" has no canonical prototype source; use the legacy fallback renderer.`);
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
    throw new Error(`Screen "${target.id}" has no browser-native prototype source; use the legacy canvas renderer.`);
  }
  return screenBoundary(screen);
}

function primitiveBoundary(primitive: PrimitiveDefinition): SourceBoundary {
  if (!primitive.prototype) {
    throw new Error(`Primitive "${primitive.id}" is missing its canonical prototype source.`);
  }
  return {
    kind: 'primitive',
    id: primitive.id,
    name: primitive.name,
    prototype: primitive.prototype,
    uses: primitive.uses ?? []
  };
}

function componentBoundary(component: ComponentDefinition): SourceBoundary {
  return {
    kind: 'component',
    id: component.id,
    name: component.name,
    prototype: component.prototype,
    uses: component.uses
  };
}

function screenBoundary(screen: ScreenDefinition): SourceBoundary {
  if (!screen.prototype) {
    throw new Error(`Screen "${screen.id}" is missing its browser-native prototype source.`);
  }
  return {
    kind: 'screen',
    id: screen.id,
    name: screen.name,
    prototype: screen.prototype,
    uses: screen.sections.flatMap(section => section.uses)
  };
}

function resolveState(boundary: SourceBoundary, requestedState: string | undefined): string {
  const state = requestedState ?? boundary.prototype.states[0];
  if (!state) {
    throw new Error(`${boundary.kind} "${boundary.id}" has no declared prototype state.`);
  }
  if (!boundary.prototype.states.includes(state)) {
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
  if (/\@import\b/i.test(css)) {
    throw new Error(`Prototype stylesheet "${styleRef}" cannot import external or undeclared stylesheets.`);
  }
  return css.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (_match, _quote: string, value: string) => {
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

function applySlots(template: string, invocationChildren: string, declaredSlots: string[], boundary: string): string {
  const slotContent = collectInvocationSlots(invocationChildren);
  for (const name of slotContent.keys()) {
    if (name !== 'default' && !declaredSlots.includes(name)) {
      throw new Error(`${boundary} received undeclared slot "${name}".`);
    }
  }

  let result = template;
  for (const slotName of declaredSlots) {
    const content = slotContent.get(slotName);
    result = replaceNamedSlotElements(result, slotName, content);
    result = replaceDataSlotContents(result, slotName, content);
  }
  const defaultContent = slotContent.get('default');
  const hadDefaultPlaceholder = /<slot(?:\s[^>]*)?>/i.test(result);
  result = replaceDefaultSlotElements(result, defaultContent);
  if (defaultContent && !hadDefaultPlaceholder) {
    throw new Error(`${boundary} received default slot content but declares no default slot placeholder.`);
  }
  return result;
}

function collectInvocationSlots(children: string): Map<string, string> {
  const slots = new Map<string, string>();
  let remaining = children;
  const elementPattern = /<([a-zA-Z][\w:-]*)([^>]*\bslot\s*=\s*(['"])([^'"]+)\3[^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  remaining = remaining.replace(elementPattern, (full, _tag: string, _attributes: string, _quote: string, name: string) => {
    appendSlot(slots, name, stripSlotAttribute(full));
    return '';
  });
  const selfClosingPattern = /<([a-zA-Z][\w:-]*)([^>]*\bslot\s*=\s*(['"])([^'"]+)\3[^>]*)\s*\/?>/gi;
  remaining = remaining.replace(selfClosingPattern, (full, _tag: string, attributes: string, _quote: string, name: string) => {
    appendSlot(slots, name, full.replace(/\s+slot\s*=\s*(['"])[^'"]+\1/i, ''));
    return '';
  });
  if (remaining.trim()) {
    appendSlot(slots, 'default', remaining.trim());
  }
  return slots;
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
  const paired = new RegExp(`(<([a-zA-Z][\\w:-]*)\\b[^>]*\\bdata-blueprint-slot\\s*=\\s*(['"])${escapedName}\\3[^>]*>)[\\s\\S]*?(<\\/\\2\\s*>)`, 'gi');
  const selfClosing = new RegExp(`<([a-zA-Z][\\w:-]*)\\b[^>]*\\bdata-blueprint-slot\\s*=\\s*(['"])${escapedName}\\2[^>]*\\/>`, 'gi');
  // Replacement functions (not strings) so `$`-sequences in app content (e.g. "$4.28M") stay literal.
  return template
    .replace(paired, (_match, open: string, _tag: string, _quote: string, close: string) => `${open}${content}${close}`)
    .replace(selfClosing, () => content);
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
  const allowed = new Set(['kind', 'ref', 'state', 'class', 'variant', 'href']);
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
  if (variant) {
    if (target.kind !== 'primitive') {
      throw new Error(`${target.kind} "${target.id}" cannot receive a primitive variant.`);
    }
    const primitive = target.prototype as PrimitiveDefinition['prototype'];
    if (!primitive?.variants.includes(variant)) {
      throw new Error(`Primitive "${target.id}" does not declare variant "${variant}".`);
    }
  }
  const href = attributes.get('href');
  if (href && !isSafePrototypeHref(href)) {
    throw new Error(`${target.kind} "${target.id}" received unsafe href "${href}".`);
  }
  return {
    ...(className ? { className } : {}),
    ...(variant ? { variant } : {}),
    ...(href ? { href } : {})
  };
}

function applyInvocationAttributes(
  fragment: string,
  attributes: ForwardedInvocationAttributes,
  boundary: SourceBoundary
): string {
  if (!attributes.className && !attributes.variant && !attributes.href) {
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
  if (attributes.href) {
    if (tagName.toLowerCase() !== 'a') {
      throw new Error(`${boundary.kind} "${boundary.id}" cannot receive href because its root element is <${tagName}>.`);
    }
    rootAttributes = setRootAttribute(rootAttributes, 'data-blueprint-href', attributes.href);
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

function assertDeclaredUse(boundary: SourceBoundary, use: PrototypeUseDeclaration): void {
  if (!boundary.uses.some(dependency => dependency.kind === use.kind && dependency.id === use.id)) {
    throw new Error(`${boundary.kind} "${boundary.id}" renders undeclared ${use.kind} "${use.id}".`);
  }
}

function assertRenderedUses(boundary: SourceBoundary, observed: ObservedPrototypeUse[]): void {
  const declaredRenderedUses = boundary.prototype.renderedUses ?? boundary.uses.filter(
    dependency => dependency.kind === 'primitive' || dependency.kind === 'component'
  );
  const observedKeys = [...new Set(observed.map(use => `${use.kind}:${use.id}`))].sort();
  const declaredKeys = [...new Set(declaredRenderedUses.map(use => `${use.kind}:${use.id}`))].sort();
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

function baseDocumentCss(): string {
  return 'html,body{margin:0;min-width:100%;min-height:100%;}body{min-height:100vh;}';
}

/**
 * Primitive specimens review on the app's own canvas color so the board stage
 * and the compiled document paint one seamless surface; screens paint their own.
 */
function specimenCanvasCss(bundle: BlueprintProjectBundle, boundary: SourceBoundary): string {
  if (boundary.kind !== 'primitive') {
    return '';
  }
  const canvas = bundle.tokens.tokenGroups
    .find(group => group.id === 'color')
    ?.tokens.find(token => token.id === 'background');
  // Padding keeps overflowing decorations (slider thumbs, focus halos, glows)
  // from clipping against the measured cell edge.
  return canvas
    ? `html,body{background:var(${canvas.styleRef});}body{box-sizing:border-box;padding:12px;}`
    : '';
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

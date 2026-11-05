import { listCssDeclarations, listCssRules, readPaintValue, type CssCompound, type CssDeclaration, type CssRule, type CssSelector } from './css';
import { elementCloseIndex, firstOpenTag, listMarkupTokens, listOpenTags, listSvgsOutsideSlots, listSvgTags } from './markup';
import type { ContractRule } from './contract-rules';
import type { BlueprintProjectBundle, LocalValueException, PrototypeAsset } from './types';

export interface StyleRuleIssue {
  rule: ContractRule;
  /** The boundary to edit, such as `screen.home`, or the file when no boundary owns the issue. */
  boundary: string;
  location: string;
  message: string;
}

/** What a selector must name to start at a boundary. */
export interface BoundaryRoot {
  kind: 'primitive' | 'component' | 'screen';
  id: string;
  /** A primitive root with `data-blueprint-surface` takes part in the surface ladder, so that attribute is a root of it too. */
  isSurfaceRoot: boolean;
}

export interface Boundary extends BoundaryRoot {
  label: string;
  source: string;
  styles: string[];
  exceptions: LocalValueException[];
  /** Each class that a `<blueprint-use>` in this source forwards onto the root of the reusable. */
  forwardedClasses: ReadonlySet<string>;
  placesReusable: boolean;
}

/** One element of a source that has a class, and whether it holds a `<blueprint-use>`. */
interface ClassedElement {
  classes: readonly string[];
  holdsReusable: boolean;
}

export interface StyleContext {
  bundle: BlueprintProjectBundle<PrototypeAsset>;
  boundaries: Boundary[];
  /** The boundaries whose source a check reads. */
  sources: Boundary[];
  owners: Map<string, Boundary[]>;
  classedElements: Map<string, readonly ClassedElement[]>;
}

type StyleCheck = (context: StyleContext) => StyleRuleIssue[];

const ROOT_ATTRIBUTE_KINDS: ReadonlyArray<Boundary['kind']> = ['primitive', 'component', 'screen'];
/** Custom properties that the compiler sets on each document, so no token declares them. */
const COMPILER_VARIABLES: ReadonlySet<string> = new Set([
  '--blueprint-safe-area-top',
  '--blueprint-safe-area-right',
  '--blueprint-safe-area-bottom',
  '--blueprint-safe-area-left',
  '--brand-accent'
]);
/** The properties that place an element in its parent. They set nothing that the element draws. */
const LAYOUT_PROPERTIES: ReadonlySet<string> = new Set([
  'align-self',
  'block-size',
  'flex',
  'flex-basis',
  'flex-grow',
  'flex-shrink',
  'grid-area',
  'grid-column',
  'grid-column-end',
  'grid-column-start',
  'grid-row',
  'grid-row-end',
  'grid-row-start',
  'height',
  'inline-size',
  'justify-self',
  'margin',
  'margin-block',
  'margin-block-end',
  'margin-block-start',
  'margin-bottom',
  'margin-inline',
  'margin-inline-end',
  'margin-inline-start',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-block-size',
  'max-height',
  'max-inline-size',
  'max-width',
  'min-block-size',
  'min-height',
  'min-inline-size',
  'min-width',
  'order',
  'place-self',
  'width'
]);
export const SVG_PAINT_ATTRIBUTES: ReadonlySet<string> = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color', 'color']);
const COLOR_ATTRIBUTES: ReadonlySet<string> = new Set(['bgcolor', 'bordercolor']);
const PLACEHOLDER_MARKERS = /\bTODO\b|\bTBD\b/;
const PLACEHOLDER_PHRASES = /lorem ipsum|<why>|<reason>|<stylesheet path>/i;
const WHOLE_VALUE_PLACEHOLDER = /^\s*<[^<>]+>\s*$/;

function hasSurfaceRoot(source: string | undefined): boolean {
  if (source === undefined) return false;
  const root = firstOpenTag(source);
  return root !== undefined && root.attributes.some(attribute => attribute.name === 'data-blueprint-surface');
}

function readPlacements(source: string | undefined): Pick<Boundary, 'forwardedClasses' | 'placesReusable'> {
  const uses = source === undefined ? [] : listOpenTags(source).filter(tag => tag.name === 'blueprint-use');
  const forwarded = uses.flatMap(tag => (tag.attributes.find(attribute => attribute.name === 'class')?.value ?? '').split(/\s+/).filter(Boolean));
  return { forwardedClasses: new Set(forwarded), placesReusable: uses.length > 0 };
}

function boundariesOf(bundle: BlueprintProjectBundle<PrototypeAsset>): Boundary[] {
  const describe = (kind: Boundary['kind'], item: { id: string; prototype: { source: string; styles?: string[]; localValueExceptions?: LocalValueException[] } }): Boundary => ({
    label: `${kind}.${item.id}`,
    kind,
    id: item.id,
    source: item.prototype.source,
    styles: item.prototype.styles ?? [],
    exceptions: item.prototype.localValueExceptions ?? [],
    isSurfaceRoot: kind === 'primitive' && hasSurfaceRoot(bundle.prototypeSourceContents[item.prototype.source]),
    ...readPlacements(bundle.prototypeSourceContents[item.prototype.source])
  });
  return [
    ...bundle.primitives.primitives.map(item => describe('primitive', item)),
    ...bundle.components.components.map(item => describe('component', item)),
    ...bundle.screens.screens.map(item => describe('screen', item))
  ];
}

export function createStyleContext(bundle: BlueprintProjectBundle<PrototypeAsset>): StyleContext {
  const boundaries = boundariesOf(bundle);
  const owners = new Map<string, Boundary[]>();
  for (const boundary of boundaries) {
    for (const styleRef of new Set(boundary.styles)) owners.set(styleRef, [...(owners.get(styleRef) ?? []), boundary]);
  }
  return { bundle, boundaries, sources: boundaries, owners, classedElements: new Map() };
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

/** A stylesheet can have many owners, and its rules are the same for each, so each stylesheet reports once. */
function forEachStylesheet(context: StyleContext, visit: (styleRef: string, css: string, owners: Boundary[]) => void): void {
  for (const [styleRef, owners] of context.owners) {
    const css = context.bundle.prototypeSourceContents[styleRef];
    if (css !== undefined) visit(styleRef, css, owners);
  }
}

function forEachSource(context: StyleContext, visit: (boundary: Boundary, source: string) => void): void {
  const seen = new Set<string>();
  for (const boundary of context.sources) {
    const source = context.bundle.prototypeSourceContents[boundary.source];
    if (source === undefined || seen.has(boundary.source)) continue;
    seen.add(boundary.source);
    visit(boundary, source);
  }
}

function checkInlineStyles(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachSource(context, (boundary, source) => {
    for (const tag of listOpenTags(source)) {
      if (!tag.attributes.some(attribute => attribute.name === 'style')) continue;
      const location = `${boundary.source}:${lineOf(source, tag.start)}`;
      issues.push({
        rule: 'inline-style',
        boundary: boundary.label,
        location,
        message: `has a style attribute on <${tag.name}>. Fix: delete this style attribute, and set its declarations in a rule of ${boundary.styles[0] ?? `a stylesheet that you add to prototype.styles of ${boundary.kind} "${boundary.id}"`}.`
      });
    }
  });
  return issues;
}

function checkStyleElements(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachSource(context, (boundary, source) => {
    for (const tag of listOpenTags(source)) {
      if (tag.name !== 'style') continue;
      issues.push({
        rule: 'style-element',
        boundary: boundary.label,
        location: `${boundary.source}:${lineOf(source, tag.start)}`,
        message: `has a <style> element. Fix: delete this <style> element, and move its rules to ${boundary.styles[0] ?? `a stylesheet that you add to prototype.styles of ${boundary.kind} "${boundary.id}"`}.`
      });
    }
  });
  return issues;
}

function checkInlineSvgs(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachSource(context, (boundary, source) => {
    if (boundary.kind === 'primitive') return;
    for (const tag of listSvgsOutsideSlots(source)) {
      issues.push({
        rule: 'inline-svg',
        boundary: boundary.label,
        location: `${boundary.source}:${lineOf(source, tag.start)}`,
        message: 'has an inline <svg> outside a reusable and outside a slot. Fix: put this <svg> in <blueprint-use kind="primitive" ref="icon">, or replace it with a <blueprint-use kind="brand-mark"> of a mark in brand.json when it is a logo.'
      });
    }
  });
  return issues;
}

function declaredVariables(context: StyleContext): ReadonlySet<string> {
  return new Set(context.bundle.tokens.tokenGroups.flatMap(group => group.tokens.map(token => token.styleRef)));
}

function isDeclaredVariable(variable: string, tokens: ReadonlySet<string>): boolean {
  return tokens.has(variable) || COMPILER_VARIABLES.has(variable);
}

function checkSvgPaintAttributes(context: StyleContext): StyleRuleIssue[] {
  const tokens = declaredVariables(context);
  const issues: StyleRuleIssue[] = [];
  forEachSource(context, (boundary, source) => {
    for (const tag of listSvgTags(source)) {
      for (const attribute of tag.attributes) {
        if (!SVG_PAINT_ATTRIBUTES.has(attribute.name) || !attribute.hasValue) continue;
        const paint = readPaintValue(attribute.value);
        if (!paint.hasColorLiteral && paint.namedColors.length === 0 && paint.variables.every(variable => isDeclaredVariable(variable, tokens))) continue;
        issues.push({
          rule: 'svg-paint-attribute',
          boundary: boundary.label,
          location: `${boundary.source}:${lineOf(source, tag.start)}`,
          message: `has ${attribute.name}="${attribute.value}" on <${tag.name}>. Fix: set ${attribute.name} to "none", "currentColor", or var() of a token in tokens.json.`
        });
      }
    }
  });
  return issues;
}

/** The browser still applies these old forms, and no stylesheet rule can read a value that markup holds. */
function checkPresentationalMarkup(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachSource(context, (boundary, source) => {
    const stylesheet = boundary.styles[0] ?? `a stylesheet that you add to prototype.styles of ${boundary.kind} "${boundary.id}"`;
    for (const tag of listOpenTags(source)) {
      const location = `${boundary.source}:${lineOf(source, tag.start)}`;
      if (tag.name === 'font') {
        issues.push({
          rule: 'presentational-markup',
          boundary: boundary.label,
          location,
          message: `has a <font> element. Fix: replace this <font> with a <span>, and set its type with a token in ${stylesheet}.`
        });
      }
      for (const attribute of tag.attributes) {
        if (!attribute.hasValue || !(COLOR_ATTRIBUTES.has(attribute.name) || (attribute.name === 'color' && tag.name === 'hr'))) continue;
        issues.push({
          rule: 'presentational-markup',
          boundary: boundary.label,
          location,
          message: `has ${attribute.name}="${attribute.value}" on <${tag.name}>. Fix: delete ${attribute.name} from this tag, and set this color with a token in ${stylesheet}.`
        });
      }
    }
  });
  return issues;
}

function checkUndeclaredVariables(context: StyleContext): StyleRuleIssue[] {
  const tokens = declaredVariables(context);
  const issues: StyleRuleIssue[] = [];
  forEachStylesheet(context, (styleRef, css, owners) => {
    const reported = new Set<string>();
    for (const declaration of listCssDeclarations(css)) {
      for (const variable of declaration.variables) {
        if (isDeclaredVariable(variable, tokens) || reported.has(variable)) continue;
        reported.add(variable);
        issues.push({
          rule: 'undeclared-variable',
          boundary: owners[0].label,
          location: styleRef,
          message: `${declaration.property}: "${declaration.value}" reads ${variable}, which no token declares. Fix: replace var(${variable}) with var() of a token in ${styleRef}. When no token fits, add a token with styleRef "--app-<group>-<token>" to tokens.json, and read that name in the var().`
        });
      }
    }
  });
  return issues;
}

function checkLocalCustomProperties(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachStylesheet(context, (styleRef, css, owners) => {
    const reported = new Set<string>();
    for (const declaration of listCssDeclarations(css)) {
      if (!declaration.property.startsWith('--') || reported.has(declaration.property)) continue;
      reported.add(declaration.property);
      issues.push({
        rule: 'local-custom-property',
        boundary: owners[0].label,
        location: styleRef,
        message: `declares the custom property ${declaration.property}. Fix: delete this declaration from ${styleRef}, and use var() of a token in tokens.json where the stylesheet reads ${declaration.property}.`
      });
    }
  });
  return issues;
}

function checkUnmatchedExceptions(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  for (const boundary of context.boundaries) {
    if (boundary.exceptions.length === 0) continue;
    const declared = new Set(boundary.styles.flatMap(styleRef => {
      const css = context.bundle.prototypeSourceContents[styleRef];
      return css === undefined ? [] : listCssDeclarations(css).map(declaration => `${declaration.property}\n${declaration.value.toLowerCase()}`);
    }));
    for (const exception of boundary.exceptions) {
      const value = String(exception.value).trim().replace(/\s+/g, ' ').toLowerCase();
      if (declared.has(`${String(exception.property).toLowerCase()}\n${value}`)) continue;
      issues.push({
        rule: 'unmatched-exception',
        boundary: boundary.label,
        location: 'prototype.localValueExceptions',
        message: `entry { "property": "${exception.property}", "value": "${exception.value}" } matches no whole declaration in the stylesheets of this boundary. Fix: set value to the whole declaration value as a stylesheet writes it, or delete this entry.`
      });
    }
  }
  return issues;
}

function checkUnparsedStylesheets(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachStylesheet(context, (styleRef, css, owners) => {
    if (listCssRules(css) !== null) return;
    issues.push({
      rule: 'unparsed-stylesheet',
      boundary: owners[0].label,
      location: styleRef,
      message: `cannot be parsed, so Blueprint cannot check its rules. Fix: close each block and each string in ${styleRef}.`
    });
  });
  return issues;
}

function isRootAttribute(match: { name: string; value?: string }, owner: BoundaryRoot): boolean {
  if (match.name === `data-blueprint-${owner.kind}` && match.value === owner.id) return true;
  return owner.isSurfaceRoot && match.name === 'data-blueprint-surface';
}

function isOwnClass(name: string, owner: BoundaryRoot): boolean {
  return name === owner.id || name.startsWith(`${owner.id}__`) || name.startsWith(`${owner.id}--`);
}

/** The compiler joins each stylesheet into one document without a scope. A class in the namespace of the boundary is as narrow as its root attribute. */
export function compoundStartsAt(compound: CssCompound | undefined, owner: BoundaryRoot): boolean {
  if (!compound) return false;
  return compound.attributes.some(match => isRootAttribute(match, owner))
    || compound.classes.some(name => isOwnClass(name, owner))
    || compound.alternatives.some(branches => branches.length > 0 && branches.every(branch => compoundStartsAt(branch.compounds[0], owner)));
}

function forEachRule(context: StyleContext, visit: (rule: CssRule, styleRef: string, owners: Boundary[]) => void): void {
  forEachStylesheet(context, (styleRef, css, owners) => {
    for (const rule of listCssRules(css) ?? []) visit(rule, styleRef, owners);
  });
}

const SELECTOR_ROOTS_LISTED = 3;

/** A rule that starts at one owner stops for each other owner, so a shared stylesheet needs one copy of the selector for each owner. */
function selectorRootMessage(selector: string, owners: Boundary[], styleRef: string): string {
  const rootOf = ({ kind, id }: Boundary): string => `[data-blueprint-${kind}="${id}"]`;
  const moveRule = 'move this rule to the stylesheet of the boundary that it styles.';
  if (owners.length === 1) {
    const [owner] = owners;
    return `selector "${selector}" does not start at the root of ${owner.kind} "${owner.id}". Fix: start this selector with ${rootOf(owner)} in ${styleRef}, or ${moveRule}`;
  }
  const unlisted = owners.length - SELECTOR_ROOTS_LISTED;
  const roots = owners.slice(0, SELECTOR_ROOTS_LISTED).map(rootOf).join(', ');
  const more = unlisted > 0 ? `, and ${unlisted} more ${unlisted === 1 ? 'boundary' : 'boundaries'} that ${unlisted === 1 ? 'lists' : 'list'} this stylesheet` : '';
  return `selector "${selector}" does not start at the root of any of the ${owners.length} boundaries that use ${styleRef}. Fix: write this selector once for each boundary in ${styleRef}, and start each copy with one root: ${roots}${more}. Or ${moveRule}`;
}

function checkSelectorRoots(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachRule(context, (rule, styleRef, owners) => {
    if (rule.nested) return;
    for (const selector of rule.selectors) {
      if (owners.some(owner => compoundStartsAt(selector.compounds[0], owner))) continue;
      issues.push({
        rule: 'selector-root',
        boundary: owners[0].label,
        location: styleRef,
        message: selectorRootMessage(selector.text, owners, styleRef)
      });
    }
  });
  return issues;
}

/** Each other boundary root that a compound selects, directly or in a branch of `:is()` or `:where()`. */
function foreignRoots(compound: CssCompound, owners: Boundary[]): string[] {
  const roots: string[] = [];
  for (const match of compound.attributes) {
    const kind = ROOT_ATTRIBUTE_KINDS.find(candidate => match.name === `data-blueprint-${candidate}`);
    if (kind && !owners.some(owner => isRootAttribute(match, owner))) {
      roots.push(match.value === undefined ? `each ${kind}` : `${kind} "${match.value}"`);
    }
  }
  for (const branches of compound.alternatives) {
    for (const branch of branches) {
      for (const inner of branch.compounds) roots.push(...foreignRoots(inner, owners));
    }
  }
  return roots;
}

/** Each forwarded class that a compound selects, directly or in the subject of a branch of `:is()` or `:where()`. */
function forwardedClassesIn(compound: CssCompound, owners: Boundary[]): string[] {
  return [
    ...compound.classes.filter(name => owners.some(owner => owner.forwardedClasses.has(name))),
    ...compound.alternatives.flat().flatMap(branch => {
      const subject = branch.compounds.at(-1);
      return subject ? forwardedClassesIn(subject, owners) : [];
    })
  ];
}

/** Each boundary whose namespace holds a class that a compound selects, directly or in the subject of a branch. */
function foreignParts(compound: CssCompound, context: StyleContext, owners: Boundary[]): Array<{ name: string; owner: Boundary }> {
  const parts: Array<{ name: string; owner: Boundary }> = [];
  for (const name of compound.classes) {
    if (owners.some(owner => isOwnClass(name, owner))) continue;
    const owner = context.boundaries.find(boundary => name.startsWith(`${boundary.id}__`) || name.startsWith(`${boundary.id}--`));
    if (owner) parts.push({ name, owner });
  }
  for (const branch of compound.alternatives.flat()) {
    const subject = branch.compounds.at(-1);
    if (subject) parts.push(...foreignParts(subject, context, owners));
  }
  return parts;
}

/** A class in the namespace of the boundary, on slot content for example, belongs to this boundary wherever a root holds it. */
function selectsOwnClass(compound: CssCompound, owners: Boundary[]): boolean {
  return compound.classes.some(name => owners.some(owner => isOwnClass(name, owner)))
    || compound.alternatives.some(branches => branches.length > 0 && branches.every(branch => {
      const subject = branch.compounds.at(-1);
      return subject !== undefined && selectsOwnClass(subject, owners);
    }));
}

/** What a compound before the subject passes through: a root, a forwarded class, or a part of another boundary. */
function passedThrough(compound: CssCompound, context: StyleContext, owners: Boundary[]): string | undefined {
  const forwarded = forwardedClassesIn(compound, owners)[0];
  return foreignRoots(compound, owners)[0]
    ?? (forwarded === undefined ? undefined : `the root that <blueprint-use class="${forwarded}"> places`)
    ?? foreignParts(compound, context, owners).map(part => `${part.owner.kind} "${part.owner.id}"`)[0];
}

function checkReachThrough(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachRule(context, (rule, styleRef, owners) => {
    for (const selector of rule.selectors) {
      const subject = selector.compounds.at(-1);
      if (!subject || foreignRoots(subject, owners).length > 0 || foreignParts(subject, context, owners).length > 0 || selectsOwnClass(subject, owners)) continue;
      const passed = selector.compounds.slice(0, -1).map(compound => passedThrough(compound, context, owners)).find(Boolean);
      if (passed === undefined) continue;
      issues.push({
        rule: 'reach-through',
        boundary: owners[0].label,
        location: styleRef,
        message: `selector "${selector.text}" reaches inside ${passed}. Fix: delete this rule from ${styleRef}, and add a variant to that reusable in its own stylesheet.`
      });
    }
  });
  return issues;
}

function readsClassAttribute(compound: CssCompound): boolean {
  return compound.attributes.some(match => match.name === 'class')
    || compound.alternatives.flat().some(branch => branch.compounds.some(readsClassAttribute));
}

/** The reach rules read class names, so a class attribute match would pass each of them. */
function checkClassAttributes(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachRule(context, (rule, styleRef, owners) => {
    for (const selector of rule.selectors) {
      if (!selector.compounds.some(readsClassAttribute)) continue;
      issues.push({
        rule: 'class-attribute-selector',
        boundary: owners[0].label,
        location: styleRef,
        message: `selector "${selector.text}" reads the class attribute, so the reach rules cannot read this class. Fix: select this class with a dot, as ".name", in ${styleRef}.`
      });
    }
  });
  return issues;
}

function checkForeignParts(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachRule(context, (rule, styleRef, owners) => {
    for (const selector of rule.selectors) {
      const subject = selector.compounds.at(-1);
      const part = subject && foreignParts(subject, context, owners)[0];
      if (!part) continue;
      issues.push({
        rule: 'reach-foreign-part',
        boundary: owners[0].label,
        location: styleRef,
        message: `selector "${selector.text}" selects the class "${part.name}" in the namespace of ${part.owner.kind} "${part.owner.id}". Fix: delete this rule from ${styleRef}, and add a variant to that reusable in its own stylesheet.`
      });
    }
  });
  return issues;
}

/** True when a compound has no class and no boundary attribute, so that any element of its type can match, in a reusable too. */
function selectsOnlyAnElement(compound: CssCompound): boolean {
  if (compound.classes.length > 0) return false;
  if (compound.attributes.some(match => ROOT_ATTRIBUTE_KINDS.some(kind => match.name === `data-blueprint-${kind}`))) return false;
  if (compound.elements.length > 0) return true;
  if (compound.attributes.length > 0) return false;
  if (compound.alternatives.length === 0) return true;
  return compound.alternatives.some(branches => branches.some(branch => {
    const subject = branch.compounds.at(-1);
    return subject !== undefined && selectsOnlyAnElement(subject);
  }));
}

/** The element nearest the subject that the selector names by more than its type, after a descendant combinator that leaves the subject free. */
export function descendantAnchor(selector: CssSelector): CssCompound | 'none' | undefined {
  for (let index = selector.compounds.length - 1; index >= 0; index -= 1) {
    const compound = selector.compounds[index];
    if (!selectsOnlyAnElement(compound)) return undefined;
    for (const branch of compound.alternatives.flat()) {
      const anchor = descendantAnchor(branch);
      if (anchor) return anchor;
    }
    if (index > 0 && selector.combinators[index - 1] === ' ') {
      return selector.compounds.slice(0, index).reverse().find(earlier => !selectsOnlyAnElement(earlier)) ?? 'none';
    }
  }
  return undefined;
}

function classedElements(boundary: Boundary, context: StyleContext): readonly ClassedElement[] {
  const source = context.bundle.prototypeSourceContents[boundary.source] ?? '';
  const known = context.classedElements.get(source);
  if (known) return known;
  const tokens = listMarkupTokens(source);
  const elements: ClassedElement[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== 'open') return;
    const classes = token.attributes.find(attribute => attribute.name === 'class')?.value.split(/\s+/).filter(Boolean) ?? [];
    if (classes.length === 0) return;
    const close = elementCloseIndex(tokens, index);
    const holdsReusable = close > index && tokens.slice(index + 1, close).some(inner => inner.kind === 'open' && inner.name === 'blueprint-use');
    elements.push({ classes, holdsReusable });
  });
  context.classedElements.set(source, elements);
  return elements;
}

/** A class on no element of the boundary can name an element in a placed reusable, unless the namespace of the boundary holds it. */
function classesCanHoldReusable(classes: readonly string[], context: StyleContext, owners: Boundary[]): boolean {
  const named = owners.flatMap(owner => classedElements(owner, context)).filter(element => classes.every(name => element.classes.includes(name)));
  if (named.length > 0) return named.some(element => element.holdsReusable);
  return !classes.some(name => owners.some(owner => isOwnClass(name, owner)));
}

/** Each set of classes that names this compound, or nothing when a root attribute or a branch without a class names it. */
function classSetsOf(compound: CssCompound): ReadonlyArray<readonly string[]> | undefined {
  if (compound.classes.length > 0) return [compound.classes];
  if (compound.alternatives.length === 0) return undefined;
  const sets: Array<readonly string[]> = [];
  for (const branch of compound.alternatives.flat()) {
    const subject = branch.compounds.at(-1);
    const inner = subject && classSetsOf(subject);
    if (!inner) return undefined;
    sets.push(...inner);
  }
  return sets;
}

/** A descendant combinator from an element that holds no `<blueprint-use>` cannot cross into a reusable. */
function canCrossIntoReusable(selector: CssSelector, context: StyleContext, owners: Boundary[]): boolean {
  const anchor = descendantAnchor(selector);
  if (!anchor) return false;
  const sets = anchor === 'none' ? undefined : classSetsOf(anchor);
  return sets === undefined || sets.some(classes => classesCanHoldReusable(classes, context, owners));
}

/** Each project resets `box-sizing` this way, and no reusable carries the reset itself, so the rule leaves this one declaration. */
function isBoxSizingReset(rule: CssRule): boolean {
  return rule.declarations.length > 0 && rule.declarations.every(declaration => declaration.property === 'box-sizing');
}

function checkDescendantSubjects(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachRule(context, (rule, styleRef, owners) => {
    const placing = owners.filter(owner => owner.placesReusable);
    if (placing.length === 0) return;
    const reset = isBoxSizingReset(rule);
    for (const selector of rule.selectors) {
      const nestedType = rule.nested && selector.compounds.length === 1 && selector.compounds[0].elements.length > 0;
      if (!nestedType && !canCrossIntoReusable(selector, context, placing)) continue;
      if (reset && selector.compounds.at(-1)?.elements.includes('*')) continue;
      if (selector.compounds.slice(0, -1).some(compound => passedThrough(compound, context, owners))) continue;
      issues.push({
        rule: 'reach-descendant',
        boundary: owners[0].label,
        location: styleRef,
        message: `selector "${selector.text}" has a type or universal subject, and its descendant combinator can cross into a reusable that this boundary places. Fix: select a class of this boundary in ${styleRef}, or use a child combinator from an element that this boundary owns.`
      });
    }
  });
  return issues;
}

/** `display: none` changes no look of the placement, because it only takes the placement out of the layout. */
function placesTheElement(declaration: CssDeclaration): boolean {
  return LAYOUT_PROPERTIES.has(declaration.property) || (declaration.property === 'display' && declaration.value.toLowerCase() === 'none');
}

function checkReachIntoRoots(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachRule(context, (rule, styleRef, owners) => {
    const painted = [...new Set(rule.declarations.filter(declaration => !placesTheElement(declaration)).map(declaration => declaration.property))];
    if (painted.length === 0) return;
    for (const selector of rule.selectors) {
      const subject = selector.compounds.at(-1);
      const reached = subject && foreignRoots(subject, owners)[0];
      if (reached === undefined) continue;
      issues.push({
        rule: 'reach-root',
        boundary: owners[0].label,
        location: styleRef,
        message: `selector "${selector.text}" reaches the root of ${reached} and sets ${painted.join(', ')}. Fix: delete ${painted.join(', ')} from this rule in ${styleRef}, and add a variant with them to that reusable. A rule on another root sets only margin, size, flex and grid placement, order, self alignment, and display: none.`
      });
    }
  });
  return issues;
}

function checkForwardedClasses(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachRule(context, (rule, styleRef, owners) => {
    const painted = [...new Set(rule.declarations.filter(declaration => !placesTheElement(declaration)).map(declaration => declaration.property))];
    if (painted.length === 0) return;
    for (const selector of rule.selectors) {
      const subject = selector.compounds.at(-1);
      if (!subject || foreignParts(subject, context, owners).length > 0) continue;
      const forwarded = forwardedClassesIn(subject, owners)[0];
      if (forwarded === undefined) continue;
      issues.push({
        rule: 'reach-forwarded',
        boundary: owners[0].label,
        location: styleRef,
        message: `selector "${selector.text}" reaches the root that <blueprint-use class="${forwarded}"> places, and sets ${painted.join(', ')}. Fix: delete ${painted.join(', ')} from this rule in ${styleRef}, and add a variant with them to that reusable in its own stylesheet.`
      });
    }
  });
  return issues;
}

function checkImportant(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  forEachStylesheet(context, (styleRef, css, owners) => {
    for (const declaration of listCssDeclarations(css)) {
      if (!declaration.important) continue;
      issues.push({
        rule: 'important',
        boundary: owners[0].label,
        location: styleRef,
        message: `${declaration.property}: "${declaration.value}" uses !important. Fix: delete !important from this declaration in ${styleRef}.`
      });
    }
  });
  return issues;
}

/** A token group restates a role when one of its colors has the id of a color in another group. */
function checkParallelPalettes(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  const firstGroup = new Map<string, string>();
  for (const group of context.bundle.tokens.tokenGroups) {
    for (const token of group.tokens) {
      if (token.type !== 'color') continue;
      const earlier = firstGroup.get(token.id);
      if (earlier === undefined) {
        firstGroup.set(token.id, group.id);
      } else if (earlier !== group.id) {
        issues.push({
          rule: 'parallel-palette',
          boundary: `tokenGroup.${group.id}`,
          location: 'tokens.json',
          message: `color token "${token.id}" restates the role "${earlier}.${token.id}". Fix: delete this token from tokens.json, and change the value of "${earlier}.${token.id}", or give this token an id that names its new meaning.`
        });
      }
    }
  }
  return issues;
}

function checkTokenPrefixes(context: StyleContext): StyleRuleIssue[] {
  const issues: StyleRuleIssue[] = [];
  for (const group of context.bundle.tokens.tokenGroups) {
    for (const token of group.tokens) {
      if (typeof token.styleRef !== 'string' || token.styleRef.startsWith('--app-')) continue;
      issues.push({
        rule: 'token-prefix',
        boundary: `tokenGroup.${group.id}`,
        location: 'tokens.json',
        message: `token "${token.id}" has styleRef "${token.styleRef}", which starts a second namespace. Fix: set styleRef of this token to "--app-${group.id}-${token.id}".`
      });
    }
  }
  return issues;
}

function placeholderIn(text: string): string | undefined {
  if (WHOLE_VALUE_PLACEHOLDER.test(text)) return text.trim();
  return (PLACEHOLDER_MARKERS.exec(text) ?? PLACEHOLDER_PHRASES.exec(text))?.[0];
}

function walkStrings(value: unknown, path: string, visit: (text: string, path: string) => void): void {
  if (typeof value === 'string') {
    visit(value, path);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${path}[${index}]`, visit));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) walkStrings(item, path ? `${path}.${key}` : key, visit);
  }
}

function checkPlaceholderText(context: StyleContext): StyleRuleIssue[] {
  const { bundle } = context;
  const files: Array<[string, unknown]> = [
    ['manifest.json', bundle.manifest],
    ['tokens.json', bundle.tokens],
    ['primitives.json', bundle.primitives],
    ['components.json', bundle.components],
    ['screens.json', bundle.screens],
    ...(bundle.brand ? [['brand.json', bundle.brand] as [string, unknown]] : [])
  ];
  const issues: StyleRuleIssue[] = [];
  for (const [file, content] of files) {
    walkStrings(content, '', (text, path) => {
      const placeholder = placeholderIn(text);
      if (placeholder === undefined) return;
      issues.push({
        rule: 'placeholder-text',
        boundary: file,
        location: path,
        message: `holds the placeholder "${placeholder}". Fix: replace "${placeholder}" at ${path} in ${file} with the real text or path.`
      });
    });
  }
  return issues;
}

/** Each check is named in this table, so that a test can read the rule of each issue. */
const STYLE_CHECKS: readonly StyleCheck[] = [
  checkInlineStyles,
  checkStyleElements,
  checkInlineSvgs,
  checkSvgPaintAttributes,
  checkPresentationalMarkup,
  checkUndeclaredVariables,
  checkLocalCustomProperties,
  checkUnmatchedExceptions,
  checkUnparsedStylesheets,
  checkSelectorRoots,
  checkReachIntoRoots,
  checkReachThrough,
  checkForeignParts,
  checkClassAttributes,
  checkForwardedClasses,
  checkDescendantSubjects,
  checkImportant,
  checkParallelPalettes,
  checkTokenPrefixes,
  checkPlaceholderText
];

/** These read the project as a whole, so a candidate file cannot change their result, or they need the whole file list of a boundary. */
const PROJECT_CHECKS: ReadonlySet<StyleCheck> = new Set([checkUnmatchedExceptions, checkParallelPalettes, checkTokenPrefixes, checkPlaceholderText]);
const FILE_CHECKS = STYLE_CHECKS.filter(check => !PROJECT_CHECKS.has(check));

export function collectStyleRuleIssues(bundle: BlueprintProjectBundle<PrototypeAsset>): StyleRuleIssue[] {
  const context = createStyleContext(bundle);
  return STYLE_CHECKS.flatMap(check => check(context));
}

/** The boundary of a screen with the files of another prototype. */
export function withScreenFiles(screen: Boundary, source: string, styles: string[], content: string | undefined): Boundary {
  return { ...screen, source, styles, ...readPlacements(content) };
}

/** A sheet that replaces a canonical sheet keeps the owners of that sheet, and promotion also writes the source that another screen shares. */
export function ownersAfterCopy(context: StyleContext, target: string, current: Boundary, screen: Boundary): Boundary[] {
  const owners = (context.owners.get(target) ?? []).map(owner => {
    if (owner === current) return screen;
    return owner.source === current.source ? { ...owner, source: screen.source, forwardedClasses: screen.forwardedClasses, placesReusable: screen.placesReusable } : owner;
  });
  return owners.includes(screen) ? owners : [screen, ...owners];
}

export function collectSourceIssues(context: StyleContext, boundary: Boundary): StyleRuleIssue[] {
  const scope = { ...context, sources: [boundary], owners: new Map<string, Boundary[]>() };
  return FILE_CHECKS.flatMap(check => check(scope));
}

export function collectStylesheetIssues(context: StyleContext, styleRef: string, owners: Boundary[]): StyleRuleIssue[] {
  const scope = { ...context, sources: [], owners: new Map([[styleRef, owners]]) };
  return FILE_CHECKS.flatMap(check => check(scope));
}

export function collectExceptionIssues(context: StyleContext, boundaries: Boundary[]): StyleRuleIssue[] {
  return checkUnmatchedExceptions({ ...context, boundaries });
}

/** Each input that the reach checks read from a source. A sheet gives one result for two sources with the same key. */
export function placementKey(boundary: Boundary, context: StyleContext): string {
  return JSON.stringify([[...boundary.forwardedClasses].sort(), boundary.placesReusable, classedElements(boundary, context)]);
}

export function styleRuleMessage(issue: StyleRuleIssue): string {
  return `${issue.boundary} ${issue.location} ${issue.message}`;
}

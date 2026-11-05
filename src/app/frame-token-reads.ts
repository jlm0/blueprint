import { type CssDeclaration, listCssDeclarations, listCssRules, readPaintValue } from '../core/css';
import { type MarkupAttribute, attributeWithValue, listPossibleOpenTags } from '../core/markup';
import type { CanvasProjectBundle, ScreenDefinition } from '../core/types';
import { declaredReusables } from './frame-uses';

export interface ScreenTokenReads {
  variables: ReadonlySet<string>;
  /** A stale frame is worse than an extra rebuild, so a case that the reader cannot read counts as a read of each token. */
  unknown: boolean;
}

const readsByBundle = new WeakMap<CanvasProjectBundle, Map<string, ScreenTokenReads>>();

function hasVarCall(text: string): boolean {
  return text.toLowerCase().includes('var(');
}

export function isReadableVariable(variable: string): boolean {
  return !variable.includes('\\');
}

/** A character reference can spell any part of a `var()` read, and the markup reader does not decode it. */
export function attributeVariables(attribute: MarkupAttribute): { variables: string[]; unknown: boolean } {
  const { value } = attribute;
  if (value.includes('&') && (value.includes('&#') || value.includes('--') || hasVarCall(value))) return { variables: [], unknown: true };
  if (!hasVarCall(value)) return { variables: [], unknown: false };
  const { variables } = readPaintValue(value);
  return { variables, unknown: variables.length === 0 || !variables.every(isReadableVariable) };
}

function tokenReadsOfValue(value: string): { variables: string[]; unknown: boolean } {
  if (!hasVarCall(value)) return { variables: [], unknown: false };
  const { variables } = readPaintValue(value);
  return { variables, unknown: variables.length === 0 || !variables.every(isReadableVariable) };
}

function declarationIsUnreadable(declaration: CssDeclaration): boolean {
  return hasVarCall(declaration.value) && (declaration.variables.length === 0 || !declaration.variables.every(isReadableVariable));
}

/** A container style query reads a custom property without `var()`. */
function sheetIsUnreadable(css: string): boolean {
  return listCssRules(css) === null || css.toLowerCase().includes('style(');
}

function tokenList(bundle: CanvasProjectBundle): Array<{ styleRef: string; value: string }> {
  return bundle.tokens.tokenGroups.flatMap(group => group.tokens);
}

export function changedTokenRefs(previous: CanvasProjectBundle, next: CanvasProjectBundle): Set<string> {
  const before = new Map(tokenList(previous).map(token => [token.styleRef, token.value]));
  const after = new Map(tokenList(next).map(token => [token.styleRef, token.value]));
  const changed = new Set<string>();
  for (const ref of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(ref) !== after.get(ref)) changed.add(ref);
  }
  if (changed.size === 0) return changed;
  const readers = new Map<string, string[]>();
  const pending = [...changed];
  for (const [ref, value] of after) {
    const reads = tokenReadsOfValue(value);
    if (reads.unknown && !changed.has(ref)) {
      changed.add(ref);
      pending.push(ref);
    }
    for (const variable of reads.variables) readers.set(variable, [...readers.get(variable) ?? [], ref]);
  }
  for (let ref = pending.pop(); ref !== undefined; ref = pending.pop()) {
    for (const reader of readers.get(ref) ?? []) {
      if (changed.has(reader)) continue;
      changed.add(reader);
      pending.push(reader);
    }
  }
  return changed;
}

export function tokenReadClosure(bundle: CanvasProjectBundle, reads: Iterable<string>): Map<string, string> {
  const values = new Map(tokenList(bundle).map(token => [token.styleRef, token.value]));
  const closure = new Map<string, string>();
  const pending = [...reads];
  for (let ref = pending.pop(); ref !== undefined; ref = pending.pop()) {
    const value = values.get(ref);
    if (value === undefined || closure.has(ref)) continue;
    closure.set(ref, value);
    pending.push(...tokenReadsOfValue(value).variables);
  }
  return closure;
}

function colorTokenRef(bundle: CanvasProjectBundle, ref: string): string | undefined {
  const separator = ref.indexOf('.');
  return bundle.tokens.tokenGroups
    .find(group => group.id === ref.slice(0, separator))
    ?.tokens.find(token => token.id === ref.slice(separator + 1))?.styleRef;
}

/** No stylesheet of the frame names the source or the variant colors of a placed brand mark. */
function readBrandMark(bundle: CanvasProjectBundle, markId: string | undefined, variantId: string | undefined, sources: string[], variables: Set<string>): boolean {
  const mark = bundle.brand?.marks.find(candidate => candidate.id === markId);
  if (!mark) return false;
  sources.push(mark.source);
  if (variantId === undefined) return true;
  const variant = mark.variants.find(candidate => candidate.id === variantId);
  if (!variant) return false;
  for (const ref of [variant.foreground, variant.accent]) {
    if (ref === undefined) continue;
    const styleRef = colorTokenRef(bundle, ref);
    if (!styleRef) return false;
    variables.add(styleRef);
  }
  return true;
}

export function screenTokenReads(bundle: CanvasProjectBundle, screen: ScreenDefinition): ScreenTokenReads {
  let reads = readsByBundle.get(bundle);
  if (!reads) {
    reads = new Map();
    readsByBundle.set(bundle, reads);
  }
  const known = reads.get(screen.id);
  if (known) return known;
  const reusables = declaredReusables(bundle, screen);
  const variables = new Set<string>();
  let unknown = false;
  for (const styleRef of [...screen.prototype.styles, ...reusables.flatMap(reusable => reusable.prototype?.styles ?? [])]) {
    const css = bundle.prototypeSourceContents[styleRef];
    if (css === undefined || sheetIsUnreadable(css)) {
      unknown = true;
      continue;
    }
    for (const declaration of listCssDeclarations(css)) {
      if (declarationIsUnreadable(declaration)) unknown = true;
      for (const variable of declaration.variables) variables.add(variable);
    }
  }
  const sources = [screen.prototype.source, ...reusables.flatMap(reusable => reusable.prototype ? [reusable.prototype.source] : [])];
  for (let index = 0; index < sources.length; index += 1) {
    const sourceRef = sources[index];
    const source = bundle.prototypeSourceContents[sourceRef];
    if (source === undefined) {
      unknown = true;
      continue;
    }
    for (const tag of listPossibleOpenTags(source)) {
      if (tag.name === 'style') unknown = true;
      if (tag.name === 'blueprint-use' && attributeWithValue(tag, 'kind')?.value === 'brand-mark'
        && !readBrandMark(bundle, attributeWithValue(tag, 'ref')?.value, attributeWithValue(tag, 'variant')?.value, sources, variables)) unknown = true;
      for (const attribute of tag.attributes) {
        const read = attributeVariables(attribute);
        if (read.unknown) unknown = true;
        for (const variable of read.variables) variables.add(variable);
      }
    }
  }
  const result: ScreenTokenReads = { variables, unknown };
  reads.set(screen.id, result);
  return result;
}

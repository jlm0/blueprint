/** The one reader of governed prototype CSS, so it stays a leaf module that imports nothing else from Blueprint. */
import type { AtRule, Declaration, Input, Root, Rule } from 'postcss';
import parse from 'postcss/lib/parse';
import tokenize from 'postcss/lib/tokenize';
import valueParser from 'postcss-value-parser';

export interface CssDeclaration {
  /** Lowercase, because CSS property names ignore case. */
  property: string;
  /** Holds any `!important`, because a finding quotes the value as written. */
  value: string;
  hasColorLiteral: boolean;
  lengths: string[];
}

export interface CssAttributeSelector {
  name: string;
  value: string;
  quote: string;
  start: number;
  end: number;
}

interface CssUrl {
  start: number;
  end: number;
  value: string;
}

interface CssReferences {
  urls: CssUrl[];
  hasImport: boolean;
}

interface CssEdit {
  start: number;
  end: number;
  text: string;
}

interface CssSheet {
  declarations?: CssDeclaration[];
  references?: CssReferences;
  selectorRanges?: Array<[number, number]>;
}

const MEMO_LIMIT = 2048;
const REFERENCE_TEXT = /url\(|@import/i;
const URL_TEXT = /url\(/i;
const IMPORT_RULE_NAME = /^import\b/i;
const HEX_COLOR = /#[0-9a-f]{3,8}\b/i;
const COLOR_FUNCTION_NAME = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/i;
const LENGTH_IN_WORD = /(?<![\w.#-])-?(?:\d*\.)?\d+(?:px|rem|em)\b/gi;
const LENGTH_VALUE = /^-?(?:\d*\.)?\d+(?:px|rem|em)$/;
const QUOTED = /^(["']).*\1$/s;
const COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')/g;
const ATTRIBUTE_SELECTOR_OR_SKIPPED_TEXT = /\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\[\s*([-\w]+)\s*=\s*(['"]?)([^'"\]\s]+)\2\s*\]/g;
const COMPOUND_BOUNDARY = /[\s,>+~{};]/;
const RAW_NEWLINE = /(?<!\\)(?:\\\\)*[\n\r\f]/;
const URL_TOKEN_THAT_POSTCSS_SPLITS = /url\([ \t\n\r\f]*(?![ \t\n\r\f"'])(?:[^)\\]|\\[\s\S])*?(?:\/\*|["'])/i;

const LEGACY_IMPORT = /@import\b/i;
const LEGACY_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const LEGACY_COMMENT = /\/\*[\s\S]*?\*\//g;
const LEGACY_DECLARATION = /([-\w]+)\s*:\s*([^;{}]+?)\s*(?=;|})/g;

const sheets = new Map<string, CssSheet>();

function sheetFor(css: string): CssSheet {
  let sheet = sheets.get(css);
  if (!sheet) {
    if (sheets.size >= MEMO_LIMIT) {
      sheets.delete(sheets.keys().next().value as string);
    }
    sheet = {};
    sheets.set(css, sheet);
  }
  return sheet;
}

/** Postcss throws on CSS that browsers recover from, so `legacy` keeps the regex reading for those sheets. */
function readSheet<T>(css: string, read: (root: Root, text: string) => T | undefined, legacy: (text: string) => T): T {
  try {
    // Postcss drops a byte order mark, which would shift every offset.
    const first = css.charCodeAt(0);
    const text = first === 0xfeff || first === 0xfffe ? ` ${css.slice(1)}` : css;
    // `map: false` stops postcss from reading a file that a sourceMappingURL comment names.
    return read(parse(text, { map: false }) as Root, text) ?? legacy(css);
  } catch {
    return legacy(css);
  }
}

export function collapseCssWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

export function isCssLengthLiteral(value: string): boolean {
  return LENGTH_VALUE.test(value);
}

export function listCssDeclarations(css: string): readonly CssDeclaration[] {
  const sheet = sheetFor(css);
  sheet.declarations ??= readSheet(css, parsedDeclarations, legacyDeclarations);
  return sheet.declarations;
}

function parsedDeclarations(root: Root, css: string): CssDeclaration[] | undefined {
  if (URL_TOKEN_THAT_POSTCSS_SPLITS.test(css)) return undefined;
  const declarations: CssDeclaration[] = [];
  root.walkDecls(declaration => {
    const { start, propertyEnd, valueStart, valueEnd } = declarationRange(declaration, css);
    const written = css.slice(start, propertyEnd);
    declarations.push(describeDeclaration(written.startsWith('*') ? written.slice(1) : written, css.slice(valueStart, valueEnd)));
  });
  return declarations;
}

/** Postcss moves a leading `*` or `_` hack out of the property name, but the source offset still points at it. */
function declarationRange(declaration: Declaration, css: string): { start: number; propertyEnd: number; valueStart: number; valueEnd: number } {
  const start = declaration.source?.start?.offset as number;
  const end = declaration.source?.end?.offset as number;
  const propertyEnd = start + (css.startsWith(declaration.prop, start) ? 0 : 1) + declaration.prop.length;
  return {
    start,
    propertyEnd,
    valueStart: propertyEnd + (declaration.raws.between as string).length,
    valueEnd: css[end - 1] === ';' ? end - 1 : end
  };
}

function legacyDeclarations(css: string): CssDeclaration[] {
  return [...css.replace(LEGACY_COMMENT, '').matchAll(LEGACY_DECLARATION)].map(match => describeDeclaration(match[1], match[2]));
}

function describeDeclaration(property: string, written: string): CssDeclaration {
  const withoutComments = written.includes('/*') ? written.replace(COMMENT_OR_STRING, (_text, string?: string) => string ?? '') : written;
  const value = collapseCssWhitespace(withoutComments.trim());
  const declaration: CssDeclaration = { property: property.toLowerCase(), value, hasColorLiteral: false, lengths: [] };
  try {
    readLiterals(valueParser(value).nodes, declaration);
  } catch {
    // A stack overflow on absurd nesting must not stop validation.
    return declaration;
  }
  return declaration;
}

function readLiterals(nodes: valueParser.Node[], declaration: CssDeclaration): void {
  for (const node of nodes) {
    if (node.type !== 'word' && node.type !== 'function') continue;
    if (HEX_COLOR.test(node.value)) declaration.hasColorLiteral = true;
    for (const [length] of node.value.matchAll(LENGTH_IN_WORD)) declaration.lengths.push(length);
    if (node.type === 'function' && !isTokenReference(node)) {
      if (COLOR_FUNCTION_NAME.test(node.value)) declaration.hasColorLiteral = true;
      readLiterals(node.nodes, declaration);
    }
  }
}

/** A function in a fallback can hold a literal, so a `var()` counts as a reference only when each such function is one too. */
function isTokenReference(node: valueParser.FunctionNode): boolean {
  const name = node.value.toLowerCase();
  if (name.endsWith('url')) return true;
  return name.endsWith('var') && node.nodes.every(child => child.type !== 'function' || isTokenReference(child));
}

export function cssHasImport(css: string): boolean {
  return REFERENCE_TEXT.test(css) && readReferences(css).hasImport;
}

export function rewriteCssUrls(css: string, rewrite: (value: string) => string): string {
  if (!URL_TEXT.test(css)) return css;
  return applyCssEdits(css, readReferences(css).urls.map(url => ({ start: url.start, end: url.end, text: rewrite(url.value) })));
}

function readReferences(css: string): CssReferences {
  const sheet = sheetFor(css);
  sheet.references ??= readSheet(css, parsedReferences, legacyReferences);
  return sheet.references;
}

function legacyReferences(css: string): CssReferences {
  return {
    hasImport: LEGACY_IMPORT.test(css),
    urls: [...css.matchAll(LEGACY_URL)].map(match => ({ start: match.index, end: match.index + match[0].length, value: match[2].trim() }))
  };
}

function parsedReferences(root: Root, css: string): CssReferences | undefined {
  if (mayHideReference(root.source?.input as Input)) return undefined;
  const references: CssReferences = { urls: [], hasImport: false };
  root.walk(node => {
    if (node.type === 'decl') {
      const { valueStart, valueEnd } = declarationRange(node, css);
      readUrls(css, valueStart, valueEnd, references.urls);
    } else if (node.type === 'rule' || node.type === 'atrule') {
      if (node.type === 'atrule' && IMPORT_RULE_NAME.test(node.name)) references.hasImport = true;
      const [start, end] = selectorRange(node);
      readUrls(css, start, end, references.urls);
    }
  });
  return references;
}

/**
 * Postcss and browsers disagree on a string that runs over a line, on an escape, and on the body of an unquoted
 * `URL(`, so in such a sheet a comment or a string can hide a reference that a browser still loads.
 */
function mayHideReference(input: Input): boolean {
  const tokens = tokenize(input);
  let hidesText = false;
  let disagrees = URL_TOKEN_THAT_POSTCSS_SPLITS.test(input.css);
  while (!tokens.endOfFile()) {
    const [type, text] = tokens.nextToken();
    if (type === 'comment' || type === 'string') {
      hidesText ||= REFERENCE_TEXT.test(text);
      disagrees ||= type === 'string' && RAW_NEWLINE.test(text);
    } else {
      disagrees ||= text.includes('\\');
    }
  }
  return hidesText && disagrees;
}

function readUrls(css: string, start: number, end: number, urls: CssUrl[]): void {
  const text = css.slice(start, end);
  if (!URL_TEXT.test(text)) return;
  const visit = (nodes: valueParser.Node[]): void => {
    for (const node of nodes) {
      if (node.type !== 'function') continue;
      if (node.value.toLowerCase().endsWith('url')) {
        const url = describeUrl(node, text, start);
        if (url) urls.push(url);
      } else {
        visit(node.nodes);
      }
    }
  };
  visit(valueParser(text).nodes);
}

/** An empty `url()` or `url("")` asks for nothing, so it stays as written. */
function describeUrl(node: valueParser.FunctionNode, text: string, offset: number): CssUrl | undefined {
  const open = node.sourceIndex + node.value.length;
  const inner = text.slice(open + 1, node.unclosed ? node.sourceEndIndex : node.sourceEndIndex - 1);
  const body = inner.trim();
  const unquoted = QUOTED.test(body) ? body.slice(1, -1) : body;
  if (inner === '' || (body !== '' && unquoted === '')) return undefined;
  return { start: offset + open - 'url'.length, end: offset + node.sourceEndIndex, value: unquoted.trim() };
}

function selectorRange(node: Rule | AtRule): [number, number] {
  const start = node.source?.start?.offset as number;
  if (node.type === 'rule') {
    return [start, start + (node.raws.selector?.raw ?? node.selector).length];
  }
  const paramsStart = start + 1 + node.name.length + (node.raws.afterName ?? '').length;
  return [paramsStart, paramsStart + (node.raws.params?.raw ?? node.params).length];
}

export function rewriteCssAttributeSelectors(
  css: string,
  rewrite: (selector: CssAttributeSelector) => string | undefined,
  compoundedWith?: { name: string; value: string }
): string {
  const selectors = listAttributeSelectors(css);
  const compounds = compoundedWith && selectors
    .filter(selector => selector.name === compoundedWith.name && selector.value === compoundedWith.value)
    .map(selector => compoundRange(css, selector.start, selector.end));
  const edits: CssEdit[] = [];
  for (const selector of selectors) {
    if (compounds && !compounds.some(([start, end]) => start <= selector.start && selector.end <= end)) continue;
    const text = rewrite(selector);
    if (text !== undefined) edits.push({ start: selector.start, end: selector.end, text });
  }
  return applyCssEdits(css, edits);
}

function listAttributeSelectors(css: string): CssAttributeSelector[] {
  const sheet = sheetFor(css);
  sheet.selectorRanges ??= readSheet(css, parsedSelectorRanges, text => [[0, text.length]]);
  const selectors: CssAttributeSelector[] = [];
  for (const [start, end] of sheet.selectorRanges) {
    for (const match of css.slice(start, end).matchAll(ATTRIBUTE_SELECTOR_OR_SKIPPED_TEXT)) {
      if (match[1]) {
        selectors.push({ name: match[1], quote: match[2], value: match[3], start: start + match.index, end: start + match.index + match[0].length });
      }
    }
  }
  return selectors;
}

function parsedSelectorRanges(root: Root): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  root.walk(node => {
    if (node.type === 'rule' || node.type === 'atrule') ranges.push(selectorRange(node));
  });
  return ranges;
}

function compoundRange(css: string, anchorStart: number, anchorEnd: number): [number, number] {
  let start = anchorStart;
  let depth = 0;
  while (start > 0) {
    const character = css[start - 1];
    if (character === ')' || character === ']') depth += 1;
    else if (character === '(' || character === '[') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && COMPOUND_BOUNDARY.test(character)) break;
    start -= 1;
  }
  let end = anchorEnd;
  depth = 0;
  while (end < css.length) {
    const character = css[end];
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && COMPOUND_BOUNDARY.test(character)) break;
    end += 1;
  }
  return [start, end];
}

function applyCssEdits(css: string, edits: readonly CssEdit[]): string {
  if (edits.length === 0) return css;
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(css.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(css.slice(cursor));
  return parts.join('');
}

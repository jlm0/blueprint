/** The one reader of governed prototype CSS, so it stays a leaf module that imports nothing else from Blueprint. */
import { colorsNamed, parse as parseColor } from 'culori';
import type { AtRule, ChildNode, Declaration, Input, Root, Rule } from 'postcss';
import parse from 'postcss/lib/parse';
import tokenize from 'postcss/lib/tokenize';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';

export interface CssDeclaration {
  /** Lowercase, because CSS property names ignore case. */
  property: string;
  /** Holds any `!important`, because a finding quotes the value as written. */
  value: string;
  hasColorLiteral: boolean;
  /** Named colors in a property that paints, because the same word names something else in other properties. */
  namedColors: string[];
  lengths: string[];
  /** Each custom property that the value reads with `var()`. */
  variables: string[];
  important: boolean;
  /** A descriptor of an `@font-face` rule names the family that it declares, and paints nothing. */
  inFontFace: boolean;
}

export interface CssAttributeMatch {
  name: string;
  /** Absent when the selector tests only that the attribute exists. */
  value?: string;
}

/** One element in a selector: the simple selectors between two combinators. */
export interface CssCompound {
  attributes: CssAttributeMatch[];
  classes: string[];
  /** Each type selector and each `*` in this compound. */
  elements: string[];
  /** The branches of each `:is()` and `:where()` in this compound. `:not()` and `:has()` select nothing, so they stay out. */
  alternatives: CssSelector[][];
}

export interface CssSelector {
  text: string;
  /** Empty when the selector does not parse. */
  compounds: CssCompound[];
  /** `combinators[i]` joins `compounds[i]` and `compounds[i + 1]`. A descendant combinator is one space. */
  combinators: string[];
}

export interface CssRule {
  selectors: CssSelector[];
  /** A nested rule starts at its parent, so only a rule that is not nested must start at the boundary. */
  nested: boolean;
  declarations: CssDeclaration[];
}

export interface CssFontFace {
  family: string;
  /** Each file that `url()` names, as written. */
  urls: string[];
  /** Each `src` entry that is not a `url()`, such as `local()`. */
  otherSources: string[];
}

export interface FontValue {
  form: 'shorthand' | 'family-list' | 'length' | 'other';
  /** Each family that the value names in text. A `var()` names no family, because the token that it reads does. */
  families: string[];
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
  rules?: CssRule[] | null;
  fontFaces?: CssFontFace[];
  declarations?: CssDeclaration[];
  references?: CssReferences;
  selectorRanges?: Array<[number, number]>;
}

const MEMO_LIMIT = 2048;
const REFERENCE_TEXT = /url\(|@import/i;
const URL_TEXT = /url\(|image-set\(/i;
const IMAGE_SET_NAME = /^(-webkit-)?image-set$/i;
const IMPORT_RULE_NAME = /^import\b/i;
const HEX_COLOR = /#[0-9a-f]{3,8}\b/i;
const WHOLE_HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const COLOR_FUNCTION_NAME = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/i;
const LENGTH_IN_WORD = /(?<![\w.#-])-?(?:\d*\.)?\d+(?:px|rem|em)\b/gi;
const LENGTH_VALUE = /^-?(?:\d*\.)?\d+(?:px|rem|em)$/;
const IMPORTANT = /!\s*important\s*$/i;
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

const PAINTING_PROPERTIES = new Set([
  'accent-color',
  'backdrop-filter',
  'background',
  'background-color',
  'background-image',
  'border',
  'border-block',
  'border-block-color',
  'border-block-end',
  'border-block-end-color',
  'border-block-start',
  'border-block-start-color',
  'border-bottom',
  'border-bottom-color',
  'border-color',
  'border-inline',
  'border-inline-color',
  'border-inline-end',
  'border-inline-end-color',
  'border-inline-start',
  'border-inline-start-color',
  'border-left',
  'border-left-color',
  'border-right',
  'border-right-color',
  'border-top',
  'border-top-color',
  'box-shadow',
  'caret-color',
  'color',
  'column-rule',
  'column-rule-color',
  'fill',
  'filter',
  'flood-color',
  'lighting-color',
  'outline',
  'outline-color',
  'scrollbar-color',
  'stop-color',
  'stroke',
  'text-decoration',
  'text-decoration-color',
  'text-emphasis',
  'text-emphasis-color',
  'text-shadow'
]);
const COLOR_NAMES: ReadonlySet<string> = new Set(Object.keys(colorsNamed));
const COLOR_KEYWORDS: ReadonlySet<string> = new Set([
  'currentcolor',
  'accentcolor',
  'accentcolortext',
  'activetext',
  'buttonborder',
  'buttonface',
  'buttontext',
  'canvas',
  'canvastext',
  'field',
  'fieldtext',
  'graytext',
  'highlight',
  'highlighttext',
  'linktext',
  'mark',
  'marktext',
  'selecteditem',
  'selecteditemtext',
  'visitedtext'
]);
const SELECTOR_ALTERNATIVES = new Set([':is', ':where', ':matches', ':any', ':-webkit-any', ':-moz-any']);
const LENGTH_FUNCTIONS = new Set(['calc', 'clamp', 'max', 'min']);
const TRACK_KEYWORDS = new Set(['auto', 'max-content', 'min-content']);
const FLEX_UNITS = new Set(['fr']);
const REPEAT_COUNT_KEYWORDS = new Set(['auto-fill', 'auto-fit']);
const GRADIENT_FUNCTION = /^(?:repeating-)?(?:linear|radial|conic)-gradient$/;
const GRID_LINE_NAMES = /\[[^\]]*\]/g;
const LENGTH_UNITS = new Set([
  'cap', 'ch', 'cm', 'cqb', 'cqh', 'cqi', 'cqmax', 'cqmin', 'cqw', 'dvb', 'dvh', 'dvi', 'dvmax', 'dvmin', 'dvw', 'em', 'ex', 'ic', 'in', 'lh',
  'lvb', 'lvh', 'lvi', 'lvmax', 'lvmin', 'lvw', 'mm', 'pc', 'pt', 'px', 'q', 'rem', 'rlh', 'svb', 'svh', 'svi', 'svmax', 'svmin', 'svw', 'vb',
  'vh', 'vi', 'vmax', 'vmin', 'vw'
]);
const TIME_UNITS = new Set(['ms', 's']);
const EASING_KEYWORDS = new Set(['ease', 'ease-in', 'ease-in-out', 'ease-out', 'linear', 'step-end', 'step-start']);
const EASING_FUNCTIONS = new Set(['cubic-bezier', 'linear', 'steps']);
const FONT_SHORTHAND_LEAD = new Set(['bold', 'bolder', 'condensed', 'expanded', 'italic', 'lighter', 'normal', 'oblique', 'small-caps']);

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
    const parent = declaration.parent as Rule | AtRule | undefined;
    const inFontFace = parent?.type === 'atrule' && parent.name.toLowerCase() === 'font-face';
    declarations.push({ ...describeDeclaration(written.startsWith('*') ? written.slice(1) : written, css.slice(valueStart, valueEnd)), inFontFace });
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
  const declaration: CssDeclaration = {
    property: property.toLowerCase(),
    value,
    hasColorLiteral: false,
    namedColors: [],
    lengths: [],
    variables: [],
    important: IMPORTANT.test(value),
    inFontFace: false
  };
  try {
    const nodes = valueParser(value).nodes;
    readLiterals(nodes, declaration);
    readVariables(nodes, declaration.variables);
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
    if (node.type === 'word' && COLOR_NAMES.has(node.value.toLowerCase()) && paintsColor(declaration.property)) {
      declaration.namedColors.push(node.value);
    }
    for (const [length] of node.value.matchAll(LENGTH_IN_WORD)) declaration.lengths.push(length);
    if (node.type === 'function' && !isTokenReference(node)) {
      if (COLOR_FUNCTION_NAME.test(node.value)) declaration.hasColorLiteral = true;
      readLiterals(node.nodes, declaration);
    }
  }
}

function paintsColor(property: string): boolean {
  return property.startsWith('--') || PAINTING_PROPERTIES.has(property);
}

function readVariables(nodes: valueParser.Node[], variables: string[]): void {
  for (const node of nodes) {
    if (node.type !== 'function') continue;
    const first = node.nodes[0];
    if (node.value.toLowerCase() === 'var' && first?.type === 'word' && !variables.includes(first.value)) variables.push(first.value);
    readVariables(node.nodes, variables);
  }
}

/** A function in a fallback can hold a literal, so a `var()` counts as a reference only when each such function is one too. */
function isTokenReference(node: valueParser.FunctionNode): boolean {
  const name = node.value.toLowerCase();
  if (name.endsWith('url')) return true;
  return name.endsWith('var') && node.nodes.every(child => child.type !== 'function' || isTokenReference(child));
}

/** `null` means that the sheet does not parse, so no rule can be read from it. */
export function listCssRules(css: string): readonly CssRule[] | null {
  const sheet = sheetFor(css);
  if (sheet.rules === undefined) {
    try {
      sheet.rules = parsedRules(parse(css, { map: false }) as Root);
    } catch {
      sheet.rules = null;
    }
  }
  return sheet.rules;
}

function parsedRules(root: Root): CssRule[] {
  const rules: CssRule[] = [];
  root.walkRules(rule => {
    const parent = rule.parent as ChildNode | Root;
    if (parent.type === 'atrule' && (parent as AtRule).name.toLowerCase().endsWith('keyframes')) return;
    rules.push({
      selectors: rule.selectors.map(readSelector),
      nested: isNestedRule(rule),
      declarations: (rule.nodes ?? []).filter((node): node is Declaration => node.type === 'decl').map(node => describeDeclaration(node.prop, `${node.value}${node.important ? ' !important' : ''}`))
    });
  });
  return rules;
}

function isNestedRule(rule: Rule): boolean {
  for (let parent = rule.parent as ChildNode | Root | undefined; parent; parent = parent.parent as ChildNode | Root | undefined) {
    if (parent.type === 'rule') return true;
  }
  return false;
}

function readSelector(text: string): CssSelector {
  const written = collapseCssWhitespace(text.trim());
  try {
    const parsed = selectorParser().astSync(text);
    return parsed.nodes.length === 1 ? partsOf(written, parsed.nodes[0]) : { text: written, compounds: [], combinators: [] };
  } catch {
    return { text: written, compounds: [], combinators: [] };
  }
}

function partsOf(text: string, selector: selectorParser.Selector): CssSelector {
  const empty = (): CssCompound => ({ attributes: [], classes: [], elements: [], alternatives: [] });
  const compounds = [empty()];
  const combinators: string[] = [];
  for (const node of selector.nodes) {
    const compound = compounds[compounds.length - 1];
    if (node.type === 'combinator') {
      compounds.push(empty());
      combinators.push(node.value.trim() || ' ');
    } else if (node.type === 'class') compound.classes.push(node.value);
    else if (node.type === 'tag' || node.type === 'universal') compound.elements.push(node.value);
    else if (node.type === 'attribute') compound.attributes.push({ name: node.attribute.toLowerCase(), ...(node.value === undefined ? {} : { value: node.value }) });
    else if (node.type === 'pseudo' && SELECTOR_ALTERNATIVES.has(node.value.toLowerCase())) {
      compound.alternatives.push(node.nodes.map(branch => partsOf(collapseCssWhitespace(String(branch).trim()), branch)));
    }
  }
  return { text, compounds, combinators };
}

/** Where each selector of each rule that is not nested and not in `@keyframes` starts, for an edit that keeps the rest of the sheet as written. */
export function listCssSelectorStarts(css: string): Array<{ selector: CssSelector; start: number }> {
  const starts: Array<{ selector: CssSelector; start: number }> = [];
  let root: Root;
  try {
    root = parse(css, { map: false }) as Root;
  } catch {
    return starts;
  }
  root.walkRules(rule => {
    const parent = rule.parent as ChildNode | Root;
    if (isNestedRule(rule) || rule.raws.selector || (parent.type === 'atrule' && (parent as AtRule).name.toLowerCase().endsWith('keyframes'))) return;
    const offset = rule.source?.start?.offset as number;
    let cursor = 0;
    for (const text of rule.selectors) {
      const index = rule.selector.indexOf(text, cursor);
      cursor = index + text.length;
      starts.push({ selector: readSelector(text), start: offset + index });
    }
  });
  return starts;
}

/**
 * Replaces the value of each declaration that `rewrite` answers for, and keeps every other byte. The rewrite skips a font face,
 * which cannot read var(), and a value with a comment, whose comment it cannot keep. A sheet that does not parse stays as it is.
 */
export function rewriteCssValues(css: string, rewrite: (property: string, value: string) => string | undefined): string {
  let root: Root;
  try {
    root = parse(css, { map: false }) as Root;
  } catch {
    return css;
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  root.walkDecls(declaration => {
    if (declaration.parent?.type === 'atrule' && (declaration.parent as AtRule).name.toLowerCase() === 'font-face') return;
    if (declaration.raws.value) return;
    const next = rewrite(declaration.prop.toLowerCase(), declaration.value);
    if (next === undefined || next === declaration.value) return;
    const start = declarationRange(declaration, css).valueStart;
    if (!css.startsWith(declaration.value, start)) return;
    edits.push({ start, end: start + declaration.value.length, text: next });
  });
  return edits.length === 0 ? css : applyCssEdits(css, edits.sort((left, right) => left.start - right.start));
}

/** Replaces each color literal and each length word of a value through `replace`. Text in url(), in var(), and in a string stays. */
export function replaceValueLiterals(value: string, replace: (literal: string, kind: 'color' | 'length') => string | undefined): string {
  const parsed = valueParser(value);
  const visit = (nodes: valueParser.Node[]): void => {
    for (const [index, node] of nodes.entries()) {
      if (node.type === 'word') {
        const kind = WHOLE_HEX_COLOR.test(node.value) ? 'color' : LENGTH_VALUE.test(node.value) ? 'length' : undefined;
        const next = kind && replace(node.value, kind);
        if (next) node.value = next;
      } else if (node.type === 'function') {
        const name = node.value.toLowerCase();
        if (name === 'url' || name === 'var') continue;
        const whole = COLOR_FUNCTION_NAME.test(node.value) ? replace(valueParser.stringify(node), 'color') : undefined;
        if (whole) {
          nodes[index] = { type: 'word', value: whole, sourceIndex: node.sourceIndex, sourceEndIndex: node.sourceEndIndex };
        } else {
          visit(node.nodes);
        }
      }
    }
  };
  visit(parsed.nodes);
  return parsed.toString();
}

export function insertIntoCss(css: string, inserts: ReadonlyArray<{ at: number; text: string }>): string {
  return applyCssEdits(css, [...inserts].sort((left, right) => left.at - right.at).map(({ at, text }) => ({ start: at, end: at, text })));
}

export function listCssFontFaces(css: string): readonly CssFontFace[] {
  const sheet = sheetFor(css);
  if (!sheet.fontFaces) {
    const fontFaces: CssFontFace[] = [];
    try {
      (parse(css, { map: false }) as Root).walkAtRules(/^font-face$/i, rule => {
        const face: CssFontFace = { family: '', urls: [], otherSources: [] };
        rule.walkDecls(declaration => {
          const property = declaration.prop.toLowerCase();
          if (property === 'font-family') face.family = unquoted(declaration.value.trim());
          if (property === 'src') readFontSources(declaration.value, face);
        });
        fontFaces.push(face);
      });
    } catch {
      fontFaces.length = 0;
    }
    sheet.fontFaces = fontFaces;
  }
  return sheet.fontFaces;
}

function readFontSources(value: string, face: CssFontFace): void {
  for (const node of valueParser(value).nodes) {
    if (node.type !== 'function') continue;
    const name = node.value.toLowerCase();
    if (name === 'url') {
      const first = node.nodes[0];
      if (first) face.urls.push(first.value.trim());
    } else if (name !== 'format' && name !== 'tech') {
      face.otherSources.push(valueParser.stringify(node));
    }
  }
}

function unquoted(text: string): string {
  return QUOTED.test(text) ? text.slice(1, -1) : text;
}

function isUnit(node: valueParser.Node, units: ReadonlySet<string>): boolean {
  if (node.type !== 'word') return false;
  const parsed = valueParser.unit(node.value);
  return parsed !== false && units.has(parsed.unit.toLowerCase());
}

function isZero(node: valueParser.Node): boolean {
  if (node.type !== 'word') return false;
  const parsed = valueParser.unit(node.value);
  return parsed !== false && parsed.unit === '' && Number(parsed.number) === 0;
}

function isPercentage(node: valueParser.Node): boolean {
  if (node.type !== 'word') return false;
  const parsed = valueParser.unit(node.value);
  return parsed !== false && parsed.unit === '%';
}

function isLengthNode(node: valueParser.Node): boolean {
  return isUnit(node, LENGTH_UNITS) || isZero(node) || (node.type === 'function' && LENGTH_FUNCTIONS.has(node.value.toLowerCase()));
}

function significantNodes(value: string): valueParser.Node[] {
  return valueParser(value).nodes.filter(node => node.type !== 'space' && node.type !== 'comment');
}

/** Splits a value at each comma that is not in a function. */
function commaSegments(value: string): valueParser.Node[][] {
  const segments: valueParser.Node[][] = [[]];
  for (const node of valueParser(value).nodes) {
    if (node.type === 'div' && node.value === ',') segments.push([]);
    else if (node.type !== 'space' && node.type !== 'comment') segments[segments.length - 1].push(node);
  }
  return segments;
}

/** A presentation attribute holds a CSS value, so it reads as the property `fill`. A `url()` names a paint server and holds no color. */
export function readPaintValue(value: string): Pick<CssDeclaration, 'hasColorLiteral' | 'namedColors' | 'variables'> {
  return describeDeclaration('fill', value.replace(/url\([^)]*\)/gi, ''));
}

export function isCssColorValue(value: string): boolean {
  const nodes = significantNodes(value);
  return nodes.length === 1 && isColorNode(nodes[0]);
}

function isColorNode(node: valueParser.Node): boolean {
  if (node.type === 'function' && node.value.toLowerCase() === 'color-mix') return isColorMix(node);
  if (node.type !== 'word' && node.type !== 'function') return false;
  if (node.type === 'word' && COLOR_KEYWORDS.has(node.value.toLowerCase())) return true;
  return parseColor(valueParser.stringify(node)) !== undefined;
}

function isColorMix(node: valueParser.FunctionNode): boolean {
  const segments = commaSegments(valueParser.stringify(node.nodes));
  if (segments.length !== 3 || segments[0][0]?.value.toLowerCase() !== 'in') return false;
  return segments.slice(1).every(segment => segment.length <= 2 && segment.length >= 1 && segment.some(isColorNode) && segment.every(part => isColorNode(part) || isPercentage(part)));
}

/** A color, or a gradient that `background-image: var()` paints. */
export function isCssColorTokenValue(value: string): boolean {
  if (isCssColorValue(value)) return true;
  const nodes = significantNodes(value);
  if (nodes.length !== 1 || nodes[0].type !== 'function' || !GRADIENT_FUNCTION.test(nodes[0].value.toLowerCase())) return false;
  return commaSegments(valueParser.stringify(nodes[0].nodes)).length >= 2;
}

/** A length, a percentage, `0`, or a math function. */
export function isCssLengthValue(value: string): boolean {
  const nodes = significantNodes(value);
  return nodes.length === 1 && (isLengthNode(nodes[0]) || isPercentage(nodes[0]));
}

/** A length, a plain number such as a stroke width, or a grid track list. */
export function isCssSizeValue(value: string): boolean {
  if (isCssLengthValue(value)) return true;
  const nodes = significantNodes(value);
  if (nodes.length === 1 && nodes[0].type === 'word' && isPlainNumber(nodes[0])) return true;
  const tracks = significantNodes(value.replace(GRID_LINE_NAMES, ' '));
  if (tracks.length === 1 && tracks[0].type === 'word' && TRACK_KEYWORDS.has(tracks[0].value.toLowerCase())) return false;
  return tracks.length > 0 && tracks.every(isGridTrack);
}

function isPlainNumber(node: valueParser.Node): boolean {
  if (node.type !== 'word') return false;
  const parsed = valueParser.unit(node.value);
  return parsed !== false && parsed.unit === '';
}

function isTrackBreadth(node: valueParser.Node): boolean {
  if (node.type === 'word' && TRACK_KEYWORDS.has(node.value.toLowerCase())) return true;
  return isLengthNode(node) || isPercentage(node) || isUnit(node, FLEX_UNITS);
}

function isGridTrack(node: valueParser.Node): boolean {
  if (node.type !== 'function') return isTrackBreadth(node);
  const segments = commaSegments(valueParser.stringify(node.nodes));
  const name = node.value.toLowerCase();
  if (name === 'minmax') return segments.length === 2 && segments.every(segment => segment.length === 1 && isTrackBreadth(segment[0]));
  if (name === 'fit-content') return segments.length === 1 && segments[0].length === 1 && (isLengthNode(segments[0][0]) || isPercentage(segments[0][0]));
  if (name === 'repeat') return segments.length === 2 && isRepeatCount(segments[0]) && segments[1].length > 0 && segments[1].every(isGridTrack);
  return isLengthNode(node);
}

function isRepeatCount(segment: readonly valueParser.Node[]): boolean {
  if (segment.length !== 1 || segment[0].type !== 'word') return false;
  return REPEAT_COUNT_KEYWORDS.has(segment[0].value.toLowerCase()) || isPlainNumber(segment[0]);
}

export function isCssShadowValue(value: string): boolean {
  const nodes = significantNodes(value);
  if (nodes.length === 1 && nodes[0].type === 'word' && nodes[0].value.toLowerCase() === 'none') return true;
  return commaSegments(value).every(segment => {
    let lengths = 0;
    let colors = 0;
    for (const node of segment) {
      if (isLengthNode(node)) lengths += 1;
      else if (isColorNode(node) || (node.type === 'function' && node.value.toLowerCase() === 'var')) colors += 1;
      else if (node.type !== 'word' || node.value.toLowerCase() !== 'inset') return false;
    }
    return lengths >= 2 && lengths <= 4 && colors <= 1;
  });
}

/** A duration, an easing, or one of each, as a `transition` reads them. */
export function isCssMotionValue(value: string): boolean {
  const nodes = significantNodes(value);
  if (nodes.length === 0) return false;
  let times = 0;
  let easings = 0;
  for (const node of nodes) {
    if (isUnit(node, TIME_UNITS)) times += 1;
    else if (node.type === 'word' && EASING_KEYWORDS.has(node.value.toLowerCase())) easings += 1;
    else if (node.type === 'function' && EASING_FUNCTIONS.has(node.value.toLowerCase())) easings += 1;
    else return false;
  }
  return times <= 2 && easings <= 1;
}

/** Reads a typography token: a `font` shorthand, a family list, or a length such as letter spacing. */
export function readFontValue(value: string): FontValue {
  const segments = commaSegments(value);
  if (segments.length === 1 && segments[0].length === 1 && isLengthNode(segments[0][0]) && segments[0][0].type === 'word') {
    return { form: 'length', families: [] };
  }
  const first = segments[0];
  const sizeIndex = first.findIndex(node => isUnit(node, LENGTH_UNITS) || isPercentage(node));
  if (sizeIndex >= 0) return readFontShorthand(first, sizeIndex, segments.slice(1));
  const families = segments.map(familyName);
  return families.some(family => family === undefined) ? { form: 'other', families: [] } : { form: 'family-list', families: families.filter((family): family is string => family !== '') };
}

const FONT_FAMILY_WORD = /^-?[a-zA-Z_][\w-]*$/;

function readFontShorthand(first: valueParser.Node[], sizeIndex: number, rest: valueParser.Node[][]): FontValue {
  const leadIsValid = first.slice(0, sizeIndex).every(node => node.type === 'word' && (FONT_SHORTHAND_LEAD.has(node.value.toLowerCase()) || valueParser.unit(node.value) !== false));
  let familyStart = sizeIndex + 1;
  if (first[familyStart]?.type === 'div' && first[familyStart].value === '/') familyStart += 2;
  const families = [first.slice(familyStart), ...rest].map(familyName);
  if (!leadIsValid || first.length <= familyStart || families.some(family => family === undefined)) return { form: 'other', families: [] };
  return { form: 'shorthand', families: families.filter((family): family is string => family !== '') };
}

/** `''` for a `var()`, and `undefined` when the nodes cannot name a family. */
function familyName(nodes: valueParser.Node[]): string | undefined {
  if (nodes.length === 1 && nodes[0].type === 'function' && nodes[0].value.toLowerCase() === 'var') return '';
  if (nodes.length === 1 && nodes[0].type === 'string') return nodes[0].value;
  if (nodes.length === 0 || !nodes.every(node => node.type === 'word' && FONT_FAMILY_WORD.test(node.value))) return undefined;
  return nodes.map(node => node.value).join(' ');
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
        if (IMAGE_SET_NAME.test(node.value)) urls.push(...imageSetUrls(node, start));
        visit(node.nodes);
      }
    }
  };
  visit(valueParser(text).nodes);
}

/** The browser loads a string in `image-set()` as a `url()`. */
function imageSetUrls(node: valueParser.FunctionNode, offset: number): CssUrl[] {
  return node.nodes.flatMap(child => (child.type === 'string' && child.value.trim() !== ''
    ? [{ start: offset + child.sourceIndex, end: offset + child.sourceEndIndex, value: child.value.trim() }]
    : []));
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

const BOUNDARY_ATTRIBUTES: ReadonlySet<string> = new Set(['data-blueprint-primitive', 'data-blueprint-component', 'data-blueprint-screen']);

/** The boundary attribute in the compound of each selector, so that a reader can tell which boundary an axis selector means. */
function selectorsWithBoundary(css: string, attribute: string, value: string): Array<{ selector: CssAttributeSelector; boundary?: CssAttributeSelector }> {
  const selectors = listAttributeSelectors(css);
  const owners = selectors.filter(selector => BOUNDARY_ATTRIBUTES.has(selector.name)).map(selector => ({ selector, range: compoundRange(css, selector.start, selector.end) }));
  return selectors
    .filter(selector => selector.name === attribute && selector.value === value)
    .map(selector => ({ selector, boundary: owners.find(({ range: [start, end] }) => start <= selector.start && selector.end <= end)?.selector }));
}

/** True when a selector tests the attribute with no boundary in its compound, so it can mean any boundary. */
export function hasUnownedAttributeSelector(css: string, attribute: string, value: string): boolean {
  return selectorsWithBoundary(css, attribute, value).some(({ boundary }) => boundary === undefined);
}

/** Renames an attribute value on each selector of one boundary. A selector with no boundary in its compound belongs to the boundary that owns the sheet. */
export function renameBoundaryAttributeValue(
  css: string,
  rename: { attribute: string; from: string; to: string },
  boundary: { name: string; value: string },
  ownsFile: boolean
): string {
  const edits: CssEdit[] = [];
  for (const { selector, boundary: owner } of selectorsWithBoundary(css, rename.attribute, rename.from)) {
    const belongs = owner ? owner.name === boundary.name && owner.value === boundary.value : ownsFile;
    if (belongs) edits.push({ start: selector.start, end: selector.end, text: `[${rename.attribute}=${selector.quote || '"'}${rename.to}${selector.quote || '"'}]` });
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

import { collapseCssWhitespace, isCssLengthLiteral, listCssDeclarations, replaceValueLiterals, rewriteCssValues } from './css';
import { applyMarkupEdits, listSvgTags } from './markup';
import { currentJson, listActiveCandidates, listBoundaries } from './migrate-style';
import { asArray, asObject } from './raw-json';
import { isExcepted, lengthCategory, maskProperties, tokenLengthCategory } from './style-lint';
import { SVG_PAINT_ATTRIBUTES } from './style-rules';
import type { DesignToken, LocalValueException } from './types';

interface TokenIndex {
  colors: Map<string, string[]>;
  typography: Map<string, string[]>;
  lengths: Map<string, string[]>;
}

interface RepairCounts {
  colors: number;
  colorSheets: number;
  sizes: number;
  sizeSheets: number;
  lengths: number;
  lengthSheets: number;
  paints: number;
  paintSources: number;
}

function normalized(value: string): string {
  return collapseCssWhitespace(value.trim()).toLowerCase();
}

function add(index: Map<string, string[]>, key: string, styleRef: string): void {
  index.set(key, [...(index.get(key) ?? []), styleRef]);
}

/** A sheet can declare a token again in a scope, so its value there is not the value in tokens.json. */
function redeclaredVariables(sheets: Iterable<string>): Set<string> {
  const declared = new Set<string>();
  for (const css of sheets) {
    for (const declaration of listCssDeclarations(css)) {
      if (declaration.property.startsWith('--')) declared.add(declaration.property);
    }
  }
  return declared;
}

function readTokenIndex(tokensFile: unknown, redeclared: ReadonlySet<string>): TokenIndex {
  const index: TokenIndex = { colors: new Map(), typography: new Map(), lengths: new Map() };
  const tokens = asArray(asObject(tokensFile).tokenGroups).flatMap(group => asArray(asObject(group).tokens)).map(asObject);
  for (const token of tokens) {
    const { type, value, styleRef } = token;
    if (typeof value !== 'string' || typeof styleRef !== 'string' || redeclared.has(styleRef)) continue;
    const key = normalized(value);
    if (type === 'color') add(index.colors, key, styleRef);
    if (type === 'typography') add(index.typography, key, styleRef);
    const category = tokenLengthCategory[type as DesignToken['type']];
    if (category && isCssLengthLiteral(key) && Number.parseFloat(key) !== 0) add(index.lengths, `${category}:${key}`, styleRef);
  }
  return index;
}

/** A value that two tokens hold names no one token, so the agent chooses. */
function soleToken(index: ReadonlyMap<string, string[]>, key: string): string | undefined {
  const styleRefs = index.get(key);
  return styleRefs?.length === 1 ? `var(${styleRefs[0]})` : undefined;
}

function repairStylesheet(css: string, tokens: TokenIndex, exceptions: readonly LocalValueException[][], counts: RepairCounts): string {
  let colors = 0;
  let sizes = 0;
  let lengths = 0;
  const repaired = rewriteCssValues(css, (property, value) => {
    if (property.startsWith('--') || exceptions.some(list => isExcepted(list, property, collapseCssWhitespace(value)))) return undefined;
    if (property === 'font-size' || property === 'font') {
      const token = soleToken(tokens.typography, normalized(value));
      if (token) sizes += 1;
      return token;
    }
    const category = lengthCategory(property);
    return replaceValueLiterals(value, (literal, kind) => {
      if (kind === 'color') {
        if (maskProperties.has(property)) return undefined;
        const token = soleToken(tokens.colors, normalized(literal));
        if (token) colors += 1;
        return token;
      }
      const token = category && soleToken(tokens.lengths, `${category}:${normalized(literal)}`);
      if (token) lengths += 1;
      return token;
    });
  });
  counts.colors += colors;
  counts.colorSheets += colors > 0 ? 1 : 0;
  counts.sizes += sizes;
  counts.sizeSheets += sizes > 0 ? 1 : 0;
  counts.lengths += lengths;
  counts.lengthSheets += lengths > 0 ? 1 : 0;
  return repaired;
}

function repairSource(html: string, tokens: TokenIndex, counts: RepairCounts): string {
  const edits = listSvgTags(html).flatMap(tag => tag.attributes.flatMap(attribute => {
    if (!SVG_PAINT_ATTRIBUTES.has(attribute.name) || !attribute.hasValue) return [];
    const token = soleToken(tokens.colors, normalized(attribute.value));
    return token ? [{ start: attribute.valueStart, end: attribute.valueEnd, text: token }] : [];
  }));
  if (edits.length === 0) return html;
  counts.paints += edits.length;
  counts.paintSources += 1;
  return applyMarkupEdits(html, edits);
}

/** Each file that a rule reads, with the exceptions of its owners. A frozen baseline and a history record stay as they are, because no rule reads them. */
function readRepairTargets(current: ReadonlyMap<string, string>): { sheets: Map<string, LocalValueException[][]>; sources: Set<string> } {
  const sheets = new Map<string, LocalValueException[][]>();
  const sources = new Set<string>();
  for (const boundary of [...listBoundaries(current), ...listActiveCandidates(current)]) {
    sources.add(boundary.source);
    for (const styleRef of boundary.styles) sheets.set(styleRef, [...(sheets.get(styleRef) ?? []), boundary.exceptions]);
  }
  return { sheets, sources };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Rewrites a literal to `var()` of a token only when exactly one token of the matching type holds that value. A token sits on
 * `:root` with that value, so the computed value stays. Each other literal stays for the rule to report, with its `Fix:`.
 */
export function normalizeLiteralValues(files: ReadonlyMap<string, string>, writes: Map<string, string>, changes: string[]): void {
  const current = new Map([...files, ...writes]);
  if (!current.has('tokens.json')) return;
  const { sheets, sources } = readRepairTargets(current);
  const texts = [...current].filter(([file]) => file.startsWith('prototype/') && file.endsWith('.css')).map(([, css]) => css);
  const tokens = readTokenIndex(currentJson(files, writes, 'tokens.json'), redeclaredVariables(texts));
  const counts: RepairCounts = { colors: 0, colorSheets: 0, sizes: 0, sizeSheets: 0, lengths: 0, lengthSheets: 0, paints: 0, paintSources: 0 };
  for (const [styleRef, exceptions] of [...sheets].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const css = current.get(styleRef);
    if (css === undefined) continue;
    const repaired = repairStylesheet(css, tokens, exceptions, counts);
    if (repaired !== css) writes.set(styleRef, repaired);
  }
  for (const source of [...sources].sort()) {
    const html = current.get(source);
    if (html === undefined) continue;
    const repaired = repairSource(html, tokens, counts);
    if (repaired !== html) writes.set(source, repaired);
  }
  if (counts.paints > 0) changes.push(`Rewrote ${plural(counts.paints, 'SVG paint attribute')} in ${plural(counts.paintSources, 'source')} to var() of the one color token that holds each value.`);
  if (counts.colors > 0) changes.push(`Rewrote ${plural(counts.colors, 'literal color')} in ${plural(counts.colorSheets, 'stylesheet')} to var() of the one color token that holds each value.`);
  if (counts.sizes > 0) changes.push(`Rewrote ${plural(counts.sizes, 'raw font size')} in ${plural(counts.sizeSheets, 'stylesheet')} to var() of the one typography token that holds each value.`);
  if (counts.lengths > 0) changes.push(`Rewrote ${plural(counts.lengths, 'restated length')} in ${plural(counts.lengthSheets, 'stylesheet')} to var() of the one token of that type that holds each value.`);
}

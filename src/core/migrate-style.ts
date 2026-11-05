import { insertIntoCss, listCssSelectorStarts, type CssCompound } from './css';
import { prototypeFileCopies } from './exploration';
import { deriveBrandFonts } from './font-rules';
import { attributeWithValue, elementCloseIndex, listMarkupTokens, listOpenTags, type OpenTag } from './markup';
import { asArray, asObject, isObject, parseJsonFile, serializeJson, stringList, type RawObject } from './raw-json';
import { compoundStartsAt, type BoundaryRoot } from './style-rules';
import type { BrandFont, LocalValueException } from './types';

export interface BoundarySources {
  kind: BoundaryRoot['kind'];
  id: string;
  source: string;
  styles: string[];
  exceptions: LocalValueException[];
}

interface CandidateSources extends BoundarySources {
  replaces: Array<[target: string, written: string]>;
}

export function currentJson(files: ReadonlyMap<string, string>, writes: ReadonlyMap<string, string>, file: string): RawObject {
  return asObject(JSON.parse(writes.get(file) ?? files.get(file) ?? '{}'));
}

function stylesheetTexts(files: ReadonlyMap<string, string>, writes: ReadonlyMap<string, string>): Map<string, string> {
  const texts = new Map<string, string>();
  for (const file of [...new Set([...files.keys(), ...writes.keys()])].sort()) {
    if (file.startsWith('prototype/') && file.endsWith('.css')) texts.set(file, writes.get(file) ?? files.get(file) ?? '');
  }
  return texts;
}

function readBrandFont(entry: unknown): BrandFont | undefined {
  if (typeof entry === 'string' && entry.trim()) return { family: entry.trim(), source: 'system', assets: [] };
  if (!isObject(entry) || typeof entry.family !== 'string' || !entry.family.trim()) return undefined;
  return { family: entry.family, source: entry.source === 'asset' ? 'asset' : 'system', assets: stringList(entry.assets) };
}

function typographyValues(tokens: RawObject): string[] {
  return asArray(tokens.tokenGroups).flatMap(group => asArray(asObject(group).tokens)).map(asObject)
    .filter(token => token.type === 'typography' && typeof token.value === 'string')
    .map(token => token.value as string);
}

/** Fills `fonts` in brand.json from the font tokens and the @font-face rules, and keeps each entry that it already holds. */
export function normalizeBrandFonts(files: ReadonlyMap<string, string>, writes: Map<string, string>, changes: string[]): void {
  if (!files.has('brand.json') && !writes.has('brand.json')) return;
  const brand = currentJson(files, writes, 'brand.json');
  const existing = asArray(brand.fonts).map(readBrandFont).filter((font): font is BrandFont => font !== undefined);
  const fonts = deriveBrandFonts(existing, typographyValues(currentJson(files, writes, 'tokens.json')), stylesheetTexts(files, writes));
  if (JSON.stringify(fonts) === JSON.stringify(brand.fonts)) return;
  const ordered: RawObject = {};
  for (const [key, value] of Object.entries(brand)) {
    if (key === 'fonts') continue;
    ordered[key] = value;
    if (key === 'marks') ordered.fonts = fonts;
  }
  ordered.fonts ??= fonts;
  writes.set('brand.json', serializeJson(ordered));
  changes.push(`brand.json: fonts now lists ${fonts.length} famil${fonts.length === 1 ? 'y' : 'ies'} from the font tokens and the @font-face rules.`);
}

function isLocalValueException(value: unknown): value is LocalValueException {
  return isObject(value) && typeof value.property === 'string' && typeof value.value === 'string';
}

/** Each candidate of an active exploration reads as the screen that it targets, with the exceptions of that screen. A frozen baseline and a closed exploration stay as they were saved. */
export function listActiveCandidates(files: ReadonlyMap<string, string>): CandidateSources[] {
  const screens = listBoundaries(files).filter(boundary => boundary.kind === 'screen');
  return [...files.keys()].filter(name => /^explorations\/[^/]+\.json$/.test(name)).sort().flatMap(file => {
    const exploration = asObject(parseJsonFile(files, file).exploration);
    if (exploration.lifecycle !== 'active') return [];
    const id = String(asObject(exploration.target).screenId);
    const screen = screens.find(item => item.id === id);
    return asArray(exploration.candidates).flatMap((candidate): CandidateSources[] => {
      const prototype = asObject(asObject(candidate).prototype);
      if (typeof prototype.source !== 'string') return [];
      const copy = { source: prototype.source, styles: stringList(prototype.styles) };
      return [{ kind: 'screen', id, ...copy, exceptions: screen?.exceptions ?? [], replaces: screen ? prototypeFileCopies(screen, copy) : [] }];
    });
  });
}

/** Promotion writes a candidate file over its canonical file, so a candidate can scope a sheet to its screen only when no other boundary owns the canonical sheet. */
function candidatesWithOwnSheets(candidates: readonly CandidateSources[], canonical: readonly BoundarySources[]): BoundarySources[] {
  const owners = (file: string): number => canonical.filter(boundary => boundary.source === file || boundary.styles.includes(file)).length;
  return candidates.flatMap(({ replaces, ...candidate }) => {
    const ownCopies = replaces.filter(([target]) => owners(target) <= 1);
    if (ownCopies[0]?.[1] !== candidate.source) return [];
    return [{ ...candidate, styles: ownCopies.slice(1).map(([, written]) => written) }];
  });
}

export function listBoundaries(files: ReadonlyMap<string, string>): BoundarySources[] {
  const read = (file: string, key: string, kind: BoundaryRoot['kind']): BoundarySources[] => {
    if (!files.has(file)) return [];
    return asArray(parseJsonFile(files, file)[key]).map(asObject).flatMap(item => {
      const prototype = asObject(item.prototype);
      if (typeof prototype.source !== 'string') return [];
      return [{ kind, id: String(item.id), source: prototype.source, styles: stringList(prototype.styles), exceptions: asArray(prototype.localValueExceptions).filter(isLocalValueException) }];
    });
  };
  return [...read('primitives.json', 'primitives', 'primitive'), ...read('components.json', 'components', 'component'), ...read('screens.json', 'screens', 'screen')];
}

function classesOf(tag: OpenTag): string[] {
  return (attributeWithValue(tag, 'class')?.value ?? '').split(/\s+/).filter(Boolean);
}

/** The root tag when one element holds the whole source, so that each element of the source is the root or is inside it. */
function soleRoot(html: string, boundary: BoundarySources): OpenTag | undefined {
  const tokens = listMarkupTokens(html);
  const rootIndex = tokens.findIndex(token => token.kind === 'open');
  if (rootIndex < 0) return undefined;
  const root = tokens[rootIndex] as OpenTag;
  const close = elementCloseIndex(tokens, rootIndex);
  if (close < 0 || tokens.slice(close + 1).some(token => token.kind === 'open')) return undefined;
  return attributeWithValue(root, `data-blueprint-${boundary.kind}`)?.value === boundary.id ? root : undefined;
}

const SELECTOR_TYPE = /^(?:\*|[a-zA-Z][\w-]*)/;
const DOCUMENT_ELEMENTS = new Set(['html', 'body']);

function compoundClasses(compound: CssCompound): string[] {
  return [
    ...compound.classes,
    ...compound.alternatives.flatMap(branches => branches.flatMap(branch => branch.compounds.flatMap(compoundClasses)))
  ];
}

/**
 * A class selector of a stylesheet with one owner can start at the root of that owner, so long as it still reaches each element it reached.
 * A document holds one screen, so each element is its root or inside it. A reusable sheet reaches further, so its class must be used only in its own source.
 * `:where()` adds no specificity, so the cascade of the sheet stays the same and the look does not change.
 */
export function normalizeSelectorRoots(files: ReadonlyMap<string, string>, writes: Map<string, string>, changes: string[]): void {
  const current = new Map([...files, ...writes]);
  const canonical = listBoundaries(current);
  const boundaries = [...canonical, ...candidatesWithOwnSheets(listActiveCandidates(current), canonical)];
  const styleOwners = new Map<string, number>();
  const sourceOwners = new Map<string, number>();
  for (const boundary of boundaries) {
    sourceOwners.set(boundary.source, (sourceOwners.get(boundary.source) ?? 0) + 1);
    for (const style of new Set(boundary.styles)) styleOwners.set(style, (styleOwners.get(style) ?? 0) + 1);
  }
  const classSources = new Map<string, Set<string>>();
  for (const [file, text] of current) {
    if (!file.endsWith('.html')) continue;
    for (const tag of listOpenTags(text)) {
      for (const name of classesOf(tag)) classSources.set(name, (classSources.get(name) ?? new Set()).add(file));
    }
  }
  let selectors = 0;
  let sheets = 0;
  for (const boundary of boundaries) {
    const html = current.get(boundary.source);
    if (html === undefined || sourceOwners.get(boundary.source) !== 1) continue;
    const root = soleRoot(html, boundary);
    if (!root) continue;
    const attribute = `[data-blueprint-${boundary.kind}="${boundary.id}"]`;
    const owner: BoundaryRoot = { kind: boundary.kind, id: boundary.id, isSurfaceRoot: boundary.kind === 'primitive' && root.attributes.some(item => item.name === 'data-blueprint-surface') };
    const rootClasses = new Set(classesOf(root));
    const inner = new Set(listOpenTags(html).filter(tag => tag.start !== root.start).flatMap(classesOf));
    for (const style of boundary.styles) {
      const css = current.get(style);
      if (css === undefined || styleOwners.get(style) !== 1) continue;
      const inserts: Array<{ at: number; text: string }> = [];
      for (const { selector, start } of listCssSelectorStarts(css)) {
        const first = selector.compounds[0];
        if (!first || compoundStartsAt(first, owner)) continue;
        const lead = SELECTOR_TYPE.exec(css.slice(start))?.[0] ?? '';
        const names = compoundClasses(first);
        const isScreen = boundary.kind === 'screen';
        if (isScreen && (DOCUMENT_ELEMENTS.has(lead.toLowerCase()) || selector.text.startsWith(':'))) continue;
        if (!isScreen && (names.length === 0 || names.some(name => [...(classSources.get(name) ?? [])].some(file => file !== boundary.source)))) continue;
        const onRoot = names.some(name => rootClasses.has(name));
        const insideRoot = names.length > 0 && !onRoot;
        if (insideRoot) {
          inserts.push({ at: start, text: `:where(${attribute}) ` });
        } else {
          const reachesInside = isScreen || names.some(name => inner.has(name));
          inserts.push({ at: start + lead.length, text: reachesInside ? `:where(${attribute}, ${attribute} *)` : `:where(${attribute})` });
        }
      }
      if (inserts.length === 0) continue;
      writes.set(style, insertIntoCss(css, inserts));
      current.set(style, writes.get(style) as string);
      selectors += inserts.length;
      sheets += 1;
    }
  }
  if (selectors > 0) {
    changes.push(`Started ${selectors} selector${selectors === 1 ? '' : 's'} at the root of their boundary with :where(), in ${sheets} stylesheet${sheets === 1 ? '' : 's'}. The look does not change.`);
  }
}

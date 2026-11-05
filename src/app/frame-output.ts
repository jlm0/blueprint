import { type CssCompound, type CssOutputItem, type CssSelector, listCssOutputItems } from '../core/css';
import { type OpenTag, listPossibleOpenTags } from '../core/markup';
import type { CanvasProjectBundle, FramePreset } from '../core/types';
import { type PrototypeDocumentOutput, createPrototypeDocumentCompiler } from '../prototype/compiler';
import { attributeVariables, tokenReadClosure } from './frame-token-reads';
import { textHash } from './text-hash';

export interface FrameOutputTarget {
  key: string;
  screenId: string;
  state: string;
  preset: FramePreset;
}

/** A frame keeps its preset id across an edit, so the old document must take the old values of that preset. */
export function frameTargetIn(bundle: CanvasProjectBundle, target: FrameOutputTarget): FrameOutputTarget {
  const preset = bundle.manifest.framePresets.find(candidate => candidate.id === target.preset.id);
  return preset ? { ...target, preset } : target;
}

/** The element diff reads the computed style of these parts, so it can answer for a rule on them. */
const PSEUDO_ELEMENTS_THAT_THE_DIFF_READS: readonly string[] = ['::before', '::after', '::placeholder', '::marker'];
/** The HTML parser adds these elements inside a table, so the markup does not name them. */
const ELEMENTS_THAT_A_TABLE_ADDS: readonly string[] = ['tbody', 'tr', 'colgroup'];

const itemDigestsBySheet = new WeakMap<readonly CssOutputItem[], string[]>();

function itemDigests(items: readonly CssOutputItem[]): string[] {
  let digests = itemDigestsBySheet.get(items);
  if (!digests) {
    digests = items.map(item => textHash([item.text]));
    itemDigestsBySheet.set(items, digests);
  }
  return digests;
}

function normalized(value: string): string {
  return value.toLowerCase();
}

/** A character reference can spell any part of an attribute value, and the markup reader does not decode it. */
function holdsReference(value: string): boolean {
  return value.includes('&');
}

interface IndexedElement {
  tag: string;
  classes: ReadonlySet<string>;
  anyClass: boolean;
  attributes: ReadonlyMap<string, string>;
}

function indexedElement(tag: OpenTag): IndexedElement {
  const classValue = tag.attributes.find(attribute => attribute.name === 'class')?.value ?? '';
  return {
    tag: normalized(tag.name),
    classes: new Set(classValue.split(/\s+/).filter(Boolean)),
    anyClass: holdsReference(classValue),
    attributes: new Map([...tag.attributes].reverse().map(attribute => [attribute.name, attribute.value]))
  };
}

function elementMatches(element: IndexedElement, compound: CssCompound): boolean {
  return compound.elements.every(name => name === '*' || normalized(name) === element.tag)
    && compound.classes.every(name => element.anyClass || element.classes.has(name))
    && compound.attributes.every(attribute => {
      const value = element.attributes.get(attribute.name);
      if (value === undefined) return false;
      if (attribute.value === undefined || attribute.operator !== '=' || holdsReference(value)) return true;
      return normalized(value) === normalized(attribute.value);
    });
}

function addToIndex(index: Map<string, IndexedElement[]>, key: string, element: IndexedElement): void {
  const list = index.get(key);
  if (list) list.push(element);
  else index.set(key, [element]);
}

/** The check reads each compound alone, because a rule that it calls live costs one extra rebuild and a rule that it calls dead by mistake leaves a stale frame. */
export function createElementIndex(
  body: string,
  state: string,
  known: Map<string, IndexedElement> = new Map()
): { canMatch: (selector: CssSelector) => boolean; tags: readonly OpenTag[] } {
  const tags = listPossibleOpenTags(body);
  const elements = new Set<IndexedElement>();
  for (const name of ['head', 'meta', 'title', 'style', 'body']) {
    elements.add({ tag: name, classes: new Set(), anyClass: false, attributes: new Map() });
  }
  elements.add({ tag: 'html', classes: new Set(), anyClass: false, attributes: new Map([['lang', 'en'], ['data-blueprint-state', state]]) });
  for (const tag of tags) {
    const text = body.slice(tag.start, tag.end);
    let element = known.get(text);
    if (!element) {
      element = indexedElement(tag);
      known.set(text, element);
    }
    elements.add(element);
    if (element.tag === 'image') elements.add({ ...element, tag: 'img' });
    if (element.tag === 'table') {
      for (const name of ELEMENTS_THAT_A_TABLE_ADDS) elements.add({ tag: name, classes: new Set(), anyClass: false, attributes: new Map() });
    }
  }
  const byTag = new Map<string, IndexedElement[]>();
  const byClass = new Map<string, IndexedElement[]>();
  const byAttribute = new Map<string, IndexedElement[]>();
  const anyClass: IndexedElement[] = [];
  for (const element of elements) {
    addToIndex(byTag, element.tag, element);
    for (const name of element.classes) addToIndex(byClass, name, element);
    if (element.anyClass) anyClass.push(element);
    for (const name of element.attributes.keys()) addToIndex(byAttribute, name, element);
  }
  const compoundCanMatch = (compound: CssCompound): boolean => {
    if (!compound.alternatives.every(branches => branches.some(branch => branch.compounds.every(compoundCanMatch)))) return false;
    if (anyClass.some(element => elementMatches(element, compound))) return true;
    let shortest: IndexedElement[] | undefined;
    const consider = (list: IndexedElement[] | undefined): void => {
      const candidates = list ?? [];
      if (!shortest || candidates.length < shortest.length) shortest = candidates;
    };
    for (const name of compound.elements) if (name !== '*') consider(byTag.get(normalized(name)));
    for (const name of compound.classes) consider(byClass.get(name));
    for (const attribute of compound.attributes) consider(byAttribute.get(attribute.name));
    return shortest ? shortest.some(element => elementMatches(element, compound)) : true;
  };
  const answers = new Map<CssSelector, boolean>();
  return {
    canMatch: selector => {
      let answer = answers.get(selector);
      if (answer === undefined) {
        answer = selector.compounds.every(compoundCanMatch);
        answers.set(selector, answer);
      }
      return answer;
    },
    tags
  };
}

function diffReads(selector: CssSelector): boolean {
  return selector.compounds.length > 0 && selector.compounds.every(compound => compound.pseudoElements.every(name => PSEUDO_ELEMENTS_THAT_THE_DIFF_READS.includes(name)));
}

/** The part of a hash that names output that a computed style cannot show: file bytes, keyframes, and other pseudo-elements. */
export function frameOutputOutsideRules(hash: string): string {
  return hash.slice(hash.lastIndexOf(':') + 1);
}

function tokenCssParts(bundle: CanvasProjectBundle, reads: Iterable<string>): string[] {
  return [...tokenReadClosure(bundle, reads)].sort(([left], [right]) => (left < right ? -1 : 1)).map(([ref, value]) => `${ref}:${value}`);
}

function assetPart(bundle: CanvasProjectBundle, assetRef: string): string {
  const asset = bundle.prototypeAssetContents[assetRef];
  return `${assetRef}:${'base64' in asset ? textHash([asset.base64]) : asset.sha256}`;
}

/** What one compile gives to a frame hash. It holds no token value, so an edit of token values compiles nothing. */
export interface FrameShape {
  digest: string;
  outsideRulesDigest: string;
  reads: string[];
  readsOutsideRules: string[];
  unknown: boolean;
  assetRefs: string[];
}

function readFrameShape(output: PrototypeDocumentOutput, safeArea: FramePreset['safeArea'], knownElements: Map<string, IndexedElement>): FrameShape {
  const { canMatch, tags } = createElementIndex(output.body, output.state, knownElements);
  const parts = [output.state, JSON.stringify(safeArea ?? null), output.body];
  const outsideRules: string[] = [];
  const reads = new Set<string>();
  const readsOutsideRules = new Set<string>();
  let unknown = false;
  for (const sheet of output.sheets) {
    const items = listCssOutputItems(sheet);
    if (!items) {
      unknown = true;
      parts.push(sheet);
      outsideRules.push(sheet);
      continue;
    }
    const digests = itemDigests(items);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.selectors && !item.selectors.some(canMatch)) continue;
      parts.push(digests[index]);
      for (const variable of item.variables) reads.add(variable);
      if (!item.selectors?.every(diffReads)) {
        outsideRules.push(digests[index]);
        for (const variable of item.variables) readsOutsideRules.add(variable);
      }
    }
  }
  for (const tag of tags) {
    if (tag.name === 'style') unknown = true;
    for (const attribute of tag.attributes) {
      const read = attributeVariables(attribute);
      if (read.unknown) unknown = true;
      for (const variable of read.variables) reads.add(variable);
    }
  }
  return { digest: textHash(parts), outsideRulesDigest: textHash(outsideRules), reads: [...reads], readsOutsideRules: [...readsOutsideRules], unknown, assetRefs: output.assetRefs };
}

/** Each document holds every token and every rule of each sheet that it loads, so a raw hash of the document changes in frames that paint nothing new. */
export function createFrameOutputHasher(bundle: CanvasProjectBundle, shapes = new Map<string, FrameShape>()): (target: FrameOutputTarget) => string {
  const compile = createPrototypeDocumentCompiler(bundle);
  const allTokens = bundle.tokens.tokenGroups.flatMap(group => group.tokens.map(token => token.styleRef));
  const knownElements = new Map<string, IndexedElement>();
  return target => {
    try {
      let shape = shapes.get(target.key);
      if (!shape) {
        const output = compile({ target: { kind: 'screen', id: target.screenId }, state: target.state, framePreset: target.preset });
        shape = readFrameShape(output, target.preset.safeArea, knownElements);
        shapes.set(target.key, shape);
      }
      const assetParts = shape.assetRefs.map(assetRef => assetPart(bundle, assetRef));
      return [
        textHash([shape.digest, ...tokenCssParts(bundle, shape.unknown ? allTokens : shape.reads), ...assetParts]),
        textHash([shape.outsideRulesDigest, ...tokenCssParts(bundle, shape.unknown ? allTokens : shape.readsOutsideRules), ...assetParts])
      ].join(':');
    } catch (error) {
      return `error:${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

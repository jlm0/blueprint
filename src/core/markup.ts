/** The one reader of governed prototype HTML. This module imports nothing else from Blueprint. */
import { QuoteType, Tokenizer } from 'htmlparser2';

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const FOREIGN_ROOTS = new Set(['svg', 'math']);
const HTML_INTEGRATION_POINTS = new Set(['foreignobject', 'desc', 'title', 'annotation-xml', 'mi', 'mo', 'mn', 'ms', 'mtext']);
const USE_ELEMENT_NAME = /blueprint-use/i;
const SECTION_MARKER_NAME = /data-blueprint-section/i;
const POSSIBLE_TAG_READ_LIMIT_PER_CHARACTER = 8;
const END_TAG_ATTRIBUTE_TEXT = /[^\t\n\f\r /]/;

export interface MarkupAttribute {
  /** Lowercase, because HTML attribute names ignore case. */
  name: string;
  value: string;
  hasValue: boolean;
  quote: '"' | "'" | '';
  nameStart: number;
  nameEnd: number;
  valueStart: number;
  valueEnd: number;
  end: number;
}

export interface OpenTag {
  kind: 'open';
  /** Lowercase, because HTML tag names ignore case. */
  name: string;
  start: number;
  nameEnd: number;
  end: number;
  selfClosing: boolean;
  attributes: MarkupAttribute[];
}

export interface CloseTag {
  kind: 'close';
  name: string;
  start: number;
  end: number;
}

export interface MarkupSpan {
  kind: 'text' | 'comment';
  start: number;
  end: number;
}

export type MarkupToken = OpenTag | CloseTag | MarkupSpan;

/** A list of edits must stay in document order, because each splice continues from the end of the last one. */
export interface MarkupEdit {
  start: number;
  end: number;
  text: string;
}

export interface UseElement {
  start: number;
  end: number;
  attributes: string;
  children: string;
}

export interface ScannedUse extends UseElement {
  hasNestedUse: boolean;
  openIndex: number;
  closeIndex: number;
}

export interface SectionTag {
  start: number;
  end: number;
  id: string;
}

/** One `<blueprint-use>` found in markup, with the content it passes to each slot. */
export interface UsePlacement {
  kind: string;
  ref: string;
  attributes: Map<string, string>;
  slots: Map<string, string>;
}

/** The first construct that a browser and this tokenizer read in different ways, so that a lint can refuse the source and not trust its tags. */
export interface MarkupDisagreement {
  kind: 'cdata-outside-foreign-content' | 'end-tag-attributes';
  start: number;
}

interface MarkupScan {
  html: string;
  tokens: MarkupToken[];
  openTags: OpenTag[];
  disagreement?: MarkupDisagreement;
  /** A later source or wrapper can still complete a tag that the end of the text cuts off. */
  cutOffOpen?: OpenTag;
  cutOffClose?: string;
  possibleOpenTags?: OpenTag[];
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function tokenize(html: string, stopAt?: (tag: OpenTag) => boolean): MarkupScan {
  const scan: MarkupScan = { html, tokens: [], openTags: [] };
  const { tokens, openTags } = scan;
  const foreign: string[] = [];
  let tag: OpenTag | undefined;
  let attribute: MarkupAttribute | undefined;
  let tailStart = 0;

  const finishOpenTag = (end: number, selfClosing: boolean): void => {
    const finished = tag as OpenTag;
    finished.end = end + 1;
    finished.selfClosing = selfClosing;
    tokens.push(finished);
    openTags.push(finished);
    tag = undefined;
    tailStart = end + 1;
    if (!selfClosing && (FOREIGN_ROOTS.has(finished.name) || (foreign.length > 0 && HTML_INTEGRATION_POINTS.has(finished.name)))) {
      foreign.push(finished.name);
    }
    if (stopAt?.(finished)) {
      tokenizer.pause();
    }
  };
  const pushInnerSpan = (start: number, end: number, offset: number): void => {
    tokens.push({ kind: 'comment', start, end: end - offset });
    tailStart = end + 1;
  };
  const inForeignContent = (): boolean => foreign.length > 0 && FOREIGN_ROOTS.has(foreign[foreign.length - 1]);
  const disagree = (kind: MarkupDisagreement['kind'], start: number): void => {
    scan.disagreement ??= { kind, start };
  };

  const tokenizer = new Tokenizer({ decodeEntities: false }, {
    onopentagname(start, end) {
      tag = { kind: 'open', name: html.slice(start, end).toLowerCase(), start: start - 1, nameEnd: end, end: -1, selfClosing: false, attributes: [] };
      attribute = undefined;
    },
    onattribname(start, end) {
      attribute = { name: html.slice(start, end).toLowerCase(), value: '', hasValue: false, quote: '', nameStart: start, nameEnd: end, valueStart: end, valueEnd: end, end };
      (tag as OpenTag).attributes.push(attribute);
    },
    onattribdata(start, end) {
      const current = attribute as MarkupAttribute;
      current.value = html.slice(start, end);
      current.valueStart = start;
      current.valueEnd = end;
    },
    onattribend(quote, end) {
      const current = attribute as MarkupAttribute;
      current.hasValue = quote !== QuoteType.NoValue;
      current.quote = quote === QuoteType.Double ? '"' : quote === QuoteType.Single ? "'" : '';
      current.end = end;
    },
    onopentagend(end) {
      finishOpenTag(end, false);
    },
    onselfclosingtag(end) {
      finishOpenTag(end, true);
    },
    onclosetag(start, end) {
      const name = html.slice(start, end).toLowerCase();
      const closeEnd = html.indexOf('>', end);
      if (closeEnd === -1) {
        scan.cutOffClose = name;
        return;
      }
      tokens.push({ kind: 'close', name, start: start - 2, end: closeEnd + 1 });
      tailStart = closeEnd + 1;
      if (END_TAG_ATTRIBUTE_TEXT.test(html.slice(end, closeEnd))) disagree('end-tag-attributes', start - 2);
      const depth = foreign.lastIndexOf(name);
      if (depth !== -1) {
        foreign.length = depth;
      }
    },
    ontext(start, end) {
      if (start >= 0 && start < end) {
        tokens.push({ kind: 'text', start, end });
      }
    },
    oncomment(start, end, offset) {
      if (!inForeignContent() && html.startsWith('<![CDATA[', start - 2)) disagree('cdata-outside-foreign-content', start - 2);
      pushInnerSpan(start, end, offset);
    },
    oncdata(start, end, offset) {
      if (!inForeignContent()) disagree('cdata-outside-foreign-content', start - '<![CDATA['.length);
      pushInnerSpan(start, end, offset);
    },
    ondeclaration(_start, end) {
      tailStart = end + 1;
    },
    onprocessinginstruction() {},
    onattribentity() {},
    ontextentity() {},
    onend() {},
    isInForeignContext: inForeignContent
  });

  tokenizer.write(html);
  if (!tokenizer.running) {
    return scan;
  }
  tokenizer.end();
  if (tag) {
    if (attribute && !attribute.hasValue && html.slice(attribute.nameEnd).trimStart().startsWith('=')) {
      attribute.hasValue = true;
    }
    scan.cutOffOpen = tag;
    return scan;
  }
  const lastTagStart = html.lastIndexOf('<');
  if (scan.cutOffClose === undefined && lastTagStart >= tailStart) {
    if (isAsciiLetter(html.charCodeAt(lastTagStart + 1))) {
      const name = html.slice(lastTagStart + 1).toLowerCase();
      scan.cutOffOpen = { kind: 'open', name, start: lastTagStart, nameEnd: html.length, end: -1, selfClosing: false, attributes: [] };
    } else if (html[lastTagStart + 1] === '/' && isAsciiLetter(html.charCodeAt(lastTagStart + 2))) {
      scan.cutOffClose = html.slice(lastTagStart + 2).toLowerCase();
    }
  }
  return scan;
}

let lastScan: MarkupScan | undefined;

/** Compile passes read the same text again when the pass before them changed nothing. */
function scanMarkup(html: string): MarkupScan {
  if (lastScan?.html !== html) {
    lastScan = tokenize(html);
  }
  return lastScan;
}

export function listMarkupTokens(html: string): readonly MarkupToken[] {
  return scanMarkup(html).tokens;
}

export function listOpenTags(html: string): readonly OpenTag[] {
  return scanMarkup(html).openTags;
}

export function markupDisagreement(html: string): MarkupDisagreement | undefined {
  return scanMarkup(html).disagreement;
}

function holdsSlotContent(token: OpenTag): boolean {
  return token.name === 'blueprint-use' || token.attributes.some(attribute => attribute.name === 'data-blueprint-slot');
}

/** Each tag outside a `<blueprint-use>` and outside a declared slot, because the reusable rules on the content of its slots. */
export function listTagsOutsideSlots(html: string): readonly OpenTag[] {
  const tokens = listMarkupTokens(html);
  const tags: OpenTag[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'open') continue;
    if (!holdsSlotContent(token)) {
      tags.push(token);
      continue;
    }
    const close = elementCloseIndex(tokens, index);
    if (close > index) index = close;
  }
  return tags;
}

/** Each `<svg>` outside a `<blueprint-use>` and outside a declared slot, because the `accepts` list of a slot rules on the graphic in it. */
export function listSvgsOutsideSlots(html: string): readonly OpenTag[] {
  const tokens = listMarkupTokens(html);
  const svgs: OpenTag[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'open') continue;
    const inSlot = holdsSlotContent(token);
    if (token.name === 'svg' && !inSlot) svgs.push(token);
    if (inSlot || token.name === 'svg') {
      const close = elementCloseIndex(tokens, index);
      if (close > index) index = close;
    }
  }
  return svgs;
}

/** Each tag inside an `<svg>`, and the `<svg>` itself, because a drawing keeps its color in attributes. */
export function listSvgTags(html: string): readonly OpenTag[] {
  const tokens = listMarkupTokens(html);
  const tags: OpenTag[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'open' || token.name !== 'svg') continue;
    const close = elementCloseIndex(tokens, index);
    const end = close > index ? close : index;
    for (const inner of tokens.slice(index, end + 1)) {
      if (inner.kind === 'open') tags.push(inner);
    }
    index = end;
  }
  return tags;
}

/** The scan stops at the match, because a caller can hold a whole document. */
export function firstOpenTag(html: string, accepts: (tag: OpenTag) => boolean = () => true): OpenTag | undefined {
  return tokenize(html, accepts).openTags.find(accepts);
}

function moveTag(tag: OpenTag, by: number): OpenTag {
  return {
    ...tag,
    start: tag.start + by,
    nameEnd: tag.nameEnd + by,
    end: tag.end === -1 ? -1 : tag.end + by,
    attributes: tag.attributes.map(attribute => ({
      ...attribute,
      nameStart: attribute.nameStart + by,
      nameEnd: attribute.nameEnd + by,
      valueStart: attribute.valueStart + by,
      valueEnd: attribute.valueEnd + by,
      end: attribute.end + by
    }))
  };
}

function readTagAt(html: string, start: number): OpenTag | undefined {
  const { openTags, cutOffOpen } = tokenize(html.slice(start), () => true);
  const tag = openTags[0] ?? cutOffOpen;
  return tag && moveTag(tag, start);
}

/**
 * A security check reads a tag at each `<` and letter in the text, because a browser and this tokenizer can
 * disagree about where a comment, raw text, CDATA, an attribute value, or a close tag ends. The tags can
 * overlap, so the read limit keeps hostile text from costing more than a set multiple of its length.
 */
export function listPossibleOpenTags(html: string): readonly OpenTag[] {
  const scan = scanMarkup(html);
  if (scan.possibleOpenTags) {
    return scan.possibleOpenTags;
  }
  const realTags = new Map(scan.openTags.map(tag => [tag.start, tag]));
  const found: OpenTag[] = [];
  let readsLeft = POSSIBLE_TAG_READ_LIMIT_PER_CHARACTER * html.length;
  for (let start = html.indexOf('<'); start !== -1; start = html.indexOf('<', start + 1)) {
    if (!isAsciiLetter(html.charCodeAt(start + 1))) {
      continue;
    }
    let tag = realTags.get(start);
    if (!tag) {
      tag = readTagAt(html, start);
      readsLeft -= (tag && tag.end !== -1 ? tag.end : html.length) - start;
      if (readsLeft < 0) {
        throw new Error('The markup holds too many unclosed tags for Blueprint to check. Fix: close each tag with ">".');
      }
    }
    if (tag) {
      found.push(tag);
    }
  }
  scan.possibleOpenTags = found;
  return found;
}

export function attributeWithValue(tag: OpenTag, name: string): MarkupAttribute | undefined {
  return tag.attributes.find(attribute => attribute.name === name && attribute.hasValue);
}

/** Blueprint reads only quoted values as its own vocabulary. */
export function quotedAttribute(tag: OpenTag, name: string): MarkupAttribute | undefined {
  return tag.attributes.find(attribute => attribute.name === name && attribute.quote);
}

export function elementCloseIndex(tokens: readonly MarkupToken[], openIndex: number): number {
  const open = tokens[openIndex] as OpenTag;
  if (open.selfClosing || VOID_ELEMENTS.has(open.name)) {
    return -1;
  }
  let depth = 1;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'open') {
      if (token.name === open.name && !token.selfClosing) {
        depth += 1;
      }
    } else if (token.kind === 'close' && token.name === open.name) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

export function applyMarkupEdits(html: string, edits: readonly MarkupEdit[]): string {
  if (edits.length === 0) {
    return html;
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(html.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(html.slice(cursor));
  return parts.join('');
}

export function setTagAttribute(openTag: string, name: string, serialized: string): string {
  const tag = firstOpenTag(openTag) as OpenTag;
  const existing = quotedAttribute(tag, name);
  return existing
    ? `${openTag.slice(0, existing.nameStart)}${serialized}${openTag.slice(existing.end)}`
    : `${openTag.slice(0, tag.end - 1)} ${serialized}${openTag.slice(tag.end - 1)}`;
}

export function attributeRemovalStart(html: string, attribute: MarkupAttribute): number {
  let start = attribute.nameStart;
  while (start > 0 && html[start - 1].trim() === '') {
    start -= 1;
  }
  return start;
}

export function isDefaultSlot(tag: OpenTag): boolean {
  return tag.name === 'slot' && !attributeWithValue(tag, 'name');
}

export function hasDefaultSlot(source: string): boolean {
  return listOpenTags(source).some(isDefaultSlot);
}

export function outerSvgMarkup(source: string): string {
  const { tokens, openTags } = scanMarkup(source);
  const open = openTags.find(tag => tag.name === 'svg');
  for (let index = tokens.length - 1; open && index >= 0; index -= 1) {
    const token = tokens[index];
    if (token.kind === 'close' && token.name === 'svg') {
      return token.start > open.start ? source.slice(open.start, token.end) : '';
    }
  }
  return '';
}

export function useTagAttributes(html: string, tag: OpenTag): string {
  return html.slice(tag.nameEnd, tag.selfClosing ? html.lastIndexOf('/', tag.end - 1) : tag.end - 1);
}

function readUseAt(html: string, scan: MarkupScan, openIndex: number): ScannedUse {
  const { tokens } = scan;
  const open = tokens[openIndex] as OpenTag;
  const attributes = useTagAttributes(html, open);
  if (open.selfClosing) {
    return { start: open.start, end: open.end, attributes, children: '', hasNestedUse: false, openIndex, closeIndex: openIndex };
  }
  let depth = 1;
  let hasNestedUse = false;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'open' && token.name === 'blueprint-use') {
      hasNestedUse = true;
      if (!token.selfClosing) {
        depth += 1;
      }
    } else if (token.kind === 'close' && token.name === 'blueprint-use') {
      depth -= 1;
      if (depth === 0) {
        return { start: open.start, end: token.end, attributes, children: html.slice(open.end, token.start), hasNestedUse, openIndex, closeIndex: index };
      }
    }
  }
  if (scan.cutOffOpen?.name === 'blueprint-use' || scan.cutOffClose === 'blueprint-use') {
    throw new Error('Prototype source contains an unclosed HTML tag. Fix: close the cut-off tag with ">", or remove it.');
  }
  throw new Error('Prototype source contains an unclosed <blueprint-use> element. Fix: add the matching </blueprint-use> tag.');
}

/** A generator, so that a fault in a later use never hides the error of an earlier one. */
export function* iterateUseElements(html: string): Generator<ScannedUse> {
  if (!USE_ELEMENT_NAME.test(html)) {
    return;
  }
  const scan = scanMarkup(html);
  const { tokens } = scan;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'open' && token.name === 'blueprint-use') {
      const use = readUseAt(html, scan, index);
      yield use;
      index = use.closeIndex;
    }
  }
  if (scan.cutOffOpen?.name === 'blueprint-use') {
    throw new Error('Prototype source contains an unclosed HTML tag. Fix: close the cut-off tag with ">", or remove it.');
  }
}

/** Every `<blueprint-use>` in the markup, outer placements before the ones nested in their slots. */
export function listUsePlacements(markup: string): UsePlacement[] {
  const placements: UsePlacement[] = [];
  for (const use of iterateUseElements(markup)) {
    const attributes = parseUseAttributes(use.attributes, 'markup');
    placements.push({
      kind: attributes.get('kind') ?? '',
      ref: attributes.get('ref') ?? '',
      attributes,
      slots: collectInvocationSlots(use.children)
    });
    placements.push(...listUsePlacements(use.children));
  }
  return placements;
}

/** The default content each slot of a reusable source holds, keyed by slot id; a bare `<slot>` is `default`. */
export function sourceSlotContents(source: string): Map<string, string> {
  const contents = new Map<string, string>();
  const { tokens } = scanMarkup(source);
  const append = (id: string, content: string): void => {
    contents.set(id, `${contents.get(id) ?? ''}${content}`);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const id = token.kind === 'open' ? quotedAttribute(token, 'data-blueprint-slot')?.value : undefined;
    if (id) {
      const closeIndex = elementCloseIndex(tokens, index);
      append(id, closeIndex === -1 ? '' : source.slice((token as OpenTag).end, tokens[closeIndex].start));
    }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'open' || token.name !== 'slot') {
      continue;
    }
    const id = quotedAttribute(token, 'name')?.value || 'default';
    if (token.selfClosing) {
      append(id, '');
      continue;
    }
    const closeIndex = elementCloseIndex(tokens, index);
    if (closeIndex !== -1) {
      append(id, source.slice(token.end, tokens[closeIndex].start));
      index = closeIndex;
    }
  }
  return contents;
}

/** What slot content is: `text`, `graphic`, `brand-mark`, or the `primitive:<id>` and `component:<id>` it places. */
export function slotContentAccepts(content: string): string[] {
  const accepts = new Set<string>();
  const scan = scanMarkup(content);
  const { tokens } = scan;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'text') {
      if (content.slice(token.start, token.end).replaceAll('&nbsp;', ' ').trim()) {
        accepts.add('text');
      }
    } else if (token.kind === 'open') {
      if (token.name === 'blueprint-use') {
        const use = readUseAt(content, scan, index);
        const attributes = parseUseAttributes(use.attributes, 'slot content');
        const kind = attributes.get('kind');
        accepts.add(kind === 'brand-mark' ? 'brand-mark' : `${kind}:${attributes.get('ref')}`);
        index = use.closeIndex;
      } else if (token.name === 'img' || token.name === 'picture') {
        accepts.add('graphic');
      } else if (token.name === 'svg') {
        const closeIndex = elementCloseIndex(tokens, index);
        if (closeIndex !== -1) {
          accepts.add('graphic');
          index = closeIndex;
        }
      }
    }
  }
  return [...accepts].sort();
}

/** Slot attributes inside a nested `<blueprint-use>` belong to that use, so the scan skips over it. */
export function collectInvocationSlots(children: string): Map<string, string> {
  const slots = new Map<string, string>();
  const scan = scanMarkup(children);
  const { tokens } = scan;
  let remaining = '';
  let cursor = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'open') {
      continue;
    }
    if (token.name === 'blueprint-use') {
      index = readUseAt(children, scan, index).closeIndex;
      continue;
    }
    const name = quotedAttribute(token, 'slot')?.value;
    if (!name) {
      continue;
    }
    const closeIndex = elementCloseIndex(tokens, index);
    const end = closeIndex === -1 ? token.end : tokens[closeIndex].end;
    appendSlot(slots, name, stripSlotAttribute(children.slice(token.start, end)));
    remaining += children.slice(cursor, token.start);
    cursor = end;
    if (closeIndex !== -1) {
      index = closeIndex;
    }
  }
  remaining += children.slice(cursor);
  if (remaining.trim()) {
    appendSlot(slots, 'default', remaining.trim());
  }
  return slots;
}

export function findElementEnd(html: string, tagName: string, openStart: number, openEnd: number): number {
  if (VOID_ELEMENTS.has(tagName.toLowerCase())) {
    return openEnd + 1;
  }
  const { tokens } = tokenize(html.slice(openStart));
  const closeIndex = elementCloseIndex(tokens, 0);
  return closeIndex === -1 ? openEnd + 1 : openStart + tokens[closeIndex].end;
}

export function appendSlot(slots: Map<string, string>, name: string, content: string): void {
  const previous = slots.get(name);
  slots.set(name, previous ? `${previous}${content}` : content);
}

export function stripSlotAttribute(markup: string): string {
  const tag = firstOpenTag(markup);
  const slot = tag && quotedAttribute(tag, 'slot');
  return slot ? `${markup.slice(0, attributeRemovalStart(markup, slot))}${markup.slice(slot.end)}` : markup;
}

export function findFirstUseElement(html: string): UseElement | undefined {
  const iterator = iterateUseElements(html);
  const first = iterator.next();
  if (first.done) {
    return undefined;
  }
  const { start, end, attributes, children } = first.value;
  return { start, end, attributes, children };
}

export function findTagEnd(html: string, start: number): number {
  const tag = firstOpenTag(html.slice(start));
  if (!tag) {
    throw new Error('Prototype source contains an unclosed HTML tag. Fix: close the cut-off tag with ">", or remove it.');
  }
  return start + tag.end - 1;
}

export function parseUseAttributes(attributes: string, boundary: string): Map<string, string> {
  const malformed = `${boundary} contains a malformed or unquoted <blueprint-use> attribute. Fix: write each attribute of this <blueprint-use> as name="value".`;
  const parsed = new Map<string, string>();
  const openTag = `<x ${attributes}>`;
  let cursor = '<x '.length;
  for (const attribute of firstOpenTag(openTag)?.attributes ?? []) {
    if (!attribute.quote || openTag.slice(cursor, attribute.nameStart).trim()) {
      throw new Error(malformed);
    }
    if (parsed.has(attribute.name)) {
      throw new Error(`${boundary} contains duplicate <blueprint-use> attribute "${attribute.name}". Fix: keep one "${attribute.name}" attribute on this <blueprint-use>.`);
    }
    parsed.set(attribute.name, attribute.value);
    cursor = attribute.end;
  }
  if (openTag.slice(cursor, -1).trim()) {
    throw new Error(malformed);
  }
  return parsed;
}

/**
 * Lists the section IDs a screen source marks with `data-blueprint-section`,
 * including markers forwarded through `<blueprint-use>`.
 */
export function findSectionMarkers(source: string): string[] {
  return listSectionTags(source).map(tag => tag.id);
}

export function listSectionTags(html: string): SectionTag[] {
  if (!SECTION_MARKER_NAME.test(html)) {
    return [];
  }
  return listOpenTags(html).flatMap(tag => {
    const marker = quotedAttribute(tag, 'data-blueprint-section');
    return marker ? [{ start: tag.start, end: tag.end, id: marker.value }] : [];
  });
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Reads governed prototype markup as text. This module imports nothing else from Blueprint. */

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

export interface UseElement {
  start: number;
  end: number;
  attributes: string;
  children: string;
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
export function collectInvocationSlots(children: string): Map<string, string> {
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

export function findElementEnd(html: string, tagName: string, openStart: number, openEnd: number): number {
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

export function appendSlot(slots: Map<string, string>, name: string, content: string): void {
  const previous = slots.get(name);
  slots.set(name, previous ? `${previous}${content}` : content);
}

export function stripSlotAttribute(markup: string): string {
  return markup.replace(/\s+slot\s*=\s*(['"])[^'"]+\1/i, '');
}

export function findFirstUseElement(html: string): UseElement | undefined {
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

export function findTagEnd(html: string, start: number): number {
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

export function parseUseAttributes(attributes: string, boundary: string): Map<string, string> {
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

/**
 * Lists the section IDs a screen source marks with `data-blueprint-section`,
 * including markers forwarded through `<blueprint-use>`.
 */
export function findSectionMarkers(source: string): string[] {
  return [...source.matchAll(sectionMarkerPattern())].map(match => match[4]);
}

export function sectionMarkerPattern(): RegExp {
  return /<([a-zA-Z][\w:-]*)(\s[^>]*?\bdata-blueprint-section\s*=\s*(['"])(.*?)\3[^>]*)>/g;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

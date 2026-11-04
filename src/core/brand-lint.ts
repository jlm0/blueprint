import { attributeWithValue, listOpenTags, listPossibleOpenTags, quotedAttribute } from './markup';

export const BRAND_MARK_ROLES = ['mark', 'wordmark', 'lockup', 'app-icon'] as const;

const UNSAFE_ELEMENTS: ReadonlyArray<[readonly string[], string]> = [
  [['script'], 'contains a script'],
  [['foreignobject'], 'embeds foreign HTML'],
  [['style'], 'carries a stylesheet that would restyle the page around it'],
  [['blueprint-use'], 'nests a Blueprint use'],
  [['image', 'iframe', 'object', 'embed'], 'embeds an external document or image']
];

const UNSAFE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\son[a-z]+\s*=/i, 'declares an event handler'],
  [/\b(?:xlink:)?href\s*=\s*["'](?!#)/i, 'links outside the file'],
  [/url\(\s*["']?(?!#)/i, 'loads a url() outside the file'],
  [/@import\b/i, 'imports a stylesheet'],
  [/javascript:/i, 'uses a javascript: URL']
];

const LITERAL_COLOR = /(?:fill|stroke|stop-color|flood-color|color)\s*(?:=\s*["']|:\s*)\s*(?:#[0-9a-f]{3,8}\b|(?:rgb|hsl|hwb|lab|lch|oklab|oklch)a?\()/i;

/** Rejects mark sources that could run code, reach the network, or stop drawing partway when inlined. */
export function brandMarkSourceIssues(svg: string): string[] {
  let elements: Set<string>;
  try {
    elements = new Set(listPossibleOpenTags(svg).map(tag => tag.name));
  } catch (error) {
    return [(error as Error).message];
  }
  const issues = [
    ...UNSAFE_ELEMENTS.filter(([names]) => names.some(name => elements.has(name))),
    ...UNSAFE_PATTERNS.filter(([pattern]) => pattern.test(svg))
  ].map(([, issue]) => `${issue}; brand marks must be self-contained drawings.`);
  if (!listOpenTags(svg).some(tag => tag.name === 'svg' && attributeWithValue(tag, 'viewbox'))) {
    issues.unshift('must be an <svg> with a viewBox so it scales.');
  }
  if (/NaN|Infinity/.test(svg)) {
    issues.push('contains a NaN or Infinity coordinate, which stops the drawing partway.');
  }
  return issues;
}

/** Handoff rules that keep marks recolorable by their variants and identical on every platform. */
export function brandMarkHandoffIssues(svg: string): string[] {
  const issues: string[] = [];
  if (LITERAL_COLOR.test(svg)) {
    issues.push('draws with a literal color; use currentColor or var(--brand-accent) so each variant can recolor it.');
  }
  if (listOpenTags(svg).some(tag => tag.name === 'text')) {
    issues.push('sets live text; outline the lettering to paths so it never depends on an installed font.');
  }
  return issues;
}

/** Brand mark IDs a governed prototype source places with `<blueprint-use kind="brand-mark">`, in document order. */
export function placedBrandMarkIds(html: string): string[] {
  const ids: string[] = [];
  for (const tag of listOpenTags(html)) {
    if (tag.name !== 'blueprint-use' || quotedAttribute(tag, 'kind')?.value !== 'brand-mark') continue;
    const ref = quotedAttribute(tag, 'ref')?.value;
    if (ref && !ids.includes(ref)) ids.push(ref);
  }
  return ids;
}

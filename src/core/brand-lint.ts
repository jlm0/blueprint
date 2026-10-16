import type { BrandMarkRole } from './types';

export const BRAND_MARK_ROLES: readonly BrandMarkRole[] = ['mark', 'wordmark', 'lockup', 'app-icon'];

const UNSAFE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/<script\b/i, 'contains a script'],
  [/<foreignObject\b/i, 'embeds foreign HTML'],
  [/<(?:image|iframe|object|embed)\b/i, 'embeds an external document or image'],
  [/\son[a-z]+\s*=/i, 'declares an event handler'],
  [/\b(?:xlink:)?href\s*=\s*["'](?!#)/i, 'links outside the file'],
  [/url\(\s*["']?(?!#)/i, 'loads a url() outside the file'],
  [/@import\b/i, 'imports a stylesheet'],
  [/javascript:/i, 'uses a javascript: URL']
];

const LITERAL_COLOR = /(?:fill|stroke|stop-color|flood-color|color)\s*(?:=\s*["']|:\s*)\s*(?:#[0-9a-f]{3,8}\b|(?:rgb|hsl|hwb|lab|lch|oklab|oklch)a?\()/i;

/** Rejects mark sources that could run code, reach the network, or stop drawing partway when inlined. */
export function brandMarkSourceIssues(svg: string): string[] {
  const issues = UNSAFE_PATTERNS
    .filter(([pattern]) => pattern.test(svg))
    .map(([, issue]) => `${issue}; brand marks must be self-contained drawings.`);
  if (!/<svg\b[^>]*\sviewBox\s*=/i.test(svg)) {
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
  if (/<text\b/i.test(svg)) {
    issues.push('sets live text; outline the lettering to paths so it never depends on an installed font.');
  }
  return issues;
}

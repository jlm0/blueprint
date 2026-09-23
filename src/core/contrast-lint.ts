import type { BlueprintProjectBundle } from './types';

export interface ContrastIssue {
  groupId: string;
  foreground: { styleRef: string; value: string };
  background: { styleRef: string; value: string };
  ratio: number;
  minimum: number;
}

const rolePairs: Array<{ foreground: string; background: string; minimum: number }> = [
  { foreground: '--app-color-foreground', background: '--app-color-background', minimum: 4.5 },
  { foreground: '--app-color-foreground', background: '--app-color-surface', minimum: 4.5 },
  { foreground: '--app-color-muted', background: '--app-color-surface', minimum: 4.5 },
  { foreground: '--app-color-on-primary', background: '--app-color-primary', minimum: 4.5 },
  { foreground: '--app-color-on-secondary', background: '--app-color-secondary', minimum: 4.5 },
  { foreground: '--app-color-on-destructive', background: '--app-color-destructive', minimum: 4.5 },
  { foreground: '--app-color-focus-ring', background: '--app-color-background', minimum: 3 }
];

/**
 * Checks the declared text-on-fill color role pairs against WCAG 2 contrast minimums.
 * Pairs with a missing, translucent, or non-literal color are skipped.
 */
export function lintColorContrast(bundle: BlueprintProjectBundle): ContrastIssue[] {
  const colors = new Map<string, { groupId: string; value: string; rgb: [number, number, number] }>();
  for (const group of bundle.tokens.tokenGroups) {
    for (const token of group.tokens) {
      const rgb = token.type === 'color' ? parseOpaqueColor(token.value) : undefined;
      if (rgb) colors.set(token.styleRef, { groupId: group.id, value: token.value, rgb });
    }
  }
  const issues: ContrastIssue[] = [];
  for (const pair of rolePairs) {
    const foreground = colors.get(pair.foreground);
    const background = colors.get(pair.background);
    if (!foreground || !background) continue;
    const ratio = contrastRatio(foreground.rgb, background.rgb);
    if (ratio < pair.minimum) {
      issues.push({
        groupId: foreground.groupId,
        foreground: { styleRef: pair.foreground, value: foreground.value },
        background: { styleRef: pair.background, value: background.value },
        ratio: Math.floor(ratio * 100) / 100,
        minimum: pair.minimum
      });
    }
  }
  return issues;
}

export function contrastMessage(issue: ContrastIssue): string {
  const use = issue.minimum === 3 ? 'a focus indicator' : 'text';
  return `${issue.foreground.styleRef} (${issue.foreground.value}) on ${issue.background.styleRef} (${issue.background.value}) has contrast ${issue.ratio}:1; ${use} needs at least ${issue.minimum}:1.`;
}

function parseOpaqueColor(value: string): [number, number, number] | undefined {
  const color = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(color)?.[1];
  if (hex) {
    const digits = hex.length <= 4 ? [...hex].map(digit => digit + digit) : hex.match(/../g) ?? [];
    const [r, g, b, a] = digits.map(pair => Number.parseInt(pair, 16));
    return a === undefined || a === 255 ? [r, g, b] : undefined;
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(color);
  if (!rgb) return undefined;
  const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number.parseFloat(rgb[4]);
  return alpha === 1 ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

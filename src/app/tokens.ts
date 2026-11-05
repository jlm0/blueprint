import type { CanvasProjectBundle, DesignToken, TokenGroup } from '../core/types';

export function singleLength(value: string): number | undefined {
  const match = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

interface TokenRecord {
  ref: string;
  group: TokenGroup;
  token: DesignToken;
}

export interface TokenIndex {
  byRef: Map<string, TokenRecord>;
  byStyleRef: Map<string, TokenRecord>;
  byGroup: Map<string, TokenGroup>;
}

export function createTokenIndex(bundle: CanvasProjectBundle): TokenIndex {
  const byRef = new Map<string, TokenRecord>();
  const byStyleRef = new Map<string, TokenRecord>();
  const byGroup = new Map<string, TokenGroup>();
  for (const group of bundle.tokens.tokenGroups) {
    byGroup.set(group.id, group);
    for (const token of group.tokens) {
      const record = { ref: `${group.id}.${token.id}`, group, token };
      byRef.set(record.ref, record);
      byStyleRef.set(token.styleRef, record);
    }
  }
  return { byRef, byStyleRef, byGroup };
}

export function resolvedColor(tokenIndex: TokenIndex, styleRef: string): string | undefined {
  const record = tokenIndex.byStyleRef.get(styleRef);
  return record?.token.type === 'color' ? resolveTokenReferences(tokenIndex, record.token.value) : undefined;
}

export function applyProjectCanvas(element: HTMLElement, tokenIndex: TokenIndex): void {
  const background = resolvedColor(tokenIndex, '--app-color-background');
  const foreground = resolvedColor(tokenIndex, '--app-color-foreground');
  const muted = resolvedColor(tokenIndex, '--app-color-muted');
  const surface = resolvedColor(tokenIndex, '--app-color-surface');
  const border = resolvedColor(tokenIndex, '--app-color-border');
  if (background) element.style.background = background;
  if (foreground) element.style.color = foreground;
  if (border) element.style.setProperty('--bp-sample-border', border);
  if (foreground) element.style.setProperty('--bp-sample-fg', foreground);
  if (muted) element.style.setProperty('--bp-sample-muted-fg', muted);
  if (surface) element.style.setProperty('--bp-sample-swatch-bg', surface);
}

export function findTokenValue(bundle: CanvasProjectBundle, tokenIds: string[]): string | undefined {
  const colorGroup = bundle.tokens.tokenGroups.find(group => group.id === 'color');
  for (const id of tokenIds) {
    const token = colorGroup?.tokens.find(candidate => candidate.id === id);
    if (token) {
      return token.value;
    }
  }
  return undefined;
}

export function setTokenHook(element: HTMLElement, record: TokenRecord | undefined, templateHook: string): void {
  if (!record) {
    return;
  }
  element.dataset.tokenRole = record.ref;
  element.dataset.templateHook = templateHook;
  element.dataset.tokenType = record.token.type;
  element.dataset.tokenStyleRef = record.token.styleRef;
}

export function resolveTokenReferences(tokenIndex: TokenIndex, value: string, depth = 0): string {
  if (depth > 4) {
    return value;
  }
  return value.replace(/var\((--[\w-]+)\)/g, (reference, styleRef: string) => {
    const record = tokenIndex.byStyleRef.get(styleRef);
    return record ? resolveTokenReferences(tokenIndex, record.token.value, depth + 1) : reference;
  });
}

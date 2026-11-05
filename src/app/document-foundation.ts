import { parseOpaqueColor } from '../core/color';
import { colorRolePairs, contrastRatio } from '../core/contrast-lint';
import type { CanvasProjectBundle, DesignToken, TokenGroup } from '../core/types';
import { createDocumentPage, createDocumentSection } from './document-page';
import { el } from './dom';
import { setBoundary } from './review-state';
import {
  type TokenIndex,
  applyProjectCanvas,
  resolveTokenReferences,
  resolvedColor,
  setTokenHook,
  singleLength
} from './tokens';

export function createFoundationPage(bundle: CanvasProjectBundle, tokenIndex: TokenIndex, group: TokenGroup): HTMLElement {
  const { page, body } = createDocumentPage('Foundations', group.name, group.description);
  setBoundary(page, 'token-group', group.id, bundle.manifest.project.id, group.name);
  page.dataset.boundarySummary = group.description;
  page.dataset.tokenGroup = group.id;
  applyProjectCanvas(body, tokenIndex);

  if (group.notes.length > 0) {
    const rules = el('ul', 'bp-chrome-doc-rules');
    for (const note of group.notes) rules.append(el('li', '', note));
    body.append(createDocumentSection('Rules', rules));
  }
  if (group.tokens.some(token => token.styleRef === SURFACE_LADDER_ROLES[0])) {
    const ladder = createSurfaceLadder(tokenIndex);
    const pairs = createContrastPairs(tokenIndex);
    if (ladder || pairs) {
      const context = el('div', 'token-context');
      for (const part of [ladder, pairs]) if (part) context.append(part);
      body.append(createDocumentSection('In context', context));
    }
  }

  const byType = new Map<DesignToken['type'], DesignToken[]>();
  for (const token of group.tokens) byType.set(token.type, [...byType.get(token.type) ?? [], token]);
  for (const [type, tokens] of byType) {
    body.append(createDocumentSection(TOKEN_TYPE_LABELS[type], createTokenSpecimens(tokenIndex, group, type, tokens)));
  }
  return page;
}

const TOKEN_TYPE_LABELS: Record<DesignToken['type'], string> = {
  color: 'Colors',
  typography: 'Type',
  space: 'Space',
  size: 'Sizes',
  radius: 'Radii',
  shadow: 'Shadows',
  motion: 'Motion'
};

function createTokenSpecimens(tokenIndex: TokenIndex, group: TokenGroup, type: DesignToken['type'], tokens: DesignToken[]): HTMLElement {
  const list = el('div', `token-specimens token-specimens-${type}`);
  for (const token of tokens) {
    const record = tokenIndex.byRef.get(`${group.id}.${token.id}`);
    const value = resolveTokenReferences(tokenIndex, token.value);
    const specimen = el('div', 'token-specimen');
    setTokenHook(specimen, record, `${type}-token-specimen`);
    specimen.dataset.tokenType = token.type;
    specimen.append(createTokenVisual(token, value), createTokenCaption(group, token));
    list.append(specimen);
  }
  return list;
}

function createTokenVisual(token: DesignToken, value: string): HTMLElement {
  const visual = el('div', 'token-visual');
  switch (token.type) {
    case 'color':
      visual.style.background = value;
      break;
    case 'typography':
      if (isFontStack(value)) {
        visual.classList.add('token-visual-family');
        visual.style.fontFamily = value;
        visual.append(el('span', 'token-visual-glyph', 'Aa'), el('span', 'token-visual-alphabet', 'ABCDEFGHIJKLM nopqrstuvwxyz 0123456789'));
      } else if (/^-?[\d.]+em$/.test(value.trim())) {
        visual.classList.add('token-visual-tracking');
        visual.style.letterSpacing = value;
        visual.textContent = 'Tracking';
      } else {
        visual.classList.add('token-visual-type');
        visual.style.font = value;
        if (!visual.style.font) visual.style.fontFamily = value;
        visual.textContent = token.description || token.name;
      }
      break;
    case 'space':
    case 'size': {
      const length = singleLength(value);
      if (length !== undefined) {
        const bar = el('span', 'token-visual-bar');
        bar.style.width = `${Math.min(length, 640)}px`;
        visual.append(bar);
      } else {
        visual.classList.add('token-visual-text');
        visual.textContent = value;
      }
      break;
    }
    case 'radius': {
      const tile = el('span', 'token-visual-radius');
      tile.style.borderRadius = value;
      visual.append(tile);
      break;
    }
    case 'shadow': {
      const tile = el('span', 'token-visual-shadow');
      tile.style.boxShadow = value;
      visual.append(tile);
      break;
    }
    case 'motion': {
      const dot = el('span', 'token-visual-motion-dot');
      dot.style.transition = `transform ${value}`;
      visual.classList.add('token-visual-motion');
      visual.append(dot);
      break;
    }
  }
  return visual;
}

function createTokenCaption(group: TokenGroup, token: DesignToken): HTMLElement {
  const caption = el('div', 'token-caption');
  const name = el('div', 'token-caption-name');
  name.append(el('b', '', token.name), createCodeWords('', token.value));
  caption.append(name);
  if (token.description && token.type !== 'typography') caption.append(el('p', 'token-caption-description', token.description));
  caption.append(createCodeWords('token-caption-ref', `${group.id}.${token.id} · ${token.styleRef}`));
  return caption;
}

function createCodeWords(className: string, text: string): HTMLElement {
  const code = el('code', className);
  // Keeps names like --app-font-sans whole: a line may only break between words, not after a hyphen.
  for (const part of text.split(/(\s+)/)) code.append(/^\s*$/.test(part) ? part : el('span', 'token-code-word', part));
  return code;
}

function isFontStack(value: string): boolean {
  return !/\d+(?:\.\d+)?px/.test(value) && /[,"']/.test(value);
}

const SURFACE_LADDER_ROLES = [
  '--app-color-background',
  '--app-color-surface',
  '--app-color-surface-2',
  '--app-color-surface-3',
  '--app-color-surface-4',
  '--app-color-surface-5',
  '--app-color-surface-6'
];

function createSurfaceLadder(tokenIndex: TokenIndex): HTMLElement | undefined {
  const steps = SURFACE_LADDER_ROLES.flatMap(styleRef => {
    const record = tokenIndex.byStyleRef.get(styleRef);
    const value = resolvedColor(tokenIndex, styleRef);
    return record && value ? [{ record, value }] : [];
  });
  if (steps.length < 2) {
    return undefined;
  }
  const ladder = el('section', 'token-ladder');
  ladder.append(el('h3', 'bp-chrome-specimen-title token-group-title', 'Surface ladder'));
  let parent: HTMLElement = ladder;
  for (const { record, value } of steps) {
    const step = el('div', 'token-ladder-step');
    step.style.background = value;
    step.append(el('span', 'token-ladder-label', `${record.token.name} · ${record.token.value}`));
    setTokenHook(step, record, 'color-ladder-step');
    parent.append(step);
    parent = step;
  }
  return ladder;
}

function createContrastPairs(tokenIndex: TokenIndex): HTMLElement | undefined {
  const list = el('div', 'token-pairs-list');
  for (const pair of colorRolePairs) {
    const foreground = tokenIndex.byStyleRef.get(pair.foreground);
    const background = tokenIndex.byStyleRef.get(pair.background);
    const foregroundValue = resolvedColor(tokenIndex, pair.foreground);
    const backgroundValue = resolvedColor(tokenIndex, pair.background);
    if (!foreground || !background || !foregroundValue || !backgroundValue) {
      continue;
    }
    const row = el('div', 'token-pair');
    row.dataset.tokenPair = `${pair.foreground} on ${pair.background}`;
    const sample = el('span', 'token-pair-sample', pair.minimum === 3 ? '' : 'Aa');
    sample.dataset.pairKind = pair.minimum === 3 ? 'indicator' : 'text';
    sample.style.background = backgroundValue;
    sample.style.color = foregroundValue;
    const foregroundRgb = parseOpaqueColor(foregroundValue);
    const backgroundRgb = parseOpaqueColor(backgroundValue);
    const ratio = foregroundRgb && backgroundRgb ? contrastRatio(foregroundRgb, backgroundRgb) : undefined;
    const verdict = el('span', 'token-pair-ratio');
    if (ratio === undefined) {
      verdict.textContent = 'not measured';
    } else {
      const passes = ratio >= pair.minimum;
      verdict.dataset.passes = String(passes);
      verdict.textContent = `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1 ${passes ? '✓' : `✕ needs ${pair.minimum}`}`;
    }
    row.append(sample, el('span', 'token-pair-label', `${foreground.token.name} on ${background.token.name}`), verdict);
    list.append(row);
  }
  if (list.childElementCount === 0) {
    return undefined;
  }
  const section = el('section', 'token-pairs');
  section.append(el('h3', 'bp-chrome-specimen-title token-group-title', 'Contrast pairs'), list);
  return section;
}

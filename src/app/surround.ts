import { parseOpaqueColor, relativeLuminance } from '../core/color';
import { contrastRatio } from '../core/contrast-lint';
import { listCssFontFaces, rewriteCssUrls } from '../core/css';
import type { CanvasProjectBundle } from '../core/types';
import { acceptedAssetRef, prototypeAssetUrl } from '../prototype/compiler';
import { project } from './canvas-state';
import { createTokenIndex, findTokenValue, resolveTokenReferences, resolvedColor, singleLength } from './tokens';

const CHROME_THEME_PROPERTIES = [
  '--bp-chrome-canvas-bg',
  '--bp-chrome-surface',
  '--bp-chrome-fg',
  '--bp-chrome-muted-fg',
  '--bp-chrome-border',
  '--bp-chrome-border-strong',
  '--bp-chrome-surface-hover',
  '--bp-chrome-surface-active',
  '--bp-chrome-accent',
  '--bp-chrome-accent-soft',
  '--bp-chrome-primary',
  '--bp-chrome-primary-fg',
  '--bp-chrome-focus',
  '--bp-chrome-grid-line',
  '--bp-chrome-grid-line-major',
  '--bp-chrome-radius',
  '--bp-chrome-radius-sm',
  '--bp-chrome-font',
  '--bp-chrome-font-display',
  '--bp-chrome-font-mono'
];

export function refreshSurround(): void {
  const root = document.documentElement;
  root.dataset.surround = backgroundAppearance(project);
  for (const property of CHROME_THEME_PROPERTIES) root.style.removeProperty(property);
  const { colors, shape } = chromeThemeFromTokens(project);
  root.dataset.chromeTheme = colors ? 'app' : 'neutral';
  for (const [property, value] of Object.entries({ ...colors, ...shape })) root.style.setProperty(property, value);
  installProjectFonts(project);
}

function chromeThemeFromTokens(bundle: CanvasProjectBundle): { colors?: Record<string, string>; shape: Record<string, string> } {
  const tokenIndex = createTokenIndex(bundle);
  const color = (role: string): { value: string; rgb: [number, number, number] } | undefined => {
    const value = resolvedColor(tokenIndex, `--app-color-${role}`);
    const rgb = value ? parseOpaqueColor(value) : undefined;
    return value && rgb ? { value, rgb } : undefined;
  };
  const tokenValue = (styleRef: string): string | undefined => {
    const record = tokenIndex.byStyleRef.get(styleRef);
    return record ? resolveTokenReferences(tokenIndex, record.token.value) : undefined;
  };

  const shape: Record<string, string> = {};
  const radius = singleLength(tokenValue('--app-radius-md') ?? '');
  const radiusSmall = singleLength(tokenValue('--app-radius-sm') ?? '');
  if (radius !== undefined) shape['--bp-chrome-radius'] = `${Math.min(12, Math.max(0, radius))}px`;
  if (radiusSmall !== undefined) shape['--bp-chrome-radius-sm'] = `${Math.min(8, Math.max(0, radiusSmall))}px`;
  const sans = tokenValue('--app-font-sans');
  const display = tokenValue('--app-font-display');
  const mono = tokenValue('--app-font-mono');
  if (sans) shape['--bp-chrome-font'] = sans;
  if (display ?? sans) shape['--bp-chrome-font-display'] = display ?? sans ?? '';
  if (mono) shape['--bp-chrome-font-mono'] = mono;

  const background = color('background');
  const surface = color('surface') ?? background;
  const foreground = color('foreground');
  if (!background || !surface || !foreground) return { shape };
  if (contrastRatio(foreground.rgb, background.rgb) < 4.5 || contrastRatio(foreground.rgb, surface.rgb) < 4.5) return { shape };

  const fg = foreground.value;
  const mix = (amount: number, base = 'transparent'): string => `color-mix(in srgb, ${fg} ${amount}%, ${base})`;
  const muted = color('muted');
  const border = color('border');
  const borderStrong = color('border-strong');
  const primary = color('primary');
  const focus = color('focus-ring');
  return {
    shape,
    colors: {
      '--bp-chrome-canvas-bg': background.value,
      '--bp-chrome-surface': surface.value,
      '--bp-chrome-fg': fg,
      '--bp-chrome-muted-fg': muted && contrastRatio(muted.rgb, surface.rgb) >= 3 ? muted.value : mix(62, surface.value),
      '--bp-chrome-border': border?.value ?? mix(12),
      '--bp-chrome-border-strong': borderStrong?.value ?? mix(24),
      '--bp-chrome-surface-hover': mix(5),
      '--bp-chrome-surface-active': mix(9),
      '--bp-chrome-accent': primary?.value ?? fg,
      '--bp-chrome-accent-soft': primary ? `color-mix(in srgb, ${primary.value} 14%, ${surface.value})` : mix(9),
      '--bp-chrome-primary': fg,
      '--bp-chrome-primary-fg': surface.value,
      '--bp-chrome-focus': focus && contrastRatio(focus.rgb, background.rgb) >= 3 ? focus.value : fg,
      '--bp-chrome-grid-line': mix(2.5),
      '--bp-chrome-grid-line-major': mix(4.5)
    }
  };
}

function installProjectFonts(bundle: CanvasProjectBundle): void {
  let style = document.getElementById('bp-project-fonts');
  if (!style) {
    style = document.createElement('style');
    style.id = 'bp-project-fonts';
    document.head.append(style);
  }
  const rules = new Set<string>();
  for (const [sourceRef, css] of Object.entries(bundle.prototypeSourceContents)) {
    if (!sourceRef.endsWith('.css')) continue;
    for (const face of listCssFontFaces(css)) {
      const rule = resolveFontFaceUrls(bundle, sourceRef, face.text);
      if (rule) rules.add(rule);
    }
  }
  style.textContent = [...rules].join('\n');
}

function resolveFontFaceUrls(bundle: CanvasProjectBundle, sourceRef: string, rule: string): string | undefined {
  let resolved = true;
  const rewritten = rewriteCssUrls(rule, value => {
    const assetRef = acceptedAssetRef(sourceRef, value);
    const asset = assetRef === undefined ? undefined : bundle.prototypeAssetContents[assetRef];
    if (!asset) {
      resolved = false;
      return 'none';
    }
    return `url("${prototypeAssetUrl(asset, location.origin)}")`;
  });
  return resolved ? rewritten : undefined;
}

export function backgroundAppearance(bundle: CanvasProjectBundle): 'light' | 'dark' {
  const background = findTokenValue(bundle, ['background']);
  const rgb = background ? parseOpaqueColor(background) : undefined;
  return rgb && relativeLuminance(rgb) < 0.4 ? 'dark' : 'light';
}

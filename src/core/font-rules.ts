import path from 'node:path';
import { listCssFontFaces, readFontValue } from './css';
import type { BlueprintProjectBundle, BrandFile, BrandFont, DesignToken, PrototypeAsset } from './types';

const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  'cursive',
  'emoji',
  'fangsong',
  'fantasy',
  'math',
  'monospace',
  'sans-serif',
  'serif',
  'system-ui',
  'ui-monospace',
  'ui-rounded',
  'ui-sans-serif',
  'ui-serif'
]);

function isGenericFamily(family: string): boolean {
  return GENERIC_FAMILIES.has(family.toLowerCase());
}

function isTypographyToken(token: DesignToken): boolean {
  return token.type === 'typography' && typeof token.value === 'string';
}

function namedFamilies(value: string): string[] {
  return readFontValue(value).families.filter(family => !isGenericFamily(family));
}

function fontsByFamily(brand: BrandFile): Map<string, BrandFont> {
  return new Map((Array.isArray(brand.fonts) ? brand.fonts : []).map(font => [String(font.family).toLowerCase(), font]));
}

function isInsideAssetRoot(ref: string, assetRoots: readonly string[]): boolean {
  return assetRoots.some(root => {
    const trimmed = root.replace(/\/$/, '');
    return ref === trimmed || ref.startsWith(`${trimmed}/`);
  });
}

export function validateBrandFonts(errors: string[], brand: BrandFile, assetRoots: readonly string[], fileExists: (ref: string) => boolean): void {
  if (!Array.isArray(brand.fonts)) {
    errors.push('brand.fonts is missing. Fix: run the migrate tool, which fills fonts in brand.json from the font tokens and the @font-face rules.');
    return;
  }
  const seen = new Set<string>();
  brand.fonts.forEach((font, index) => {
    const label = `brand.fonts[${index}]`;
    if (typeof font?.family !== 'string' || !font.family.trim()) {
      errors.push(`${label}.family is missing. Fix: set it to the family name that the font tokens use.`);
      return;
    }
    const key = font.family.toLowerCase();
    if (seen.has(key)) errors.push(`${label}.family "${font.family}" repeats an earlier entry. Fix: delete one of the two entries in brand.json.`);
    seen.add(key);
    if (font.source !== 'asset' && font.source !== 'system') {
      errors.push(`${label}.source "${String(font.source)}" is not a font source. Fix: set it to "asset" for a file in the project, or to "system" for a font that the device has.`);
      return;
    }
    const assets = Array.isArray(font.assets) ? font.assets : [];
    if (!Array.isArray(font.assets)) errors.push(`${label}.assets is missing. Fix: add assets to this entry, as a list of font files for "asset", or as [] for "system".`);
    if (font.source === 'system' && assets.length > 0) errors.push(`${label}.assets must be empty for a system font. Fix: set assets to [], or set source to "asset".`);
    if (font.source === 'asset' && Array.isArray(font.assets) && assets.length === 0) errors.push(`${label}.assets is empty for an asset font. Fix: list the font files of "${font.family}" in assets, or set source to "system".`);
    for (const asset of assets) {
      if (!isInsideAssetRoot(asset, assetRoots)) errors.push(`${label}.assets entry "${asset}" is outside prototypeHost.assetRoots. Fix: move the file into one of ${assetRoots.join(', ') || 'the asset roots that you add to manifest.json'}, and set this entry to its new path.`);
      else if (!fileExists(asset)) errors.push(`${label}.assets entry "${asset}" does not exist. Fix: add the file "${asset}" to the project, or delete this entry.`);
    }
  });
}

/** Without brand.json the project declares no fonts yet, so these rules wait for the brand that the person approves. */
export function validateFontFamilyTokens(errors: string[], bundle: BlueprintProjectBundle<PrototypeAsset>): void {
  if (!bundle.brand) return;
  const fonts = fontsByFamily(bundle.brand);
  for (const group of bundle.tokens.tokenGroups) {
    for (const token of group.tokens) {
      if (!isTypographyToken(token)) continue;
      for (const family of namedFamilies(token.value)) {
        if (fonts.has(family.toLowerCase())) continue;
        errors.push(`tokenGroup.${group.id}.token.${token.id}.value names the font family "${family}", which brand.json does not declare. Fix: add { "family": "${family}", "source": "system", "assets": [] } to fonts in brand.json, with source "asset" and its files when the project holds the font.`);
      }
    }
  }
}

export function validateFontFaces(errors: string[], bundle: BlueprintProjectBundle<PrototypeAsset>): void {
  if (!bundle.brand) return;
  const styleRefs = new Set([...bundle.primitives.primitives, ...bundle.components.components, ...bundle.screens.screens].flatMap(item => item.prototype.styles ?? []));
  for (const styleRef of styleRefs) {
    const css = bundle.prototypeSourceContents[styleRef];
    if (css !== undefined) validateStylesheetFontFaces(errors, bundle.brand, styleRef, css);
  }
}

export function validateStylesheetFontFaces(errors: string[], brand: BrandFile, styleRef: string, css: string): void {
  if (!css.toLowerCase().includes('@font-face')) return;
  const fonts = fontsByFamily(brand);
  for (const face of listCssFontFaces(css)) {
    const font = fonts.get(face.family.toLowerCase());
    for (const source of face.otherSources) {
      errors.push(`${styleRef} @font-face "${face.family}" reads ${source}, which is not a declared asset. Fix: delete ${source} from this rule, and load a file with url().`);
    }
    for (const url of face.urls) {
      const asset = resolveStyleUrl(styleRef, url);
      if (font?.source === 'asset' && Array.isArray(font.assets) && font.assets.includes(asset)) continue;
      errors.push(`${styleRef} @font-face "${face.family}" loads "${asset}", which brand.fonts does not declare. Fix: add "${asset}" to the assets of the "${face.family}" entry in fonts of brand.json, with source "asset".`);
    }
  }
}

export function resolveStyleUrl(styleRef: string, url: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(styleRef), url));
}

/** The fonts that the tokens and the @font-face rules already name, for `migrate`. Each entry in `existing` stays, and a found file joins it. */
export function deriveBrandFonts(existing: readonly BrandFont[], typographyValues: readonly string[], stylesheets: ReadonlyMap<string, string>): BrandFont[] {
  const fonts = new Map(existing.map(font => [font.family.toLowerCase(), { ...font, assets: [...font.assets] }]));
  const add = (family: string): BrandFont => {
    const key = family.toLowerCase();
    const font = fonts.get(key) ?? { family, source: 'system' as const, assets: [] };
    fonts.set(key, font);
    return font;
  };
  for (const value of typographyValues) namedFamilies(value).forEach(add);
  for (const [styleRef, css] of stylesheets) {
    for (const face of listCssFontFaces(css)) {
      if (!face.family || isGenericFamily(face.family)) continue;
      const font = add(face.family);
      for (const url of face.urls) {
        if (/^[a-z][a-z\d+.-]*:|^\//i.test(url)) continue;
        const asset = resolveStyleUrl(styleRef, url);
        font.source = 'asset';
        if (!font.assets.includes(asset)) font.assets.push(asset);
      }
    }
  }
  return [...fonts.values()];
}

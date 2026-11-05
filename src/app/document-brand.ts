import { brandMarkSourceIssues } from '../core/brand-lint';
import type { BrandFile, BrandMark, BrandMarkVariant, CanvasProjectBundle } from '../core/types';
import { createInspoDirections } from './document-inspo';
import { createDocumentPage, createDocumentSection } from './document-page';
import { el } from './dom';
import { type TokenIndex, applyProjectCanvas, resolveTokenReferences } from './tokens';

const BRAND_ROLE_LABELS: Record<BrandMark['role'], string> = {
  mark: 'Mark',
  wordmark: 'Wordmark',
  lockup: 'Lockup',
  'app-icon': 'App icon'
};

export function createBrandPage(bundle: CanvasProjectBundle, tokenIndex: TokenIndex, brand: BrandFile): HTMLElement {
  const marks = brand.marks ?? [];
  const badges = [el('span', 'bp-chrome-doc-fact', `${marks.length} ${marks.length === 1 ? 'mark' : 'marks'}`)];
  const { page, body } = createDocumentPage('Foundations', brand.name, brand.tagline ?? '', badges);
  page.dataset.brand = 'true';
  applyProjectCanvas(body, tokenIndex);

  const approved = (bundle.inspo?.directions ?? []).filter(direction => direction.status === 'approved');
  if (approved.length > 0) {
    body.append(createDocumentSection('From inspo', createInspoDirections(approved)));
  }

  if (brand.personality && brand.personality.length > 0) {
    const traits = el('div', 'bp-chrome-brand-traits');
    for (const trait of brand.personality) {
      const item = el('div', 'bp-chrome-brand-trait');
      item.append(el('h3', 'bp-chrome-brand-trait-name', trait.name), el('p', 'bp-chrome-brand-trait-text', trait.description));
      traits.append(item);
    }
    body.append(createDocumentSection('Personality', traits));
  }

  if (marks.length > 0) {
    const list = el('div', 'bp-chrome-brand-marks');
    list.append(...marks.map(mark => createBrandMarkSpecimen(bundle, tokenIndex, mark)));
    body.append(createDocumentSection('Marks', list));
  }

  if (brand.voice) {
    const summary = el('p', 'bp-chrome-doc-text', brand.voice.summary);
    body.append(createDocumentSection('Voice', summary, createBrandExamples(brand.voice.do, brand.voice.dont, true)));
  }
  if (brand.usage) {
    body.append(createDocumentSection('Usage', createBrandExamples(brand.usage.do, brand.usage.dont, false)));
  }
  return page;
}

function createBrandMarkSpecimen(bundle: CanvasProjectBundle, tokenIndex: TokenIndex, mark: BrandMark): HTMLElement {
  const specimen = el('div', 'bp-chrome-brand-mark');
  specimen.dataset.brandMark = mark.id;
  const head = el('div', 'bp-chrome-brand-mark-head');
  head.append(el('h3', 'bp-chrome-specimen-title', mark.name), el('span', 'bp-chrome-doc-fact', BRAND_ROLE_LABELS[mark.role] ?? mark.role));
  specimen.append(head, el('p', 'bp-chrome-doc-text', mark.description));

  const source = bundle.prototypeSourceContents[mark.source];
  const displayHeight = mark.role === 'wordmark' || mark.role === 'lockup' ? 40 : 56;
  const draw = (height: number, label: string): SVGSVGElement | undefined => source === undefined ? undefined : createBrandGraphic(source, height, label);
  if (!draw(displayHeight, mark.name)) {
    specimen.append(el('p', 'bp-chrome-doc-notice', `${mark.source} is missing or failed the brand mark source checks, so it is not drawn.`));
    return specimen;
  }

  const variants = el('div', 'bp-chrome-brand-row');
  for (const variant of mark.variants ?? []) {
    variants.append(createBrandTile(tokenIndex, variant, draw(displayHeight, `${mark.name}, ${variant.name}`)!, variant.name));
  }
  specimen.append(variants);

  const primary = mark.variants?.[0];
  if (!primary) return specimen;
  const construction = el('div', 'bp-chrome-brand-row');
  const clearGraphic = draw(displayHeight, `${mark.name} with its clear space`)!;
  const clearArea = el('div', 'bp-chrome-brand-clearspace');
  const basis = mark.clearSpace?.basis === 'width' ? Number(clearGraphic.getAttribute('width')) : displayHeight;
  clearArea.style.padding = `${Math.round((mark.clearSpace?.ratio ?? 0) * basis)}px`;
  clearArea.append(clearGraphic);
  construction.append(createBrandTile(tokenIndex, primary, clearArea, ['Clear space', mark.clearSpace?.note].filter(Boolean).join(' · ')));

  const minimum = mark.minimumSize;
  if (minimum) {
    const graphic = draw(displayHeight, `${mark.name} at its minimum size`)!;
    const ratio = Number(graphic.getAttribute('width')) / displayHeight;
    const height = minimum.axis === 'width' ? minimum.px / ratio : minimum.px;
    graphic.setAttribute('height', String(Math.round(height * 100) / 100));
    graphic.setAttribute('width', String(Math.round(height * ratio * 100) / 100));
    const size = `Minimum ${minimum.px} px ${minimum.axis === 'width' ? 'wide' : 'tall'}`;
    construction.append(createBrandTile(tokenIndex, primary, graphic, [size, minimum.note].filter(Boolean).join(' · ')));
  }
  specimen.append(construction);
  return specimen;
}

function createBrandTile(tokenIndex: TokenIndex, variant: BrandMarkVariant, content: Element, caption: string): HTMLElement {
  const tile = el('figure', 'bp-chrome-brand-tile');
  tile.dataset.brandVariant = variant.id;
  const surface = el('div', 'bp-chrome-brand-surface');
  const color = (ref: string | undefined): string | undefined => {
    const record = ref ? tokenIndex.byRef.get(ref) : undefined;
    return record?.token.type === 'color' ? resolveTokenReferences(tokenIndex, record.token.value) : undefined;
  };
  const background = color(variant.background);
  const foreground = color(variant.foreground);
  const accent = color(variant.accent);
  if (background) surface.style.background = background;
  if (foreground) surface.style.color = foreground;
  if (accent) surface.style.setProperty('--brand-accent', accent);
  surface.append(content);
  tile.append(surface, el('figcaption', 'bp-chrome-brand-caption', caption));
  return tile;
}

function createBrandGraphic(source: string, height: number, label: string): SVGSVGElement | undefined {
  if (brandMarkSourceIssues(source).length > 0) return undefined;
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (svg.localName !== 'svg' || parsed.getElementsByTagName('parsererror').length > 0) return undefined;
  // The text checks above run before entity decoding, so decoded attribute values are checked again here.
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    const unsafeText = node.localName === 'style' && /url\(\s*["']?(?!#)|@import/i.test(node.textContent ?? '');
    if (unsafeText || /^(script|foreignobject|image|iframe|object|embed)$/i.test(node.localName)) return undefined;
    for (const attribute of node.attributes) {
      const value = attribute.value.toLowerCase();
      if (/^on/i.test(attribute.name) || value.includes('javascript:') || /url\(\s*["']?(?!#)/.test(value)) return undefined;
      if (/href$/i.test(attribute.name) && !value.trim().startsWith('#')) return undefined;
    }
  }
  const [, , boxWidth, boxHeight] = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  if (!boxWidth || !boxHeight) return undefined;
  const graphic = document.importNode(svg, true) as unknown as SVGSVGElement;
  graphic.setAttribute('height', String(height));
  graphic.setAttribute('width', String(Math.round(height * (boxWidth / boxHeight) * 100) / 100));
  graphic.setAttribute('role', 'img');
  graphic.setAttribute('aria-label', label);
  graphic.classList.add('bp-chrome-brand-graphic');
  return graphic;
}

function createBrandExamples(doItems: string[], dontItems: string[], quoted: boolean): HTMLElement {
  const examples = el('div', 'bp-chrome-brand-examples');
  for (const [tone, title, items] of [['do', 'Do', doItems], ['dont', "Don't", dontItems]] as const) {
    const column = el('div', 'bp-chrome-brand-example-list');
    column.dataset.tone = tone;
    const list = el('ul', 'bp-chrome-brand-example-items');
    for (const item of items) list.append(el('li', '', quoted ? `\u201c${item}\u201d` : item));
    column.append(el('h3', 'bp-chrome-specimen-title', title), list);
    examples.append(column);
  }
  return examples;
}

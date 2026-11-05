import { type BoundaryExtent, measureElementExtent, viewportExtent } from './boundary-extent';
import { yieldToMain } from './frame-mounting';
import { readPrototypeTwin } from './frame-overlay';

const SLICE_MS = 8;
const SLICE_CHECK_INTERVAL = 128;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

type ChangedPair = [before: Element, after: Element];

// A change box draws 5 px outside its edges, 2 px of outline and a 3 px offset, and the frame clips at its own edges.
const OUTLINE_REACH_PX = 5;

/** A property outside these lists counts on each element, because a missed change is worse than an extra mark. */
const NOT_PAINTED_PROPERTIES: readonly string[] = [
  'cursor', 'pointer-events', 'user-select', '-webkit-user-select', '-webkit-user-drag', '-webkit-user-modify', '-webkit-tap-highlight-color',
  'touch-action', 'caret-color', 'will-change', 'overflow-anchor', 'orphans', 'widows', 'speak', 'app-region'
];
/** A logical property repeats a physical one, and the physical one answers for it. */
const NOT_PAINTED_FAMILY = /^(?:--|transition-|scroll-|overscroll-|view-transition-)|(?:^|-)(?:block|inline)(?:-|$)|^border-(?:start|end)-(?:start|end)-radius$/;
/** These properties inherit, so a difference paints only on an element that holds text, and its children show the difference themselves. */
export const INHERITED_TEXT_PROPERTIES: readonly string[] = [
  'color', 'direction', 'writing-mode', 'line-height', 'letter-spacing', 'word-spacing', 'word-break', 'overflow-wrap', 'white-space-collapse',
  'line-break', 'hyphens', 'hyphenate-character', 'hyphenate-limit-chars', 'tab-size',
  'font-family', 'font-feature-settings', 'font-kerning', 'font-optical-sizing', 'font-palette', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style',
  'font-synthesis-small-caps', 'font-synthesis-style', 'font-synthesis-weight', 'font-variant-alternates', 'font-variant-caps', 'font-variant-east-asian',
  'font-variant-emoji', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-position', 'font-variation-settings', 'font-weight',
  'list-style-image', 'list-style-position', 'list-style-type',
  'text-align', 'text-align-last', 'text-combine-upright', 'text-decoration-skip-ink', 'text-indent', 'text-orientation', 'text-rendering', 'text-shadow', 'text-size-adjust',
  'text-spacing-trim', 'text-transform', 'text-underline-offset', 'text-underline-position', 'text-wrap-mode', 'text-wrap-style', 'text-autospace',
  '-webkit-font-smoothing', '-webkit-locale', '-webkit-text-decorations-in-effect', '-webkit-text-fill-color', '-webkit-text-orientation', '-webkit-text-security',
  '-webkit-text-stroke-color', '-webkit-text-stroke-width', '-webkit-writing-mode'
];
const SHAPE_PROPERTIES: readonly string[] = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width',
  'clip-rule', 'marker-start', 'marker-mid', 'marker-end', 'shape-rendering', 'text-anchor', 'color-interpolation', 'color-interpolation-filters',
  'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity', 'lighting-color'
];
/** A computed line color holds the resolved `currentColor` even when the line does not paint, so an inherited color must not count as a change. */
const STYLE_OF_LINE_COLOR: Readonly<Record<string, string>> = {
  'border-top-color': 'border-top-style',
  'border-right-color': 'border-right-style',
  'border-bottom-color': 'border-bottom-style',
  'border-left-color': 'border-left-style',
  'outline-color': 'outline-style',
  'column-rule-color': 'column-rule-style',
  'row-rule-color': 'row-rule-style',
  'text-decoration-color': 'text-decoration-line',
  'text-emphasis-color': 'text-emphasis-style'
};
const RADIUS_PROPERTIES: readonly string[] = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
const ROUNDED_PAINT_NONE: ReadonlyArray<readonly [string, string]> = [
  ['background-color', 'rgba(0, 0, 0, 0)'], ['background-image', 'none'], ['box-shadow', 'none'], ['overflow', 'visible'], ['backdrop-filter', 'none'], ['contain', 'none'],
  ['border-top-style', 'none'], ['border-right-style', 'none'], ['border-bottom-style', 'none'], ['border-left-style', 'none'], ['outline-style', 'none']
];
const ELEMENTS_WITH_OWN_CONTENT = ['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'METER', 'PROGRESS', 'svg'];
const PSEUDO_ELEMENTS = ['::before', '::after'];
const ELEMENTS_WITH_PLACEHOLDER = ['INPUT', 'TEXTAREA'];
const ELEMENTS_WITH_BUILT_IN_TEXT = ['INPUT', 'TEXTAREA', 'SELECT'];
const NOT_PAINTED_ATTRIBUTE_PREFIXES = ['data-', 'aria-'];
const NOT_PAINTED_ATTRIBUTES = ['class', 'style', 'id', 'role', 'title', 'tabindex', 'name', 'for', 'target', 'rel'];

interface PaintedContent {
  text: boolean;
  shape: boolean;
  rounded: boolean;
}

let comparedProperties: readonly string[] | undefined;

function propertiesToCompare(style: CSSStyleDeclaration): readonly string[] {
  comparedProperties ??= Array.from(style).filter(property => !NOT_PAINTED_PROPERTIES.includes(property) && !NOT_PAINTED_FAMILY.test(property));
  return comparedProperties;
}

function holdsRoundedPaint(style: CSSStyleDeclaration): boolean {
  return ROUNDED_PAINT_NONE.some(([property, none]) => style.getPropertyValue(property) !== none);
}

function differencePaints(property: string, before: CSSStyleDeclaration, after: CSSStyleDeclaration, content: PaintedContent): boolean {
  if (INHERITED_TEXT_PROPERTIES.includes(property)) return content.text;
  if (SHAPE_PROPERTIES.includes(property)) return content.shape;
  if (RADIUS_PROPERTIES.includes(property)) return content.rounded || holdsRoundedPaint(after);
  const line = STYLE_OF_LINE_COLOR[property];
  return line === undefined || before.getPropertyValue(line) !== 'none' || after.getPropertyValue(line) !== 'none';
}

function stylesDiffer(before: CSSStyleDeclaration, after: CSSStyleDeclaration, content: PaintedContent): boolean {
  for (const property of propertiesToCompare(after)) {
    if (before.getPropertyValue(property) !== after.getPropertyValue(property) && differencePaints(property, before, after, content)) return true;
  }
  return false;
}

function generatesPseudo(content: string): boolean {
  return content !== 'none' && content !== 'normal' && content !== '';
}

function pseudoElementDiffers(beforeView: Window, afterView: Window, before: Element, after: Element, pseudo: string): boolean {
  const beforeStyle = beforeView.getComputedStyle(before, pseudo);
  const afterStyle = afterView.getComputedStyle(after, pseudo);
  const beforeContent = beforeStyle.getPropertyValue('content');
  const afterContent = afterStyle.getPropertyValue('content');
  if (!generatesPseudo(beforeContent) && !generatesPseudo(afterContent)) return false;
  if (beforeContent !== afterContent) return true;
  return stylesDiffer(beforeStyle, afterStyle, { text: afterContent !== '""', shape: false, rounded: false });
}

/** A built-in part paints with no `content`, so `generatesPseudo` cannot answer for it. */
function builtInPartDiffers(beforeView: Window, afterView: Window, before: Element, after: Element, style: CSSStyleDeclaration): boolean {
  const part = ELEMENTS_WITH_PLACEHOLDER.includes(after.tagName) ? '::placeholder' : style.getPropertyValue('display') === 'list-item' ? '::marker' : undefined;
  return part !== undefined && stylesDiffer(beforeView.getComputedStyle(before, part), afterView.getComputedStyle(after, part), { text: true, shape: false, rounded: false });
}

function ownText(element: Element): string {
  let text = '';
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 3) text += node.nodeValue;
  }
  return text;
}

function paintsText(element: Element, text: string, style: CSSStyleDeclaration): boolean {
  return text.trim() !== '' || ELEMENTS_WITH_BUILT_IN_TEXT.includes(element.tagName) || style.getPropertyValue('display') === 'list-item';
}

function paintedAttributes(element: Element): string {
  return element.getAttributeNames()
    .filter(name => !NOT_PAINTED_ATTRIBUTES.includes(name) && !NOT_PAINTED_ATTRIBUTE_PREFIXES.some(prefix => name.startsWith(prefix)))
    .sort()
    .map(name => `${name}=${element.getAttribute(name)}`)
    .join('\n');
}

function boxesDiffer(before: Element, after: Element): boolean {
  const beforeBox = before.getBoundingClientRect();
  const afterBox = after.getBoundingClientRect();
  return beforeBox.left !== afterBox.left || beforeBox.top !== afterBox.top || beforeBox.width !== afterBox.width || beforeBox.height !== afterBox.height;
}

/** The walk reads a paused first keyframe, so an element that fades in reads opacity 0 and still paints. */
function paintsNothingInBoth(beforeElement: Element, afterElement: Element, before: CSSStyleDeclaration, after: CSSStyleDeclaration): boolean {
  return (before.getPropertyValue('display') === 'none' && after.getPropertyValue('display') === 'none')
    || (before.getPropertyValue('opacity') === '0' && after.getPropertyValue('opacity') === '0' && beforeElement.getAnimations().length === 0 && afterElement.getAnimations().length === 0);
}

/** The walk stops at the topmost element that differs, because its outline already covers what is inside it. */
async function changedElements(before: Document, after: Document): Promise<ChangedPair[]> {
  const beforeView = before.defaultView as Window;
  const afterView = after.defaultView as Window;
  const changed: ChangedPair[] = [];
  if (stylesDiffer(beforeView.getComputedStyle(before.documentElement), afterView.getComputedStyle(after.documentElement), { text: false, shape: false, rounded: false })) {
    changed.push([before.documentElement, after.documentElement]);
  }
  const pending: ChangedPair[] = [[before.body, after.body]];
  let visited = 0;
  let sliceStart = performance.now();
  for (let pair = pending.pop(); pair; pair = pending.pop()) {
    const [beforeElement, afterElement] = pair;
    visited += 1;
    if (visited % SLICE_CHECK_INTERVAL === 0 && performance.now() - sliceStart > SLICE_MS) {
      await yieldToMain();
      sliceStart = performance.now();
    }
    const beforeStyle = beforeView.getComputedStyle(beforeElement);
    const afterStyle = afterView.getComputedStyle(afterElement);
    if (paintsNothingInBoth(beforeElement, afterElement, beforeStyle, afterStyle)) continue;
    const ownPaint = beforeStyle.getPropertyValue('visibility') !== 'hidden' || afterStyle.getPropertyValue('visibility') !== 'hidden';
    const svg = afterElement.namespaceURI === SVG_NAMESPACE;
    const text = ownText(afterElement);
    const content: PaintedContent = { text: paintsText(afterElement, text, afterStyle), shape: svg, rounded: ELEMENTS_WITH_OWN_CONTENT.includes(afterElement.tagName) };
    if (
      beforeElement.tagName !== afterElement.tagName
      || beforeElement.childElementCount !== afterElement.childElementCount
      || boxesDiffer(beforeElement, afterElement)
      || (ownPaint && (
        stylesDiffer(beforeStyle, afterStyle, content)
        || ownText(beforeElement) !== text
        || paintedAttributes(beforeElement) !== paintedAttributes(afterElement)
        || (!svg && PSEUDO_ELEMENTS.some(pseudo => pseudoElementDiffers(beforeView, afterView, beforeElement, afterElement, pseudo)))
        || (!svg && builtInPartDiffers(beforeView, afterView, beforeElement, afterElement, afterStyle))
      ))
    ) {
      changed.push(pair);
      continue;
    }
    for (let index = afterElement.childElementCount - 1; index >= 0; index -= 1) {
      pending.push([beforeElement.children[index], afterElement.children[index]]);
    }
  }
  return changed;
}

function pauseAnimations(twin: Document): void {
  for (const animation of twin.getAnimations()) {
    animation.pause();
    animation.currentTime = 0;
  }
}

function outlineOf(extent: BoundaryExtent, view: Window): BoundaryExtent {
  const inside = (value: number, size: number): number => Math.min(Math.max(value, OUTLINE_REACH_PX), size - OUTLINE_REACH_PX);
  return {
    left: inside(extent.left, view.innerWidth),
    top: inside(extent.top, view.innerHeight),
    right: inside(extent.right, view.innerWidth),
    bottom: inside(extent.bottom, view.innerHeight)
  };
}

function extentHolds(outer: BoundaryExtent, inner: BoundaryExtent): boolean {
  return outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom;
}

function extentIn(element: Element): BoundaryExtent | undefined {
  const view = element.ownerDocument.defaultView as Window;
  return measureElementExtent(element, view, viewportExtent(view));
}

/** A box that moves or shrinks also changes the pixels of the place that it left. */
function changedExtents([before, after]: ChangedPair): BoundaryExtent[] {
  const was = extentIn(before);
  const now = extentIn(after);
  if (!was || !now) return was ? [was] : now ? [now] : [];
  if (extentHolds(now, was)) return [now];
  return extentHolds(was, now) ? [was] : [was, now];
}

function coversView(extent: BoundaryExtent, view: Window): boolean {
  return extent.left <= 0 && extent.top <= 0 && extent.right >= view.innerWidth && extent.bottom >= view.innerHeight;
}

export interface DocumentDiff {
  changed: boolean;
  outlines: BoundaryExtent[];
}

/** A diff that cannot run must keep the mark, because a missed change is worse than an extra mark. */
export const UNKNOWN_DIFF: DocumentDiff = { changed: true, outlines: [] };

/** An element that fills the frame answers no outline, because the frame clips that outline and the mark on the frame says the same thing. */
export function diffPrototypeDocuments(beforeHtml: string, afterHtml: string, width: number, height: number): Promise<DocumentDiff> {
  return readPrototypeTwin<DocumentDiff>(beforeHtml, width, height, before => readPrototypeTwin<DocumentDiff>(afterHtml, width, height, async after => {
    pauseAnimations(before);
    pauseAnimations(after);
    const view = after.defaultView as Window;
    const pairs = await changedElements(before, after);
    if (pairs.length === 0) return { changed: false, outlines: [] };
    const extents = pairs.flatMap(changedExtents);
    return { changed: true, outlines: extents.some(extent => coversView(extent, view)) ? [] : extents.map(extent => outlineOf(extent, view)) };
  }, UNKNOWN_DIFF), UNKNOWN_DIFF);
}

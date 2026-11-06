export interface BoundaryExtent {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BoundaryHit {
  boundaryId: string;
  instance: number;
  extent?: BoundaryExtent;
}

const boundaryAttributes = ['data-blueprint-boundary-id', 'data-blueprint-section-boundary-id'] as const;

export function measureBoundaryExtents(document: Document, boundaryIds: ReadonlySet<string>): BoundaryExtent[] {
  const view = document.defaultView;
  if (!view) return [];
  return boundaryElements(document)
    .filter(element => boundaryAttributes.some(attribute => boundaryIds.has(element.getAttribute(attribute) ?? '')))
    .map(element => measureElementExtent(element, view))
    .filter((extent): extent is BoundaryExtent => extent !== undefined);
}

export function boundaryHitsAtPoint(document: Document, x: number, y: number): BoundaryHit[] {
  const view = document.defaultView;
  if (!view) return [];
  const hits: BoundaryHit[] = [];
  for (let element = document.elementFromPoint(x, y); element; element = element.parentElement) {
    for (const attribute of boundaryAttributes) {
      const boundaryId = element.getAttribute(attribute);
      if (!boundaryId) continue;
      hits.push({
        boundaryId,
        instance: boundaryInstances(document, boundaryId).indexOf(element),
        extent: measureElementExtent(element, view)
      });
    }
  }
  return hits;
}

export function measureBoundaryInstance(document: Document, boundaryId: string, instance: number): BoundaryExtent | undefined {
  const view = document.defaultView;
  const element = boundaryInstances(document, boundaryId)[instance];
  return view && element ? measureElementExtent(element, view) : undefined;
}

function boundaryInstances(document: Document, boundaryId: string): Element[] {
  return boundaryElements(document)
    .filter(element => boundaryAttributes.some(attribute => element.getAttribute(attribute) === boundaryId));
}

function boundaryElements(document: Document): Element[] {
  return [...document.querySelectorAll(boundaryAttributes.map(attribute => `[${attribute}]`).join(', '))];
}

/** A positioned element escapes each clipper below its containing block, so each frame keeps what a positioned descendant needs to find that block. */
interface ClipFrame {
  childClip: BoundaryExtent | undefined;
  style?: CSSStyleDeclaration;
  parent?: ClipFrame;
  holdsFixed?: boolean;
}

const FIXED_CONTAINER_PROPERTIES = ['transform', 'translate', 'rotate', 'scale', 'perspective', 'filter', 'backdropFilter'] as const;
const FIXED_CONTAINER_CONTAIN = ['layout', 'paint', 'strict', 'content'];
const FIXED_CONTAINER_WILL_CHANGE = ['transform', 'translate', 'rotate', 'scale', 'perspective', 'filter', 'backdrop-filter', 'contain'];

function viewportExtent(view: Window): BoundaryExtent {
  return { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
}

function boxOf(element: Element): BoundaryExtent {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function holdsFixedDescendants(style: CSSStyleDeclaration): boolean {
  return FIXED_CONTAINER_PROPERTIES.some(property => style[property] !== 'none')
    || style.contain.split(' ').some(value => FIXED_CONTAINER_CONTAIN.includes(value))
    || style.willChange.split(/,\s*/).some(value => FIXED_CONTAINER_WILL_CHANGE.includes(value))
    || style.contentVisibility !== 'visible'
    || style.transformStyle === 'preserve-3d';
}

/** The viewport frame has no style and holds every positioned element that no ancestor holds. */
function holdsPositioned(frame: ClipFrame, position: string): boolean {
  if (!frame.style) return true;
  if (position === 'absolute' && frame.style.position !== 'static') return true;
  frame.holdsFixed ??= holdsFixedDescendants(frame.style);
  return frame.holdsFixed;
}

function clipOf(style: CSSStyleDeclaration, frame: ClipFrame): BoundaryExtent | undefined {
  const { position } = style;
  if (position !== 'absolute' && position !== 'fixed') return frame.childClip;
  let container = frame;
  while (container.parent && !holdsPositioned(container, position)) container = container.parent;
  return container.childClip;
}

function clipToOverflow(clip: BoundaryExtent, style: CSSStyleDeclaration, readBox: () => BoundaryExtent): BoundaryExtent | undefined {
  const clipsX = style.overflowX !== 'visible';
  const clipsY = style.overflowY !== 'visible';
  if (!clipsX && !clipsY) return clip;
  const box = readBox();
  return nonEmpty({
    left: clipsX ? Math.max(box.left, clip.left) : clip.left,
    top: clipsY ? Math.max(box.top, clip.top) : clip.top,
    right: clipsX ? Math.min(box.right, clip.right) : clip.right,
    bottom: clipsY ? Math.min(box.bottom, clip.bottom) : clip.bottom
  });
}

function frameForChildren(style: CSSStyleDeclaration, clip: BoundaryExtent | undefined, frame: ClipFrame, readBox: () => BoundaryExtent): ClipFrame {
  if (style.display === 'contents') return frame;
  return { childClip: clip && clipToOverflow(clip, style, readBox), style, parent: frame };
}

/** Each ancestor clips by the rule that `extentWithin` applies to descendants, so a boundary measures what its parent measures for it. */
export function measureElementExtent(element: Element, view: Window): BoundaryExtent | undefined {
  const ancestors: Element[] = [];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor);
  let frame: ClipFrame = { childClip: viewportExtent(view) };
  for (const ancestor of ancestors) {
    const style = view.getComputedStyle(ancestor);
    frame = frameForChildren(style, clipOf(style, frame), frame, () => boxOf(ancestor));
  }
  return extentWithin(element, view, frame);
}

function extentWithin(element: Element, view: Window, frame: ClipFrame): BoundaryExtent | undefined {
  const style = view.getComputedStyle(element);
  if (style.display === 'none') return undefined;
  const box = boxOf(element);
  const clip = clipOf(style, frame);
  const generatesBox = style.display !== 'contents' && box.right > box.left && box.bottom > box.top;
  let extent = clip && generatesBox && style.visibility !== 'hidden' ? intersectExtents(box, clip) : undefined;
  const childFrame = frameForChildren(style, clip, frame, () => box);
  for (const child of element.children) {
    extent = unionExtents(extent, extentWithin(child, view, childFrame));
  }
  return extent;
}

function intersectExtents(extent: BoundaryExtent, clip: BoundaryExtent): BoundaryExtent | undefined {
  return nonEmpty({
    left: Math.max(extent.left, clip.left),
    top: Math.max(extent.top, clip.top),
    right: Math.min(extent.right, clip.right),
    bottom: Math.min(extent.bottom, clip.bottom)
  });
}

function nonEmpty(extent: BoundaryExtent): BoundaryExtent | undefined {
  return extent.right > extent.left && extent.bottom > extent.top ? extent : undefined;
}

function unionExtents(left: BoundaryExtent | undefined, right: BoundaryExtent | undefined): BoundaryExtent | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    left: Math.min(left.left, right.left),
    top: Math.min(left.top, right.top),
    right: Math.max(left.right, right.right),
    bottom: Math.max(left.bottom, right.bottom)
  };
}

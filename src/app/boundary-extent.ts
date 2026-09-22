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
    .map(element => measureElementExtent(element, view, viewportExtent(view)))
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
        extent: measureElementExtent(element, view, viewportExtent(view))
      });
    }
  }
  return hits;
}

export function measureBoundaryInstance(document: Document, boundaryId: string, instance: number): BoundaryExtent | undefined {
  const view = document.defaultView;
  const element = boundaryInstances(document, boundaryId)[instance];
  return view && element ? measureElementExtent(element, view, viewportExtent(view)) : undefined;
}

function boundaryInstances(document: Document, boundaryId: string): Element[] {
  return boundaryElements(document)
    .filter(element => boundaryAttributes.some(attribute => element.getAttribute(attribute) === boundaryId));
}

function boundaryElements(document: Document): Element[] {
  return [...document.querySelectorAll(boundaryAttributes.map(attribute => `[${attribute}]`).join(', '))];
}

function viewportExtent(view: Window): BoundaryExtent {
  return { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
}

function measureElementExtent(element: Element, view: Window, clip: BoundaryExtent | undefined): BoundaryExtent | undefined {
  const style = view.getComputedStyle(element);
  if (style.display === 'none') return undefined;
  const rect = element.getBoundingClientRect();
  const box: BoundaryExtent = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  const generatesBox = style.display !== 'contents' && rect.width > 0 && rect.height > 0;
  let extent = generatesBox && style.visibility !== 'hidden' ? intersectExtents(box, clip) : undefined;
  const clipsChildren = generatesBox && (style.overflowX !== 'visible' || style.overflowY !== 'visible');
  const childClip = clipsChildren ? intersectExtents(box, clip) : clip;
  if (clipsChildren && !childClip) return extent;
  for (const child of element.children) {
    extent = unionExtents(extent, measureElementExtent(child, view, childClip));
  }
  return extent;
}

function intersectExtents(extent: BoundaryExtent, clip: BoundaryExtent | undefined): BoundaryExtent | undefined {
  if (!clip) return extent;
  const intersection = {
    left: Math.max(extent.left, clip.left),
    top: Math.max(extent.top, clip.top),
    right: Math.min(extent.right, clip.right),
    bottom: Math.min(extent.bottom, clip.bottom)
  };
  return intersection.right > intersection.left && intersection.bottom > intersection.top ? intersection : undefined;
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

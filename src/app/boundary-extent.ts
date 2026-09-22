export interface BoundaryExtent {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function measureBoundaryExtents(document: Document, boundaryIds: ReadonlySet<string>): BoundaryExtent[] {
  const view = document.defaultView;
  if (!view) return [];
  const viewportExtent: BoundaryExtent = { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
  return [...document.querySelectorAll('[data-blueprint-boundary-id], [data-blueprint-section-boundary-id]')]
    .filter(element => boundaryIds.has(element.getAttribute('data-blueprint-boundary-id') ?? '') ||
      boundaryIds.has(element.getAttribute('data-blueprint-section-boundary-id') ?? ''))
    .map(element => measureElementExtent(element, view, viewportExtent))
    .filter((extent): extent is BoundaryExtent => extent !== undefined);
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

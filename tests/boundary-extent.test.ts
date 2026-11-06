import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boundaryHitsAtPoint, measureBoundaryExtents, measureBoundaryInstance } from '../src/app/boundary-extent';

const BOUNDARY = 'data-blueprint-boundary-id';
const SECTION = 'data-blueprint-section-boundary-id';

type Rect = [left: number, top: number, right: number, bottom: number];

interface FakeElement {
  attributes: Record<string, string>;
  rect: Rect;
  style: Record<string, string>;
  children: FakeElement[];
  parentElement: FakeElement | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
}

function element(
  rect: Rect,
  options: { attributes?: Record<string, string>; style?: Record<string, string> } = {},
  ...children: FakeElement[]
): FakeElement {
  const created: FakeElement = {
    attributes: options.attributes ?? {},
    rect,
    style: options.style ?? {},
    children,
    parentElement: null,
    getAttribute: name => created.attributes[name] ?? null,
    getBoundingClientRect: () => {
      const [left, top, right, bottom] = created.rect;
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }
  };
  for (const child of children) child.parentElement = created;
  return created;
}

function boundary(id: string, rect: Rect, style: Record<string, string> = {}, ...children: FakeElement[]): FakeElement {
  return element(rect, { attributes: { [BOUNDARY]: id }, style }, ...children);
}

function inDocumentOrder(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap(inDocumentOrder)];
}

function fakeDocument(root: FakeElement, pointTarget: FakeElement | null = null): Document {
  return {
    defaultView: {
      innerWidth: 800,
      innerHeight: 600,
      getComputedStyle: (target: FakeElement) => ({
        display: 'block',
        visibility: 'visible',
        overflowX: 'visible',
        overflowY: 'visible',
        position: 'static',
        transform: 'none',
        translate: 'none',
        rotate: 'none',
        scale: 'none',
        perspective: 'none',
        filter: 'none',
        backdropFilter: 'none',
        contain: 'none',
        willChange: 'auto',
        contentVisibility: 'visible',
        transformStyle: 'flat',
        ...target.style
      })
    },
    querySelectorAll: (selector: string) => {
      const attributes = [...selector.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
      return inDocumentOrder(root).filter(candidate => attributes.some(attribute => candidate.getAttribute(attribute) !== null));
    },
    elementFromPoint: () => pointTarget
  } as unknown as Document;
}

const CLIPS = { overflowX: 'hidden', overflowY: 'hidden' };

function extentOf(left: number, top: number, right: number, bottom: number) {
  return { left, top, right, bottom };
}

function measureOne(target: FakeElement) {
  return measureBoundaryExtents(fakeDocument(element([0, 0, 800, 600], {}, target)), new Set(['target']));
}

describe('boundary extent', () => {
  it('returns nothing for a document without a window', () => {
    const detached = { ...fakeDocument(boundary('target', [0, 0, 10, 10])), defaultView: null } as unknown as Document;

    assert.deepEqual(measureBoundaryExtents(detached, new Set(['target'])), []);
    assert.deepEqual(boundaryHitsAtPoint(detached, 1, 1), []);
    assert.equal(measureBoundaryInstance(detached, 'target', 0), undefined);
  });

  it('measures only the requested ids, through either boundary attribute', () => {
    const root = element(
      [0, 0, 800, 600],
      {},
      boundary('first', [0, 0, 10, 10]),
      boundary('skipped', [20, 0, 30, 10]),
      element([40, 0, 50, 10], { attributes: { [SECTION]: 'second' } })
    );

    assert.deepEqual(measureBoundaryExtents(fakeDocument(root), new Set(['first', 'second'])), [
      extentOf(0, 0, 10, 10),
      extentOf(40, 0, 50, 10)
    ]);
  });

  it('clips an extent to the viewport, and drops one wholly outside it', () => {
    assert.deepEqual(measureOne(boundary('target', [-50, -50, 1000, 1000])), [extentOf(0, 0, 800, 600)]);
    assert.deepEqual(measureOne(boundary('target', [900, 0, 950, 50])), []);
  });

  it('drops an element with display none and its children', () => {
    const hidden = boundary('target', [0, 0, 10, 10], { display: 'none' }, element([0, 0, 50, 50]));

    assert.deepEqual(measureOne(hidden), []);
  });

  it('measures only the children of an element that paints no box of its own', () => {
    const child = () => element([10, 10, 20, 20]);

    assert.deepEqual(measureOne(boundary('target', [0, 0, 100, 100], { visibility: 'hidden' }, child())), [extentOf(10, 10, 20, 20)]);
    assert.deepEqual(measureOne(boundary('target', [0, 0, 100, 100], { display: 'contents' }, child())), [extentOf(10, 10, 20, 20)]);
    assert.deepEqual(measureOne(boundary('target', [0, 0, 0, 100], {}, child())), [extentOf(10, 10, 20, 20)]);
    assert.deepEqual(measureOne(boundary('target', [0, 0, 100, 100], { visibility: 'hidden' })), []);
  });

  it('grows an extent over a child that overflows without clipping', () => {
    const target = boundary('target', [10, 10, 20, 20], {}, element([5, 15, 40, 50]));

    assert.deepEqual(measureOne(target), [extentOf(5, 10, 40, 50)]);
  });

  it('clips a child to a parent on each axis that clips', () => {
    const child = () => element([0, 0, 200, 200]);

    assert.deepEqual(measureOne(boundary('target', [10, 10, 50, 50], { overflowX: 'hidden', overflowY: 'auto' }, child())), [extentOf(10, 10, 50, 50)]);
    assert.deepEqual(measureOne(boundary('target', [10, 10, 50, 50], { overflowX: 'clip' }, child())), [extentOf(10, 0, 50, 200)]);
    assert.deepEqual(measureOne(boundary('target', [10, 10, 50, 50], { overflowY: 'clip' }, child())), [extentOf(0, 10, 200, 50)]);
  });

  it('keeps the vertical extent of a child of a zero-height parent that clips only on the x axis', () => {
    const child = () => element([0, 0, 200, 80]);

    assert.deepEqual(measureOne(boundary('target', [10, 10, 100, 10], { overflowX: 'clip' }, child())), [extentOf(10, 0, 100, 80)]);
    assert.deepEqual(measureOne(element([10, 10, 100, 10], { style: { overflowX: 'clip' } }, boundary('target', [0, 0, 200, 80]))), [extentOf(10, 0, 100, 80)]);
  });

  it('measures a fixed boundary in a clipper by the view, from the ancestor start and in the walk', () => {
    const inClipper = element([0, 0, 100, 100], { style: CLIPS }, boundary('target', [0, 0, 800, 600], { position: 'fixed' }));
    const holdsFixed = boundary('target', [0, 0, 100, 100], CLIPS, element([0, 0, 800, 600], { style: { position: 'fixed' } }));

    assert.deepEqual(measureOne(inClipper), [extentOf(0, 0, 800, 600)]);
    assert.deepEqual(measureOne(holdsFixed), [extentOf(0, 0, 800, 600)]);
  });

  it('clips a fixed boundary to each clipper at or above its containing block', () => {
    const fixed = () => boundary('target', [0, 0, 800, 600], { position: 'fixed' });
    const transformedInClipper = element([10, 10, 100, 100], { style: CLIPS }, element([0, 0, 300, 300], { style: { transform: 'matrix(1, 0, 0, 1, 0, 0)' } }, fixed()));
    const clipperInTransformed = element([0, 0, 800, 600], { style: { filter: 'blur(1px)' } }, element([10, 10, 100, 100], { style: CLIPS }, fixed()));

    assert.deepEqual(measureOne(transformedInClipper), [extentOf(10, 10, 100, 100)]);
    assert.deepEqual(measureOne(clipperInTransformed), [extentOf(0, 0, 800, 600)]);
  });

  it('does not clip an absolute boundary to a clipper below its positioned ancestor', () => {
    const inClipper = element([0, 0, 800, 600], { style: { position: 'relative' } }, element([10, 10, 100, 100], { style: CLIPS }, boundary('target', [0, 0, 300, 300], { position: 'absolute' })));
    const holdsAbsolute = boundary('target', [10, 10, 100, 100], CLIPS, element([0, 0, 300, 300], { style: { position: 'absolute' } }));
    const belowContainment = element([0, 0, 800, 600], { style: { contain: 'layout' } }, element([10, 10, 100, 100], { style: CLIPS }, boundary('target', [0, 0, 300, 300], { position: 'absolute' })));

    assert.deepEqual(measureOne(inClipper), [extentOf(0, 0, 300, 300)]);
    assert.deepEqual(measureOne(holdsAbsolute), [extentOf(0, 0, 300, 300)]);
    assert.deepEqual(measureOne(belowContainment), [extentOf(0, 0, 300, 300)]);
  });

  it('clips an absolute boundary to a clipper that is or holds its containing block', () => {
    const absolute = () => boundary('target', [0, 0, 300, 300], { position: 'absolute' });
    const positionedClipper = element([10, 10, 100, 100], { style: { ...CLIPS, position: 'relative' } }, absolute());
    const positionedInClipper = element([10, 10, 100, 100], { style: CLIPS }, element([0, 0, 300, 300], { style: { position: 'relative' } }, absolute()));
    const willChangeInClipper = element([10, 10, 100, 100], { style: CLIPS }, element([0, 0, 300, 300], { style: { willChange: 'transform' } }, absolute()));
    const holdsAbsolute = boundary('target', [10, 10, 100, 100], { ...CLIPS, position: 'relative' }, element([0, 0, 300, 300], { style: { position: 'absolute' } }));

    assert.deepEqual(measureOne(positionedClipper), [extentOf(10, 10, 100, 100)]);
    assert.deepEqual(measureOne(positionedInClipper), [extentOf(10, 10, 100, 100)]);
    assert.deepEqual(measureOne(willChangeInClipper), [extentOf(10, 10, 100, 100)]);
    assert.deepEqual(measureOne(holdsAbsolute), [extentOf(10, 10, 100, 100)]);
  });

  it('skips the children of a clipping parent outside the viewport', () => {
    const target = boundary('target', [900, 0, 950, 50], { overflowX: 'hidden' }, element([0, 0, 50, 50]));

    assert.deepEqual(measureOne(target), []);
  });

  it('measures nothing for a clipping boundary with no height', () => {
    const target = boundary('target', [0, 0, 800, 0], { overflowY: 'hidden' }, element([0, 0, 120, 80]));

    assert.deepEqual(measureOne(target), []);
  });

  it('measures nothing for a clipping boundary with no width', () => {
    const target = boundary('target', [0, 0, 0, 100], { overflowX: 'hidden', overflowY: 'hidden' }, element([0, 0, 120, 80]));

    assert.deepEqual(measureOne(target), []);
  });

  it('measures nothing for a boundary inside a clipping ancestor with no height', () => {
    const collapsed = element([0, 0, 800, 0], { style: { overflowY: 'hidden' } }, boundary('target', [0, 0, 120, 80]));

    assert.deepEqual(measureOne(collapsed), []);
  });

  it('clips a boundary to each clipping ancestor', () => {
    const clipper = element([10, 10, 100, 100], { style: { overflowX: 'hidden', overflowY: 'hidden' } }, element([0, 0, 800, 600], {}, boundary('target', [0, 0, 200, 50])));

    assert.deepEqual(measureOne(clipper), [extentOf(10, 10, 100, 50)]);
  });

  it('lists each boundary from the point up to the root, with its instance and extent', () => {
    const inner = element([220, 20, 230, 30]);
    const firstCard = boundary('card', [0, 0, 100, 100]);
    const secondCard = element(
      [200, 0, 300, 100],
      { attributes: { [BOUNDARY]: 'card', [SECTION]: 'hero' } },
      element([210, 10, 290, 90], {}, inner)
    );
    const root = boundary('page', [0, 0, 800, 600], {}, firstCard, secondCard);

    assert.deepEqual(boundaryHitsAtPoint(fakeDocument(root, inner), 225, 25), [
      { boundaryId: 'card', instance: 1, extent: extentOf(200, 0, 300, 100) },
      { boundaryId: 'hero', instance: 0, extent: extentOf(200, 0, 300, 100) },
      { boundaryId: 'page', instance: 0, extent: extentOf(0, 0, 800, 600) }
    ]);
    assert.deepEqual(boundaryHitsAtPoint(fakeDocument(root, null), 225, 25), []);
    assert.deepEqual(boundaryHitsAtPoint(fakeDocument(element([0, 0, 800, 600]), element([0, 0, 1, 1])), 0, 0), []);
  });

  it('measures one instance by its position among the elements of that id', () => {
    const root = element(
      [0, 0, 800, 600],
      {},
      boundary('card', [0, 0, 10, 10]),
      boundary('other', [20, 0, 30, 10]),
      element([40, 0, 50, 10], { attributes: { [SECTION]: 'card' } }),
      boundary('hidden', [0, 0, 10, 10], { display: 'none' })
    );
    const document = fakeDocument(root);

    assert.deepEqual(measureBoundaryInstance(document, 'card', 0), extentOf(0, 0, 10, 10));
    assert.deepEqual(measureBoundaryInstance(document, 'card', 1), extentOf(40, 0, 50, 10));
    assert.equal(measureBoundaryInstance(document, 'card', 2), undefined);
    assert.equal(measureBoundaryInstance(document, 'hidden', 0), undefined);
  });
});

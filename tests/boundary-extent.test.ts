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

  it('clips a child to a parent that clips on either axis', () => {
    const child = () => element([0, 0, 200, 200]);

    assert.deepEqual(measureOne(boundary('target', [10, 10, 50, 50], { overflowX: 'hidden' }, child())), [extentOf(10, 10, 50, 50)]);
    assert.deepEqual(measureOne(boundary('target', [10, 10, 50, 50], { overflowY: 'auto' }, child())), [extentOf(10, 10, 50, 50)]);
  });

  it('skips the children of a clipping parent outside the viewport', () => {
    const target = boundary('target', [900, 0, 950, 50], { overflowX: 'hidden' }, element([0, 0, 50, 50]));

    assert.deepEqual(measureOne(target), []);
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

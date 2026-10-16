import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createCanvasController } from '../src/app/canvas-controller';

const viewportWidth = 1200;
const viewportHeight = 800;

function controller() {
  const viewport = { clientWidth: viewportWidth, clientHeight: viewportHeight, addEventListener() {} };
  const world = { style: { transform: '', setProperty() {} } };
  return createCanvasController({
    viewport: viewport as unknown as HTMLElement,
    world: world as unknown as HTMLElement
  });
}

function frame(left: number, top: number, width: number, height: number): HTMLElement {
  return { style: { left: `${left}px`, top: `${top}px` }, offsetWidth: width, offsetHeight: height } as unknown as HTMLElement;
}

describe('Blueprint canvas fit', () => {
  before(() => {
    Object.assign(globalThis, { window: { addEventListener() {} } });
  });

  it('top-aligns a tall screen below the board origin at the readable scale', () => {
    const canvas = controller();
    const top = 4200;
    canvas.fitTo([frame(1000, top, 1440, 6200)]);

    assert.equal(canvas.view.s, 0.55);
    assert.ok(Math.abs(canvas.view.y + top * canvas.view.s - (24 + 82 * canvas.view.s)) < 0.001);
  });

  it('centres a wide but short screen below the board origin at the readable scale', () => {
    const canvas = controller();
    const top = 2000;
    const height = 844;
    canvas.fitTo([0, 450, 900, 1350, 1800, 2250].map(left => frame(left, top, 390, height)));

    assert.equal(canvas.view.s, 0.55);
    const frameCentre = canvas.view.y + (top + height / 2) * canvas.view.s;
    assert.ok(Math.abs(frameCentre - (viewportHeight / 2 + 24)) < 0.001);
  });
});

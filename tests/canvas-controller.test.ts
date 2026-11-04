import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';
import { createCanvasController, GESTURE_IDLE_MS } from '../src/app/canvas-controller';

const viewportWidth = 1200;
const viewportHeight = 800;

function controller(listeners: Record<string, (event: unknown) => void> = {}) {
  const viewport = {
    clientWidth: viewportWidth,
    clientHeight: viewportHeight,
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners[type] = listener;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0 })
  };
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

  it('tells each view listener about a view change until it unsubscribes', () => {
    const canvas = controller();
    const scales: number[] = [];
    const unsubscribe = canvas.onViewChange(view => scales.push(view.s));
    canvas.setView({ x: 10, y: 20, s: 0.4 });
    unsubscribe();
    canvas.setView({ x: 0, y: 0, s: 0.9 });

    assert.deepEqual(scales, [0.4]);
  });

  it('reports a wheel gesture as active until it settles', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const listeners: Record<string, (event: unknown) => void> = {};
      const canvas = controller(listeners);
      assert.equal(canvas.gesturing(), false);
      listeners.wheel({ ctrlKey: false, deltaY: 40, deltaX: 0, clientX: 600, clientY: 400, preventDefault() {} });
      assert.equal(canvas.gesturing(), true);
      mock.timers.tick(GESTURE_IDLE_MS);
      assert.equal(canvas.gesturing(), false);
      canvas.setView({ x: 0, y: 0, s: 0.5 });
      assert.equal(canvas.gesturing(), false);
    } finally {
      mock.timers.reset();
    }
  });

  it('settles a continuous gesture at least every 500 ms and keeps it active until it is idle', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const listeners: Record<string, (event: unknown) => void> = {};
      const canvas = controller(listeners);
      const settled: Array<{ x: number; gesturing: boolean }> = [];
      canvas.onViewSettled(view => settled.push({ x: view.x, gesturing: canvas.gesturing() }));
      const wheel = { ctrlKey: false, deltaY: 0, deltaX: -5, clientX: 600, clientY: 400, preventDefault() {} };
      for (let elapsed = 0; elapsed < 1200; elapsed += 50) {
        listeners.wheel(wheel);
        mock.timers.tick(50);
      }

      assert.deepEqual(settled.map(entry => entry.gesturing), [true, true]);
      assert.ok(settled[0].x < settled[1].x, 'Each forced settle should carry the current view');
      mock.timers.tick(GESTURE_IDLE_MS);
      assert.deepEqual(settled.map(entry => entry.gesturing), [true, true, false]);
      mock.timers.tick(1000);
      assert.equal(settled.length, 3);
    } finally {
      mock.timers.reset();
    }
  });

  it('settles a wheel zoom once, after the gesture is idle, and a set view at once', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const listeners: Record<string, (event: unknown) => void> = {};
      const canvas = controller(listeners);
      const changed: number[] = [];
      const settled: number[] = [];
      canvas.onViewChange(view => changed.push(view.s));
      canvas.onViewSettled(view => settled.push(view.s));
      const wheel = { ctrlKey: true, deltaY: -10, deltaX: 0, clientX: 600, clientY: 400, preventDefault() {} };
      listeners.wheel(wheel);
      mock.timers.tick(GESTURE_IDLE_MS - 1);
      listeners.wheel(wheel);
      mock.timers.tick(GESTURE_IDLE_MS - 1);

      assert.equal(changed.length, 2);
      assert.deepEqual(settled, []);
      mock.timers.tick(1);
      assert.deepEqual(settled, [canvas.view.s]);

      canvas.setView({ x: 0, y: 0, s: 0.5 });
      assert.deepEqual(settled, [changed[1], 0.5]);
      mock.timers.tick(GESTURE_IDLE_MS);
      assert.equal(settled.length, 2);
    } finally {
      mock.timers.reset();
    }
  });
});

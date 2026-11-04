import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { trackFrameLoad, waitForFrameLoads } from '../src/app/frame-loads';

describe('Blueprint frame load wait', () => {
  it('counts a load that fired before the wait started', async () => {
    const early = new EventTarget();
    const late = new EventTarget();
    trackFrameLoad(early);
    trackFrameLoad(late);
    early.dispatchEvent(new Event('load'));
    setTimeout(() => late.dispatchEvent(new Event('load')), 10);

    const start = performance.now();
    await waitForFrameLoads([early, late], 1000);

    assert.ok(performance.now() - start < 500, 'the wait should end when both frames have loaded, not at the fallback');
  });

  it('ends at the fallback when a frame never loads', async () => {
    const frame = new EventTarget();
    trackFrameLoad(frame);
    const start = performance.now();
    await waitForFrameLoads([frame], 50);

    assert.ok(performance.now() - start >= 45);
  });
});

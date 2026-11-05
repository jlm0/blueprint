import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { WORKER_ANSWER_TIMEOUT_MS, changedFrameOutputs } from '../src/app/frame-output-client';
import type { FrameOutputTarget } from '../src/app/frame-output';
import type { CanvasProjectBundle, FramePreset } from '../src/core/types';

describe('the frame output client', () => {
  it('stops a worker that stays silent, and answers undefined, so that a caller rebuilds each frame in scope', { timeout: 10_000 }, async () => {
    let terminated = 0;
    class SilentWorker {
      postMessage(): void {}
      terminate(): void {
        terminated += 1;
      }
    }
    (globalThis as unknown as { Worker: unknown }).Worker = SilentWorker;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const target: FrameOutputTarget = { key: 'one', screenId: 'one', state: 'default', preset: { id: 'phone' } as FramePreset };
      const before = {} as CanvasProjectBundle;
      const after = {} as CanvasProjectBundle;
      const answer = changedFrameOutputs(before, after, [target]);
      mock.timers.tick(WORKER_ANSWER_TIMEOUT_MS);
      assert.equal(await answer, undefined);
      assert.equal(terminated, 1);
      assert.equal(await changedFrameOutputs(before, after, [target]), undefined, 'A failed worker must stay failed.');
    } finally {
      mock.timers.reset();
    }
  });
});

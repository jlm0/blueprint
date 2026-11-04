import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createFrameMounter,
  planFrameMounts,
  type FrameMountCandidate,
  type FrameMountPolicy,
  type MountableFrame
} from '../src/app/frame-mounting';

const viewport = { width: 1000, height: 800 };
const policy: FrameMountPolicy = { nearMargin: 200, farMargin: 600, maxFrames: 3, maxBytes: 1000 };

function row(count: number, options: Partial<FrameMountCandidate> = {}): FrameMountCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    box: { left: index * 500, top: 0, width: 400, height: 700 },
    mounted: false,
    bytes: undefined,
    ...options
  }));
}

describe('Blueprint frame mount plan', () => {
  it('mounts the frames in the viewport and near it, nearest the centre first', () => {
    const plan = planFrameMounts(row(4), { x: 20, y: 0, s: 1 }, viewport, policy);

    assert.deepEqual(plan.mount, [1, 0, 2]);
    assert.equal(plan.visibleMount, 2);
    assert.deepEqual(plan.unmount, []);
  });

  it('leaves frames beyond the near margin unmounted', () => {
    const plan = planFrameMounts(row(4), { x: -3000, y: 0, s: 1 }, viewport, policy);

    assert.deepEqual(plan.mount, []);
  });

  it('keeps a mounted frame until it passes the far margin, but mounts a frame only inside the near margin', () => {
    const view = { x: -1300, y: 0, s: 1 };
    const mounted = planFrameMounts(row(3, { mounted: true, bytes: 10 }), view, viewport, policy);
    const unmounted = planFrameMounts(row(3), view, viewport, policy);

    assert.deepEqual(mounted.unmount, [0]);
    assert.deepEqual(mounted.mount, []);
    assert.deepEqual(unmounted.mount, [2]);
  });

  it('caps mounted frames at a zoom that shows every frame and unmounts the farthest', () => {
    const frames = row(8, { mounted: true, bytes: 10 });
    const plan = planFrameMounts(frames, { x: 0, y: 0, s: 0.25 }, viewport, policy);

    assert.equal(plan.mount.length, 0);
    assert.equal(plan.unmount.length, 5);
    assert.deepEqual([...plan.unmount].sort(), [0, 1, 2, 6, 7]);
    assert.equal(plan.unmount[0], 0);
  });

  it('stops mounting once the next frame would pass the byte budget', () => {
    const frames = row(4, { bytes: 400 });
    const plan = planFrameMounts(frames, { x: 0, y: 0, s: 0.25 }, viewport, policy);

    assert.equal(plan.mount.length, 2);
  });

  it('estimates the bytes of a frame that never compiled from the frames that did', () => {
    const frames = [...row(2), ...row(3, { bytes: 600, mounted: true }).slice(2)];
    const plan = planFrameMounts(frames, { x: 0, y: 0, s: 0.25 }, viewport, policy);

    assert.equal(plan.mount.length, 0);
    assert.deepEqual(plan.unmount, []);
  });
});

describe('Blueprint frame mounter', () => {
  it('mounts frames across several tasks and settles when the visible frames are mounted', async () => {
    let mountedCount = 0;
    const tasks: number[] = [];
    let task = 0;
    const frames: MountableFrame[] = row(6).map(candidate => {
      const frame: MountableFrame = {
        ...candidate,
        mount() {
          frame.mounted = true;
          mountedCount += 1;
          tasks.push(task);
        },
        unmount() {
          frame.mounted = false;
        }
      };
      return frame;
    });
    const mounter = createFrameMounter({
      view: () => ({ x: 0, y: 0, s: 0.25 }),
      viewport: () => viewport,
      state: () => 'active',
      policy: { ...policy, maxFrames: 6 },
      maxMountsPerTask: 2,
      onMounted: () => {
        task += 1;
      }
    });
    for (const frame of frames) mounter.add(frame);
    await mounter.visibleMounted();
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(mountedCount, 6);
    assert.deepEqual(tasks, [0, 0, 1, 1, 2, 2]);
  });

  it('settles a waiter without mounting while the board is hidden', async () => {
    let mounts = 0;
    const mounter = createFrameMounter({
      view: () => ({ x: 0, y: 0, s: 1 }),
      viewport: () => viewport,
      state: () => 'hidden'
    });
    mounter.add({ ...row(1)[0], mount: () => { mounts += 1; }, unmount: () => undefined });
    await mounter.visibleMounted();

    assert.equal(mounts, 0);
  });
});

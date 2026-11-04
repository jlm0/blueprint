import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createFrameMounter,
  DEFAULT_FRAME_MOUNT_POLICY,
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

  it('keeps the visible frames that are mounted while a pan moves the view at the cap', () => {
    const viewport = { width: 2240, height: 1400 };
    const grid: FrameMountCandidate[] = [];
    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        grid.push({ box: { left: 90 + col * 473, top: 160 + row * 994, width: 415, height: 874 }, mounted: false, bytes: 200_000 });
      }
    }
    const apply = (plan: ReturnType<typeof planFrameMounts>): void => {
      for (const index of plan.unmount) grid[index].mounted = false;
      for (const index of plan.mount) grid[index].mounted = true;
    };
    let view = { x: 0, y: 0, s: 0.15 };
    apply(planFrameMounts(grid, view, viewport, DEFAULT_FRAME_MOUNT_POLICY));
    const visible = (index: number): boolean => {
      const { left, top, width, height } = grid[index].box;
      const x = view.x + left * view.s;
      const y = view.y + top * view.s;
      return x + width * view.s > 0 && x < viewport.width && y + height * view.s > 0 && y < viewport.height;
    };
    let visibleUnmounts = 0;
    for (let step = 0; step < 10; step += 1) {
      view = { ...view, x: view.x - 24 };
      const plan = planFrameMounts(grid, view, viewport, DEFAULT_FRAME_MOUNT_POLICY);
      visibleUnmounts += plan.unmount.filter(visible).length;
      apply(plan);
    }

    assert.equal(grid.filter(frame => frame.mounted).length, DEFAULT_FRAME_MOUNT_POLICY.maxFrames);
    assert.equal(visibleUnmounts, 0);
  });

  it('mounts a requested frame first, even past the cap', () => {
    const frames = row(5, { mounted: true });
    frames[4] = { ...frames[4], mounted: false, requested: true };
    const plan = planFrameMounts(frames, { x: 0, y: 0, s: 0.25 }, viewport, { ...policy, maxFrames: 4 });

    assert.deepEqual(plan.mount, [4]);
    assert.equal(plan.unmount.length, 1);
    assert.notEqual(plan.unmount[0], 4);
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
  it('mounts one frame per task, nearest the centre first, and settles when the visible frames are mounted', async () => {
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
      yieldToMain: async () => {
        task += 1;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    });
    for (const frame of frames) mounter.add(frame);
    await mounter.visibleMounted();
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(mountedCount, 6);
    assert.deepEqual(tasks, [0, 1, 2, 3, 4, 5]);
  });

  it('yields with scheduler.yield when the browser has it', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'scheduler');
    let yields = 0;
    Object.defineProperty(globalThis, 'scheduler', {
      configurable: true,
      value: {
        yield: () => {
          yields += 1;
          return new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    });
    try {
      let mounts = 0;
      const mounter = createFrameMounter({
        view: () => ({ x: 0, y: 0, s: 0.25 }),
        viewport: () => viewport,
        state: () => 'active',
        policy: { ...policy, maxFrames: 4 }
      });
      for (const candidate of row(4)) {
        const frame: MountableFrame = { ...candidate, mount: () => { frame.mounted = true; mounts += 1; }, unmount: () => undefined };
        mounter.add(frame);
      }
      await mounter.visibleMounted();
      await new Promise(resolve => setTimeout(resolve, 20));

      assert.equal(mounts, 4);
      assert.equal(yields, 4);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'scheduler', previous);
      else delete (globalThis as { scheduler?: unknown }).scheduler;
    }
  });

  it('drops the queued mounts when the page changes', async () => {
    let connected = true;
    let mounts = 0;
    let disposed = 0;
    const mounter = createFrameMounter({
      view: () => ({ x: 0, y: 0, s: 0.25 }),
      viewport: () => viewport,
      state: () => connected ? 'active' : 'disposed',
      policy: { ...policy, maxFrames: 6 },
      yieldToMain: () => new Promise(resolve => setTimeout(resolve, 0)),
      onDisposed: () => {
        disposed += 1;
      }
    });
    for (const candidate of row(6)) {
      const frame: MountableFrame = {
        ...candidate,
        mount: () => {
          frame.mounted = true;
          mounts += 1;
          if (mounts === 2) connected = false;
        },
        unmount: () => undefined
      };
      mounter.add(frame);
    }
    await mounter.visibleMounted();
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(mounts, 2);
    assert.equal(disposed, 1);
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

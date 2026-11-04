import type { CanvasView } from './canvas-controller';

export interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FrameMountCandidate {
  box: FrameBox;
  mounted: boolean;
  bytes: number | undefined;
  requested?: boolean;
}

export interface FrameMountPolicy {
  nearMargin: number;
  farMargin: number;
  maxFrames: number;
  maxBytes: number;
}

export interface FrameMountPlan {
  mount: number[];
  unmount: number[];
  visibleMount: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export const DEFAULT_FRAME_MOUNT_POLICY: FrameMountPolicy = {
  nearMargin: 600,
  farMargin: 1800,
  maxFrames: 32,
  maxBytes: 384 * 1024 * 1024
};

export function planFrameMounts(
  frames: readonly FrameMountCandidate[],
  view: CanvasView,
  viewport: ViewportSize,
  policy: FrameMountPolicy = DEFAULT_FRAME_MOUNT_POLICY
): FrameMountPlan {
  const known = frames.flatMap(frame => frame.bytes === undefined ? [] : [frame.bytes]);
  const estimate = known.length > 0 ? known.reduce((sum, bytes) => sum + bytes, 0) / known.length : 0;
  const ranked = frames
    .map((frame, index) => ({ index, ...viewportDistance(frame.box, view, viewport) }))
    .sort((left, right) => (
      Number(Boolean(frames[right.index].requested)) - Number(Boolean(frames[left.index].requested))
      || Number(left.edge > 0) - Number(right.edge > 0)
      || (left.edge === 0 ? Number(!frames[left.index].mounted) - Number(!frames[right.index].mounted) : 0)
      || left.edge - right.edge
      || left.centre - right.centre
    ));

  const kept = new Set<number>();
  let keptBytes = 0;
  for (const { index, edge } of ranked) {
    const frame = frames[index];
    if (!(edge <= policy.nearMargin || (frame.mounted && edge <= policy.farMargin))) continue;
    const bytes = frame.bytes ?? estimate;
    if (kept.size >= policy.maxFrames || (kept.size > 0 && keptBytes + bytes > policy.maxBytes)) break;
    kept.add(index);
    keptBytes += bytes;
  }

  const mount = ranked.filter(({ index }) => kept.has(index) && !frames[index].mounted);
  return {
    mount: mount.map(({ index }) => index),
    unmount: ranked.filter(({ index }) => frames[index].mounted && !kept.has(index)).map(({ index }) => index).reverse(),
    visibleMount: mount.filter(({ edge }) => edge === 0).length
  };
}

function viewportDistance(box: FrameBox, view: CanvasView, viewport: ViewportSize): { edge: number; centre: number } {
  const left = view.x + box.left * view.s;
  const top = view.y + box.top * view.s;
  const right = left + box.width * view.s;
  const bottom = top + box.height * view.s;
  const edge = Math.max(0, left - viewport.width, -right, top - viewport.height, -bottom);
  const centre = Math.hypot((left + right - viewport.width) / 2, (top + bottom - viewport.height) / 2);
  return { edge, centre };
}

export interface MountableFrame extends FrameMountCandidate {
  mount: () => void;
  unmount: () => void;
}

export type FrameMounterState = 'active' | 'hidden' | 'disposed';

export interface FrameMounterOptions {
  view: () => CanvasView;
  viewport: () => ViewportSize;
  state: () => FrameMounterState;
  policy?: FrameMountPolicy;
  yieldToMain?: () => Promise<void>;
  onMounted?: () => void;
  onDisposed?: () => void;
}

export interface FrameMounter {
  add: (frame: MountableFrame) => void;
  remove: (frame: MountableFrame) => void;
  schedule: () => void;
  visibleMounted: () => Promise<void>;
  hold: () => () => void;
}

export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise(resolve => setTimeout(resolve, 0));
}

export function createFrameMounter(options: FrameMounterOptions): FrameMounter {
  const frames: MountableFrame[] = [];
  const policy = options.policy ?? DEFAULT_FRAME_MOUNT_POLICY;
  const yieldNext = options.yieldToMain ?? yieldToMain;
  let waiters: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let holds = 0;
  let disposed = false;
  let pumping = false;

  const settle = (): void => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  const schedule = (): void => {
    if (disposed || pumping || timer !== undefined) return;
    timer = setTimeout(() => void pump(), 0);
  };

  async function pump(): Promise<void> {
    timer = undefined;
    pumping = true;
    try {
      for (;;) {
        const state = options.state();
        if (state === 'disposed') {
          disposed = true;
          settle();
          options.onDisposed?.();
          return;
        }
        if (state === 'hidden') {
          settle();
          return;
        }
        if (holds > 0) return;

        const plan = planFrameMounts(frames, options.view(), options.viewport(), policy);
        const toUnmount = plan.unmount.map(index => frames[index]);
        const next = plan.mount.length > 0 ? frames[plan.mount[0]] : undefined;
        for (const frame of toUnmount) frame.unmount();
        if (!next) {
          settle();
          return;
        }
        next.mount();
        options.onMounted?.();
        if (plan.visibleMount <= 1) settle();
        await yieldNext();
      }
    } finally {
      pumping = false;
    }
  }

  return {
    add(frame) {
      frames.push(frame);
      schedule();
    },
    remove(frame) {
      const index = frames.indexOf(frame);
      if (index >= 0) frames.splice(index, 1);
    },
    schedule,
    visibleMounted() {
      if (disposed) return Promise.resolve();
      return new Promise(resolve => {
        waiters.push(resolve);
        schedule();
      });
    },
    hold() {
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        schedule();
      };
    }
  };
}

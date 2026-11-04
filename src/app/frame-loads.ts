const frameLoads = new WeakMap<EventTarget, Promise<void>>();

function nextLoad(frame: EventTarget): Promise<void> {
  return new Promise(resolve => frame.addEventListener('load', () => resolve(), { once: true }));
}

export function trackFrameLoad(frame: EventTarget): void {
  frameLoads.set(frame, nextLoad(frame));
}

export async function waitForFrameLoads(frames: readonly EventTarget[], timeoutMs: number): Promise<void> {
  if (frames.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(frames.map(frame => frameLoads.get(frame) ?? nextLoad(frame))),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs);
    })
  ]);
  clearTimeout(timer);
}

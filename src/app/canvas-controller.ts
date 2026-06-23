export interface CanvasView {
  x: number;
  y: number;
  s: number;
}

export interface CanvasController {
  view: CanvasView;
  apply: () => void;
  zoomAt: (cx: number, cy: number, factor: number) => void;
  fitTo: (elements: HTMLElement[]) => void;
  makeDraggable: (element: HTMLElement, handle: HTMLElement) => void;
  configure: (nextOptions?: Partial<CanvasOptions>) => CanvasController;
  snapshot: () => CanvasView;
  setView: (nextView: CanvasView) => void;
}

export interface CanvasOptions {
  minScale: number;
  maxScale: number;
  fallbackWidth: number;
  fallbackHeight: number;
  beforeWheel?: (event: WheelEvent) => boolean | void;
}

interface CreateCanvasOptions extends Partial<CanvasOptions> {
  viewport: HTMLElement;
  world: HTMLElement;
}

export function createCanvasController({
  viewport,
  world,
  minScale = 0.08,
  maxScale = 3,
  fallbackWidth = 400,
  fallbackHeight = 200,
  beforeWheel
}: CreateCanvasOptions): CanvasController {
  const options: CanvasOptions = {
    minScale,
    maxScale,
    fallbackWidth,
    fallbackHeight,
    beforeWheel
  };
  const view: CanvasView = { x: 0, y: 0, s: 1 };
  let spaceHeld = false;

  function apply(): void {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  }

  function zoomAt(cx: number, cy: number, factor: number): void {
    const scale = Math.min(options.maxScale, Math.max(options.minScale, view.s * factor));
    const ratio = scale / view.s;
    view.x = cx - (cx - view.x) * ratio;
    view.y = cy - (cy - view.y) * ratio;
    view.s = scale;
    apply();
  }

  viewport.addEventListener(
    'wheel',
    event => {
      if (options.beforeWheel?.(event) === false) {
        return;
      }

      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.01));
      } else {
        view.x -= event.deltaX;
        view.y -= event.deltaY;
        apply();
      }
    },
    { passive: false }
  );

  viewport.addEventListener('pointerdown', event => {
    const onBackground = event.target === viewport || event.target === world;
    if (!(onBackground || spaceHeld || event.button === 1)) {
      return;
    }

    event.preventDefault();
    viewport.classList.add('panning');
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = view.x;
    const originY = view.y;

    const move = (moveEvent: PointerEvent): void => {
      view.x = originX + moveEvent.clientX - startX;
      view.y = originY + moveEvent.clientY - startY;
      apply();
    };

    const up = (): void => {
      viewport.classList.remove('panning');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  window.addEventListener('keydown', event => {
    if (event.code !== 'Space') {
      return;
    }

    spaceHeld = true;
    viewport.classList.add('pan-ready');
    event.preventDefault();
  });

  window.addEventListener('keyup', event => {
    if (event.code !== 'Space') {
      return;
    }

    spaceHeld = false;
    viewport.classList.remove('pan-ready');
  });

  function fitTo(elements: HTMLElement[]): void {
    if (elements.length === 0) {
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const element of elements) {
      const x = parseFloat(element.style.left || '0');
      const y = parseFloat(element.style.top || '0');
      const width = element.offsetWidth || options.fallbackWidth;
      const height = element.offsetHeight || options.fallbackHeight;
      minX = Math.min(minX, x - 40);
      minY = Math.min(minY, y - 82);
      maxX = Math.max(maxX, x + width + 40);
      maxY = Math.max(maxY, y + height + 82);
    }

    const width = maxX - minX;
    const height = maxY - minY;
    const nextScale = Math.min((window.innerWidth - 80) / width, (window.innerHeight - 140) / height, 1.18);
    view.s = Math.min(options.maxScale, Math.max(options.minScale, nextScale));
    view.x = (window.innerWidth - width * view.s) / 2 - minX * view.s;
    view.y = (window.innerHeight - height * view.s) / 2 - minY * view.s + 24;
    apply();
  }

  function makeDraggable(element: HTMLElement, handle: HTMLElement): void {
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const originX = parseFloat(element.style.left || '0');
      const originY = parseFloat(element.style.top || '0');

      const move = (moveEvent: PointerEvent): void => {
        element.style.left = `${originX + (moveEvent.clientX - startX) / view.s}px`;
        element.style.top = `${originY + (moveEvent.clientY - startY) / view.s}px`;
      };

      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function configure(nextOptions: Partial<CanvasOptions> = {}): CanvasController {
    Object.assign(options, nextOptions);
    return api;
  }

  function snapshot(): CanvasView {
    return { ...view };
  }

  function setView(nextView: CanvasView): void {
    view.x = nextView.x;
    view.y = nextView.y;
    view.s = nextView.s;
    apply();
  }

  const api: CanvasController = { view, apply, zoomAt, fitTo, makeDraggable, configure, snapshot, setView };
  return api;
}

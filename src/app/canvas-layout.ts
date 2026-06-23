export interface CanvasItemLayout {
  elements: () => HTMLElement[];
  reflow: () => HTMLElement[];
}

export interface CanvasItemLayoutOptions {
  selector?: string;
  chipClearance?: number;
  stackGap?: number;
  horizontalGap?: number;
  fallbackWidth?: number;
  fallbackHeight?: number;
}

interface LayoutItem {
  element: HTMLElement;
  x: number;
  y: number;
  width: number;
  height: number;
  chipClearance: number;
}

interface LayoutRect {
  element: HTMLElement;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function createCanvasItemLayout(root: HTMLElement, options: CanvasItemLayoutOptions = {}): CanvasItemLayout {
  const selector = options.selector ?? '.group-head, .spec';
  const chipClearance = options.chipClearance ?? 38;
  const stackGap = options.stackGap ?? 34;
  const horizontalGap = options.horizontalGap ?? 24;
  const fallbackWidth = options.fallbackWidth ?? 400;
  const fallbackHeight = options.fallbackHeight ?? 200;

  function elements(): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(selector)];
  }

  function reflow(): HTMLElement[] {
    const items = elements()
      .map(readItem)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const placed: LayoutRect[] = [];

    for (const item of items) {
      let y = item.y;
      let settled = false;

      while (!settled) {
        settled = true;
        const nextRect = rectFor(item, y);

        for (const previous of placed) {
          if (!overlapsHorizontally(nextRect, previous, horizontalGap)) {
            continue;
          }

          if (nextRect.top < previous.bottom + stackGap && nextRect.bottom > previous.top - stackGap) {
            y = previous.bottom + stackGap + item.chipClearance;
            settled = false;
          }
        }
      }

      item.element.style.top = `${y}px`;
      placed.push(rectFor(item, y));
    }

    return elements();
  }

  function readItem(element: HTMLElement): LayoutItem {
    const currentX = numberFromStyle(element.style.left, 0);
    const currentY = numberFromStyle(element.style.top, 0);
    element.dataset.layoutX ??= String(currentX);
    element.dataset.layoutY ??= String(currentY);
    const isSpec = element.classList.contains('spec');

    return {
      element,
      x: numberFromData(element.dataset.layoutX, currentX),
      y: numberFromData(element.dataset.layoutY, currentY),
      width: element.offsetWidth || fallbackWidth,
      height: element.offsetHeight || fallbackHeight,
      chipClearance: isSpec ? chipClearance : 0
    };
  }

  return { elements, reflow };
}

function rectFor(item: LayoutItem, y: number): LayoutRect {
  return {
    element: item.element,
    left: item.x,
    right: item.x + item.width,
    top: y - item.chipClearance,
    bottom: y + item.height
  };
}

function overlapsHorizontally(left: LayoutRect, right: LayoutRect, gap: number): boolean {
  return left.left < right.right + gap && left.right + gap > right.left;
}

function numberFromStyle(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberFromData(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

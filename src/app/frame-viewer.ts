import type { CanvasProjectBundle, FramePreset, ScreenDefinition } from '../core/types';
import { applyPrototypeIframeIsolation } from '../prototype/host-policy';
import { createHomeIndicator, createStatusBar } from './device-chrome';
import { createIconButton, el } from './dom';
import { failIcon } from './icons';
import { defaultMobileFramePreset } from './screen-layout';
import { backgroundAppearance } from './surround';

export const frameViewBySlot = new WeakMap<HTMLElement, FrameView>();

interface FrameView {
  bundle: CanvasProjectBundle;
  screen: ScreenDefinition;
  preset: FramePreset;
  document: () => string | undefined;
}

const frameViewerSteps: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1 };

export function openFrameViewer(origin: HTMLElement): void {
  const viewer = el('div', 'bp-frame-viewer');
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-modal', 'true');
  viewer.tabIndex = -1;
  const exit = createIconButton('bp-chrome-frame-tool bp-frame-viewer-exit', 'Exit full screen', failIcon());
  viewer.append(exit);

  let shown = origin;
  let content: HTMLElement | undefined;
  const fitPhone = (): void => {
    if (!content?.classList.contains('bp-frame-viewer-phone')) return;
    const scale = Math.min((window.innerHeight - 32) / content.offsetHeight, (window.innerWidth - 32) / content.offsetWidth);
    content.style.scale = `${Math.max(scale, 0.1)}`;
  };
  const show = (slot: HTMLElement): boolean => {
    const view = frameViewBySlot.get(slot);
    const html = view?.document();
    if (!view || !html) return false;
    shown = slot;
    viewer.dataset.frameType = view.preset.type;
    viewer.setAttribute('aria-label', `${view.screen.name} in full screen`);
    const next = createFrameViewerContent(view, html);
    if (content) content.replaceWith(next);
    else exit.before(next);
    content = next;
    fitPhone();
    return true;
  };
  const step = (offset: number): void => {
    const slots = [...document.querySelectorAll<HTMLElement>('.frame-slot')].filter(slot => frameViewBySlot.has(slot));
    const index = slots.findIndex(slot => slot === shown || slot.dataset.liveFrameKey === shown.dataset.liveFrameKey);
    if (index < 0) return;
    for (let next = index + offset; next >= 0 && next < slots.length; next += offset) {
      if (show(slots[next])) return;
    }
  };

  const close = (): void => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', keepFocus);
    window.removeEventListener('resize', fitPhone);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    if (document.fullscreenElement === viewer) void document.exitFullscreen().catch(() => undefined);
    viewer.remove();
  };
  const onKey = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === 'Escape') close();
    const offset = frameViewerSteps[event.key];
    if (offset === undefined || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    step(offset);
  };
  // The sandboxed iframe keeps its key events, so focus returns to the viewer for the arrow keys to work.
  const keepFocus = (): void => {
    window.setTimeout(() => {
      if (document.activeElement instanceof HTMLIFrameElement && viewer.contains(document.activeElement)) viewer.focus();
    });
  };
  const onFullscreenChange = (): void => {
    if (!document.fullscreenElement) close();
  };
  exit.addEventListener('click', close);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', keepFocus);
  window.addEventListener('resize', fitPhone);
  document.addEventListener('fullscreenchange', onFullscreenChange);

  document.body.append(viewer);
  if (!show(origin)) {
    close();
    return;
  }
  viewer.focus();
  void viewer.requestFullscreen?.().catch(() => undefined);
}

function createFrameViewerContent({ bundle, screen, preset }: FrameView, html: string): HTMLElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'bp-frame-viewer-iframe';
  applyPrototypeIframeIsolation(iframe);
  iframe.title = screen.name;
  iframe.srcdoc = html;
  if (preset.type !== 'mobile') return iframe;

  const phone = el('div', 'bp-frame-viewer-phone');
  phone.dataset.appearance = backgroundAppearance(bundle);
  phone.style.setProperty('--frame-width', `${preset.width}px`);
  phone.style.setProperty('--frame-height', `${viewerPhoneHeight(preset)}px`);
  const display = el('div', 'frame-display');
  display.append(iframe, createStatusBar(), createHomeIndicator());
  phone.append(display);
  return phone;
}

/** Tall mobile presets hold a whole scrolling page, so the viewer shows them through a standard phone viewport. */
function viewerPhoneHeight(preset: FramePreset): number {
  const reference = defaultMobileFramePreset();
  return Math.min(preset.height, Math.round(preset.width * reference.height / reference.width));
}

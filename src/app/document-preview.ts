import type { CanvasProjectBundle } from '../core/types';
import { el } from './dom';

// Previews keep their natural size and scale down only when the column is narrower, so pages never scroll sideways.
const previewFitObserver = new ResizeObserver(entries => {
  for (const entry of entries) scalePreview(entry.target as HTMLElement);
});

export function createPreviewFit(frame: HTMLIFrameElement): HTMLElement {
  const host = el('div', 'bp-chrome-preview-fit');
  host.append(frame);
  return host;
}

export function fitPreviewFrame(frame: HTMLIFrameElement, size: { width: number; height: number }): void {
  frame.style.width = `${size.width}px`;
  frame.style.height = `${size.height}px`;
  const host = frame.parentElement;
  if (!host) return;
  host.dataset.previewWidth = String(size.width);
  host.dataset.previewHeight = String(size.height);
  host.style.width = `${size.width}px`;
  scalePreview(host);
  previewFitObserver.observe(host);
}

function scalePreview(host: HTMLElement): void {
  const width = Number(host.dataset.previewWidth);
  const height = Number(host.dataset.previewHeight);
  const frame = host.firstElementChild;
  if (!(frame instanceof HTMLElement) || !width || !height || host.clientWidth === 0) return;
  const scale = Math.min(1, host.clientWidth / width);
  frame.style.transform = scale < 1 ? `scale(${scale})` : '';
  host.style.height = `${Math.ceil(height * scale)}px`;
}

export function measureComponentPreview(html: string, width: number, done: (size: { width: number; height: number }) => void): void {
  const probe = document.createElement('iframe');
  probe.style.cssText = `position:absolute;left:-10000px;top:0;width:${width}px;height:1px;border:0;visibility:hidden;`;
  probe.setAttribute('aria-hidden', 'true');
  probe.addEventListener('load', () => {
    const measure = (): void => {
      try {
        const body = probe.contentDocument?.body;
        const root = body?.firstElementChild as HTMLElement | null | undefined;
        const rect = root?.getBoundingClientRect();
        const intrinsic = rect && rect.width < width - 48 ? Math.ceil(rect.width) + 24 : width;
        const height = Math.max(rect ? Math.ceil(rect.bottom) + 12 : 0, probe.contentDocument?.documentElement.scrollHeight ?? 0);
        done({ width: Math.max(160, intrinsic), height: Math.min(1600, Math.max(48, height)) });
      } catch {
        // Keep the default preview size when the document cannot be measured.
      } finally {
        probe.remove();
      }
    };
    void (probe.contentDocument?.fonts.ready ?? Promise.resolve()).then(measure, measure);
  });
  probe.srcdoc = html;
  document.body.append(probe);
}

export function componentPreviewWidth(bundle: CanvasProjectBundle, componentId: string): number {
  const users = new Set([componentId]);
  for (const component of bundle.components.components) {
    if (component.uses.some(use => use.kind === 'component' && use.id === componentId)) users.add(component.id);
  }
  const presets = new Map(bundle.manifest.framePresets.map(preset => [preset.id, preset]));
  const widths = bundle.screens.screens
    .filter(screen => screen.sections.some(section => section.uses.some(use => use.kind === 'component' && users.has(use.id))))
    .flatMap(screen => {
      const preset = presets.get(screen.framePresetId);
      return preset ? [Math.min(preset.width, 1120)] : [];
    });
  return widths.length > 0 ? Math.min(...widths) : 640;
}

/**
 * Fits a specimen cell to its rendered control so the cell hugs the content
 * instead of clipping or stretching it. Controls with their own width hug it;
 * full-bleed controls (width:100% roots) keep the family width, and content
 * that runs wider grows its own cell.
 */
export function measureCanonicalCellSize(
  html: string,
  fallbackWidth: number,
  done: (size: { width: number; height: number }) => void
): void {
  const probe = document.createElement('iframe');
  // A 1px-tall probe lets the document's scroll size report the real content
  // extent, including overlays and line boxes that spill past the root.
  probe.style.cssText = `position:absolute;left:-10000px;top:0;width:${fallbackWidth}px;height:1px;border:0;visibility:hidden;`;
  probe.setAttribute('aria-hidden', 'true');
  probe.addEventListener('load', () => {
    try {
      const documentRoot = probe.contentDocument?.documentElement;
      const control = probe.contentDocument?.querySelector<HTMLElement>('[data-blueprint-primitive]') ?? probe.contentDocument?.body;
      const rect = control?.getBoundingClientRect();
      const fillsCell = !rect || rect.width >= fallbackWidth - 25;
      const extent = control ? [control, ...control.querySelectorAll('*')].reduce((right, node) => Math.max(right, node.getBoundingClientRect().right), 0) : 0;
      const overflow = (documentRoot?.scrollWidth ?? 0) > fallbackWidth ? documentRoot!.scrollWidth : 0;
      const measuredWidth = fillsCell
        ? Math.max(fallbackWidth, documentRoot?.scrollWidth ?? 0)
        : Math.max(Math.ceil(extent) + 12, overflow);
      const measuredHeight = rect ? Math.max(Math.ceil(rect.height) + 24, documentRoot?.scrollHeight ?? 0) : 88;
      done({
        width: Math.min(520, measuredWidth),
        height: Math.min(280, Math.max(40, measuredHeight))
      });
    } catch {
      // Keep the default cell size when the document cannot be measured.
    } finally {
      probe.remove();
    }
  });
  probe.srcdoc = html;
  document.body.append(probe);
}

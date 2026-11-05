import type { CanvasProjectBundle, FramePreset, ScreenDefinition } from '../core/types';
import { el } from './dom';
import { batteryIcon, lockIcon, signalIcon, wifiIcon } from './icons';
import { backgroundAppearance } from './surround';

/**
 * Phones render the full-bleed screen at preset size with the status bar and
 * home indicator overlaid, as on device; browsers keep their toolbar outside
 * the viewport because web content never renders beneath it.
 */
export function mountDeviceChrome(
  frame: HTMLElement,
  bundle: CanvasProjectBundle,
  screen: ScreenDefinition,
  preset: FramePreset,
  screenEl: HTMLElement
): void {
  frame.classList.add('frame-device');
  if (preset.type === 'mobile') {
    frame.dataset.appearance = backgroundAppearance(bundle);
    const display = el('div', 'frame-display');
    display.append(screenEl, createStatusBar(), createHomeIndicator());
    frame.append(display);
  } else {
    frame.append(createBrowserBar(screen), screenEl);
  }
}

export function createHomeIndicator(): HTMLElement {
  const indicator = el('div', 'home-indicator');
  indicator.setAttribute('aria-hidden', 'true');
  return indicator;
}

export function createStatusBar(): HTMLElement {
  const status = el('div', 'status-bar');
  status.setAttribute('aria-hidden', 'true');
  const icons = el('span', 'status-icons');
  icons.innerHTML = `${signalIcon()}${wifiIcon()}${batteryIcon()}`;
  status.append(el('span', 'status-time', '9:41'), el('span', 'status-island'), icons);
  return status;
}

function createBrowserBar(screen: ScreenDefinition): HTMLElement {
  const bar = el('div', 'browser-bar');
  const controls = el('span', 'browser-controls');
  controls.append(el('span', 'browser-dot close'), el('span', 'browser-dot minimize'), el('span', 'browser-dot maximize'));
  const address = el('span', 'browser-address');
  const route = el('span', 'browser-address-text', screen.productionRelationship?.routePath ?? screen.name);
  address.innerHTML = lockIcon();
  address.append(route);
  bar.append(controls, address, el('span', 'browser-bar-spacer'));
  return bar;
}

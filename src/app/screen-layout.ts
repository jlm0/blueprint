import { screenRoutePath } from '../core/screen-naming';
import type { CanvasProjectBundle, FramePreset, ScreenDefinition } from '../core/types';
import {
  type PrototypeReviewSelectionRequest,
  type SelectedPrototypeReviewCondition,
  selectPrototypeReviewCondition
} from '../prototype/compiler';
import { errorMessage } from './dom';

export interface ScreenFrameLayout {
  screen: ScreenDefinition;
  preset: FramePreset;
  x: number;
  y: number;
  pageLabel?: { text: string; x: number; y: number };
  prototypeSelection?: SelectedPrototypeReviewCondition;
  selectionError?: string;
}

// Rows are routes; a row's columns read left-to-right as substates of that route.
// The group key is the screen's full production route, so distinct subroutes
// (e.g. /settings vs /settings/flic) each get their own row instead of one
// overlong row per top-level section.
function routeGroupOf(screen: ScreenDefinition): string {
  return screenRoutePath(screen);
}

export function layoutScreenFrames(
  bundle: CanvasProjectBundle,
  request: PrototypeReviewSelectionRequest,
  pageFilter?: string
): ScreenFrameLayout[] {
  const startX = 90;
  const startY = 160;
  const gapX = 80;
  const gapY = 120;

  // Screens group by declared page; a page filter narrows the board to one page.
  // Within a page, each top-level route gets its own row in first-seen order; the
  // frame chip names the route.
  const groups = new Map<string | undefined, ScreenDefinition[]>();
  for (const screen of bundle.screens.screens) {
    const key = screen.page;
    if (pageFilter !== undefined && key !== pageFilter) {
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)?.push(screen);
  }

  const layouts: ScreenFrameLayout[] = [];
  let y = startY;
  // Page labels only earn their place when several pages share one canvas
  // (deep-link boards); on a single page the sub-navigation already names it.
  const showPageLabels = groups.size > 1;
  for (const [pageId, screens] of groups) {
    const rows = new Map<string, ScreenDefinition[]>();
    for (const screen of screens) {
      const key = routeGroupOf(screen);
      if (!rows.has(key)) {
        rows.set(key, []);
      }
      rows.get(key)?.push(screen);
    }
    let pageLabeled = !showPageLabels;
    for (const rowScreens of rows.values()) {
      let x = startX;
      let rowHeight = 0;
      for (const screen of rowScreens) {
        for (const resolved of resolveScreenFrameVariants(bundle, screen, request)) {
          const layout: ScreenFrameLayout = { screen, preset: resolved.preset, x, y, ...resolved.prototype };
          if (!pageLabeled && pageId !== undefined) {
            const text = bundle.screens.pages?.find(page => page.id === pageId)?.name ?? pageId;
            layout.pageLabel = { text, x: startX, y: y - 70 };
            pageLabeled = true;
          }
          layouts.push(layout);
          x += resolved.preset.width + gapX;
          rowHeight = Math.max(rowHeight, frameExtentHeight(resolved.preset));
        }
      }
      y += rowHeight + gapY;
    }
  }

  return layouts;
}

// Phones add their bezel around the preset-sized display; browsers add a
// toolbar above the preset-sized viewport.
export function frameExtentHeight(preset: FramePreset): number {
  return preset.height + (preset.type === 'mobile' ? 2 * PHONE_BEZEL : BROWSER_BAR_HEIGHT);
}

export const PHONE_BEZEL = 11;

const BROWSER_BAR_HEIGHT = 48;

function resolveScreenFrameVariants(
  bundle: CanvasProjectBundle,
  screen: ScreenDefinition,
  request: PrototypeReviewSelectionRequest
): Array<{
  preset: FramePreset;
  prototype: { prototypeSelection?: SelectedPrototypeReviewCondition; selectionError?: string };
}> {
  // An explicit state/viewport request (capture, deep link) keeps single-frame selection.
  if (request.state || request.viewport) {
    return [resolveScreenFrame(bundle, screen, request)];
  }
  // Default board view: one frame per declared review condition (phone, desktop, states).
  return screen.prototype.reviewConditions.map(condition => {
    const preset = bundle.manifest.framePresets.find(candidate => candidate.id === condition.framePresetId);
    if (!preset) {
      return {
        preset: resolveFramePreset(bundle, screen),
        prototype: {
          selectionError: `Screen "${screen.id}" review condition "${condition.id}" references unknown frame preset "${condition.framePresetId}".`
        }
      };
    }
    return {
      preset,
      prototype: {
        prototypeSelection: { conditionId: condition.id, framePresetId: condition.framePresetId, state: condition.state }
      }
    };
  });
}

function resolveScreenFrame(
  bundle: CanvasProjectBundle,
  screen: ScreenDefinition,
  request: PrototypeReviewSelectionRequest
): {
  preset: FramePreset;
  prototype: { prototypeSelection?: SelectedPrototypeReviewCondition; selectionError?: string };
} {
  try {
    const prototypeSelection = selectPrototypeReviewCondition(screen, request);
    const preset = bundle.manifest.framePresets.find(candidate => candidate.id === prototypeSelection.framePresetId);
    if (!preset) {
      throw new Error(
        `Screen "${screen.id}" review condition "${prototypeSelection.conditionId}" references unknown frame preset "${prototypeSelection.framePresetId}".`
      );
    }
    return { preset, prototype: { prototypeSelection } };
  } catch (error) {
    return {
      preset: resolveFramePreset(bundle, screen),
      prototype: { selectionError: errorMessage(error) }
    };
  }
}

function resolveFramePreset(bundle: CanvasProjectBundle, screen: ScreenDefinition): FramePreset {
  return (
    bundle.manifest.framePresets.find(preset => preset.id === screen.framePresetId) ??
    bundle.manifest.framePresets.find(preset => preset.type === 'mobile') ??
    bundle.manifest.framePresets[0] ??
    defaultMobileFramePreset()
  );
}

export function defaultMobileFramePreset(): FramePreset {
  return {
    id: 'phone',
    name: 'Phone',
    type: 'mobile',
    width: 393,
    height: 852,
    safeArea: {
      top: 59,
      right: 20,
      bottom: 34,
      left: 20
    }
  };
}

export function liveFrameKey(
  screenId: string,
  framePresetId: string,
  selection?: SelectedPrototypeReviewCondition
): string {
  return [screenId, framePresetId, selection?.state ?? '', selection?.conditionId ?? ''].join('\u0000');
}

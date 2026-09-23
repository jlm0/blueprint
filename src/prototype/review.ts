import { compilePrototypeDocument, selectPrototypeReviewCondition } from '../prototype/compiler';
import { boundaryId } from '../core/address';
import type { BlueprintProjectBundle } from '../core/types';

/** URL- or MCP-level intent for one declared browser-native screen review. */
export interface PrototypeReviewRequest {
  /** App-owned local screen ID. */
  screenId: string;
  /** Declared static screen state. */
  state?: string;
  /** Declared frame-preset ID or review-condition ID. */
  viewport?: string;
}

/** A validated review condition and its exact CSS-pixel viewport. */
export interface PrototypeReviewSelection {
  /** App-owned local screen ID. */
  screenId: string;
  /** Stable fully-qualified screen boundary ID. */
  boundaryId: string;
  /** Stable review-condition ID selected from the screen contract. */
  conditionId: string;
  /** Declared frame-preset ID. */
  framePresetId: string;
  /** Declared static screen state. */
  state: string;
  /** Exact CSS-pixel viewport width. */
  width: number;
  /** Exact CSS-pixel viewport height. */
  height: number;
}

/** A complete isolated source document paired with its validated review selection. */
export interface CompiledPrototypeReview {
  /** Validated condition and viewport metadata. */
  selection: PrototypeReviewSelection;
  /** Complete browser-native HTML document. */
  html: string;
  /** Mechanically observed reusable-boundary IDs, without source bodies. */
  observedBoundaryIds: string[];
}

/**
 * Resolves user intent against one screen's declared review conditions and frame presets.
 *
 * @throws {Error} When the screen, state, condition, or frame preset is undeclared.
 */
export function resolvePrototypeReviewSelection(
  bundle: BlueprintProjectBundle,
  request: PrototypeReviewRequest
): PrototypeReviewSelection {
  const screen = bundle.screens.screens.find(candidate => candidate.id === request.screenId);
  if (!screen) {
    throw new Error(`Screen not found: ${request.screenId}.`);
  }
  if (!screen.prototype) {
    throw new Error(`Screen "${screen.id}" has no browser-native prototype review source.`);
  }

  const condition = selectPrototypeReviewCondition(screen, {
    state: request.state,
    viewport: request.viewport
  });
  const framePreset = bundle.manifest.framePresets.find(candidate => candidate.id === condition.framePresetId);
  if (!framePreset) {
    throw new Error(
      `Screen "${screen.id}" review condition "${condition.conditionId}" references missing frame preset "${condition.framePresetId}".`
    );
  }
  if (!Number.isInteger(framePreset.width) || framePreset.width <= 0 || !Number.isInteger(framePreset.height) || framePreset.height <= 0) {
    throw new Error(`Frame preset "${framePreset.id}" must declare positive integer CSS-pixel dimensions.`);
  }

  return {
    screenId: screen.id,
    boundaryId: boundaryId(bundle.manifest.project.id, 'screen', screen.id),
    conditionId: condition.conditionId,
    framePresetId: condition.framePresetId,
    state: condition.state,
    width: framePreset.width,
    height: framePreset.height
  };
}

/**
 * Compiles one previously validated review selection into its isolated source document.
 *
 * @throws {Error} When governed source composition fails closed.
 */
export function compilePrototypeReview(
  bundle: BlueprintProjectBundle,
  selection: PrototypeReviewSelection
): CompiledPrototypeReview {
  const compiled = compilePrototypeDocument({
    bundle,
    target: { kind: 'screen', id: selection.screenId },
    state: selection.state,
    framePreset: bundle.manifest.framePresets.find(preset => preset.id === selection.framePresetId)
  });
  if (compiled.targetBoundaryId !== selection.boundaryId || compiled.state !== selection.state) {
    throw new Error(`Compiled screen review did not match the validated selection for "${selection.screenId}".`);
  }

  return {
    selection,
    html: compiled.html,
    observedBoundaryIds: [...new Set(compiled.observedUses.map(use => use.targetBoundaryId))]
  };
}

/**
 * Parses and validates the allowlisted query parameters for the source-focused review route.
 *
 * @throws {Error} When parameters are missing, duplicated, empty, or unsupported.
 */
export function parsePrototypeReviewRequest(requestUrl: URL): PrototypeReviewRequest {
  const allowed = new Set(['screen', 'state', 'viewport']);
  for (const key of requestUrl.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new Error(`Unsupported prototype review parameter "${key}".`);
    }
    if (requestUrl.searchParams.getAll(key).length !== 1) {
      throw new Error(`Prototype review parameter "${key}" must appear exactly once.`);
    }
  }

  const screenId = requireNonEmptySearchParam(requestUrl, 'screen');
  const state = optionalNonEmptySearchParam(requestUrl, 'state');
  const viewport = optionalNonEmptySearchParam(requestUrl, 'viewport');
  return { screenId, state, viewport };
}

function requireNonEmptySearchParam(requestUrl: URL, key: string): string {
  const value = requestUrl.searchParams.get(key);
  if (!value?.trim()) {
    throw new Error(`Missing prototype review parameter "${key}".`);
  }
  return value;
}

function optionalNonEmptySearchParam(requestUrl: URL, key: string): string | undefined {
  if (!requestUrl.searchParams.has(key)) {
    return undefined;
  }
  const value = requestUrl.searchParams.get(key);
  if (!value?.trim()) {
    throw new Error(`Prototype review parameter "${key}" must not be empty.`);
  }
  return value;
}

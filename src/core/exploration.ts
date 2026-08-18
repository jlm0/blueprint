import { createHash } from 'node:crypto';
import path from 'node:path';
import { screenVersionGroupKey } from './screen-naming';
import type {
  BlueprintProjectBundle,
  ExplorationCandidate,
  ExplorationDefinition,
  ExplorationFile,
  ExplorationPrototypeSource,
  ScreenDefinition,
  ScreenFile,
  ScreenPrototypeSource
} from './types';

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface ExplorationSummary {
  id: string;
  title: string;
  intent: string;
  lifecycle: ExplorationDefinition['lifecycle'];
  target: Omit<ExplorationDefinition['target'], 'baseline'>;
  candidates: Array<{ id: string; label: string }>;
  selectedCandidateId?: string;
  promotedScreenId?: string;
}

export interface ExplorationInspection {
  exploration: ExplorationDefinition;
  currentDigest: string;
  candidateDigests: Record<string, string>;
}

export interface CreateExplorationInput {
  id?: string;
  screenId: string;
  state: string;
  framePresetId: string;
  title: string;
  intent: string;
  candidateLabels: string[];
}

export interface TextSourceWrite {
  path: string;
  content: string;
}

export interface ExplorationMutationResult {
  explorations: ExplorationFile;
  exploration: ExplorationDefinition;
  prototypeSourceContents: Record<string, string>;
  sourceWrites: TextSourceWrite[];
}

export interface PromoteExplorationInput {
  explorationId: string;
  candidateId: string;
  expectedBaseDigest: string;
  expectedCurrentDigest: string;
  expectedCandidateDigest: string;
}

export interface PromotionResult extends ExplorationMutationResult {
  screens: ScreenFile;
  promotedScreen: ScreenDefinition;
  historicalScreen: ScreenDefinition;
}

/** Lists saved alternatives without exposing source text or treating them as screen boundaries. */
export function listExplorations(bundle: BlueprintProjectBundle): ExplorationSummary[] {
  return bundle.explorations.explorations.map(exploration => ({
    id: exploration.id,
    title: exploration.title,
    intent: exploration.intent,
    lifecycle: exploration.lifecycle,
    target: {
      screenId: exploration.target.screenId,
      state: exploration.target.state,
      framePresetId: exploration.target.framePresetId,
      baseDigest: exploration.target.baseDigest
    },
    candidates: exploration.candidates.map(candidate => ({ id: candidate.id, label: candidate.label })),
    ...(exploration.selectedCandidateId ? { selectedCandidateId: exploration.selectedCandidateId } : {}),
    ...(exploration.promotedScreenId ? { promotedScreenId: exploration.promotedScreenId } : {})
  }));
}

/** Returns one persistent exploration plus the digests callers need for compare-and-swap mutations. */
export function inspectExploration(bundle: BlueprintProjectBundle, explorationId: string): ExplorationInspection {
  const exploration = requireExploration(bundle, explorationId);
  const current = currentScreenForExploration(bundle, exploration);
  return {
    exploration: structuredClone(exploration),
    currentDigest: computeScreenDigest(bundle, current, screenPrototype(current)),
    candidateDigests: Object.fromEntries(exploration.candidates.map(candidate => [
      candidate.id,
      computeCandidateDigest(bundle, exploration, candidate)
    ]))
  };
}

/** Computes the current digest for a canonical screen using the same normalization as exploration baselines. */
export function computeCanonicalScreenDigest(bundle: BlueprintProjectBundle, screenId: string): string {
  const screen = bundle.screens.screens.find(candidate => candidate.id === screenId);
  if (!screen) {
    throw new Error(`Canonical screen "${screenId}" does not exist.`);
  }
  return computeScreenDigest(bundle, screen, screenPrototype(screen));
}

export function computeExplorationCandidateDigest(
  bundle: BlueprintProjectBundle,
  explorationId: string,
  candidateId: string
): string {
  const exploration = requireExploration(bundle, explorationId);
  const candidate = requireCandidate(exploration, candidateId);
  return computeCandidateDigest(bundle, exploration, candidate);
}

export function computeExplorationBaselineDigest(
  bundle: BlueprintProjectBundle,
  explorationId: string
): string {
  const exploration = requireExploration(bundle, explorationId);
  return computeScreenDigest(
    bundle,
    exploration.target.baseline.screen,
    exploration.target.baseline.prototype
  );
}

/**
 * Creates valid persistent metadata and byte-for-byte starter copies for the baseline and every candidate.
 * It deliberately does not generate or choose design content.
 */
export function createExplorationMetadata(
  bundle: BlueprintProjectBundle,
  input: CreateExplorationInput
): ExplorationMutationResult {
  const screen = bundle.screens.screens.find(candidate => candidate.id === input.screenId);
  if (!screen) {
    throw new Error(`Canonical screen "${input.screenId}" does not exist.`);
  }
  if (!screen.prototype) {
    throw new Error(`Canonical screen "${input.screenId}" does not have a governed prototype source.`);
  }
  if (!screen.prototype.reviewConditions.some(condition => (
    condition.state === input.state && condition.framePresetId === input.framePresetId
  ))) {
    throw new Error(
      `Canonical screen "${input.screenId}" does not declare review state "${input.state}" at frame preset "${input.framePresetId}".`
    );
  }
  const activeForTarget = bundle.explorations.explorations.find(exploration => (
    exploration.lifecycle === 'active' &&
    exploration.target.screenId === input.screenId &&
    exploration.target.state === input.state &&
    exploration.target.framePresetId === input.framePresetId
  ));
  if (activeForTarget) {
    throw new Error(
      `Canonical screen "${input.screenId}" already has active exploration "${activeForTarget.id}" for state "${input.state}" at frame preset "${input.framePresetId}".`
    );
  }
  assertHumanText('Exploration title', input.title);
  assertHumanText('Exploration intent', input.intent);
  if (input.candidateLabels.length < 2 || input.candidateLabels.length > 5) {
    throw new Error('An exploration must contain between 2 and 5 candidates.');
  }
  assertUniqueLabels(input.candidateLabels);

  const existingIds = new Set(bundle.explorations.explorations.map(exploration => exploration.id));
  const requestedId = input.id;
  if (requestedId !== undefined) {
    assertSafeId('Exploration id', requestedId);
    if (existingIds.has(requestedId)) {
      throw new Error(`Exploration id "${requestedId}" already exists.`);
    }
  }
  const explorationId = requestedId ?? nextAvailableId(
    `${safeIdSegment(screen.id)}-${safeIdSegment(input.title)}`,
    existingIds
  );
  const baseDigest = computeScreenDigest(bundle, screen, screenPrototype(screen));
  const baselinePrototype = snapshotPrototype(screen.prototype, explorationId, 'baseline');
  const candidateIds = new Set<string>();
  const candidates = input.candidateLabels.map(label => {
    const id = nextAvailableId(safeIdSegment(label), candidateIds);
    candidateIds.add(id);
    return {
      id,
      label,
      prototype: snapshotPrototype(screen.prototype!, explorationId, id)
    } satisfies ExplorationCandidate;
  });
  const exploration: ExplorationDefinition = {
    id: explorationId,
    title: input.title,
    intent: input.intent,
    lifecycle: 'active',
    target: {
      screenId: screen.id,
      state: input.state,
      framePresetId: input.framePresetId,
      baseDigest,
      baseline: {
        screen: structuredClone(screen),
        prototype: baselinePrototype
      }
    },
    candidates
  };

  const prototypeSourceContents = { ...bundle.prototypeSourceContents };
  const sourceWrites: TextSourceWrite[] = [];
  copyPrototypeSources(bundle, screenPrototype(screen), baselinePrototype, prototypeSourceContents, sourceWrites);
  for (const candidate of candidates) {
    copyPrototypeSources(bundle, screenPrototype(screen), candidate.prototype, prototypeSourceContents, sourceWrites);
  }

  return {
    explorations: {
      ...structuredClone(bundle.explorations),
      explorations: [...structuredClone(bundle.explorations.explorations), exploration]
    },
    exploration: structuredClone(exploration),
    prototypeSourceContents,
    sourceWrites
  };
}

/** Archives an exploration without removing any candidate or baseline source. */
export function archiveExploration(bundle: BlueprintProjectBundle, explorationId: string): ExplorationMutationResult {
  const exploration = requireExploration(bundle, explorationId);
  if (exploration.lifecycle === 'promoted') {
    throw new Error(`Promoted exploration "${explorationId}" cannot be archived.`);
  }
  const archived: ExplorationDefinition = { ...structuredClone(exploration), lifecycle: 'archived' };
  return {
    explorations: replaceExploration(bundle.explorations, archived),
    exploration: archived,
    prototypeSourceContents: { ...bundle.prototypeSourceContents },
    sourceWrites: []
  };
}

/**
 * Promotes an explicitly selected candidate while preserving the stable current screen ID.
 * The previous current render is appended as immutable Vn history and no input object is mutated.
 */
export function promoteExploration(
  bundle: BlueprintProjectBundle,
  input: PromoteExplorationInput
): PromotionResult {
  const exploration = requireExploration(bundle, input.explorationId);
  if (exploration.lifecycle !== 'active') {
    throw new Error(`Exploration "${exploration.id}" must be active before promotion.`);
  }
  const candidate = requireCandidate(exploration, input.candidateId);
  assertDigest('expectedBaseDigest', input.expectedBaseDigest, exploration.target.baseDigest);
  const baselineDigest = computeScreenDigest(
    bundle,
    exploration.target.baseline.screen,
    exploration.target.baseline.prototype
  );
  assertDigest('stored baseline digest', exploration.target.baseDigest, baselineDigest);

  const current = currentScreenForExploration(bundle, exploration);
  const currentDigest = computeScreenDigest(bundle, current, screenPrototype(current));
  assertDigest('expectedCurrentDigest', input.expectedCurrentDigest, currentDigest);
  const candidateDigest = computeCandidateDigest(bundle, exploration, candidate);
  assertDigest('expectedCandidateDigest', input.expectedCandidateDigest, candidateDigest);

  const group = screensInExplorationGroup(bundle, exploration);
  const currentVersion = group.length === 1 && current.version === undefined
    ? 1
    : Math.max(...group.map(screen => screen.version ?? 0));
  const nextVersion = currentVersion + 1;
  const historicalId = historyScreenId(current.id, currentVersion, new Set(bundle.screens.screens.map(screen => screen.id)));
  const historicalPrototype = snapshotPrototype(screenPrototype(current), exploration.id, `history-v${currentVersion}`);
  const historicalScreen = withPrototypeRefs(structuredClone(current), historicalPrototype);
  historicalScreen.id = historicalId;
  historicalScreen.version = currentVersion;

  const promotedScreen = structuredClone(current);
  promotedScreen.version = nextVersion;
  const promotedPrototype: ScreenPrototypeSource = {
    ...structuredClone(screenPrototype(current)),
    source: screenPrototype(current).source,
    styles: canonicalStyleTargets(screenPrototype(current), candidate.prototype.styles),
    assetRefs: [...candidate.prototype.assetRefs]
  };
  promotedScreen.prototype = promotedPrototype;
  promotedScreen.styleRefs = replaceRefs(
    promotedScreen.styleRefs,
    screenPrototype(current).styles,
    promotedPrototype.styles
  );

  const prototypeSourceContents = { ...bundle.prototypeSourceContents };
  const sourceWrites: TextSourceWrite[] = [];
  copyPrototypeSources(bundle, screenPrototype(current), historicalPrototype, prototypeSourceContents, sourceWrites);
  copyCandidateIntoCanonical(candidate, promotedScreen, bundle, prototypeSourceContents, sourceWrites);

  const screens = structuredClone(bundle.screens);
  screens.screens = screens.screens.map(screen => screen.id === current.id ? promotedScreen : screen);
  screens.screens.push(historicalScreen);

  const promotedExploration: ExplorationDefinition = {
    ...structuredClone(exploration),
    lifecycle: 'promoted',
    selectedCandidateId: candidate.id,
    promotedScreenId: promotedScreen.id
  };
  return {
    screens,
    explorations: replaceExploration(bundle.explorations, promotedExploration),
    exploration: promotedExploration,
    promotedScreen,
    historicalScreen,
    prototypeSourceContents,
    sourceWrites
  };
}

function currentScreenForExploration(bundle: BlueprintProjectBundle, exploration: ExplorationDefinition): ScreenDefinition {
  const group = screensInExplorationGroup(bundle, exploration);
  if (group.length === 0) {
    throw new Error(`Exploration "${exploration.id}" no longer has a canonical screen target.`);
  }
  return [...group].sort((left, right) => (right.version ?? 1) - (left.version ?? 1))[0]!;
}

function screensInExplorationGroup(bundle: BlueprintProjectBundle, exploration: ExplorationDefinition): ScreenDefinition[] {
  const key = screenVersionGroupKey(exploration.target.baseline.screen);
  return bundle.screens.screens.filter(screen => screenVersionGroupKey(screen) === key);
}

function computeCandidateDigest(
  bundle: BlueprintProjectBundle,
  exploration: ExplorationDefinition,
  candidate: ExplorationCandidate
): string {
  return digest({
    explorationId: exploration.id,
    candidate,
    sourceContents: prototypeText(candidate.prototype, bundle.prototypeSourceContents),
    assets: prototypeAssets(candidate.prototype, bundle)
  });
}

function computeScreenDigest(
  bundle: BlueprintProjectBundle,
  screen: ScreenDefinition,
  prototype: ExplorationPrototypeSource
): string {
  return digest({
    screen,
    sourceContents: prototypeText(prototype, bundle.prototypeSourceContents),
    assets: prototypeAssets(prototype, bundle)
  });
}

function prototypeText(prototype: ExplorationPrototypeSource, contents: Record<string, string>): string[] {
  return [prototype.source, ...prototype.styles].map(sourceRef => {
    const content = contents[sourceRef];
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error(`Governed prototype source "${sourceRef}" is missing or empty.`);
    }
    return content;
  });
}

function prototypeAssets(prototype: ExplorationPrototypeSource, bundle: BlueprintProjectBundle): unknown[] {
  return prototype.assetRefs.map(assetRef => {
    const asset = bundle.prototypeAssetContents[assetRef];
    if (!asset) {
      throw new Error(`Governed prototype asset "${assetRef}" is missing.`);
    }
    return asset;
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function screenPrototype(screen: ScreenDefinition): ScreenPrototypeSource {
  if (!screen.prototype) {
    throw new Error(`Canonical screen "${screen.id}" does not have a governed prototype source.`);
  }
  return screen.prototype;
}

function snapshotPrototype(
  prototype: ExplorationPrototypeSource,
  explorationId: string,
  suffix: string
): ExplorationPrototypeSource {
  const marker = `exploration-${explorationId}-${suffix}`;
  return {
    source: insertFileSuffix(prototype.source, marker),
    styles: prototype.styles.map(styleRef => insertFileSuffix(styleRef, marker)),
    assetRefs: [...prototype.assetRefs]
  };
}

function insertFileSuffix(fileRef: string, suffix: string): string {
  const extension = path.posix.extname(fileRef);
  const base = extension.length > 0 ? fileRef.slice(0, -extension.length) : fileRef;
  return `${base}.${suffix}${extension}`;
}

function copyPrototypeSources(
  bundle: BlueprintProjectBundle,
  from: ExplorationPrototypeSource,
  to: ExplorationPrototypeSource,
  contents: Record<string, string>,
  writes: TextSourceWrite[]
): void {
  const fromRefs = [from.source, ...from.styles];
  const toRefs = [to.source, ...to.styles];
  if (fromRefs.length !== toRefs.length) {
    throw new Error('Prototype source snapshots must preserve the source/style shape.');
  }
  fromRefs.forEach((sourceRef, index) => {
    const content = bundle.prototypeSourceContents[sourceRef];
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error(`Governed prototype source "${sourceRef}" is missing or empty.`);
    }
    const targetRef = toRefs[index]!;
    contents[targetRef] = content;
    writes.push({ path: targetRef, content });
  });
}

function copyCandidateIntoCanonical(
  candidate: ExplorationCandidate,
  promoted: ScreenDefinition,
  bundle: BlueprintProjectBundle,
  contents: Record<string, string>,
  writes: TextSourceWrite[]
): void {
  const prototype = screenPrototype(promoted);
  const candidateRefs = [candidate.prototype.source, ...candidate.prototype.styles];
  const targetRefs = [prototype.source, ...prototype.styles];
  candidateRefs.forEach((sourceRef, index) => {
    const content = bundle.prototypeSourceContents[sourceRef];
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error(`Governed prototype source "${sourceRef}" is missing or empty.`);
    }
    const targetRef = targetRefs[index];
    if (!targetRef) {
      throw new Error('Candidate styles could not be mapped to canonical screen source paths.');
    }
    contents[targetRef] = content;
    writes.push({ path: targetRef, content });
  });
}

function canonicalStyleTargets(current: ExplorationPrototypeSource, candidateStyles: string[]): string[] {
  return candidateStyles.map((_, index) => current.styles[index] ?? insertFileSuffix(current.source, `style-${index + 1}`));
}

function withPrototypeRefs(screen: ScreenDefinition, prototype: ExplorationPrototypeSource): ScreenDefinition {
  const current = screenPrototype(screen);
  screen.prototype = {
    ...screen.prototype!,
    source: prototype.source,
    styles: [...prototype.styles],
    assetRefs: [...prototype.assetRefs]
  };
  screen.styleRefs = replaceRefs(screen.styleRefs, current.styles, prototype.styles);
  screen.styleEvidence = screen.styleEvidence?.map(evidence => ({
    ...evidence,
    styleRef: replaceRef(evidence.styleRef, current.styles, prototype.styles),
    ...(evidence.sourceAnchor
      ? { sourceAnchor: replaceRef(evidence.sourceAnchor, current.styles, prototype.styles) }
      : {})
  }));
  return screen;
}

function replaceRefs(refs: string[], from: string[], to: string[]): string[] {
  return refs.map(ref => replaceRef(ref, from, to));
}

function replaceRef(ref: string, from: string[], to: string[]): string {
  const index = from.indexOf(ref);
  return index >= 0 ? (to[index] ?? ref) : ref;
}

function historyScreenId(currentId: string, version: number, existing: Set<string>): string {
  const candidate = `${safeIdSegment(currentId)}-v${version}`;
  if (existing.has(candidate)) {
    throw new Error(`Cannot preserve screen history because id "${candidate}" already exists.`);
  }
  return candidate;
}

function replaceExploration(file: ExplorationFile, replacement: ExplorationDefinition): ExplorationFile {
  return {
    ...structuredClone(file),
    explorations: file.explorations.map(exploration => (
      exploration.id === replacement.id ? structuredClone(replacement) : structuredClone(exploration)
    ))
  };
}

function requireExploration(bundle: BlueprintProjectBundle, explorationId: string): ExplorationDefinition {
  const exploration = bundle.explorations.explorations.find(candidate => candidate.id === explorationId);
  if (!exploration) {
    throw new Error(`Exploration "${explorationId}" does not exist.`);
  }
  return exploration;
}

function requireCandidate(exploration: ExplorationDefinition, candidateId: string): ExplorationCandidate {
  const candidate = exploration.candidates.find(item => item.id === candidateId);
  if (!candidate) {
    throw new Error(`Exploration "${exploration.id}" does not contain candidate "${candidateId}".`);
  }
  return candidate;
}

function nextAvailableId(baseInput: string, existing: Set<string>): string {
  const unbounded = baseInput.length > 0 ? baseInput : 'exploration';
  const base = unbounded.slice(0, 64).replace(/-+$/g, '') || 'exploration';
  if (!existing.has(base)) {
    return base;
  }
  let index = 2;
  while (true) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function safeIdSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return normalized || createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function assertSafeId(label: string, value: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} "${value}" must use 1-64 lowercase letters, numbers, or internal hyphens.`);
  }
}

function assertHumanText(label: string, value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be non-empty, at most 160 characters, and contain no control characters.`);
  }
}

function assertUniqueLabels(labels: string[]): void {
  const seen = new Set<string>();
  for (const label of labels) {
    assertHumanText('Candidate label', label);
    const key = label.trim().toLocaleLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate candidate label "${label}".`);
    }
    seen.add(key);
  }
}

function assertDigest(label: string, expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error(`${label} is stale; expected "${expected}" but current digest is "${actual}".`);
  }
}

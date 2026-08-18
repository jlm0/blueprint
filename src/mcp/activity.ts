import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { boundaryId, parseBoundarySelector } from '../core/address';
import type {
  BlueprintAgentActivityEvent,
  BlueprintAgentActivityFocus,
  BlueprintAgentActivityPhase
} from '../core/activity';
import type { BlueprintProjectBundle, BoundaryKind } from '../core/types';

export const BLUEPRINT_ACTIVITY_STREAM_PATH = '/__blueprint/events';
export const BLUEPRINT_ACTIVITY_POST_PATH = '/__blueprint/agent-activity';
export const BLUEPRINT_ACTIVITY_TOKEN_HEADER = 'x-blueprint-activity-token';
export const BLUEPRINT_ACTIVITY_RUNTIME_VERSION = 1;

const runtimeDirectory = path.join(tmpdir(), 'blueprint-agent-activity-v1');
const terminalActivityRetentionMs = 2_000;

export interface BlueprintActivityRuntimeDescriptor {
  version: 1;
  projectRoot: string;
  activityUrl: string;
  token: string;
  pid: number;
  createdAt: string;
}

export interface RegisteredBlueprintActivityRuntime {
  descriptor: BlueprintActivityRuntimeDescriptor;
  filePath: string;
  close: () => Promise<void>;
}

export interface BlueprintHookBridgeEvent {
  version: 1;
  sessionId: string;
  turnId?: string;
  toolUseId: string;
  toolName: string;
  phase: BlueprintAgentActivityPhase;
  emittedAt: string;
  toolInput: unknown;
}

export class BlueprintActivityHub {
  readonly #clients = new Set<ServerResponse>();
  readonly #activityByToolUseId = new Map<string, BlueprintAgentActivityEvent>();
  readonly #terminalTimers = new Map<string, NodeJS.Timeout>();

  connect(response: ServerResponse): void {
    this.#clients.add(response);
    response.on('close', () => {
      this.#clients.delete(response);
    });
    response.write(': blueprint activity stream\n\n');
    for (const event of [...this.#activityByToolUseId.values()].sort((left, right) => left.emittedAt.localeCompare(right.emittedAt))) {
      writeServerSentEvent(response, 'agent-activity', event);
    }
  }

  publishActivity(event: BlueprintAgentActivityEvent): void {
    const activityKey = `${event.sessionId}\u0000${event.toolUseId}`;
    const previous = this.#activityByToolUseId.get(activityKey);
    if (previous?.phase === event.phase) {
      return;
    }
    if (previous && activityPhaseRank(previous.phase) > activityPhaseRank(event.phase)) {
      return;
    }

    this.#activityByToolUseId.set(activityKey, event);
    this.publish('agent-activity', event);

    const currentTimer = this.#terminalTimers.get(activityKey);
    if (currentTimer) {
      clearTimeout(currentTimer);
      this.#terminalTimers.delete(activityKey);
    }
    if (event.phase !== 'started') {
      const timer = setTimeout(() => {
        this.#activityByToolUseId.delete(activityKey);
        this.#terminalTimers.delete(activityKey);
      }, terminalActivityRetentionMs);
      timer.unref();
      this.#terminalTimers.set(activityKey, timer);
    }
  }

  publish(eventName: string, value: unknown): void {
    for (const client of this.#clients) {
      writeServerSentEvent(client, eventName, value);
    }
  }

  close(): void {
    for (const timer of this.#terminalTimers.values()) {
      clearTimeout(timer);
    }
    this.#terminalTimers.clear();
    this.#activityByToolUseId.clear();
    for (const client of this.#clients) {
      client.end();
    }
    this.#clients.clear();
  }
}

export async function registerBlueprintActivityRuntime(
  projectRoot: string,
  activityUrl: string
): Promise<RegisteredBlueprintActivityRuntime> {
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const descriptor: BlueprintActivityRuntimeDescriptor = {
    version: BLUEPRINT_ACTIVITY_RUNTIME_VERSION,
    projectRoot: path.resolve(projectRoot),
    activityUrl,
    token: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString()
  };
  const fileName = `runtime-${process.pid}-${randomUUID()}.json`;
  const filePath = path.join(runtimeDirectory, fileName);
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(descriptor)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, filePath);
  return {
    descriptor,
    filePath,
    close: async () => {
      await rm(filePath, { force: true });
    }
  };
}

export async function readBlueprintActivityRuntimeDescriptors(): Promise<BlueprintActivityRuntimeDescriptor[]> {
  let entries: string[];
  try {
    entries = await readdir(runtimeDirectory);
  } catch {
    return [];
  }

  const descriptors: BlueprintActivityRuntimeDescriptor[] = [];
  for (const entry of entries.filter(candidate => candidate.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(await readFile(path.join(runtimeDirectory, entry), 'utf8')) as unknown;
      if (isBlueprintActivityRuntimeDescriptor(parsed)) {
        descriptors.push(parsed);
      }
    } catch {
      // Runtime discovery is best-effort. A stale or partially removed file
      // must never fail the Codex tool call that triggered the hook.
    }
  }
  return descriptors;
}

export function selectBlueprintActivityRuntimes(
  descriptors: BlueprintActivityRuntimeDescriptor[],
  event: Pick<BlueprintHookBridgeEvent, 'toolInput'> & { cwd: string }
): BlueprintActivityRuntimeDescriptor[] {
  const cwd = path.resolve(event.cwd);
  const toolInput = asRecord(event.toolInput);
  const explicitProject = typeof toolInput?.project === 'string' ? path.resolve(cwd, toolInput.project) : undefined;
  if (explicitProject) {
    return descriptors.filter(descriptor => samePath(descriptor.projectRoot, explicitProject));
  }

  const inputText = collectStrings(event.toolInput).join('\n').replaceAll('\\', '/');
  const pathMatched = descriptors.filter(descriptor => {
    const projectRoot = path.resolve(descriptor.projectRoot);
    const relative = path.relative(cwd, projectRoot).replaceAll('\\', '/');
    return inputText.includes(projectRoot.replaceAll('\\', '/')) || (relative.length > 0 && inputText.includes(relative));
  });
  if (pathMatched.length > 0) {
    return pathMatched;
  }

  return descriptors.filter(descriptor => pathsOverlap(cwd, path.resolve(descriptor.projectRoot)));
}

export function parseBlueprintHookBridgeEvent(value: unknown): BlueprintHookBridgeEvent | undefined {
  const record = asRecord(value);
  if (
    record?.version !== 1 ||
    typeof record.sessionId !== 'string' ||
    typeof record.toolUseId !== 'string' ||
    typeof record.toolName !== 'string' ||
    !isActivityPhase(record.phase) ||
    typeof record.emittedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    version: 1,
    sessionId: record.sessionId,
    ...(typeof record.turnId === 'string' ? { turnId: record.turnId } : {}),
    toolUseId: record.toolUseId,
    toolName: record.toolName,
    phase: record.phase,
    emittedAt: record.emittedAt,
    toolInput: record.toolInput
  };
}

export function createBlueprintAgentActivityEvent(
  bundle: BlueprintProjectBundle,
  event: BlueprintHookBridgeEvent
): BlueprintAgentActivityEvent {
  const focus = resolveActivityFocus(bundle, event.toolInput);
  return {
    version: 1,
    sessionId: event.sessionId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    phase: event.phase,
    label: activityLabel(bundle, focus, event.phase),
    emittedAt: event.emittedAt,
    focus
  };
}

export function resolveActivityFocus(bundle: BlueprintProjectBundle, toolInput: unknown): BlueprintAgentActivityFocus {
  const input = asRecord(toolInput);
  const query = asRecord(input?.query);
  const operation = asRecord(input?.operation);
  const directSelector = firstString(input?.boundary, query?.boundary);
  if (directSelector) {
    const parsed = safeBoundarySelector(directSelector);
    if (parsed) {
      return focusForBoundary(bundle, parsed.kind, parsed.id);
    }
  }

  const screenId = firstString(input?.screenId, query?.screenId, query?.screen, operation?.screenId);
  if (screenId) {
    return focusForBoundary(bundle, 'screen', screenId);
  }

  const explorationId = firstString(input?.explorationId, query?.explorationId, operation?.explorationId);
  if (explorationId) {
    const exploration = bundle.explorations.explorations.find(candidate => candidate.id === explorationId);
    if (exploration) {
      return focusForBoundary(bundle, 'screen', exploration.target.screenId);
    }
  }

  const inputText = collectStrings(toolInput).join('\n').replaceAll('\\', '/');
  const sourceFocus = focusForSourceReference(bundle, inputText);
  if (sourceFocus) {
    return sourceFocus;
  }

  if (inputText.includes('screens.json')) {
    return focusForBoundary(bundle, 'board', 'screens');
  }
  if (inputText.includes('tokens.json') || inputText.includes('primitives.json') || inputText.includes('components.json')) {
    return focusForBoundary(bundle, 'board', 'primitives');
  }
  return focusForBoundary(bundle, 'project', bundle.manifest.project.id);
}

function focusForSourceReference(bundle: BlueprintProjectBundle, inputText: string): BlueprintAgentActivityFocus | undefined {
  const candidates: Array<{ ref: string; kind: BoundaryKind; id: string }> = [];
  for (const primitive of bundle.primitives.primitives) {
    if (primitive.prototype) {
      for (const ref of [primitive.prototype.source, ...primitive.prototype.styles]) {
        candidates.push({ ref, kind: 'primitive', id: primitive.id });
      }
    }
  }
  for (const component of bundle.components.components) {
    if (component.prototype) {
      for (const ref of [component.prototype.source, ...component.prototype.styles]) {
        candidates.push({ ref, kind: 'component', id: component.id });
      }
    }
  }
  for (const screen of bundle.screens.screens) {
    if (screen.prototype) {
      for (const ref of [screen.prototype.source, ...screen.prototype.styles, ...screen.prototype.assetRefs]) {
        candidates.push({ ref, kind: 'screen', id: screen.id });
      }
    }
  }
  for (const exploration of bundle.explorations.explorations) {
    for (const prototype of [exploration.target.baseline.prototype, ...exploration.candidates.map(candidate => candidate.prototype)]) {
      for (const ref of [prototype.source, ...prototype.styles, ...prototype.assetRefs]) {
        candidates.push({ ref, kind: 'screen', id: exploration.target.screenId });
      }
    }
  }
  for (const entry of bundle.history.entries) {
    if (entry.screen.prototype) {
      for (const ref of [entry.screen.prototype.source, ...entry.screen.prototype.styles, ...entry.screen.prototype.assetRefs]) {
        candidates.push({ ref, kind: 'screen', id: entry.screenId });
      }
    }
  }

  candidates.sort((left, right) => right.ref.length - left.ref.length);
  const matched = candidates.find(candidate => inputText.includes(candidate.ref.replaceAll('\\', '/')));
  return matched ? focusForBoundary(bundle, matched.kind, matched.id) : undefined;
}

function focusForBoundary(bundle: BlueprintProjectBundle, kind: BoundaryKind, localId: string): BlueprintAgentActivityFocus {
  const screenId = kind === 'section' ? localId.split('/')[0] : kind === 'screen' ? localId : undefined;
  return {
    boundaryId: boundaryId(bundle.manifest.project.id, kind, localId),
    kind,
    localId,
    board: boardForBoundary(kind),
    ...(screenId ? { screenId } : {})
  };
}

function activityLabel(
  bundle: BlueprintProjectBundle,
  focus: BlueprintAgentActivityFocus,
  phase: BlueprintAgentActivityPhase
): string {
  const target = boundaryName(bundle, focus);
  if (phase === 'failed') {
    return `Codex could not finish ${target}`;
  }
  if (phase === 'completed') {
    return `Codex finished ${target}`;
  }
  return `Codex is looking at ${target}`;
}

function boundaryName(bundle: BlueprintProjectBundle, focus: BlueprintAgentActivityFocus): string {
  if (focus.kind === 'project') return bundle.manifest.project.name;
  if (focus.kind === 'board') return focus.localId === 'screens' ? 'Screens' : 'Primitives';
  if (focus.kind === 'token-group') {
    return bundle.tokens.tokenGroups.find(candidate => candidate.id === focus.localId)?.name ?? focus.localId;
  }
  if (focus.kind === 'primitive') {
    return bundle.primitives.primitives.find(candidate => candidate.id === focus.localId)?.name ?? focus.localId;
  }
  if (focus.kind === 'component') {
    return bundle.components.components.find(candidate => candidate.id === focus.localId)?.name ?? focus.localId;
  }
  if (focus.kind === 'screen') {
    return bundle.screens.screens.find(candidate => candidate.id === focus.localId)?.name ?? focus.localId;
  }
  if (focus.kind === 'section') {
    const [screenId, sectionId] = focus.localId.split('/');
    return bundle.screens.screens
      .find(candidate => candidate.id === screenId)
      ?.sections.find(candidate => candidate.id === sectionId)?.name ?? focus.localId;
  }
  if (focus.kind === 'state-set') {
    const [primitiveId, stateSetId] = focus.localId.split('/');
    return bundle.primitives.primitives
      .find(candidate => candidate.id === primitiveId)
      ?.stateSets.find(candidate => candidate.id === stateSetId)?.name ?? focus.localId;
  }
  return focus.localId;
}

function boardForBoundary(kind: BoundaryKind): 'primitives' | 'screens' | null {
  if (kind === 'screen' || kind === 'section') return 'screens';
  if (kind === 'board' || kind === 'project') return null;
  return 'primitives';
}

function safeBoundarySelector(value: string): { kind: BoundaryKind; id: string } | undefined {
  try {
    return parseBoundarySelector(value);
  } catch {
    return undefined;
  }
}

function writeServerSentEvent(response: ServerResponse, eventName: string, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(value)}\n\n`);
}

function activityPhaseRank(phase: BlueprintAgentActivityPhase): number {
  return phase === 'started' ? 0 : 1;
}

function isBlueprintActivityRuntimeDescriptor(value: unknown): value is BlueprintActivityRuntimeDescriptor {
  const record = asRecord(value);
  return record?.version === 1 &&
    typeof record.projectRoot === 'string' &&
    typeof record.activityUrl === 'string' &&
    typeof record.token === 'string' &&
    typeof record.pid === 'number' &&
    typeof record.createdAt === 'string';
}

function isActivityPhase(value: unknown): value is BlueprintAgentActivityPhase {
  return value === 'started' || value === 'completed' || value === 'failed';
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => collectStrings(item, depth + 1));
  const record = asRecord(value);
  return record ? Object.values(record).flatMap(item => collectStrings(item, depth + 1)) : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function pathsOverlap(left: string, right: string): boolean {
  const canonicalLeft = canonicalPath(left);
  const canonicalRight = canonicalPath(right);
  return isInside(canonicalLeft, canonicalRight) || isInside(canonicalRight, canonicalLeft);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

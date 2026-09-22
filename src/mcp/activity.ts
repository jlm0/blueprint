import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServerResponse } from 'node:http';
import { parseBoundarySelector } from '../core/address';
import {
  activityFocusForBoundary,
  activityFocusesForSourceText,
  boundaryDisplayName,
  type BlueprintAgentActivityEvent,
  type BlueprintAgentActivityFocus,
  type BlueprintAgentActivityPhase
} from '../core/activity';
import type { BlueprintProjectBundle, BoundaryKind } from '../core/types';

export const BLUEPRINT_ACTIVITY_STREAM_PATH = '/__blueprint/events';
export const BLUEPRINT_ACTIVITY_POST_PATH = '/__blueprint/agent-activity';
export const BLUEPRINT_PROJECT_SNAPSHOT_PATH = '/__blueprint/project';
export const BLUEPRINT_SELECTION_PATH = '/__blueprint/selection';
export const BLUEPRINT_CANVAS_TOKEN_HEADER = 'x-blueprint-canvas-token';
export const BLUEPRINT_ACTIVITY_TOKEN_HEADER = 'x-blueprint-activity-token';
export const BLUEPRINT_ACTIVITY_RUNTIME_VERSION = 1;

const runtimeDirectory = path.join(tmpdir(), 'blueprint-agent-activity-v1');
const runtimeLockDirectory = path.join(runtimeDirectory, 'locks');
const terminalActivityRetentionMs = 2_000;
const runtimeProbeTimeoutMs = 750;
const runtimeLockTimeoutMs = 15_000;
const incompleteLockRetentionMs = 2_000;

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

interface BlueprintActivityRuntimeRecord {
  descriptor: BlueprintActivityRuntimeDescriptor;
  filePath: string;
}

interface BlueprintRuntimeLockOwner {
  pid: number;
  createdAt: string;
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
  const records = await readBlueprintActivityRuntimeRecords();
  const descriptors: BlueprintActivityRuntimeDescriptor[] = [];
  for (const record of records) {
    if (isProcessAlive(record.descriptor.pid)) {
      descriptors.push(record.descriptor);
    } else {
      await rm(record.filePath, { force: true }).catch(() => undefined);
    }
  }
  return descriptors;
}

export async function findLiveBlueprintActivityRuntime(
  projectRoot: string
): Promise<BlueprintActivityRuntimeDescriptor | undefined> {
  const canonicalProjectRoot = canonicalPath(projectRoot);
  const records = (await readBlueprintActivityRuntimeRecords())
    .filter(record => canonicalPath(record.descriptor.projectRoot) === canonicalProjectRoot)
    .sort((left, right) => left.descriptor.createdAt.localeCompare(right.descriptor.createdAt));

  for (const record of records) {
    if (isProcessAlive(record.descriptor.pid) && await probeBlueprintActivityRuntime(record.descriptor)) {
      return record.descriptor;
    }
    await rm(record.filePath, { force: true }).catch(() => undefined);
  }
  return undefined;
}

export function blueprintActivityRuntimeBaseUrl(descriptor: BlueprintActivityRuntimeDescriptor): string {
  const activityUrl = new URL(descriptor.activityUrl);
  if (
    activityUrl.protocol !== 'http:' ||
    activityUrl.hostname !== '127.0.0.1' ||
    activityUrl.pathname !== BLUEPRINT_ACTIVITY_POST_PATH
  ) {
    throw new Error('Blueprint runtime descriptor contains an invalid loopback activity URL.');
  }
  activityUrl.pathname = '/';
  activityUrl.search = '';
  activityUrl.hash = '';
  return activityUrl.toString();
}

export async function withBlueprintServeRuntimeLock<T>(
  projectRoot: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  await mkdir(runtimeLockDirectory, { recursive: true, mode: 0o700 });
  const canonicalProjectRoot = canonicalPath(projectRoot);
  const lockId = createHash('sha256').update(canonicalProjectRoot).digest('hex');
  const lockPath = path.join(runtimeLockDirectory, lockId);
  const ownerPath = path.join(lockPath, 'owner.json');
  const deadline = Date.now() + runtimeLockTimeoutMs;
  let acquired = false;

  try {
    while (!acquired) {
      throwIfSignalAborted(signal);
      try {
        await mkdir(lockPath, { mode: 0o700 });
        acquired = true;
        const owner: BlueprintRuntimeLockOwner = { pid: process.pid, createdAt: new Date().toISOString() };
        await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        if (await removeAbandonedRuntimeLock(lockPath, ownerPath)) continue;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for the active Blueprint runtime lease for ${canonicalProjectRoot}.`);
        }
        await delay(25, undefined, signal ? { signal } : undefined);
      }
    }
    return await operation();
  } finally {
    if (acquired) {
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function readBlueprintActivityRuntimeRecords(): Promise<BlueprintActivityRuntimeRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(runtimeDirectory);
  } catch {
    return [];
  }

  const records: BlueprintActivityRuntimeRecord[] = [];
  for (const entry of entries.filter(candidate => candidate.endsWith('.json'))) {
    const filePath = path.join(runtimeDirectory, entry);
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      if (isBlueprintActivityRuntimeDescriptor(parsed)) {
        records.push({ descriptor: parsed, filePath });
      }
    } catch {
      // Runtime discovery is best-effort. A stale or partially removed file
      // must never fail the Codex tool call that triggered the hook.
    }
  }
  return records;
}

async function probeBlueprintActivityRuntime(descriptor: BlueprintActivityRuntimeDescriptor): Promise<boolean> {
  try {
    const response = await fetch(new URL(BLUEPRINT_PROJECT_SNAPSHOT_PATH, blueprintActivityRuntimeBaseUrl(descriptor)), {
      method: 'HEAD',
      signal: AbortSignal.timeout(runtimeProbeTimeoutMs)
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function removeAbandonedRuntimeLock(lockPath: string, ownerPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as Partial<BlueprintRuntimeLockOwner>;
    if (typeof owner.pid === 'number' && isProcessAlive(owner.pid)) return false;
  } catch {
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs < incompleteLockRetentionMs) return false;
    } catch {
      return true;
    }
  }
  await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Operation aborted.');
  }
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
  const focuses = resolveActivityFocuses(bundle, event.toolInput);
  const focus = focuses[0];
  return {
    version: 1,
    sessionId: event.sessionId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    phase: event.phase,
    label: activityLabel(bundle, focuses, event.phase),
    emittedAt: event.emittedAt,
    focus,
    focuses
  };
}

export function resolveActivityFocus(bundle: BlueprintProjectBundle, toolInput: unknown): BlueprintAgentActivityFocus {
  return resolveActivityFocuses(bundle, toolInput)[0];
}

export function resolveActivityFocuses(bundle: BlueprintProjectBundle, toolInput: unknown): [BlueprintAgentActivityFocus, ...BlueprintAgentActivityFocus[]] {
  const input = asRecord(toolInput);
  const query = asRecord(input?.query);
  const operation = asRecord(input?.operation);
  const directSelector = firstString(input?.boundary, query?.boundary);
  if (directSelector) {
    const parsed = safeBoundarySelector(directSelector);
    if (parsed) {
      return [activityFocusForBoundary(bundle, parsed.kind, parsed.id)];
    }
  }

  const screenId = firstString(input?.screenId, query?.screenId, query?.screen, operation?.screenId);
  if (screenId) {
    return [activityFocusForBoundary(bundle, 'screen', screenId)];
  }

  const explorationId = firstString(input?.explorationId, query?.explorationId, operation?.explorationId);
  if (explorationId) {
    const exploration = bundle.explorations.explorations.find(candidate => candidate.id === explorationId);
    if (exploration) {
      return [activityFocusForBoundary(bundle, 'screen', exploration.target.screenId)];
    }
  }

  const inputText = collectStrings(toolInput).join('\n').replaceAll('\\', '/');
  const [firstSourceFocus, ...otherSourceFocuses] = activityFocusesForSourceText(bundle, inputText);
  if (firstSourceFocus) {
    return [firstSourceFocus, ...otherSourceFocuses];
  }

  if (inputText.includes('screens.json')) {
    return [activityFocusForBoundary(bundle, 'board', 'screens')];
  }
  if (inputText.includes('tokens.json') || inputText.includes('primitives.json') || inputText.includes('components.json')) {
    return [activityFocusForBoundary(bundle, 'board', 'primitives')];
  }
  return [activityFocusForBoundary(bundle, 'project', bundle.manifest.project.id)];
}

function activityLabel(
  bundle: BlueprintProjectBundle,
  focuses: BlueprintAgentActivityFocus[],
  phase: BlueprintAgentActivityPhase
): string {
  const names = focuses.map(focus => boundaryDisplayName(bundle, focus.kind, focus.localId));
  const target = names.length > 2 ? `${names[0]} and ${names.length - 1} more` : names.join(' and ');
  if (phase === 'failed') {
    return `Codex could not finish ${target}`;
  }
  if (phase === 'completed') {
    return `Codex is reviewing ${target}`;
  }
  return `Codex is looking at ${target}`;
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

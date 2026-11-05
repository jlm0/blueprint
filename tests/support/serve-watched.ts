import { watch } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serveBlueprint, type BlueprintServeHandle } from '../../src/mcp/operations';
import { loadValidatedProject } from '../../src/mcp/project-validation';

const SENTINEL = '.blueprint-settle-file-events';
const QUIET_MS = 300;
const SENTINEL_RETRY_MS = 100;
/** Each event restarts the serve debounce of 120 ms, so a shorter interval starves the reload. */
const WRITE_RETRY_MS = 400;
/** Heavy file churn can stop FSEvents delivery for many seconds, and a shorter limit fails on that churn and not on the code under test. */
const DEADLINE_MS = 60_000;

function assertBeforeDeadline(deadline: number, problem: string): void {
  if (performance.now() > deadline) throw new Error(`${problem} within ${DEADLINE_MS} ms. Fix: stop the other processes that use this machine, then run the test again.`);
}

/** macOS can deliver events of finished writes to a watcher that starts later, so a test that counts reloads waits for them before it serves the project. */
export async function settleFileEvents(project: string): Promise<void> {
  const parent = path.dirname(project);
  const sentinel = path.join(parent, SENTINEL);
  let sawSentinel = false;
  let lastEventAt = performance.now();
  const watcher = watch(parent, { recursive: true }, (_eventType, fileName) => {
    lastEventAt = performance.now();
    if (fileName === SENTINEL) sawSentinel = true;
  });
  const deadline = performance.now() + DEADLINE_MS;
  try {
    while (!sawSentinel) {
      assertBeforeDeadline(deadline, `The watcher of ${parent} did not report a write`);
      await writeFile(sentinel, '');
      await delay(SENTINEL_RETRY_MS);
    }
    while (performance.now() - lastEventAt < QUIET_MS) {
      assertBeforeDeadline(deadline, `File events under ${parent} did not stop`);
      await delay(10);
    }
  } finally {
    watcher.close();
    await rm(sentinel, { force: true });
  }
}

/** `fs.watch` returns before its stream starts, so the watcher can miss one write. This function writes the same bytes again until `seen` holds. */
export async function rewriteUntilSeen(file: string, seen: () => boolean): Promise<void> {
  const content = await readFile(file);
  const deadline = performance.now() + DEADLINE_MS;
  while (!seen()) {
    assertBeforeDeadline(deadline, `No watcher reported a write of ${file}`);
    await delay(WRITE_RETRY_MS);
    if (!seen()) await writeFile(file, content);
  }
}

/** A test that waits for a reaction to its first write serves through this function, so that write cannot go unseen. */
export async function serveWatched(project: string): Promise<BlueprintServeHandle> {
  await settleFileEvents(project);
  let reads = 0;
  const served = await serveBlueprint({ project, port: 0 }, undefined, undefined, (root, signal) => {
    reads += 1;
    return loadValidatedProject(root, signal);
  });
  try {
    const manifestPath = path.join(project, 'manifest.json');
    const readsAtStart = reads;
    await writeFile(manifestPath, await readFile(manifestPath));
    await rewriteUntilSeen(manifestPath, () => reads > readsAtStart);
    let readsSeen = reads;
    let quietSince = performance.now();
    const deadline = performance.now() + DEADLINE_MS;
    while (performance.now() - quietSince < QUIET_MS) {
      assertBeforeDeadline(deadline, `The serve runtime of ${project} did not stop its reloads`);
      await delay(10);
      if (reads !== readsSeen) {
        readsSeen = reads;
        quietSince = performance.now();
      }
    }
    await served.settledProject?.();
    return served;
  } catch (error) {
    await served.close();
    throw error;
  }
}

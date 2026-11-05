type ScheduleChange = (changedPath: string) => void;

const ownedRuntimes = new Map<string, Set<ScheduleChange>>();

export function registerOwnedServeRuntime(canonicalRoot: string, schedule: ScheduleChange): () => void {
  const runtimes = ownedRuntimes.get(canonicalRoot) ?? new Set<ScheduleChange>();
  runtimes.add(schedule);
  ownedRuntimes.set(canonicalRoot, runtimes);
  return () => {
    runtimes.delete(schedule);
    if (runtimes.size === 0 && ownedRuntimes.get(canonicalRoot) === runtimes) ownedRuntimes.delete(canonicalRoot);
  };
}

/** FSEvents can deliver an event seconds late or never, so a write in this process reaches its own runtimes directly. */
export function scheduleOwnedServeReloads(canonicalRoot: string, changedPaths: readonly string[]): void {
  for (const schedule of ownedRuntimes.get(canonicalRoot) ?? []) {
    for (const changedPath of changedPaths) schedule(changedPath);
  }
}

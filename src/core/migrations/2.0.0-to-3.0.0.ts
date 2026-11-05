import { asObject, isObject, serializeJson, type RawObject } from '../raw-json';
import { isSavedRecordFile } from '../storage-records';
import { stampSchemaVersions, type MigrationStep, type MigrationStepResult } from './step';

const FROM = '2.0.0';
const TO = '3.0.0';

function pageIdFromFlow(flow: unknown): string | undefined {
  if (typeof flow !== 'string' || !flow.trim()) return undefined;
  return flow.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || undefined;
}

function hasPage(screen: RawObject): boolean {
  return typeof screen.page === 'string' && screen.page.length > 0;
}

/** The new key takes the position of `flow`, because compiled output and digests depend on key order. */
function withPageFromFlow(screen: RawObject): RawObject {
  const page = hasPage(screen) ? undefined : pageIdFromFlow(screen.flow);
  return Object.fromEntries(Object.entries(screen).flatMap(([key, value]): Array<[string, unknown]> => {
    if (key !== 'flow') return [[key, value]];
    return page === undefined ? [] : [['page', page]];
  }));
}

function savedScreenPaths(record: RawObject): Array<{ holder: RawObject; screen: RawObject }> {
  const holders = [
    isObject(record.exploration) && isObject(record.exploration.target) && isObject(record.exploration.target.baseline) ? record.exploration.target.baseline : undefined,
    isObject(record.entry) ? record.entry : undefined
  ];
  return holders.flatMap(holder => (holder && isObject(holder.screen) ? [{ holder, screen: holder.screen }] : []));
}

function run(input: ReadonlyMap<string, string>): MigrationStepResult {
  const files = new Map(input);
  let moved = 0;
  for (const file of [...files.keys()].filter(isSavedRecordFile).sort()) {
    const record = asObject(JSON.parse(files.get(file)!));
    let changed = false;
    for (const { holder, screen } of savedScreenPaths(record)) {
      if (!('flow' in screen)) continue;
      holder.screen = withPageFromFlow(screen);
      moved += 1;
      changed = true;
    }
    if (changed) files.set(file, serializeJson(record));
  }
  const changes = moved > 0 ? [`explorations and history: moved flow to page in ${moved} saved screen${moved > 1 ? 's' : ''}.`] : [];
  return { files, changes, stamped: stampSchemaVersions(files, FROM, TO) };
}

/** Saved snapshots lose `flow`, because the schema of a saved screen now holds only the fields of a current screen. */
export const step: MigrationStep = { from: FROM, to: TO, run };

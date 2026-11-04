import { asObject, serializeJson } from '../raw-json';
import { VERSIONED_FILES } from '../schema-version';
import { isSavedRecordFile } from '../storage-records';

/** Kept apart from `changes`, because migrate lists these files after every other change. */
export interface StampedSchemaVersions {
  files: string[];
  records: string[];
}

export interface MigrationStepResult {
  files: Map<string, string>;
  changes: string[];
  stamped: StampedSchemaVersions;
}

/** A step reads only the file set, so its output does not change when the current contract does. */
export interface MigrationStep {
  from: string;
  to: string;
  /** A file already past `from` keeps its version, because one project can hold files on different versions. */
  run: (files: ReadonlyMap<string, string>) => MigrationStepResult;
}

/** A saved record without a version predates versions, so it counts as on `from`. */
export function stampSchemaVersions(files: Map<string, string>, from: string, to: string): StampedSchemaVersions {
  const stamped: StampedSchemaVersions = { files: [], records: [] };
  const stamp = (file: string): boolean => {
    const record = asObject(JSON.parse(files.get(file)!));
    if ('schemaVersion' in record && record.schemaVersion !== from) return false;
    files.set(file, serializeJson('schemaVersion' in record ? { ...record, schemaVersion: to } : { schemaVersion: to, ...record }));
    return true;
  };
  for (const file of VERSIONED_FILES) {
    if (files.has(file) && stamp(file)) stamped.files.push(file);
  }
  for (const file of [...files.keys()].filter(isSavedRecordFile).sort()) {
    if (stamp(file)) stamped.records.push(file);
  }
  return stamped;
}

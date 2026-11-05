import { normalizeCurrentFiles } from './migrate-normalize';
import { MIGRATABLE_SCHEMA_VERSIONS, MIGRATIONS, OLDEST_SCHEMA_VERSION, stepsFrom } from './migrations';
import { parseJsonFile } from './raw-json';
import { BLUEPRINT_SCHEMA_VERSION, isNewerSchemaVersion, newerSchemaVersionError, OPTIONAL_VERSIONED_FILES, schemaVersionText, VERSIONED_FILES } from './schema-version';
import { isSavedRecordFile } from './storage-records';

/** Inputs to {@linkcode migrateProjectFiles}. */
export interface MigrationInput {
  /** Every JSON, HTML, CSS, and Markdown file in the project, keyed by project-relative path with forward slashes. */
  files: Map<string, string>;
  /** The same files of the current starter: `primitives.json`, its prototype files, and `AGENTS.md`. */
  starterFiles: ReadonlyMap<string, string>;
}

export interface MigrationOutput {
  fromVersion: string;
  toVersion: string;
  upToDate: boolean;
  /** New contents keyed by project-relative path, only for files that change. */
  writes: Map<string, string>;
  /** One line per kind of mechanical change applied. */
  changes: string[];
}

/**
 * Upgrades a project to the current schema without touching the disk: every chain step from its oldest version, then the current-version normalizers.
 * Applies every mechanical change; judgment calls are left for validation to report.
 *
 * @throws {Error} When a structured file is missing, or a file or saved record is on a schema version migrate cannot read.
 */
export function migrateProjectFiles(input: MigrationInput): MigrationOutput {
  const versions = readProjectVersions(input.files);
  const fromVersion = MIGRATIONS.find(step => versions.has(step.from))?.from ?? BLUEPRINT_SCHEMA_VERSION;

  const changes: string[] = [];
  const stampedFiles = new Set<string>();
  const stampedRecords = new Set<string>();
  let files: ReadonlyMap<string, string> = input.files;
  for (const step of stepsFrom(fromVersion)) {
    const result = step.run(files);
    files = result.files;
    changes.push(...result.changes);
    for (const file of result.stamped.files) stampedFiles.add(file);
    for (const file of result.stamped.records) stampedRecords.add(file);
  }

  const writes = new Map([...files].filter(([file, content]) => input.files.get(file) !== content));
  normalizeCurrentFiles({ files, starterFiles: input.starterFiles }, writes, changes);

  const bumped = VERSIONED_FILES.filter(file => stampedFiles.has(file));
  if (bumped.length > 0) {
    changes.push(`${bumped.join(', ')}: schemaVersion is now "${BLUEPRINT_SCHEMA_VERSION}".`);
  }
  if (stampedRecords.size > 0) {
    changes.push(`explorations and history: ${stampedRecords.size} saved record${stampedRecords.size > 1 ? 's' : ''} now carry schemaVersion "${BLUEPRINT_SCHEMA_VERSION}".`);
  }
  return { fromVersion, toVersion: BLUEPRINT_SCHEMA_VERSION, upToDate: writes.size === 0 && changes.length === 0, writes, changes };
}

function readProjectVersions(files: ReadonlyMap<string, string>): Set<string> {
  const versions = new Set<string>();
  const refusals: string[] = [];
  const readVersion = (file: string, version: string): void => {
    if (isNewerSchemaVersion(version)) refusals.push(newerSchemaVersionError(file, version));
    else if (!MIGRATABLE_SCHEMA_VERSIONS.has(version)) refusals.push(`${file} is on schema "${version}", which migrate does not know how to upgrade. Fix: set schemaVersion in ${file} to the version whose shape it has, one of ${[...MIGRATABLE_SCHEMA_VERSIONS].join(', ')}, then run migrate again.`);
    else versions.add(version);
  };
  for (const file of VERSIONED_FILES) {
    if (OPTIONAL_VERSIONED_FILES.has(file) && !files.has(file)) continue;
    readVersion(file, schemaVersionText(parseJsonFile(files, file).schemaVersion ?? ''));
  }
  for (const file of [...files.keys()].filter(isSavedRecordFile).sort()) {
    const record = parseJsonFile(files, file);
    readVersion(file, 'schemaVersion' in record ? schemaVersionText(record.schemaVersion) : OLDEST_SCHEMA_VERSION);
  }
  if (refusals.length > 0) throw new Error(refusals.join('\n'));
  return versions;
}

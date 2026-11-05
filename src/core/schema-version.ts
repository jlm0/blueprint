import type { BlueprintProjectBundle } from './types';

/** The one schema every structured file and saved record of a project carries; tools refuse a project on any other until `migrate` runs. */
export const BLUEPRINT_SCHEMA_VERSION = '3.0.0';

/** Structured files that carry `schemaVersion`; brand.json and inspo.json only when the project has them. */
export const VERSIONED_FILES = ['manifest.json', 'tokens.json', 'brand.json', 'inspo.json', 'screens.json', 'primitives.json', 'components.json'] as const;

export const OPTIONAL_VERSIONED_FILES: ReadonlySet<string> = new Set(['brand.json', 'inspo.json']);

type VersionedBundle = Pick<BlueprintProjectBundle, 'manifest' | 'tokens' | 'screens' | 'primitives' | 'components'> &
  Partial<Pick<BlueprintProjectBundle, 'brand' | 'inspo' | 'recordSchemaVersions'>>;

/** The version of each structured file, and of each saved record that is not on the current schema. */
export function fileSchemaVersions(bundle: VersionedBundle): Array<[string, unknown]> {
  return [
    ['manifest.json', bundle.manifest?.schemaVersion],
    ['tokens.json', bundle.tokens?.schemaVersion],
    ...(bundle.brand ? [['brand.json', bundle.brand.schemaVersion] as [string, unknown]] : []),
    ...(bundle.inspo ? [['inspo.json', bundle.inspo.schemaVersion] as [string, unknown]] : []),
    ['screens.json', bundle.screens?.schemaVersion],
    ['primitives.json', bundle.primitives?.schemaVersion],
    ['components.json', bundle.components?.schemaVersion],
    ...Object.entries(bundle.recordSchemaVersions ?? {})
  ];
}

/** A version that is not a string prints as JSON, because `String(["2.0.0"])` reads as the current version. */
export function schemaVersionText(version: unknown): string {
  return typeof version === 'string' || version === undefined ? String(version) : JSON.stringify(version);
}

export function isNewerSchemaVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  if (!parts) return false;
  const current = BLUEPRINT_SCHEMA_VERSION.split('.').map(Number);
  const first = parts.findIndex((part, index) => part !== current[index]);
  return first !== -1 && parts[first] > current[first];
}

export function newerSchemaVersionError(file: string, version: unknown): string {
  return `${file} is on schema "${schemaVersionText(version)}", which is newer than schema "${BLUEPRINT_SCHEMA_VERSION}" that this Blueprint reads. ` +
    'Fix: update Blueprint to a release that reads this schema, then call the tool again. Do not edit schemaVersion by hand.';
}

/** One error per structured file or saved record that is not on the current schema; `validate` reports them, `serve` shows a notice, and the other tools refuse until `migrate` runs. */
export function schemaVersionErrors(bundle: VersionedBundle): string[] {
  return fileSchemaVersions(bundle)
    .filter(([, version]) => version !== BLUEPRINT_SCHEMA_VERSION)
    .map(([file, version]) => (isNewerSchemaVersion(version)
      ? newerSchemaVersionError(file, version)
      : `${file} is on schema "${schemaVersionText(version)}", and Blueprint now reads "${BLUEPRINT_SCHEMA_VERSION}". ` +
        'Fix: run the migrate tool on this project, then fix each error that it returns.'
    ));
}

/** @throws {Error} When the project still needs `migrate`, or Blueprint is older than the project. */
export function assertCurrentSchema(bundle: VersionedBundle): void {
  const errors = schemaVersionErrors(bundle);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

/** @throws {Error} When a file is on a schema newer than this Blueprint, so its shape cannot be read. */
export function assertNoNewerSchema(versions: ReadonlyArray<[string, unknown]>): void {
  const errors = versions.filter(([, version]) => isNewerSchemaVersion(version)).map(([file, version]) => newerSchemaVersionError(file, version));
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

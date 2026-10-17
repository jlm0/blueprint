import type { BlueprintProjectBundle } from './types';

/** The one schema every structured file of a project carries; tools refuse a project on any other until `migrate` runs. */
export const BLUEPRINT_SCHEMA_VERSION = '2.0.0';

/** Schema versions `migrate` knows how to upgrade from, including the current one. */
export const MIGRATABLE_SCHEMA_VERSIONS: ReadonlySet<string> = new Set(['1.0.0', BLUEPRINT_SCHEMA_VERSION]);

/** Structured files that carry `schemaVersion`; brand.json only when the project has one. */
export const VERSIONED_FILES = ['manifest.json', 'tokens.json', 'brand.json', 'screens.json', 'primitives.json', 'components.json'] as const;

export type VersionedFile = (typeof VERSIONED_FILES)[number];

type VersionedBundle = Pick<BlueprintProjectBundle, 'manifest' | 'tokens' | 'screens' | 'primitives' | 'components'> &
  Partial<Pick<BlueprintProjectBundle, 'brand'>>;

export function fileSchemaVersions(bundle: VersionedBundle): Array<[VersionedFile, unknown]> {
  return [
    ['manifest.json', bundle.manifest?.schemaVersion],
    ['tokens.json', bundle.tokens?.schemaVersion],
    ...(bundle.brand ? [['brand.json', bundle.brand.schemaVersion] as [VersionedFile, unknown]] : []),
    ['screens.json', bundle.screens?.schemaVersion],
    ['primitives.json', bundle.primitives?.schemaVersion],
    ['components.json', bundle.components?.schemaVersion]
  ];
}

/** One error per structured file that predates the current schema; every tool except `migrate` refuses such a project. */
export function schemaVersionErrors(bundle: VersionedBundle): string[] {
  return fileSchemaVersions(bundle)
    .filter(([, version]) => version !== BLUEPRINT_SCHEMA_VERSION)
    .map(([file, version]) => (
      `${file} is on schema "${String(version)}", and Blueprint now reads "${BLUEPRINT_SCHEMA_VERSION}". ` +
      'Fix: run the migrate tool on this project, then fix what validate reports.'
    ));
}

/** @throws {Error} When the project still needs `migrate`. */
export function assertCurrentSchema(bundle: VersionedBundle): void {
  const errors = schemaVersionErrors(bundle);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

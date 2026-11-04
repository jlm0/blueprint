import { BLUEPRINT_SCHEMA_VERSION } from '../schema-version';
import { step as from1To2 } from './1.0.0-to-2.0.0';
import type { MigrationStep } from './step';

export const MIGRATIONS: readonly MigrationStep[] = [from1To2];

export const OLDEST_SCHEMA_VERSION = MIGRATIONS[0].from;

export const MIGRATABLE_SCHEMA_VERSIONS: ReadonlySet<string> = new Set([...MIGRATIONS.map(step => step.from), BLUEPRINT_SCHEMA_VERSION]);

export function stepsFrom(version: string): readonly MigrationStep[] {
  const start = MIGRATIONS.findIndex(step => step.from === version);
  return start === -1 ? [] : MIGRATIONS.slice(start);
}

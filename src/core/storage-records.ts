import { createHash } from 'node:crypto';
import type {
  ExplorationDefinition,
  ExplorationRecordFile,
  ScreenHistoryEntry,
  ScreenHistoryRecordFile
} from './types';

const SAFE_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function explorationRecordRef(explorationId: string): string {
  return `explorations/${storageRecordSegment(explorationId)}.json`;
}

export function historyRecordRef(screenId: string, version: number): string {
  return `history/${storageRecordSegment(screenId)}-v${version}.json`;
}

export function explorationRecordFile(
  projectId: string,
  exploration: ExplorationDefinition
): ExplorationRecordFile {
  return {
    schemaVersion: '1.0.0',
    projectId,
    exploration: structuredClone(exploration)
  };
}

export function historyRecordFile(
  projectId: string,
  entry: ScreenHistoryEntry
): ScreenHistoryRecordFile {
  return {
    schemaVersion: '1.0.0',
    projectId,
    entry: structuredClone(entry)
  };
}

export function storageRecordSegment(value: string): string {
  if (SAFE_SEGMENT.test(value)) {
    return value;
  }
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || 'record';
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${slug}-${digest}`;
}

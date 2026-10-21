import { checkClosedObject, checkId, checkProse, isRecord, quoteList } from './contract-checks';
import type { InspoAspect, InspoDirection, InspoEntry, InspoFile } from './types';

export const INSPO_FILE_FIELDS = ['schemaVersion', 'projectId', 'entries', 'directions'] as const satisfies ReadonlyArray<keyof InspoFile>;
export const INSPO_ENTRY_FIELDS = ['id', 'sourceUrl', 'image', 'aspects', 'stance', 'note', 'reading'] as const satisfies ReadonlyArray<keyof InspoEntry>;
export const INSPO_DIRECTION_FIELDS = ['aspect', 'statement', 'entryIds', 'status'] as const satisfies ReadonlyArray<keyof InspoDirection>;
export const INSPO_ASPECTS: readonly InspoAspect[] = ['mark', 'wordmark', 'typography', 'color', 'layout', 'imagery', 'style'];
export const INSPO_STANCES: ReadonlyArray<InspoEntry['stance']> = ['like', 'avoid'];
export const INSPO_DIRECTION_STATUSES: ReadonlyArray<InspoDirection['status']> = ['proposed', 'approved'];
export const INSPO_IMAGE_DIRECTORY = 'inspo';
export const INSPO_IMAGE_PATTERN = /^inspo\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:png|jpg|webp|gif)$/;

export const INSPO_LIMITS = {
  sourceUrl: 2048,
  note: 1000,
  reading: 240,
  statement: 240
} as const;

/** Checks inspo.json against its fixed shape; the note keeps the person's words, so only agent prose is linted. */
export function validateInspoContract(errors: string[], inspo: InspoFile, projectId: string): void {
  checkClosedObject(errors, 'inspo.json', inspo, INSPO_FILE_FIELDS);
  if (inspo.projectId !== projectId) {
    errors.push(`inspo.json projectId "${String(inspo.projectId)}" does not match the manifest. Fix: set it to "${projectId}".`);
  }
  if (!Array.isArray(inspo.entries)) {
    errors.push('inspo.json entries must be a list. Fix: write it as [] or [{ … }].');
  }
  if (!Array.isArray(inspo.directions)) {
    errors.push('inspo.json directions must be a list. Fix: write it as [] or [{ … }].');
  }
  const entries = Array.isArray(inspo.entries) ? inspo.entries : [];
  const entryIds = new Set<string>();
  entries.forEach((entry, index) => {
    validateEntry(errors, entry, index);
    if (isRecord(entry) && typeof entry.id === 'string') {
      if (entryIds.has(entry.id)) errors.push(`inspo.entry.${entry.id} appears twice. Fix: give each entry its own id.`);
      entryIds.add(entry.id);
    }
  });
  const aspects = new Set<string>();
  (Array.isArray(inspo.directions) ? inspo.directions : []).forEach((direction, index) => {
    validateDirection(errors, direction, index, entryIds);
    if (isRecord(direction) && typeof direction.aspect === 'string') {
      if (aspects.has(direction.aspect)) errors.push(`inspo.direction.${direction.aspect} appears twice. Fix: keep one direction for each aspect.`);
      aspects.add(direction.aspect);
    }
  });
}

export function hasApprovedInspoDirection(inspo: InspoFile): boolean {
  return Array.isArray(inspo.directions) && inspo.directions.some(direction => isRecord(direction) && direction.status === 'approved');
}

function validateEntry(errors: string[], entry: unknown, index: number): void {
  const label = isRecord(entry) && typeof entry.id === 'string' && entry.id ? `inspo.entry.${entry.id}` : `inspo.entries[${index}]`;
  if (!isRecord(entry)) {
    errors.push(`${label} must be an object. Fix: write it as { ${quoteList(INSPO_ENTRY_FIELDS)} }.`);
    return;
  }
  checkClosedObject(errors, label, entry, INSPO_ENTRY_FIELDS);
  checkId(errors, label, entry.id);
  if (typeof entry.sourceUrl !== 'string' || !/^https:\/\/\S+$/.test(entry.sourceUrl) || entry.sourceUrl.length > INSPO_LIMITS.sourceUrl) {
    errors.push(`${label}.sourceUrl is not an https link. Fix: set it to the image link the person pasted.`);
  }
  if (typeof entry.image !== 'string' || !INSPO_IMAGE_PATTERN.test(entry.image) || !entry.image.startsWith(`${INSPO_IMAGE_DIRECTORY}/${String(entry.id)}.`)) {
    errors.push(`${label}.image ${typeof entry.image === 'string' ? `"${entry.image}"` : 'is missing and'} is not the cached copy of the entry. Fix: add images with the inspo tool, which writes "inspo/${String(entry.id)}.<png|jpg|webp|gif>".`);
  }
  if (!Array.isArray(entry.aspects) || entry.aspects.some(aspect => !INSPO_ASPECTS.includes(aspect as InspoAspect))) {
    errors.push(`${label}.aspects must list aspects of the image. Fix: use [] or values from ${quoteList(INSPO_ASPECTS)}.`);
  } else if (new Set(entry.aspects).size !== entry.aspects.length) {
    errors.push(`${label}.aspects lists an aspect twice. Fix: list each aspect once.`);
  }
  if (!INSPO_STANCES.includes(entry.stance as InspoEntry['stance'])) {
    errors.push(`${label}.stance ${typeof entry.stance === 'string' ? `"${entry.stance}"` : 'is missing and'} is not a stance. Fix: set it to "like" or "avoid".`);
  }
  checkOptionalText(errors, `${label}.note`, entry.note, INSPO_LIMITS.note, 'the words of the person, kept as they wrote them');
  checkOptionalText(errors, `${label}.reading`, entry.reading, INSPO_LIMITS.reading, 'what you take from the image for its aspects');
  checkProse(errors, `${label}.reading`, entry.reading);
}

function validateDirection(errors: string[], direction: unknown, index: number, entryIds: ReadonlySet<string>): void {
  const label = isRecord(direction) && typeof direction.aspect === 'string' && direction.aspect ? `inspo.direction.${direction.aspect}` : `inspo.directions[${index}]`;
  if (!isRecord(direction)) {
    errors.push(`${label} must be an object. Fix: write it as { ${quoteList(INSPO_DIRECTION_FIELDS)} }.`);
    return;
  }
  checkClosedObject(errors, label, direction, INSPO_DIRECTION_FIELDS);
  if (!INSPO_ASPECTS.includes(direction.aspect as InspoAspect)) {
    errors.push(`${label}.aspect is not an aspect. Fix: set it to one of ${quoteList(INSPO_ASPECTS)}.`);
  }
  if (typeof direction.statement !== 'string' || !direction.statement.trim()) {
    errors.push(`${label}.statement is missing. Fix: say what the brand takes from the entries, in ${INSPO_LIMITS.statement} characters or fewer.`);
  } else if (direction.statement.length > INSPO_LIMITS.statement) {
    errors.push(`${label}.statement is ${direction.statement.length} characters. Fix: shorten it to ${INSPO_LIMITS.statement} or fewer.`);
  }
  checkProse(errors, `${label}.statement`, direction.statement);
  if (!Array.isArray(direction.entryIds) || direction.entryIds.length === 0) {
    errors.push(`${label}.entryIds is empty. Fix: list the ids of the entries the direction comes from.`);
  } else {
    for (const entryId of direction.entryIds) {
      if (typeof entryId !== 'string' || !entryIds.has(entryId)) {
        errors.push(`${label}.entryIds names "${String(entryId)}", which is not an entry. Fix: use ids from inspo.json entries.`);
      }
    }
  }
  if (!INSPO_DIRECTION_STATUSES.includes(direction.status as InspoDirection['status'])) {
    errors.push(`${label}.status is not a status. Fix: set it to "proposed", or to "approved" after the person approves the statement.`);
  }
}

function checkOptionalText(errors: string[], label: string, text: unknown, limit: number, purpose: string): void {
  if (typeof text !== 'string') {
    errors.push(`${label} must be a string. Fix: write "" until you have ${purpose}.`);
  } else if (text.length > limit) {
    errors.push(`${label} is ${text.length} characters. Fix: shorten it to ${limit} or fewer.`);
  }
}

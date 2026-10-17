import {
  checkClosedObject,
  checkEntries,
  checkId,
  checkName,
  checkProse,
  checkText,
  isRecord,
  isStringList,
  quoteList
} from './contract-checks';
import { DECLARED_GROUP_FIELDS } from './reusable-contract';
import type { DeclaredGroup, ProductionRelationshipKind, ScreenDefinition, ScreenFile, ScreenSection } from './types';

export const SCREEN_FILE_FIELDS = ['schemaVersion', 'projectId', 'pages', 'screens'] as const;
export const PAGE_FIELDS = DECLARED_GROUP_FIELDS;

/** Field order every screen is written in; `version` and `productionRelationship` are the only optional fields. */
export const SCREEN_FIELD_ORDER = [
  'id',
  'name',
  'version',
  'description',
  'framePresetId',
  'page',
  'styleRefs',
  'styleEvidence',
  'notes',
  'prototypeOnly',
  'implementationHints',
  'productionRelationship',
  'implementationTargets',
  'prototype',
  'sections'
] as const satisfies ReadonlyArray<keyof ScreenDefinition>;
export const SCREEN_OPTIONAL_FIELDS = ['version', 'productionRelationship'] as const;
export const SCREEN_FIELDS = SCREEN_FIELD_ORDER.filter(field => !(SCREEN_OPTIONAL_FIELDS as readonly string[]).includes(field));

export const SECTION_FIELDS = [
  'id',
  'name',
  'description',
  'styleRefs',
  'styleEvidence',
  'uses',
  'prototypeOnly',
  'notes',
  'implementationHints',
  'implementationTargets'
] as const satisfies ReadonlyArray<keyof ScreenSection>;

export const SECTION_USE_FIELDS = ['kind', 'id', 'reason'] as const;
export const SECTION_USE_OPTIONAL_FIELDS = ['binding'] as const;
export const PRODUCTION_RELATIONSHIP_FIELDS = ['kind', 'notes'] as const;
export const PRODUCTION_RELATIONSHIP_OPTIONAL_FIELDS = ['routePath', 'targetScreenId', 'replacedSectionId'] as const;
export const SCREEN_PROTOTYPE_FIELDS = ['source', 'styles', 'states', 'assetRefs', 'reviewConditions'] as const;
export const SCREEN_PROTOTYPE_OPTIONAL_FIELDS = ['renderedUses', 'localValueExceptions'] as const;

export const PRODUCTION_RELATIONSHIP_KINDS: readonly ProductionRelationshipKind[] = [
  'new-route',
  'existing-route',
  'state-of-existing-screen',
  'variant-of-existing-screen',
  'section-replacement',
  'embedded-flow'
];

export const SCREEN_LIMITS = {
  pageName: 24,
  pageDescription: 120,
  name: 32,
  description: 200,
  reason: 200,
  note: 200
} as const;

export interface ProseField {
  /** Path below the boundary, such as "description" or "notes[0]". */
  path: string;
  text: string;
}

/** Prose a screen carries itself; each section's prose is listed by {@linkcode sectionProseFields}. */
export function screenProseFields(screen: ScreenDefinition): ProseField[] {
  const fields: ProseField[] = [];
  addProse(fields, 'description', screen.description);
  addEntries(fields, 'notes', screen.notes);
  addEntries(fields, 'implementationHints', screen.implementationHints);
  if (isRecord(screen.productionRelationship)) addEntries(fields, 'productionRelationship.notes', screen.productionRelationship.notes);
  return fields;
}

export function sectionProseFields(section: ScreenSection): ProseField[] {
  const fields: ProseField[] = [];
  addProse(fields, 'description', section.description);
  (Array.isArray(section.uses) ? section.uses : []).forEach((use, index) => addProse(fields, `uses[${index}].reason`, use?.reason));
  addEntries(fields, 'notes', section.notes);
  addEntries(fields, 'implementationHints', section.implementationHints);
  return fields;
}

export function pageProseFields(page: DeclaredGroup): ProseField[] {
  const fields: ProseField[] = [];
  addProse(fields, 'description', page.description);
  return fields;
}

/** Checks screens.json against its fixed shape and the prose rules; reference checks stay in validateProject. */
export function validateScreenContract(errors: string[], screens: ScreenFile): void {
  checkClosedObject(errors, 'screens.json', screens, SCREEN_FILE_FIELDS);
  if (!Array.isArray(screens.pages)) {
    errors.push('screens.pages must be a list. Fix: declare each page as { "id", "name", "description" }.');
  } else {
    screens.pages.forEach((page, index) => validatePage(errors, page, index));
  }
  if (Array.isArray(screens.screens)) {
    screens.screens.forEach((screen, index) => validateScreenShape(errors, screen, index));
  }
}

function validatePage(errors: string[], page: unknown, index: number): void {
  const label = isRecord(page) && typeof page.id === 'string' && page.id ? `screens.page.${page.id}` : `screens.pages[${index}]`;
  if (!isRecord(page)) {
    errors.push(`${label} must be an object. Fix: declare it as { "id", "name", "description" }.`);
    return;
  }
  checkClosedObject(errors, label, page, PAGE_FIELDS);
  checkId(errors, label, page.id);
  checkName(errors, `${label}.name`, page.name, SCREEN_LIMITS.pageName);
  checkText(errors, `${label}.description`, page.description, SCREEN_LIMITS.pageDescription, 'say which screens the page holds');
  for (const field of pageProseFields(page as unknown as DeclaredGroup)) checkProse(errors, `${label}.${field.path}`, field.text);
}

function validateScreenShape(errors: string[], item: unknown, index: number): void {
  const label = isRecord(item) && typeof item.id === 'string' && item.id ? `screen.${item.id}` : `screens.screens[${index}]`;
  if (!isRecord(item)) {
    errors.push(`${label} must be an object. Fix: write it in the screen shape that AGENTS.md describes.`);
    return;
  }
  const screen = item as unknown as ScreenDefinition;
  const withoutFlow = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'flow'));
  checkClosedObject(errors, label, withoutFlow, SCREEN_FIELDS, SCREEN_OPTIONAL_FIELDS);
  checkId(errors, label, screen.id);
  checkName(errors, `${label}.name`, screen.name, SCREEN_LIMITS.name);
  checkText(errors, `${label}.description`, screen.description, SCREEN_LIMITS.description, 'say what the screen shows and when it appears');
  checkLists(errors, label, item);
  if ('productionRelationship' in item) validateProductionRelationshipShape(errors, `${label}.productionRelationship`, item.productionRelationship);
  if (isRecord(item.prototype)) {
    checkClosedObject(errors, `${label}.prototype`, item.prototype, SCREEN_PROTOTYPE_FIELDS, SCREEN_PROTOTYPE_OPTIONAL_FIELDS);
  }
  for (const field of screenProseFields(screen)) checkProse(errors, `${label}.${field.path}`, field.text);
  if (!Array.isArray(item.sections)) return;
  item.sections.forEach((section, sectionIndex) => validateSectionShape(errors, label, section, sectionIndex));
}

function validateSectionShape(errors: string[], screenLabel: string, item: unknown, index: number): void {
  const label = isRecord(item) && typeof item.id === 'string' && item.id ? `${screenLabel}.section.${item.id}` : `${screenLabel}.sections[${index}]`;
  if (!isRecord(item)) {
    errors.push(`${label} must be an object. Fix: write it in the section shape that AGENTS.md describes.`);
    return;
  }
  const section = item as unknown as ScreenSection;
  checkClosedObject(errors, label, item, SECTION_FIELDS);
  checkId(errors, label, section.id);
  checkName(errors, `${label}.name`, section.name, SCREEN_LIMITS.name);
  checkText(errors, `${label}.description`, section.description, SCREEN_LIMITS.description, 'say what the section holds');
  checkLists(errors, label, item);
  if (Array.isArray(item.uses)) {
    item.uses.forEach((use, useIndex) => {
      const useLabel = `${label}.uses[${useIndex}]`;
      if (!isRecord(use)) {
        errors.push(`${useLabel} must be an object. Fix: write it as { "kind", "id", "reason" }.`);
        return;
      }
      checkClosedObject(errors, useLabel, use, SECTION_USE_FIELDS, SECTION_USE_OPTIONAL_FIELDS);
      checkText(errors, `${useLabel}.reason`, use.reason, SCREEN_LIMITS.reason, 'say what the piece does in this section');
    });
  }
  for (const field of sectionProseFields(section)) checkProse(errors, `${label}.${field.path}`, field.text);
}

function checkLists(errors: string[], label: string, item: Record<string, unknown>): void {
  if ('styleRefs' in item && !isStringList(item.styleRefs)) {
    errors.push(`${label}.styleRefs must be a list of strings. Fix: write it as [] or ["…"].`);
  }
  for (const field of ['notes', 'implementationHints'] as const) {
    if (field in item) checkEntries(errors, `${label}.${field}`, item[field], SCREEN_LIMITS.note);
  }
  for (const field of ['styleEvidence', 'implementationTargets', 'uses'] as const) {
    if (field in item && !Array.isArray(item[field])) {
      errors.push(`${label}.${field} must be a list. Fix: write it as [] when there is nothing to record.`);
    }
  }
  if ('prototypeOnly' in item && typeof item.prototypeOnly !== 'boolean') {
    errors.push(`${label}.prototypeOnly must be true or false. Fix: write false unless it never ships.`);
  }
}

function validateProductionRelationshipShape(errors: string[], label: string, relationship: unknown): void {
  if (!isRecord(relationship)) {
    errors.push(`${label} must be an object. Fix: write it as { "kind", "notes" } with the route fields its kind needs, or remove it until the route is decided.`);
    return;
  }
  checkClosedObject(errors, label, relationship, PRODUCTION_RELATIONSHIP_FIELDS, PRODUCTION_RELATIONSHIP_OPTIONAL_FIELDS);
  if (!PRODUCTION_RELATIONSHIP_KINDS.includes(relationship.kind as ProductionRelationshipKind)) {
    errors.push(`${label}.kind ${typeof relationship.kind === 'string' ? `"${relationship.kind}"` : 'is missing and'} is not a relationship kind. Fix: set it to one of ${quoteList(PRODUCTION_RELATIONSHIP_KINDS)}.`);
  }
  if ('notes' in relationship) checkEntries(errors, `${label}.notes`, relationship.notes, SCREEN_LIMITS.note);
}

function addProse(fields: ProseField[], path: string, text: unknown): void {
  if (typeof text === 'string' && text.trim()) fields.push({ path, text });
}

function addEntries(fields: ProseField[], path: string, entries: unknown): void {
  if (!Array.isArray(entries)) return;
  entries.forEach((entry, index) => addProse(fields, `${path}[${index}]`, entry));
}

import { PRIMITIVE_GROUPS, primitiveGroupName } from '../core/base-primitives';
import type { PrimitiveDefinition } from '../core/types';

interface FamilyGroup {
  family: string;
  primitives: PrimitiveDefinition[];
}

const FAMILY_ORDER = [
  'button',
  'input',
  'select',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'text',
  'surface',
  'card',
  'media',
  'navigation',
  'tabs',
  'separator',
  'list',
  'row',
  'loading',
  'badge',
  'icon',
  'avatar',
  'skeleton',
  'toast',
  'tooltip',
  'alert',
  'dialog',
  'menu',
  'sheet',
  'generic'
];

export function groupPrimitivesForNavigation(primitives: PrimitiveDefinition[]): Array<{ label: string; primitives: PrimitiveDefinition[] }> {
  const ordered = groupPrimitivesByFamily(primitives).flatMap(group => group.primitives);
  const groupIds = [...PRIMITIVE_GROUPS.map(group => group.id as string), ...new Set(ordered.map(primitive => primitive.group))];
  return [...new Set(groupIds)].flatMap(groupId => {
    const members = ordered.filter(primitive => primitive.group === groupId);
    return members.length > 0 ? [{ label: primitiveGroupName(groupId) ?? 'Other', primitives: members }] : [];
  });
}

/**
 * Natural review-cell width per primitive family, mirroring the reference
 * canvas: small centered cells for compact controls, wider cells for fields,
 * rows, and panels. Column headers align over these cells.
 */
function familyCellWidth(family: string): number {
  const widths: Record<string, number> = {
    button: 160,
    input: 190,
    select: 190,
    checkbox: 120,
    radio: 120,
    switch: 120,
    slider: 180,
    text: 240,
    surface: 240,
    card: 240,
    media: 240,
    navigation: 280,
    tabs: 300,
    separator: 200,
    list: 260,
    row: 260,
    loading: 120,
    badge: 96,
    icon: 96,
    avatar: 96,
    skeleton: 220,
    toast: 240,
    tooltip: 160,
    alert: 300,
    dialog: 240,
    menu: 240,
    sheet: 240
  };
  return widths[family] ?? 200;
}

/** Primitives whose natural footprint exceeds their family's default cell. */
const PRIMITIVE_CELL_WIDTH_OVERRIDES: Record<string, number> = {
  'otp-input': 344,
  'table-row': 440,
  progress: 240
};

export function primitiveCellWidth(family: string, primitiveId: string): number {
  return PRIMITIVE_CELL_WIDTH_OVERRIDES[primitiveId] ?? familyCellWidth(family);
}

function groupPrimitivesByFamily(primitives: PrimitiveDefinition[]): FamilyGroup[] {
  const groups = new Map<string, PrimitiveDefinition[]>();
  for (const primitive of primitives) {
    const family = inferPrimitiveFamily(primitive);
    const current = groups.get(family) ?? [];
    current.push(primitive);
    groups.set(family, current);
  }
  return [...groups.entries()]
    .map(([family, items]) => ({ family, primitives: items }))
    .sort((a, b) => familySortIndex(a.family) - familySortIndex(b.family) || a.family.localeCompare(b.family));
}

export function inferPrimitiveFamily(primitive: PrimitiveDefinition): string {
  const terms = primitiveFamilyTerms(primitive);
  if (hasFamilyTerm(terms, 'button')) return 'button';
  if (hasFamilyTerm(terms, 'otp', 'input', 'textarea')) return 'input';
  if (hasFamilyTerm(terms, 'select')) return 'select';
  if (hasFamilyTerm(terms, 'checkbox')) return 'checkbox';
  if (hasFamilyTerm(terms, 'radio')) return 'radio';
  if (hasFamilyTerm(terms, 'switch')) return 'switch';
  if (hasFamilyTerm(terms, 'slider')) return 'slider';
  if (hasFamilyTerm(terms, 'tabs', 'tab', 'segmented')) return 'tabs';
  if (hasFamilyTerm(terms, 'text', 'typography')) return 'text';
  if (hasFamilyTerm(terms, 'surface')) return 'surface';
  if (hasFamilyTerm(terms, 'media')) return 'media';
  if (hasFamilyTerm(terms, 'card')) return 'card';
  if (hasFamilyTerm(terms, 'nav', 'navbar', 'navigation', 'back')) return 'navigation';
  if (hasFamilyTerm(terms, 'separator')) return 'separator';
  if (hasFamilyTerm(terms, 'list')) return 'list';
  if (hasFamilyTerm(terms, 'row')) return 'row';
  if (hasFamilyTerm(terms, 'loading', 'progress')) return 'loading';
  if (hasFamilyTerm(terms, 'badge', 'pill')) return 'badge';
  if (hasFamilyTerm(terms, 'icon')) return 'icon';
  if (hasFamilyTerm(terms, 'avatar')) return 'avatar';
  if (hasFamilyTerm(terms, 'skeleton')) return 'skeleton';
  if (hasFamilyTerm(terms, 'toast')) return 'toast';
  if (hasFamilyTerm(terms, 'tooltip')) return 'tooltip';
  if (hasFamilyTerm(terms, 'dialog')) return 'dialog';
  if (hasFamilyTerm(terms, 'alert')) return 'alert';
  if (hasFamilyTerm(terms, 'menu')) return 'menu';
  if (hasFamilyTerm(terms, 'sheet')) return 'sheet';
  return 'generic';
}

function primitiveFamilyTerms(primitive: PrimitiveDefinition): Set<string> {
  return new Set(
    `${primitive.id} ${primitive.name}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

function hasFamilyTerm(terms: Set<string>, ...candidates: string[]): boolean {
  return candidates.some(candidate => terms.has(candidate));
}

function familySortIndex(family: string): number {
  const index = FAMILY_ORDER.indexOf(family);
  return index === -1 ? FAMILY_ORDER.length : index;
}

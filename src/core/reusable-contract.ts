import type { BasePrimitiveText } from './base-primitives';
import type { Platform, ReusableAxis, ReusableAxisName, ReusableDefinition } from './types';

export const PLATFORMS: readonly Platform[] = ['web', 'mobile', 'desktop'];

export const PLATFORM_LABELS: Record<Platform, string> = {
  web: 'Web',
  mobile: 'Mobile',
  desktop: 'Desktop'
};

export const REUSABLE_AXES: ReadonlyArray<{ name: ReusableAxisName; key: 'variants' | 'sizes' | 'states'; label: string }> = [
  { name: 'variant', key: 'variants', label: 'variant' },
  { name: 'size', key: 'sizes', label: 'size' },
  { name: 'state', key: 'states', label: 'state' }
];

export const SLOT_CONTENT_ACCEPTS = ['text', 'graphic', 'brand-mark'] as const;

export const REUSABLE_LIMITS = {
  name: 32,
  description: 200,
  valueName: 24,
  valueDescription: 120,
  reason: 200,
  accessibility: 200,
  unsupportedReason: 120,
  groupName: 24,
  groupDescription: 120,
  note: 200
} as const;

/** Value ids that name a step on a scale; they belong in sizes, never in variants or states. */
export const SIZE_VALUE_IDS: ReadonlySet<string> = new Set([
  'xs', 'sm', 'md', 'lg', 'xl', 'xxl', 'small', 'medium', 'large', 'compact', 'dense', 'condensed', 'comfortable', 'mini', 'tiny'
]);

export const KEBAB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Field order every reusable is written in; validation rejects any other field. */
export const REUSABLE_FIELDS = [
  'id',
  'name',
  'description',
  'group',
  'platforms',
  'uses',
  'variants',
  'sizes',
  'states',
  'unsupported',
  'slots',
  'prototype',
  'tokenGroupIds',
  'tokenRoles',
  'accessibility',
  'notes',
  'implementationHints',
  'implementationTargets',
  'styleRefs',
  'styleEvidence',
  'prototypeOnly'
] as const satisfies ReadonlyArray<keyof ReusableDefinition>;

export const REUSABLE_PROTOTYPE_FIELDS = ['source', 'styles', 'localValueExceptions'] as const;
export const REUSABLE_AXIS_FIELDS = ['default', 'values'] as const;
export const REUSABLE_AXIS_VALUE_FIELDS = ['id', 'name', 'description'] as const;
export const REUSABLE_SLOT_FIELDS = ['id', 'name', 'description', 'accepts'] as const;
export const REUSABLE_USE_FIELDS = ['kind', 'id', 'reason'] as const;
export const REUSABLE_UNSUPPORTED_FIELDS = ['axis', 'value', 'state', 'reason'] as const;
export const DECLARED_GROUP_FIELDS = ['id', 'name', 'description'] as const;
export const PRIMITIVE_FILE_FIELDS = ['schemaVersion', 'projectId', 'primitives'] as const;
export const COMPONENT_FILE_FIELDS = ['schemaVersion', 'projectId', 'groups', 'components'] as const;

export const SINGLE_VALUE_DESCRIPTIONS: Record<ReusableAxisName, string> = {
  variant: 'The only variant.',
  size: 'The only size.',
  state: 'The only state.'
};

export interface ReusableProseField {
  /** Path below the reusable, such as "variants.primary.description" or "notes[0]". */
  path: string;
  text: string;
  /** Blueprint writes the text of its own primitives; everything else is the app's to write. */
  owner: 'blueprint' | 'app';
}

/** Every prose field of a reusable that agents read, in document order; skips fields that are not strings. */
export function reusableProseFields(reusable: ReusableDefinition, blueprintText?: BasePrimitiveText): ReusableProseField[] {
  const fields: ReusableProseField[] = [];
  const add = (path: string, text: unknown, owner: ReusableProseField['owner'] = 'app'): void => {
    if (typeof text === 'string' && text.trim()) fields.push({ path, text, owner });
  };
  add('description', reusable.description, blueprintText ? 'blueprint' : 'app');
  for (const axis of REUSABLE_AXES) {
    for (const value of listOf(reusable[axis.key]?.values)) {
      add(`${axis.key}.${String(value.id)}.description`, value.description, blueprintText?.[axis.key][String(value.id)] ? 'blueprint' : 'app');
    }
  }
  for (const slot of listOf(reusable.slots)) {
    add(`slots.${String(slot.id)}.description`, slot.description, blueprintText?.slots[String(slot.id)] ? 'blueprint' : 'app');
  }
  listOf(reusable.uses).forEach((use, index) => add(`uses[${index}].reason`, use.reason));
  listOf(reusable.unsupported).forEach((combination, index) => add(`unsupported[${index}].reason`, combination.reason));
  add('accessibility', reusable.accessibility, blueprintText ? 'blueprint' : 'app');
  listOf(reusable.notes).forEach((note, index) => add(`notes[${index}]`, note, blueprintText ? 'blueprint' : 'app'));
  listOf(reusable.implementationHints).forEach((hint, index) => add(`implementationHints[${index}]`, hint));
  return fields;
}

function listOf<T>(value: readonly T[] | undefined): T[] {
  return Array.isArray(value) ? value.filter(item => item !== null && item !== undefined) : [];
}

export function axisIds(axis: ReusableAxis | undefined): string[] {
  return Array.isArray(axis?.values) ? axis.values.map(value => value.id) : [];
}

export function platformsLabel(platforms: readonly Platform[]): string {
  const labels = platforms.map((platform, index) => (index === 0 ? PLATFORM_LABELS[platform] : PLATFORM_LABELS[platform].toLowerCase()));
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

export function humanizeId(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  if (/^[a-z]{1,2}$/i.test(words)) return words.toUpperCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Two or more words, every later one capitalized like a title: "Auth Heading", not "OTP input". */
export function isTitleCase(name: string): boolean {
  const words = name.trim().split(/\s+/);
  return words.length > 1 && words.slice(1).every(word => /^[A-Z][a-z]/.test(word));
}

export function toSentenceCase(name: string): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  return [first, ...rest.map(word => (/^[A-Z][a-z]/.test(word) ? word.charAt(0).toLowerCase() + word.slice(1) : word))].join(' ');
}

export function isSlotReuseAccept(accept: string): accept is `${'primitive' | 'component'}:${string}` {
  return /^(primitive|component):.+$/.test(accept);
}

const ROOT_TAG_PATTERN = /<([a-zA-Z][\w:-]*)([^>]*)>/;
const AXIS_ATTRIBUTE_PATTERN = /\s+data-blueprint-(variant|size|state)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;

/** Axis attributes set on a reusable source's root element, which the compiler owns. */
export function rootAxisAttributes(html: string): string[] {
  const root = ROOT_TAG_PATTERN.exec(html);
  return root ? [...root[2].matchAll(AXIS_ATTRIBUTE_PATTERN)].map(match => `data-blueprint-${match[1]}`) : [];
}

/** Values a reusable source's root element sets, which v1 rendered for any placement that set none. */
export function rootAxisValues(html: string): Partial<Record<ReusableAxisName, string>> {
  const root = ROOT_TAG_PATTERN.exec(html);
  const values: Partial<Record<ReusableAxisName, string>> = {};
  for (const match of root?.[2].matchAll(/\sdata-blueprint-(variant|size|state)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g) ?? []) {
    values[match[1] as ReusableAxisName] = match[2] ?? match[3] ?? match[4];
  }
  return values;
}

export function stripRootAxisAttributes(html: string): string {
  const root = ROOT_TAG_PATTERN.exec(html);
  if (!root) return html;
  const attributes = root[2].replace(AXIS_ATTRIBUTE_PATTERN, '');
  return `${html.slice(0, root.index)}<${root[1]}${attributes}>${html.slice(root.index + root[0].length)}`;
}

export function isUnsupportedCombination(reusable: Pick<ReusableDefinition, 'unsupported'>, variant: string, size: string, state: string): boolean {
  return reusable.unsupported.some(combination => (
    combination.state === state && combination.value === (combination.axis === 'variant' ? variant : size)
  ));
}

/** Specimens a reusable's page renders: every variant at the default size, then every size at the default variant when it has more than one, each across every offered state. */
export function reusableSpecimens(reusable: Pick<ReusableDefinition, 'variants' | 'sizes' | 'states' | 'unsupported'>): Array<{ variant: string; size: string; state: string }> {
  const rows = [
    ...reusable.variants.values.map(variant => ({ variant: variant.id, size: reusable.sizes.default })),
    ...(reusable.sizes.values.length > 1 ? reusable.sizes.values.map(size => ({ variant: reusable.variants.default, size: size.id })) : [])
  ];
  return rows.flatMap(row => reusable.states.values
    .filter(state => !isUnsupportedCombination(reusable, row.variant, row.size, state.id))
    .map(state => ({ ...row, state: state.id })));
}

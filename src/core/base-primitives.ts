/**
 * The closed Blueprint primitive set.
 *
 * Primitives are the building blocks every app shares, so every project carries
 * exactly this set: none removed and none added. Blueprint owns each one's name,
 * group, platforms, axis defaults, and the floor of variants, sizes, states, and
 * slots. An app restyles them through token values and may add values above the
 * floor, but an app-specific piece is a component built from primitives.
 */

import type { Platform } from './types';

export type PrimitiveGroupId = 'actions' | 'inputs' | 'text' | 'surfaces' | 'navigation' | 'structure' | 'feedback' | 'overlays';

export const PRIMITIVE_GROUPS: ReadonlyArray<{ id: PrimitiveGroupId; name: string }> = [
  { id: 'actions', name: 'Actions' },
  { id: 'inputs', name: 'Inputs' },
  { id: 'text', name: 'Text' },
  { id: 'surfaces', name: 'Surfaces' },
  { id: 'navigation', name: 'Navigation' },
  { id: 'structure', name: 'Structure' },
  { id: 'feedback', name: 'Feedback' },
  { id: 'overlays', name: 'Overlays' }
];

/** Required values for one axis; `default` is omitted when the app chooses it. */
export interface BasePrimitiveAxisFloor {
  default?: string;
  values: string[];
}

export interface BasePrimitiveContractEntry {
  id: string;
  name: string;
  group: PrimitiveGroupId;
  platforms: Platform[];
  /** Primitives added to the set after sidecars already existed block only strict validation until those sidecars catch up. */
  enforcement?: 'strict';
  variants: BasePrimitiveAxisFloor;
  sizes: BasePrimitiveAxisFloor;
  states: BasePrimitiveAxisFloor;
  slots: string[];
}

const EVERY_PLATFORM: Platform[] = ['web', 'mobile', 'desktop'];
const ONLY_DEFAULT: BasePrimitiveAxisFloor = { default: 'default', values: ['default'] };
const APP_CHOSEN: BasePrimitiveAxisFloor = { values: [] };

export const BASE_PRIMITIVE_CONTRACT: BasePrimitiveContractEntry[] = [
  {
    id: 'button',
    name: 'Button',
    group: 'actions',
    platforms: EVERY_PLATFORM,
    variants: { default: 'primary', values: ['primary', 'secondary', 'outline', 'ghost', 'destructive', 'link'] },
    sizes: { default: 'md', values: ['md'] },
    states: { default: 'normal', values: ['normal', 'loading', 'disabled'] },
    slots: ['label', 'icon']
  },
  {
    id: 'input',
    name: 'Input',
    group: 'inputs',
    platforms: EVERY_PLATFORM,
    variants: { default: 'default', values: ['default', 'filled', 'ghost', 'outline', 'underline'] },
    sizes: APP_CHOSEN,
    states: { default: 'empty', values: ['empty', 'value', 'focused', 'invalid', 'disabled'] },
    slots: ['label', 'placeholder']
  },
  {
    id: 'checkbox',
    name: 'Checkbox',
    group: 'inputs',
    platforms: EVERY_PLATFORM,
    variants: ONLY_DEFAULT,
    sizes: APP_CHOSEN,
    states: { default: 'off', values: ['off', 'on', 'disabled', 'disabled-on'] },
    slots: ['label']
  },
  {
    id: 'switch',
    name: 'Switch',
    group: 'inputs',
    platforms: EVERY_PLATFORM,
    variants: ONLY_DEFAULT,
    sizes: APP_CHOSEN,
    states: { default: 'off', values: ['off', 'on', 'disabled', 'disabled-on'] },
    slots: ['label']
  },
  {
    id: 'otp-input',
    name: 'OTP input',
    group: 'inputs',
    platforms: EVERY_PLATFORM,
    variants: ONLY_DEFAULT,
    sizes: APP_CHOSEN,
    states: { default: 'empty', values: ['empty', 'filled', 'focused'] },
    slots: []
  },
  {
    id: 'slider',
    name: 'Slider',
    group: 'inputs',
    platforms: EVERY_PLATFORM,
    variants: { default: 'primary', values: ['primary', 'secondary', 'contrast'] },
    sizes: APP_CHOSEN,
    states: { default: 'normal', values: ['normal', 'disabled'] },
    slots: []
  },
  {
    id: 'surface',
    name: 'Surface',
    group: 'surfaces',
    platforms: EVERY_PLATFORM,
    variants: { default: '1', values: ['1', '2', '3'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: ['label']
  },
  {
    id: 'card',
    name: 'Card',
    group: 'surfaces',
    platforms: EVERY_PLATFORM,
    variants: { default: 'default', values: ['default', 'flat', 'elevated', 'status-accent'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: ['default']
  },
  {
    id: 'nav-bar',
    name: 'Navigation bar',
    group: 'navigation',
    platforms: ['mobile'],
    variants: { default: 'back-and-right', values: ['back-and-right', 'back-only', 'right-only'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: ['title']
  },
  {
    id: 'back-button',
    name: 'Back button',
    group: 'navigation',
    platforms: ['mobile'],
    variants: ONLY_DEFAULT,
    sizes: { default: 'md', values: ['md', 'sm'] },
    states: { default: 'normal', values: ['normal', 'disabled'] },
    slots: []
  },
  {
    id: 'separator',
    name: 'Separator',
    group: 'structure',
    platforms: EVERY_PLATFORM,
    variants: { default: 'default', values: ['subtle', 'default', 'strong'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: []
  },
  {
    id: 'list',
    name: 'List',
    group: 'structure',
    platforms: ['mobile'],
    variants: { default: 'grouped', values: ['grouped', 'plain'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: []
  },
  {
    id: 'pressable-row',
    name: 'Pressable row',
    group: 'structure',
    platforms: ['mobile'],
    variants: { default: 'standalone', values: ['standalone', 'group-first', 'group-middle', 'group-last'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: ['title']
  },
  {
    id: 'row-layout',
    name: 'Row layout',
    group: 'structure',
    platforms: EVERY_PLATFORM,
    variants: { default: 'leading-body-trailing', values: ['leading-body-trailing'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: ['title']
  },
  {
    id: 'loading-mark',
    name: 'Loading mark',
    group: 'feedback',
    platforms: EVERY_PLATFORM,
    variants: { default: 'primary', values: ['primary', 'surface'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: []
  },
  {
    id: 'badge',
    name: 'Badge',
    group: 'feedback',
    platforms: EVERY_PLATFORM,
    variants: { default: 'default', values: ['default', 'secondary', 'tonal', 'accent', 'destructive', 'success', 'outline'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: ['label']
  },
  {
    id: 'icon',
    name: 'Icon',
    group: 'feedback',
    platforms: EVERY_PLATFORM,
    variants: { default: 'default', values: ['default', 'muted', 'accent'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: ['default']
  },
  {
    id: 'skeleton',
    name: 'Skeleton',
    group: 'feedback',
    platforms: EVERY_PLATFORM,
    variants: { default: 'line', values: ['line', 'block'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: []
  },
  {
    id: 'alert-dialog',
    name: 'Alert dialog',
    group: 'overlays',
    platforms: EVERY_PLATFORM,
    variants: { default: 'neutral', values: ['neutral', 'destructive'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: ['title', 'message']
  },
  {
    id: 'context-menu',
    name: 'Context menu',
    group: 'overlays',
    platforms: EVERY_PLATFORM,
    variants: ONLY_DEFAULT,
    sizes: APP_CHOSEN,
    states: { default: 'default', values: ['default', 'checked', 'destructive'] },
    slots: []
  },
  {
    id: 'bottom-sheet',
    name: 'Bottom sheet',
    group: 'overlays',
    platforms: ['mobile'],
    variants: { default: 'navbar', values: ['navbar', 'content', 'footer'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: ['title']
  },
  {
    id: 'text',
    name: 'Text',
    group: 'text',
    platforms: EVERY_PLATFORM,
    variants: { default: 'default', values: ['default', 'muted', 'primary'] },
    sizes: { default: 'body', values: ['display', 'body', 'label'] },
    states: ONLY_DEFAULT,
    slots: ['text']
  },
  {
    id: 'radio',
    name: 'Radio',
    group: 'inputs',
    platforms: EVERY_PLATFORM,
    variants: ONLY_DEFAULT,
    sizes: APP_CHOSEN,
    states: { default: 'off', values: ['off', 'on', 'disabled', 'disabled-on'] },
    slots: ['label']
  },
  {
    id: 'select',
    name: 'Select',
    group: 'inputs',
    platforms: EVERY_PLATFORM,
    variants: ONLY_DEFAULT,
    sizes: APP_CHOSEN,
    states: { default: 'placeholder', values: ['placeholder', 'value', 'open', 'disabled'] },
    slots: ['placeholder', 'value']
  },
  {
    id: 'tabs',
    name: 'Tabs',
    group: 'navigation',
    platforms: EVERY_PLATFORM,
    variants: ONLY_DEFAULT,
    sizes: APP_CHOSEN,
    states: { default: 'first-selected', values: ['first-selected', 'second-selected', 'disabled'] },
    slots: ['tabs']
  },
  {
    id: 'toast',
    name: 'Toast',
    group: 'feedback',
    platforms: EVERY_PLATFORM,
    variants: { default: 'default', values: ['default', 'success', 'destructive'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: ['label', 'action']
  },
  {
    id: 'textarea',
    name: 'Textarea',
    group: 'inputs',
    platforms: EVERY_PLATFORM,
    enforcement: 'strict',
    variants: ONLY_DEFAULT,
    sizes: APP_CHOSEN,
    states: { default: 'empty', values: ['empty', 'value', 'focused', 'invalid', 'disabled'] },
    slots: ['label', 'placeholder', 'hint']
  },
  {
    id: 'avatar',
    name: 'Avatar',
    group: 'feedback',
    platforms: EVERY_PLATFORM,
    enforcement: 'strict',
    variants: ONLY_DEFAULT,
    sizes: { default: 'md', values: ['sm', 'md', 'lg'] },
    states: { default: 'initials', values: ['initials', 'fallback', 'status'] },
    slots: ['initials']
  },
  {
    id: 'progress',
    name: 'Progress',
    group: 'feedback',
    platforms: EVERY_PLATFORM,
    enforcement: 'strict',
    variants: ONLY_DEFAULT,
    sizes: APP_CHOSEN,
    states: { default: 'value', values: ['value', 'complete', 'indeterminate'] },
    slots: ['label']
  },
  {
    id: 'tooltip',
    name: 'Tooltip',
    group: 'feedback',
    platforms: ['web', 'desktop'],
    enforcement: 'strict',
    variants: { default: 'top', values: ['top', 'bottom'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: ['label']
  },
  {
    id: 'inline-alert',
    name: 'Inline alert',
    group: 'feedback',
    platforms: EVERY_PLATFORM,
    enforcement: 'strict',
    variants: { default: 'info', values: ['info', 'success', 'warning', 'destructive'] },
    sizes: APP_CHOSEN,
    states: ONLY_DEFAULT,
    slots: ['title', 'message']
  },
  {
    id: 'segmented-control',
    name: 'Segmented control',
    group: 'navigation',
    platforms: EVERY_PLATFORM,
    enforcement: 'strict',
    variants: ONLY_DEFAULT,
    sizes: APP_CHOSEN,
    states: { default: 'first-selected', values: ['first-selected', 'second-selected', 'disabled'] },
    slots: ['options']
  },
  {
    id: 'table-row',
    name: 'Table row',
    group: 'structure',
    platforms: ['web', 'desktop'],
    enforcement: 'strict',
    variants: ONLY_DEFAULT,
    sizes: APP_CHOSEN,
    states: { default: 'default', values: ['default', 'hover', 'selected'] },
    slots: ['cells']
  }
];

const BASE_PRIMITIVES_BY_ID = new Map(BASE_PRIMITIVE_CONTRACT.map(entry => [entry.id, entry]));

export function isBasePrimitive(id: string): boolean {
  return BASE_PRIMITIVES_BY_ID.has(id);
}

export function basePrimitive(id: string): BasePrimitiveContractEntry | undefined {
  return BASE_PRIMITIVES_BY_ID.get(id);
}

export function primitiveGroupName(groupId: string): string | undefined {
  return PRIMITIVE_GROUPS.find(group => group.id === groupId)?.name;
}

/** Primitives a project declares outside the closed set; each belongs in components instead. */
export function primitivesOutsideSet(primitiveIds: string[]): string[] {
  return primitiveIds.filter(id => !BASE_PRIMITIVES_BY_ID.has(id));
}

export function primitiveOutsideSetMessage(id: string): string {
  return `primitive "${id}" is not in the Blueprint primitive set; rebuild it as a component from primitives.`;
}

/** Shared wording for locked-base-set validation errors. */
export const BASE_PRIMITIVE_LOCK_REASON =
  'The Blueprint primitive set is closed: it is themed through tokens, and app-specific pieces are components built from primitives.';

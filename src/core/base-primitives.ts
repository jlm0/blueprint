/**
 * The closed Blueprint primitive set.
 *
 * Primitives are the building blocks every app shares, so every project carries
 * exactly this set: none removed and none added. They take the app's design
 * from its token values and may add state sets and states, but an app-specific
 * piece is a component built from primitives, never a new primitive.
 */

/** Required floor for one locked base primitive: required state ids per required state-set id. */
export interface BasePrimitiveContractEntry {
  id: string;
  /** Primitives added to the set after sidecars already existed block only strict validation until those sidecars catch up. */
  enforcement?: 'strict';
  stateSets: Array<{
    id: string;
    states: string[];
  }>;
}

export const BASE_PRIMITIVE_CONTRACT: BasePrimitiveContractEntry[] = [
  {
    id: 'button',
    stateSets: [
      { id: 'variant', states: ['primary', 'secondary', 'outline', 'ghost', 'destructive', 'link'] },
      { id: 'interaction', states: ['normal', 'loading', 'disabled'] }
    ]
  },
  {
    id: 'input',
    stateSets: [
      { id: 'variant', states: ['default', 'filled', 'ghost', 'outline', 'underline'] },
      { id: 'interaction', states: ['empty', 'value', 'focused', 'invalid', 'disabled'] }
    ]
  },
  {
    id: 'checkbox',
    stateSets: [{ id: 'state', states: ['off', 'on', 'disabled', 'disabled-on'] }]
  },
  {
    id: 'switch',
    stateSets: [{ id: 'state', states: ['off', 'on', 'disabled', 'disabled-on'] }]
  },
  {
    id: 'otp-input',
    stateSets: [{ id: 'cell', states: ['empty', 'filled', 'focused'] }]
  },
  {
    id: 'slider',
    stateSets: [{ id: 'tone', states: ['primary', 'secondary', 'contrast', 'disabled'] }]
  },
  {
    id: 'surface',
    stateSets: [{ id: 'level', states: ['1', '2', '3'] }]
  },
  {
    id: 'card',
    stateSets: [{ id: 'variant', states: ['default', 'flat', 'elevated', 'status-accent'] }]
  },
  {
    id: 'nav-bar',
    stateSets: [{ id: 'slots', states: ['back-and-right', 'back-only', 'right-only'] }]
  },
  {
    id: 'back-button',
    stateSets: [{ id: 'size', states: ['md', 'sm', 'disabled'] }]
  },
  {
    id: 'separator',
    stateSets: [{ id: 'emphasis', states: ['subtle', 'default', 'strong'] }]
  },
  {
    id: 'list',
    stateSets: [{ id: 'variant', states: ['grouped', 'plain'] }]
  },
  {
    id: 'pressable-row',
    stateSets: [{ id: 'shape', states: ['standalone', 'group-first', 'group-middle', 'group-last'] }]
  },
  {
    id: 'row-layout',
    stateSets: [{ id: 'slots', states: ['leading-body-trailing'] }]
  },
  {
    id: 'loading-mark',
    stateSets: [{ id: 'tone', states: ['primary', 'surface'] }]
  },
  {
    id: 'badge',
    stateSets: [{ id: 'variant', states: ['default', 'secondary', 'tonal', 'accent', 'destructive', 'success', 'outline'] }]
  },
  {
    id: 'icon',
    stateSets: [{ id: 'tone', states: ['default', 'muted', 'accent'] }]
  },
  {
    id: 'skeleton',
    stateSets: [{ id: 'density', states: ['line', 'block'] }]
  },
  {
    id: 'alert-dialog',
    stateSets: [{ id: 'intent', states: ['neutral', 'destructive'] }]
  },
  {
    id: 'context-menu',
    stateSets: [{ id: 'item', states: ['default', 'checked', 'destructive'] }]
  },
  {
    id: 'bottom-sheet',
    stateSets: [{ id: 'slot', states: ['navbar', 'content', 'footer'] }]
  },
  {
    id: 'text',
    stateSets: [
      { id: 'variant', states: ['display', 'body', 'label'] },
      { id: 'tone', states: ['default', 'muted', 'primary'] }
    ]
  },
  {
    id: 'radio',
    stateSets: [{ id: 'state', states: ['off', 'on', 'disabled', 'disabled-on'] }]
  },
  {
    id: 'select',
    stateSets: [{ id: 'state', states: ['placeholder', 'value', 'open', 'disabled'] }]
  },
  {
    id: 'tabs',
    stateSets: [{ id: 'state', states: ['first-selected', 'second-selected', 'disabled'] }]
  },
  {
    id: 'toast',
    stateSets: [{ id: 'variant', states: ['default', 'success', 'destructive'] }]
  },
  {
    id: 'textarea',
    enforcement: 'strict',
    stateSets: [{ id: 'interaction', states: ['empty', 'value', 'focused', 'invalid', 'disabled'] }]
  },
  {
    id: 'avatar',
    enforcement: 'strict',
    stateSets: [
      { id: 'size', states: ['sm', 'md', 'lg'] },
      { id: 'content', states: ['initials', 'fallback', 'status'] }
    ]
  },
  {
    id: 'progress',
    enforcement: 'strict',
    stateSets: [{ id: 'progress', states: ['value', 'complete', 'indeterminate'] }]
  },
  {
    id: 'tooltip',
    enforcement: 'strict',
    stateSets: [{ id: 'placement', states: ['top', 'bottom'] }]
  },
  {
    id: 'inline-alert',
    enforcement: 'strict',
    stateSets: [{ id: 'tone', states: ['info', 'success', 'warning', 'destructive'] }]
  },
  {
    id: 'segmented-control',
    enforcement: 'strict',
    stateSets: [{ id: 'state', states: ['first-selected', 'second-selected', 'disabled'] }]
  },
  {
    id: 'table-row',
    enforcement: 'strict',
    stateSets: [{ id: 'state', states: ['default', 'hover', 'selected'] }]
  }
];

const BASE_PRIMITIVE_IDS = new Set(BASE_PRIMITIVE_CONTRACT.map(entry => entry.id));

export function isBasePrimitive(id: string): boolean {
  return BASE_PRIMITIVE_IDS.has(id);
}

/** Primitives a project declares outside the closed set; each belongs in components instead. */
export function primitivesOutsideSet(primitiveIds: string[]): string[] {
  return primitiveIds.filter(id => !BASE_PRIMITIVE_IDS.has(id));
}

export function primitiveOutsideSetMessage(id: string): string {
  return `primitive "${id}" is not in the Blueprint primitive set; rebuild it as a component from primitives.`;
}

/** Shared wording for locked-base-set validation errors. */
export const BASE_PRIMITIVE_LOCK_REASON =
  'The Blueprint primitive set is closed: it is themed through tokens, and app-specific pieces are components built from primitives.';

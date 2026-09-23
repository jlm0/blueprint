/**
 * Locked universal base primitive floor.
 *
 * Blueprint's 26 base primitives are universal and locked: every project must
 * carry the full base set below.
 * Apps may add primitives, state sets, and states, and base primitives inherit
 * app design through token values, but the base set can never be removed or
 * reduced. The starter declaration in starter/design/blueprint/primitives.json
 * carries this floor and may add unlocked primitives, state sets, and states,
 * so sidecars created from an older starter stay valid as the starter grows.
 */

/** Required floor for one locked base primitive: required state ids per required state-set id. */
export interface BasePrimitiveContractEntry {
  id: string;
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
  }
];

/** Shared wording for locked-base-set validation errors. */
export const BASE_PRIMITIVE_LOCK_REASON =
  'The Blueprint base primitive set is locked and cannot be reduced; it can be themed via tokens and extended with app-added primitives.';

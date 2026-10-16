import type { BasePrimitiveText } from './base-primitives';

/** Text Blueprint writes for its own primitives; every sidecar carries it unchanged. */
export const BASE_PRIMITIVE_TEXT: Readonly<Record<string, BasePrimitiveText>> = {
  button: {
    description: 'Runs a command when pressed: form submits, confirmations, toolbar actions, and links styled as actions.',
    accessibility: 'A native button that is reachable by keyboard. Its visible label is its accessible name, and the icon size keeps that label as visually hidden text.',
    notes: ["Change token values and variant names only when the app's design system needs it. Do not build a one-off button for one screen."],
    variants: {
      primary: { name: 'Primary', description: 'The one main action in a region.' },
      secondary: { name: 'Secondary', description: 'A supporting action beside the primary one.' },
      outline: { name: 'Outline', description: 'A bordered action that stays quiet on busy surfaces.' },
      ghost: { name: 'Ghost', description: 'A borderless action for toolbars and dense rows.' },
      destructive: { name: 'Destructive', description: 'An action that deletes or cannot be undone.' },
      link: { name: 'Link', description: 'An action that reads as inline text.' }
    },
    sizes: {
      sm: { name: 'Small', description: 'Dense rows, toolbars, and inline actions.' },
      md: { name: 'Medium', description: 'The default control height.' },
      lg: { name: 'Large', description: 'Prominent calls to action and touch-first layouts.' },
      icon: { name: 'Icon', description: 'A square button holding only an icon.' }
    },
    states: {
      normal: { name: 'Normal', description: 'At rest, ready to press.' },
      hover: { name: 'Hover', description: 'A pointer is over it.' },
      focus: { name: 'Focus', description: 'It holds keyboard focus.' },
      pressed: { name: 'Pressed', description: 'A pointer or key holds it down.' },
      loading: { name: 'Loading', description: 'Its command is running. A loading mark replaces the label.' },
      disabled: { name: 'Disabled', description: 'It cannot be pressed right now.' }
    },
    slots: {
      label: { name: 'Label', description: 'The command in a word or two.' },
      icon: { name: 'Icon', description: 'An optional glyph before the label.' }
    }
  },
  input: {
    description: 'A single-line text field for a short value, with its label and validation feedback.',
    accessibility: 'A native text input with a programmatically associated label and a visible focus ring.',
    notes: ['Input states are core app behavior. Do not infer them from one rendered form.'],
    variants: {
      default: { name: 'Default', description: 'A bordered field on a plain surface.' },
      filled: { name: 'Filled', description: 'A tinted field without a border.' },
      ghost: { name: 'Ghost', description: 'A borderless field that blends into its surface.' },
      outline: { name: 'Outline', description: 'A field with a stronger border.' },
      underline: { name: 'Underline', description: 'A field drawn as a single bottom rule.' }
    },
    sizes: {},
    states: {
      empty: { name: 'Empty', description: 'The field is empty, so the placeholder shows.' },
      value: { name: 'Value', description: 'Holds a typed value.' },
      focused: { name: 'Focused', description: 'Has keyboard focus and is ready for typing.' },
      invalid: { name: 'Invalid', description: 'The value failed validation.' },
      disabled: { name: 'Disabled', description: 'Cannot be edited right now.' }
    },
    slots: {
      label: { name: 'Label', description: 'Names the field above it.' },
      placeholder: { name: 'Placeholder', description: 'A hint shown while the field is empty.' }
    }
  },
  checkbox: {
    description: 'Turns one option on or off, alone or as one of several independent choices.',
    accessibility: 'A checkbox that is reachable by keyboard. Assistive technology reads its checked and disabled states.',
    notes: [],
    variants: {},
    sizes: {},
    states: {
      off: { name: 'Off', description: 'Not selected.' },
      on: { name: 'On', description: 'Selected.' },
      focus: { name: 'Focus', description: 'Holds keyboard focus.' },
      disabled: { name: 'Disabled', description: 'Not selected and cannot change.' },
      'disabled-on': { name: 'Disabled on', description: 'Selected and cannot change.' }
    },
    slots: {
      label: { name: 'Label', description: 'Names the option beside the box.' }
    }
  },
  switch: {
    description: 'Turns a setting on or off with immediate effect.',
    accessibility: 'A binary toggle exposing its on/off state with an associated visible label and an explicit disabled presentation.',
    notes: [],
    variants: {},
    sizes: {},
    states: {
      off: { name: 'Off', description: 'The setting is off.' },
      on: { name: 'On', description: 'The setting is on.' },
      focus: { name: 'Focus', description: 'Holds keyboard focus.' },
      disabled: { name: 'Disabled', description: 'Off and cannot change.' },
      'disabled-on': { name: 'Disabled on', description: 'On and cannot change.' }
    },
    slots: {
      label: { name: 'Label', description: 'Names the setting beside the switch.' }
    }
  },
  'otp-input': {
    description: 'A row of fixed cells for typing a one-time verification code.',
    accessibility: 'A fixed-length passcode input announced as one field with a visible focus cell and caret.',
    notes: [],
    variants: {},
    sizes: {},
    states: {
      empty: { name: 'Empty', description: 'No digits entered yet.' },
      filled: { name: 'Filled', description: 'Every cell holds a digit.' },
      focused: { name: 'Focused', description: 'The next empty cell has focus.' }
    },
    slots: {}
  },
  slider: {
    description: 'Picks a value along a continuous range by dragging a thumb.',
    accessibility: 'A range control exposing its value, minimum, and maximum with a keyboard-operable thumb.',
    notes: [],
    variants: {
      primary: { name: 'Primary', description: 'The fill uses the primary color.' },
      secondary: { name: 'Secondary', description: 'The fill uses the secondary color.' },
      contrast: { name: 'Contrast', description: 'The fill uses the foreground color for maximum contrast.' }
    },
    sizes: {},
    states: {
      normal: { name: 'Normal', description: 'At rest, ready to drag.' },
      disabled: { name: 'Disabled', description: 'Shows its value but cannot be dragged.' }
    },
    slots: {}
  },
  surface: {
    description: 'Sets the background level of a region. Each nested surface, card, grouped list, or pressable row sits one level deeper than its parent.',
    accessibility: 'A container level with no interaction of its own. Nested content keeps its own semantics and keyboard reach.',
    notes: ['A root with `data-blueprint-surface` takes the level after its nearest marked ancestor. A surface variant sets the level for its whole subtree.'],
    variants: {
      '1': { name: 'Surface 1', description: 'The base level, directly on the page.' },
      '2': { name: 'Surface 2', description: 'One level up: a card or panel on the base.' },
      '3': { name: 'Surface 3', description: 'Two levels up: content inside a card.' },
      '4': { name: 'Surface 4', description: 'Three levels up, for deeply nested content.' },
      '5': { name: 'Surface 5', description: 'Four levels up, the deepest level.' }
    },
    sizes: {},
    states: {},
    slots: {
      label: { name: 'Label', description: 'Names the level in the specimen.' }
    }
  },
  card: {
    description: 'A bounded container that groups related content into one unit.',
    accessibility: 'A neutral content container. Each interactive child stays reachable on its own.',
    notes: [],
    variants: {
      default: { name: 'Default', description: 'A bordered card on its surface.' },
      flat: { name: 'Flat', description: 'A card without a border or shadow.' },
      elevated: { name: 'Elevated', description: 'A card lifted off its surface with a shadow.' },
      'status-accent': { name: 'Status accent', description: 'A card with an accent edge that flags its status.' }
    },
    sizes: {},
    states: {},
    slots: {
      default: { name: 'Content', description: 'The content the card groups.' }
    }
  },
  'nav-bar': {
    description: 'The top bar of a mobile screen, with a centered title between a back action and a trailing action.',
    accessibility: 'A navigation landmark with a centered title and accessibly named slot actions.',
    notes: [],
    variants: {
      'back-and-right': { name: 'Back and right', description: 'A back action on the left and an action on the right.' },
      'back-only': { name: 'Back only', description: 'Only a back action, for screens deeper in a stack.' },
      'right-only': { name: 'Right only', description: 'Only a trailing action, for the root of a stack.' }
    },
    sizes: {},
    states: {},
    slots: {
      title: { name: 'Title', description: 'The screen title, centered.' }
    }
  },
  'back-button': {
    description: 'Returns to the previous screen in a mobile navigation stack.',
    accessibility: 'An icon-only button whose accessible name comes from its aria label.',
    notes: [],
    variants: {},
    sizes: {
      md: { name: 'Medium', description: 'The default size in a navigation bar.' },
      sm: { name: 'Small', description: 'A compact size for sheets and dense headers.' }
    },
    states: {
      normal: { name: 'Normal', description: 'At rest, ready to press.' },
      disabled: { name: 'Disabled', description: 'Cannot go back right now.' }
    },
    slots: {}
  },
  separator: {
    description: 'A thin rule that divides content into groups.',
    accessibility: 'A thematic break exposed as a separator to assistive technology.',
    notes: [],
    variants: {
      subtle: { name: 'Subtle', description: 'A faint rule between closely related items.' },
      default: { name: 'Default', description: 'The standard rule between groups.' },
      strong: { name: 'Strong', description: 'A heavier rule between major regions.' }
    },
    sizes: {},
    states: {},
    slots: {}
  },
  list: {
    description: 'A vertical list of rows, grouped on a surface or plain.',
    accessibility: 'A list of rows exposed with list and listitem semantics.',
    notes: [],
    variants: {
      grouped: { name: 'Grouped', description: 'Rows share one rounded surface.' },
      plain: { name: 'Plain', description: 'Rows sit directly on the page, divided by rules.' }
    },
    sizes: {},
    states: {},
    slots: {}
  },
  'pressable-row': {
    description: 'A full-width row that opens or selects something when pressed, alone or within a grouped list.',
    accessibility: 'A single keyboard-reachable row-shaped button with a text-backed accessible name.',
    notes: [],
    variants: {
      standalone: { name: 'Standalone', description: 'A row on its own, rounded on every corner.' },
      'group-first': { name: 'Group first', description: 'The first row of a group, rounded on top.' },
      'group-middle': { name: 'Group middle', description: 'A row between others in a group, square on every corner.' },
      'group-last': { name: 'Group last', description: 'The last row of a group, rounded on the bottom.' }
    },
    sizes: {},
    states: {},
    slots: {
      title: { name: 'Title', description: 'What the row opens or selects.' }
    }
  },
  'row-layout': {
    description: 'Arranges leading, body, and trailing content in one row, without a surface of its own.',
    accessibility: 'A row of leading, body, and trailing content with no role of its own. Only interactive slot content takes focus.',
    notes: [],
    variants: {
      'leading-body-trailing': { name: 'Leading body trailing', description: 'Leading art, body text, and a trailing accessory.' }
    },
    sizes: {},
    states: {},
    slots: {
      title: { name: 'Title', description: 'The main line of the body.' }
    }
  },
  'loading-mark': {
    description: 'An indeterminate spinner shown while something loads.',
    accessibility: 'A polite status indicator that announces busy state without trapping focus.',
    notes: ['It turns the reference mark into a loader that the app owns and can replace.'],
    variants: {
      primary: { name: 'Primary', description: 'A spinner in the primary color on any surface.' },
      surface: { name: 'Surface', description: 'A spinner inside a filled primary circle, for busy backgrounds.' }
    },
    sizes: {},
    states: {},
    slots: {}
  },
  badge: {
    description: 'A compact label for a status, a count, or a category.',
    accessibility: 'A compact status label whose visible text carries the meaning. Its tone never relies on color alone.',
    notes: [],
    variants: {
      default: { name: 'Default', description: 'The primary fill, for the most important label.' },
      secondary: { name: 'Secondary', description: 'A quieter fill for supporting labels.' },
      tonal: { name: 'Tonal', description: 'A muted fill with an accent dot.' },
      accent: { name: 'Accent', description: 'A bordered label with an accent dot.' },
      destructive: { name: 'Destructive', description: 'An error or a destructive status.' },
      success: { name: 'Success', description: 'A success or completed status.' },
      outline: { name: 'Outline', description: 'A border only, for neutral categories.' }
    },
    sizes: {},
    states: {},
    slots: {
      label: { name: 'Label', description: 'The status, count, or category.' }
    }
  },
  icon: {
    description: 'Sizes and colors one inline glyph to the type around it.',
    accessibility: 'A decorative inline glyph. The text around it supplies any accessible name.',
    notes: [],
    variants: {
      default: { name: 'Default', description: 'The foreground color.' },
      muted: { name: 'Muted', description: 'The muted foreground color, for secondary glyphs.' },
      accent: { name: 'Accent', description: 'The accent color, to draw the eye.' }
    },
    sizes: {},
    states: {},
    slots: {
      default: { name: 'Content', description: 'The glyph, as an inline SVG.' }
    }
  },
  skeleton: {
    description: 'A placeholder shape that holds the layout while content loads.',
    accessibility: 'A decorative loading placeholder hidden from assistive technology while content loads.',
    notes: [],
    variants: {
      line: { name: 'Line', description: 'A text-height bar standing in for a line of copy.' },
      block: { name: 'Block', description: 'A larger block standing in for media or a card.' }
    },
    sizes: {},
    states: {},
    slots: {}
  },
  'alert-dialog': {
    description: 'A modal that asks a person to confirm or cancel before an action goes ahead.',
    accessibility: 'A modal alert dialog named by its title, described by its message, and keeping destructive intent on the confirm action only.',
    notes: [],
    variants: {
      neutral: { name: 'Neutral', description: 'Confirms an ordinary action.' },
      destructive: { name: 'Destructive', description: 'Confirms an action that deletes or cannot be undone.' }
    },
    sizes: {},
    states: {},
    slots: {
      title: { name: 'Title', description: 'The question, in a few words.' },
      message: { name: 'Message', description: 'What happens if they confirm.' }
    }
  },
  'context-menu': {
    description: 'A floating menu of actions for one item, opened from that item.',
    accessibility: 'A menu of keyboard-navigable items with separator, shortcut, checked, and destructive item roles.',
    notes: [],
    variants: {},
    sizes: {},
    states: {
      default: { name: 'Default', description: 'Shows a plain action item.' },
      checked: { name: 'Checked', description: 'Shows an item checked as the current choice.' },
      destructive: { name: 'Destructive', description: 'Shows an item for an action that deletes or cannot be undone.' }
    },
    slots: {}
  },
  'bottom-sheet': {
    description: 'A mobile sheet that rises from the bottom edge with its own navigation, content, and footer.',
    accessibility: 'A modal sheet region whose handle, navigation, content, and footer keep a logical source order.',
    notes: [],
    variants: {
      navbar: { name: 'Navbar', description: 'The sheet top: close, title, and done.' },
      content: { name: 'Content', description: 'The sheet body.' },
      footer: { name: 'Footer', description: 'The sheet bottom, holding its main action.' }
    },
    sizes: {},
    states: {},
    slots: {
      title: { name: 'Title', description: 'The sheet title, centered in its navigation bar.' }
    }
  },
  text: {
    description: 'The type ramp: binds the typography tokens to display, body, and label roles in three tones.',
    accessibility: 'Readable text whose tone never relies on color alone for meaning.',
    notes: ['Use the ramp roles instead of one-off font styles. A screen may still set its own display treatment.'],
    variants: {
      default: { name: 'Default', description: 'The foreground color.' },
      muted: { name: 'Muted', description: 'The muted foreground color, for secondary copy.' },
      primary: { name: 'Primary', description: 'The primary color, for emphasis.' }
    },
    sizes: {
      display: { name: 'Display', description: 'Titles and hero copy.' },
      body: { name: 'Body', description: 'Running text.' },
      label: { name: 'Label', description: 'Captions, field labels, and metadata.' }
    },
    states: {},
    slots: {
      text: { name: 'Text', description: 'The copy to set.' }
    }
  },
  radio: {
    description: 'Picks exactly one option from a small set shown together.',
    accessibility: 'A single-choice control that is reachable by keyboard. Assistive technology reads its selected and disabled states.',
    notes: [],
    variants: {},
    sizes: {},
    states: {
      off: { name: 'Off', description: 'Not chosen.' },
      on: { name: 'On', description: 'The chosen option.' },
      focus: { name: 'Focus', description: 'Holds keyboard focus.' },
      disabled: { name: 'Disabled', description: 'Not chosen and cannot change.' },
      'disabled-on': { name: 'Disabled on', description: 'Chosen and cannot change.' }
    },
    slots: {
      label: { name: 'Label', description: 'Names the option beside the circle.' }
    }
  },
  select: {
    description: 'Picks one value from a list that opens on demand.',
    accessibility: 'A named listbox that is reachable by keyboard. Assistive technology reads its value and whether it is open.',
    notes: [],
    variants: {},
    sizes: {},
    states: {
      placeholder: { name: 'Placeholder', description: 'Nothing is chosen yet, so the placeholder shows.' },
      value: { name: 'Value', description: 'Shows the chosen value.' },
      open: { name: 'Open', description: 'The option list is open.' },
      disabled: { name: 'Disabled', description: 'Cannot be opened right now.' }
    },
    slots: {
      placeholder: { name: 'Placeholder', description: 'A hint shown before a value is chosen.' },
      value: { name: 'Value', description: 'The chosen value.' }
    }
  },
  tabs: {
    description: 'Switches between sibling sections of one screen.',
    accessibility: 'A tablist. Assistive technology reads which tab is selected and which tabs are disabled.',
    notes: [],
    variants: {},
    sizes: {},
    states: {
      'first-selected': { name: 'First selected', description: 'The first tab is selected.' },
      'second-selected': { name: 'Second selected', description: 'The second tab is selected.' },
      disabled: { name: 'Disabled', description: 'One tab cannot be selected right now.' }
    },
    slots: {
      tabs: { name: 'Tabs', description: 'The tab labels, in order.' }
    }
  },
  toast: {
    description: 'A brief message that confirms an action or reports a result, with an optional quiet action.',
    accessibility: 'A status message announced through a live region whose tone is not conveyed by color alone.',
    notes: [],
    variants: {
      default: { name: 'Default', description: 'A neutral confirmation.' },
      success: { name: 'Success', description: 'A completed action.' },
      destructive: { name: 'Destructive', description: 'A failed action or an error.' }
    },
    sizes: {},
    states: {},
    slots: {
      label: { name: 'Label', description: 'The message, in one line.' },
      action: { name: 'Action', description: 'An optional follow-up, such as Undo.' }
    }
  },
  textarea: {
    description: 'A multi-line text field for longer writing, with its label, hint, and validation feedback.',
    accessibility: 'A labelled native textarea whose hint text describes the field.',
    notes: [],
    variants: {},
    sizes: {},
    states: {
      empty: { name: 'Empty', description: 'The field is empty, so the placeholder shows.' },
      value: { name: 'Value', description: 'Holds typed text.' },
      focused: { name: 'Focused', description: 'Has keyboard focus and is ready for typing.' },
      invalid: { name: 'Invalid', description: 'The text failed validation.' },
      disabled: { name: 'Disabled', description: 'Cannot be edited right now.' }
    },
    slots: {
      label: { name: 'Label', description: 'Names the field above it.' },
      placeholder: { name: 'Placeholder', description: 'A hint shown while the field is empty.' },
      hint: { name: 'Hint', description: 'Guidance or a character count below the field.' }
    }
  },
  avatar: {
    description: 'Marks a person or entity with initials or a fallback glyph, and optionally their presence.',
    accessibility: 'An image-role mark whose accessible name is the person or entity name.',
    notes: [],
    variants: {},
    sizes: {
      sm: { name: 'Small', description: 'Dense lists and inline mentions.' },
      md: { name: 'Medium', description: 'The default size in rows and headers.' },
      lg: { name: 'Large', description: 'Profiles and detail headers.' }
    },
    states: {
      initials: { name: 'Initials', description: 'Shows the initials of the name.' },
      fallback: { name: 'Fallback', description: 'It has no name or image, so it shows a generic glyph.' },
      status: { name: 'Status', description: 'Adds a presence dot.' }
    },
    slots: {
      initials: { name: 'Initials', description: 'One or two letters from the name.' }
    }
  },
  progress: {
    description: 'A labelled bar that shows how much of a task is complete, or that it is under way.',
    accessibility: 'A progressbar with a visible label and current value.',
    notes: [],
    variants: {},
    sizes: {},
    states: {
      value: { name: 'Value', description: 'Part done, with the current value.' },
      complete: { name: 'Complete', description: 'Finished.' },
      indeterminate: { name: 'Indeterminate', description: 'Under way, with no known end.' }
    },
    slots: {
      label: { name: 'Label', description: 'Names the task above the bar.' }
    }
  },
  tooltip: {
    description: 'A short label that appears beside a control on hover or focus.',
    accessibility: 'A tooltip role describing its anchor control.',
    notes: [],
    variants: {
      top: { name: 'Top', description: 'Appears above its control.' },
      bottom: { name: 'Bottom', description: 'Appears below its control.' }
    },
    sizes: {},
    states: {},
    slots: {
      label: { name: 'Label', description: 'The label, in a few words.' }
    }
  },
  'inline-alert': {
    description: 'A persistent message in the page flow that reports information, success, a warning, or an error.',
    accessibility: 'A status message. Assistive technology reads its title and message together.',
    notes: [],
    variants: {
      info: { name: 'Info', description: 'Neutral information.' },
      success: { name: 'Success', description: 'A completed action or a good outcome.' },
      warning: { name: 'Warning', description: 'Something needs attention soon.' },
      destructive: { name: 'Destructive', description: 'An error that blocks progress.' }
    },
    sizes: {},
    states: {},
    slots: {
      title: { name: 'Title', description: 'The point, in a few words.' },
      message: { name: 'Message', description: 'What happened and what to do next.' }
    }
  },
  'segmented-control': {
    description: 'Switches between a few adjacent options, such as views or time ranges.',
    accessibility: 'A radiogroup whose options are radios named by their visible labels.',
    notes: [],
    variants: {},
    sizes: {},
    states: {
      'first-selected': { name: 'First selected', description: 'The first option is selected.' },
      'second-selected': { name: 'Second selected', description: 'The second option is selected.' },
      disabled: { name: 'Disabled', description: 'One option cannot be selected right now.' }
    },
    slots: {
      options: { name: 'Options', description: 'The option labels, in order.' }
    }
  },
  'table-row': {
    description: 'One row of a data table, with primary, text, numeric, and status cells.',
    accessibility: 'A table row of cells inside a table or grid.',
    notes: [],
    variants: {},
    sizes: {},
    states: {
      default: { name: 'Default', description: 'At rest.' },
      hover: { name: 'Hover', description: 'A pointer is over the row.' },
      selected: { name: 'Selected', description: 'The row is selected.' }
    },
    slots: {
      cells: { name: 'Cells', description: 'The cell contents, in column order.' }
    }
  }
};

export function basePrimitiveText(id: string): BasePrimitiveText | undefined {
  return Object.hasOwn(BASE_PRIMITIVE_TEXT, id) ? BASE_PRIMITIVE_TEXT[id] : undefined;
}

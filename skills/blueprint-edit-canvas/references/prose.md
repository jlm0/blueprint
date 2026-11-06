# Writing reusable prose

Agents read the prose on reusables, screens, and tokens with no person to resolve what it means. Write all of it in Simplified Technical English (ASD-STE100), strict mode: one meaning per sentence, short sentences, active verbs, plain words.

## What it covers

| Field | Limit | What it says | Example |
|---|---|---|---|
| `description` | 200 | What it is and when to use it. | "Groups the actions that close a region, primary first." |
| variant `description` | 120 | The design choice and where it fits. | "A borderless action for toolbars and dense rows." |
| size `description` | 120 | The step on the scale and where it fits. | "Dense rows, toolbars, and inline actions." |
| state `description` | 120 | The condition the instance is in. | "Its command is running. A loading mark replaces the label." |
| slot `description` | 120 | What the slot holds. | "The command in a word or two." |
| `uses[].reason` | 200 | What the piece does in this reusable. | "The next action." |
| `unsupported[].reason` | 120 | Why the combination does not exist. | "A link has no loading state." |
| `accessibility` | 200 | Its role, and how assistive technology announces it. | "A group of ordinary buttons read in order. It adds no role of its own." |
| each note and hint | 200 | One fact or one instruction. Write instructions as commands. | "Show it on hover and on keyboard focus." |
| component group `description` | 120 | What belongs in the group. | "Actions that close a region." |
| page `description` | 120 | Which screens the page holds. | "Phone screens of the signed-in app." |
| screen `description` | 200 | What the screen shows and when it appears. | "The inbox after sign-in. It lists open threads, newest first." |
| section `description` | 200 | What the section holds. | "The thread title, the model picker, and the share action." |
| section `uses[].reason` | 200 | What the piece does in this section. | "Picks the model for the next reply." |
| screen and section notes and hints, production relationship notes | 200 each | One fact or one instruction. | "Keep the composer pinned above the keyboard." |
| token group `description` | 120 | What the tokens in the group decide. | "Semantic color roles every primitive reads from." |
| token group notes | 200 each | One fact or one instruction. | "Theme the app by changing these values." |
| token `description` | 120 | Where the token applies. | "Menus, dialogs, and sheets that float above content." |

The copy inside screen HTML is not covered. It follows `brand.voice`.

## Rules validation enforces

Each error names the field and ends with `Fix:`. Apply the fix as written.

- No semicolons. Split the text into two sentences.
- At most 25 words in a sentence.
- No phrasal verbs, such as "spin up", "reach out", "dive into", or "kick off". Use one plain verb: start, contact, read, begin.
- No marketing words, such as "seamless", "robust", "cutting-edge", or "effortless". Delete the word, or state the fact that earns it.
- No noun for an action, such as "perform an analysis". Use the verb: "analyze".
- Start each field with a capital letter and end it with a period. Write it on one line.
- Do not end with "and" or "or".
- Once an axis has more than one value, no value keeps "The only size." or a similar placeholder. Say what sets the value apart.

## Advisories

`validate` returns these in `prose`. They never fail validation, because each one needs a judgment call.

- `passive-voice`: name who acts, unless the actor is unknown or does not matter. A past participle used as an adjective is correct STE: "The row is selected."
- `present-perfect`: use the simple present or past, unless the current result is the point.
- `synonym-rotation`: two words for what may be one action on one reusable, screen, section, page, or token group, such as "show" and "display". Pick one word and use it every time.

## Habits the linter cannot check

- One instruction per sentence: "Open the menu. Pick a value.", not "Open the menu and pick a value, then close it."
- Keep noun stacks to three words or fewer: "the tier label", not "the season pass tier progress label".
- Keep the subject, verb, and article. Do not drop words to save space.
- Use one term for one thing across the sidecar. Use Blueprint's terms: placement, slot, variant, size, state, surface level.
- Keep hedges such as "may" or "could" when the doubt is real. Do not turn "may fail" into "fails".
- Never add a fact the design does not show. A rewrite fixes the form, not the content.
- Stop when the sentence has one meaning. Shorter is not the goal.

## Blueprint's own text

Blueprint writes the description, accessibility, notes, and value and slot text of its 33 primitives. Every sidecar carries that text word for word, validation rejects edits to it, and `migrate` restores it. Put app guidance for a primitive in `implementationHints`. A value or slot you add to a primitive carries your text, so write it in the same style.

## Process

1. Write the prose with the reusable.
2. Run `validate` in `baseline` mode, and fix each prose error as its `Fix:` says.
3. Read the `prose` advisories. Rewrite each one, unless the wording is deliberate.
4. Run `validate` again.

## Before and after

| Rule | Before | After |
|---|---|---|
| semicolon | "A link named by its kicker, title, and description; the arrow glyph is hidden from assistive technology." | "A link named by its kicker, title, and description. Assistive technology skips the arrow glyph." |
| semicolon | "Nothing typed yet; the placeholder shows." | "The field is empty, so the placeholder shows." |
| long sentence | "A figure whose plot is one image with a text summary of the trend; the range control is a radio group and the bars are hidden from assistive technology." | "A figure whose plot is one image with a text summary of the trend. The range control is a radio group, and assistive technology skips the bars." |
| passive voice | "Its checked and disabled states are exposed to assistive technology." | "Assistive technology reads its checked and disabled states." |
| hedged instruction | "Input states are a core app behavior and should not be inferred from a single rendered form." | "Input states are core app behavior. Do not infer them from one rendered form." |

## Source

Adapted from [asd-ste100-skill](https://github.com/danyuchn/asd-ste100-skill) by Dustin Yuchen Teng, MIT License, Copyright (c) 2026 Dustin Yuchen Teng. Blueprint's linter ports its `ste-lint.py`. It is a clarity tool inspired by STE, not a certified STE authoring tool, and it does not reproduce the ASD-STE100 dictionary.

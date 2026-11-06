---
name: blueprint-edit-canvas
description: Inspect and edit an existing app-owned Blueprint sidecar through the Blueprint MCP server. Use for the brand, tokens, primitives, components, their variants, sizes, states, slots, and prose, governed HTML/CSS, screens, pages, sections, explorations, history, migration, canvas selection, visual review, or any change under `design/blueprint`.
---

# Blueprint Edit Canvas

The JSON owns identity and relationships. Governed HTML/CSS owns visuals. Canvas DOM, screenshots, and activity overlays are evidence only, not source.

## Tools

- `mcp__blueprint__`: `validate`, `migrate`, `index`, `query`, `serve`, `selection`, `explore`, `promote`, `restore`, `capture`, `inspo`.
- `init` and `extract` only when the task needs them.
- If a tool is missing, stop and ask for a restart with the `blueprint` MCP server enabled. Don't fall back to a CLI.
- A running MCP server keeps its tool code, tool text, and canvas page from the build that started it. Its validation workers and the starter come from the build on disk. After a new Blueprint build, ask for a restart of the MCP server in each session on this sidecar. The sessions share one runtime. Then run `migrate`.
- The `migrate`, `inspo`, `explore`, `promote`, and `restore` tools validate their own result. Do not call `validate` again on that result.

## Preflight

1. Sidecar path defaults to `<app-root>/design/blueprint`. Read its `AGENTS.md` (the full authoring rules), `manifest.json`, `brand.json`, and the files affected by the change.
2. `validate` → `{"project":"<sidecar>","mode":"baseline"}`. If it reports a file on an older schema, run `migrate` → `{"project":"<sidecar>","dryRun":true}`, then again without `dryRun`, and fix every error it returns before other work. Every structured file carries one `schemaVersion`, and `serve` with `focus` or `explorationId` and every other tool that reads the sidecar refuse it while any file is older. The canvas shows a "needs migrate" notice until then.
3. `index` → `{"project":"<sidecar>"}`. Besides boundary references, it lists the declared `pages` with their screens and `componentGroups` with their components.
4. `query` for each affected boundary:

| Query | Shape |
| --- | --- |
| show / uses / used-by | `{"type":"show","boundary":"<kind>:<id>"}` |
| sections | `{"type":"sections","screen":"<id>"}` |
| prototype-only | `{"type":"prototype-only"}` |
| explorations | `{"type":"explorations","screenId?":"…","lifecycle?":"active\|archived\|promoted"}` |
| exploration | `{"type":"exploration","explorationId":"…"}` |
| history | `{"type":"history","screenId?":"…"}` |
| history-version | `{"type":"history-version","screenId":"…","version":1}` |

Boundary kinds: `project`, `board`, `token-group`, `primitive`, `component`, `screen`, `section`. `show` on `project:root` returns the brand guideline.

## Layers

Build in order: `brand.json` sets the direction, tokens encode it, primitives inherit the tokens, components compose primitives, screens compose components and primitives. When a screen needs a look the lower layers can't express, change the tokens or add a component instead of styling the screen one-off.

## Edit rules

- Edit sidecar files with normal file tools. Keep stable IDs stable.
- Declare every reusable dependency in JSON. Compose with `<blueprint-use kind="primitive|component" ref="<id>" variant="<variant>" size="<size>" state="<state>">`, not copied markup. An omitted attribute takes that axis's default.
- Slot content belongs to the source that wrote it. A reusable placed inside another reusable's slot is declared on the screen section or component whose HTML contains it. Declare it on the container only when every instance of the container renders it.
- Primitives are a closed set of 33. Never add or remove one, and never drop a value or slot below its Blueprint floor. Restyle their sources, and add variants, sizes, states, and slots as the app needs. An app-specific piece is a component built from primitives.
- Every screen names a declared `page` in `screens.json`, and every component a declared `group` in `components.json`. Reuse one when the work fits; to start a new one, declare it first with an `id`, a sentence-case `name`, and a one-line `description`. `flow` no longer exists. `migrate` turns each old flow into a declared page, and you write its description.
- Fill `home` / `web-home` before adding screens. Add a screen only for a distinct route, state, version, or review target. Group screens with pages, not extra boards.
- Frame preset types: `mobile` or `desktop` only.
- Put the route in `productionRelationship.routePath` and a short frame name in `name`. Use `version` (1, 2, …) only when several records share both.
- A screen id is unique in the project. Each pair of screen name and version is unique in the project, so two routes cannot share a name. Numbered versions of one route keep a shared name.
- Theme by changing token values. Don't create parallel palettes. Record intentional literals in `prototype.localValueExceptions`.
- Instantiate control primitives instead of hand-building native buttons, inputs, or selects; mark a deliberate native control with `data-blueprint-native="<reason>"`.
- Assets go inside `prototypeHost.assetRoots` and must be listed in the screen's `assetRefs`. No scripts, no network.
- Mark uncertainty in notes, hints, `prototypeOnly`, targets, or unresolved decisions, not in visible copy.

## Reusables

Primitives and components share one shape, and every field is required. The sidecar's `AGENTS.md` lists the fields and limits.

- Ids are kebab-case. Names are sentence case, at most 32 characters: "Empty state", not "Empty State".
- An id has at most 36 characters and says what it holds. It holds no placeholder word, no version word, and no final number. The sidecar's `AGENTS.md` lists each naming rule.
- A variant is a design choice the placement keeps. A size is a step on a scale. A state is a condition the instance moves through at runtime. Size words such as `sm`, `lg`, and `compact` are sizes only, and one value never combines two axes.
- The compiler stamps `data-blueprint-variant`, `data-blueprint-size`, and `data-blueprint-state` on each placed root. Never set them on a source root.
- Each slot lists what it `accepts`: `text`, `graphic`, `brand-mark`, `primitive:<id>`, or `component:<id>`.
- `uses` lists each reusable the source renders, once, with a reason. A component's `platforms` fit inside the platforms of everything it uses.
- `tokenRoles`, `accessibility`, `notes`, `implementationHints`, and targets are for agents. The canvas page shows only the header, platforms, built from, variants, sizes, states, and slots.

## Screens and tokens

Screens, sections, pages, token groups, and tokens have fixed shapes too, and validation rejects any other field. The sidecar's `AGENTS.md` lists the fields and limits.

- A screen and a section carry every field. Write `[]` or `false` when a field has nothing to record. Only `version` and `productionRelationship` are optional on a screen.
- A production relationship carries `kind`, `notes`, and the route fields its kind needs.
- Each section use is `{ "kind", "id", "reason" }` plus an optional `binding`.
- Names are sentence case. Screen, section, and token names are at most 32 characters; page and token group names at most 24.
- A path in a hint does not say what the file holds. Record implementation files in `implementationTargets`, or write a sentence around the path.

## Prose

- Write the prose on every primitive, component, screen, section, page, token group, and token in Simplified Technical English. Read `references/prose.md` before you write or edit a description, reason, accessibility line, note, or hint.
- Validation rejects semicolons, sentences over 25 words, phrasal verbs, marketing words, nouns for actions, and fields that are not full sentences. `validate` also returns `prose` advisories.
- Never edit the text of a Blueprint primitive. `migrate` restores it. Put app guidance in `implementationHints`, and describe each value or slot you add.
- Screen copy inside the HTML follows `brand.voice`, not these rules.

## Brand

- Replace the starter's placeholder brand before designing screens. Write interface copy in `brand.voice`.
- Marks are SVGs under `brand/` drawn with `currentColor`, plus `var(--brand-accent)` for a second color, so variants recolor them from color tokens. Outline wordmarks to paths; no live `<text>`, `<style>`, scripts, or external refs. Declare each mark's variants, clear space, and minimum size.
- Place a logo with `<blueprint-use kind="brand-mark" ref="<mark-id>" variant="<variant-id>" class="<sizing-class>"></blueprint-use>`. Never paste SVG markup. It defaults to `1em` tall; size it with the class.
- Add `aria-hidden="true"` when nearby text already names the brand; otherwise the mark is labeled with the brand name.
- Brand marks are not declared in `uses`.

## Validate

- After each batch of edits: `baseline`, then fix every error. Each error ends with `Fix:` and the exact change to make.
- Read the `prose` advisories that `validate` returns. Rewrite each one, unless the wording is deliberate.
- Clear the `findings` that `validate` returns. Each names a `rule`, the boundary, and the file to fix in `location`. Validation in each mode rejects each finding, except a `section-marker` finding, which baseline validation does not reject.
- For implementation-bound work, also run `readiness` and `strict`. They are separate gates. Never report pending, unresolved, or blocked as a pass.

## Review

- `serve` → `{"project":"<sidecar>"}`. The URL stays stable per repo; pass `port` only if the user asks for one.
- When handing work back, call `serve` with `"focus":"<kind>:<id>"` for what you changed and share that URL. A screen focus opens its page and centers the screen; `project:root` opens the brand.
- Valid edits appear live with no reload. An edit with only style errors also appears. While the project has a contract error, the canvas keeps its last valid state. A runtime that has no valid state shows the error page. While it needs `migrate`, the canvas shows a notice that names the outdated files.
- When the user says "this", "that", or "the selected" one, call `selection` → `{"project":"<sidecar>"}` first. A selection made inside an exploration names its candidate.
- A change mark or a change outline names an element whose computed look changed. A frame out of view gets its mark when the view reaches the frame. A frame preset edit appears as the change entry "Frame sizes".
- At the zoom floor, most frames show a thumbnail in place of a live document. A frame document over 4 MB keeps its title placeholder. These states are not errors.
- The agent activity overlay only appears when the consuming project registers the `blueprint-codex-hook` hook. `serve` does not install it.

## Explorations

- Create one:
  ```json
  {"project":"<sidecar>","operation":{"type":"create","screenId":"<id>","state":"<state>","framePresetId":"<preset>","title":"…","intent":"…","candidateLabels":["A","B"]}}
  ```
  Use 2–5 candidates. Edit only the returned candidate sources. Never add candidates to `screens.json`.
- Review one: `serve` → `{"project":"<sidecar>","explorationId":"<id>"}`.
- Archive one: `{"type":"archive","explorationId":"<id>"}`. Archiving keeps the baseline and candidates.
- Promote one: `promote` only after the user picks a candidate, with `explorationId`, `candidateId`, `expectedBaseDigest`, `expectedCurrentDigest`, and `expectedCandidateDigest` from a fresh `exploration` query.
- Restore a version: `restore` only after a `history-version` query, with `screenId`, `version`, `expectedCurrentDigest`, and `expectedVersionDigest`. Never guess digests. The restored screen stays on its current page.

## Capture

```json
{"project":"<sidecar>","boundary":"screen:<id>","state":"<state>","viewport":"<preset-or-condition-id>","out":"<app-root>/.blueprint-artifacts/review/screen-<id>.png"}
```

```json
{"project":"<sidecar>","boundary":"primitive:<id>","state":"<state>","variant":"<variant>","out":"<app-root>/.blueprint-artifacts/review/primitive-<id>.png"}
```

- Screens render a declared review condition. If you omit `state` and `viewport`, the screen's default is used.
- Components and primitives crop to their own box and take `variant` and `size`. `viewport` only sets the width (1280 px by default). Capture them after editing to check your own work.
- Screenshots are evidence only. Don't commit `.blueprint-artifacts/`.

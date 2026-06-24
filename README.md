# Blueprint

Blueprint is a portable design-system canvas template for modeling interface systems as app-owned, agent-readable files. It provides the shared infinite-canvas runtime, TypeScript schema, starter structure, frame/viewport wrappers, primitive methodology, dependency queries, and extraction packet shape that individual app repositories can copy into their own design folders.

The product goal is not to preserve one app's prototype, and it is not to create a centralized app that owns or switches between every project's design system. The goal is to turn the working reference canvas pattern into a reusable standalone template that any app can instantiate, usually under a path such as `design/blueprint/`, while keeping that app's tokens, primitives, screens, copy, theme, and product decisions in the app repo that owns them.

Blueprint core should reconcile the repeatable behavior across projects: a full-screen infinite canvas, a small board switcher, Primitives and Screens boards, smooth reference-style pan/zoom/fit behavior, collision-aware canvas placement, baseline token categories behind primitive samples, universal primitive families such as buttons and inputs, iPhone-class frame/viewport conventions, screen-section composition, dependency lookup, and extraction-ready handoff packets. Each app's Blueprint project should adapt those structures into its own theme and prototype screens by changing app-owned token values, primitive definitions, and screen composition, without re-deciding how the canvas, frame wrappers, primitive state matrices, canvas placement rules, or agent handoff boundaries work.

Structured Blueprint files are the source of truth for agents. HTML and CSS are the human-facing prototype surface or reference evidence, not the contract agents should reverse-engineer. Agents should be able to ask for a single token group, primitive, primitive state set, screen, or screen section and receive either a focused packet for that boundary or a deep production handoff packet with the transitive boundaries, resolved tokens, production relationships, dependency bindings, target mapping, style evidence status, prototype-only caveats, and unresolved decisions needed to move that boundary into React, React Native, HTML, or another target.

## Core Contracts

Each app-owned Blueprint project should be structured around stable, addressable boundaries: project, board, token group, primitive, primitive state set, screen, and screen section. Those boundaries are primarily an agent-consumable sidecar contract, exposed through structured files, data attributes, query scripts, and extraction packets rather than visible dashboard chrome. Every boundary must have a stable ID, an owning source file, dependency metadata, notes, and enough style context to inspect it without reading the whole canvas.

Query outputs and extraction packets share one canonical boundary shape. The minimum packet fields are `id`, `kind`, `projectId`, `sourceFiles`, `data`, `styleRefs`, `styleEvidence`, `dependencies.uses`, `dependencies.usedBy`, `notes`, `prototypeOnly`, and `implementationHints`. Focused extraction preserves that single-boundary view. Deep extraction adds `boundaries`, `resolvedTokens`, and traversal metadata so an implementation agent can consume the selected screen, section, primitive, or state set without manually chasing references.

Baseline validation keeps existing V1 app-owned projects loadable. Strict handoff-readiness validation is opt-in and checks the richer production contract: supported `handoffContractVersion`, token resolution, screen relationship metadata, composition bindings, implementation target metadata, explicit style evidence status, deterministic traversal behavior, and unresolved decision flags. This is not code generation; implementation targets are handoff guidance for agents and must remain portable across app repositories.

## Canvas Review Loop

The Screens board preserves the reusable empty phone placeholder. Structured screen sections remain available through sidecar files, query helpers, extraction packets, and review metadata; they are not rendered as visible phone content unless a future user-approved design explicitly asks for that. Every visible primitive card and screen frame carries `data-boundary-id`/`data-boundary-kind` metadata that is checked against the loaded structured bundle so hand-authored canvas drift fails smoke instead of becoming a hidden handoff bug.

Visible affordances stay minimal. Primitive cards do not render copy or terminal controls; their boundary IDs and extraction commands remain machine-readable metadata for agents and review artifacts. The screen frame keeps its existing compact copy/screenshot/save controls. Browser smoke also writes a machine-readable review manifest and canvas-side style evidence artifact under the canvas-contract workstream artifacts, linking project ID, boundary ID, board/screen context, screenshot capture status, optional packet command, rendered snippet, computed-style summary, and unresolved/captured style evidence status. These artifacts help a future agent connect what the user reviewed to sidecar data without treating canvas HTML, CSS, or JavaScript as the source of truth.

The initial reference input is the reference canvas at:

```text
path/to/reference/canvas
```

That canvas is evidence for the kit shape, not the tool's product boundary. Any app-specific names, visuals, tokens, screens, or copy from the reference must live as sample/reference data or reference notes, never as assumptions baked into Blueprint core. Blueprint should preserve the reference canvas grammar and primitive coverage while generalizing the palette through neutral, replaceable tokens.

## Repository Shape

The first implementation is a browser-native TypeScript template with no runtime framework dependency. Vite is used only as local serving/build tooling. The visible app renders one configured Blueprint project bundle at a time, defaulting to the starter fixture; additional fixtures are headless schema proof and never appear as selectable apps. The app-owned proof fixtures live under `fixtures/app-owned/*/design/blueprint/`, the invalid schema fixture lives under `fixtures/invalid/`, and the starter scaffold lives under `starter/design/blueprint/`.

```text
src/core/        typed schema, validation, boundary IDs, queries, extraction packets
src/app/         browser-native reference-style canvas template and placement helpers
src/scripts/     validation, query, extraction, scope, and smoke commands
fixtures/        app-owned proof fixtures and invalid fixture
starter/         copyable design/blueprint starter shape
docs/            kit, query, and reference-import guidance
```

## Commands

```text
npm run dev
npm run typecheck
npm run check:fixtures
npm test
npm run query -- show --project fixtures/app-owned/nova-care/design/blueprint --boundary screen:home
npm run query -- used-by --project fixtures/app-owned/nova-care/design/blueprint --boundary primitive:action-button
npm run query -- extract --project fixtures/app-owned/nova-care/design/blueprint --boundary screen:home --mode deep
npm run extract:artifacts
npm run scan:scope
npm run smoke:browser
npm run qa
```

## Local CLI

Blueprint also exposes a local package/bin surface for app-owned sidecars. Build it with:

```text
npm run build:cli
```

Then use the generated `blueprint` command shape from an app repo or local package link:

```text
blueprint init --project-id my-app --name "My App" --out design/blueprint
blueprint validate --project design/blueprint
blueprint index --project design/blueprint
blueprint query --project design/blueprint --type show --boundary screen:home
blueprint extract --project design/blueprint --boundary screen:home --out packet.json
```

The CLI is single-project by design: every command takes one explicit app-owned project path. `init` fails on non-empty destinations unless `--force` is provided, and force mode overwrites Blueprint starter files in place rather than deleting the destination directory. `validate` defaults to baseline validation, `index` is backed by structured boundary references, and `extract` writes focused packets by default with `--mode deep` available when the handoff contract API is present. Schema artifacts are shipped under `schema/blueprint-project.schema.json`, and copied starter projects include `AGENTS.md` governance that keeps future agents on the sidecar-first workflow.

`npm run extract:artifacts` writes canonical primitive and screen packets under `.agent-workstream/2026-06-23-01-blueprint-platform-foundation/artifacts/extraction/`. `npm run smoke:browser` renders the dark Blueprint canvas, verifies the Screens board keeps its reusable empty phone placeholder, proves visible-boundary synchronization, review-loop affordances, no-dashboard constraints, and single-project rendering, then writes screenshots, review manifests, and canvas-side style evidence under `.agent-workstream/2026-06-23-04-blueprint-canvas-contract-review-loop/artifacts/`.

## Workstream

```text
.agent-workstream/2026-06-23-01-blueprint-platform-foundation/
```

The workstream remains the source for scope, validation, and closure evidence. Future implementation should continue from the workstream documents rather than relying on chat context.

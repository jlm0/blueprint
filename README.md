# Blueprint

Blueprint is a portable design-system canvas template for modeling interface systems as app-owned, agent-readable files. It provides the shared infinite-canvas runtime, TypeScript schema, starter structure, frame/viewport wrappers, primitive methodology, dependency queries, and extraction packet shape that individual app repositories can copy into their own design folders.

The product goal is not to preserve one app's prototype, and it is not to create a centralized app that owns or switches between every project's design system. The goal is to turn the working reference canvas pattern into a reusable standalone template that any app can instantiate, usually under a path such as `design/blueprint/`, while keeping that app's tokens, primitives, screens, copy, theme, and product decisions in the app repo that owns them.

Blueprint core should reconcile the repeatable behavior across projects: a full-screen infinite canvas, a small board switcher, Primitives and Screens boards, smooth reference-style pan/zoom/fit behavior, collision-aware canvas placement, baseline token categories behind primitive samples, universal primitive families such as buttons and inputs, iPhone-class frame/viewport conventions, screen-section composition, dependency lookup, and extraction-ready handoff packets. Each app's Blueprint project should adapt those structures into its own theme and prototype screens by changing app-owned token values, primitive definitions, and screen composition, without re-deciding how the canvas, frame wrappers, primitive state matrices, canvas placement rules, or agent handoff boundaries work.

Structured Blueprint files are the source of truth for agents. HTML and CSS are the human-facing prototype surface or reference evidence, not the contract agents should reverse-engineer. Agents should be able to ask for a single token group, primitive, primitive state set, screen, or screen section and receive only the relevant data, dependencies, notes, style references, prototype-only caveats, and target-neutral implementation hints needed to move that boundary into React, React Native, HTML, or another target.

## Core Contracts

Each app-owned Blueprint project should be structured around stable, addressable boundaries: project, board, token group, primitive, primitive state set, screen, and screen section. Those boundaries are primarily an agent-consumable sidecar contract, exposed through structured files, data attributes, query scripts, and extraction packets rather than visible dashboard chrome. Every boundary must have a stable ID, an owning source file, dependency metadata, notes, and enough style context to inspect it without reading the whole canvas.

Query outputs and extraction packets should share one canonical boundary shape. The minimum packet fields are `id`, `kind`, `projectId`, `sourceFiles`, `data`, `styleRefs`, `dependencies.uses`, `dependencies.usedBy`, `notes`, `prototypeOnly`, and `implementationHints`. A primitive or screen extraction packet may add target-specific examples later, but the V1 contract stays target-neutral and focused on the smallest useful unit.

The initial reference input is the reference canvas at:

```text
path/to/reference/canvas
```

That canvas is evidence for the kit shape, not the tool's product boundary. Any app-specific names, visuals, tokens, screens, or copy from the reference must live as sample/reference data or reference notes, never as assumptions baked into Blueprint core. Blueprint should preserve the reference canvas grammar and primitive coverage while generalizing the palette through neutral, replaceable tokens.

## Repository Shape

The first implementation is a browser-native TypeScript template with no runtime framework dependency. Vite is used only as local serving/build tooling. The visible app loads one starter fixture; additional fixtures are headless schema proof and never appear as selectable apps. The app-owned proof fixtures live under `fixtures/app-owned/*/design/blueprint/`, the invalid schema fixture lives under `fixtures/invalid/`, and the starter scaffold lives under `starter/design/blueprint/`.

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
npm run extract:artifacts
npm run scan:scope
npm run smoke:browser
npm run qa
```

`npm run extract:artifacts` writes canonical primitive and screen packets under `.agent-workstream/2026-06-23-01-blueprint-platform-foundation/artifacts/extraction/`. `npm run smoke:browser` renders the dark Blueprint canvas and saves screenshots under the same workstream artifact tree.

## Workstream

```text
.agent-workstream/2026-06-23-01-blueprint-platform-foundation/
```

The workstream remains the source for scope, validation, and closure evidence. Future implementation should continue from the workstream documents rather than relying on chat context.

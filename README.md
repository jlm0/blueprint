# Blueprint

Blueprint is a portable design-system canvas template for modeling interface systems as app-owned, agent-readable files. It provides the shared infinite-canvas runtime, TypeScript schema, starter structure, frame/viewport wrappers, primitive methodology, dependency queries, and extraction packet shape that individual app repositories can copy into their own design folders.

The product goal is not to preserve one app's prototype, and it is not to create a centralized app that owns or switches between every project's design system. The goal is to turn the working reference canvas pattern into a reusable standalone template that any app can instantiate, usually under a path such as `design/blueprint/`, while keeping that app's tokens, primitives, screens, copy, theme, and product decisions in the app repo that owns them.

Blueprint core should reconcile the repeatable behavior across projects: a full-screen infinite canvas, a small board switcher, Primitives and Screens boards, smooth reference-style pan/zoom/fit behavior, collision-aware canvas placement, token materialization, canonical primitive and component compilation, isolated browser-native screen hosting, mobile and desktop review conditions, dependency lookup, and extraction-ready handoff packets. Each app adapts those structures through its own token values, canonical sources, reusable components, and screen composition without re-deciding how the canvas, isolation boundary, frame wrappers, dependency graph, or agent handoff boundaries work.

Blueprint has a split authority model. Structured JSON owns stable IDs, declarations, named states, dependency relationships, production targets, and review conditions. App-owned HTML/CSS owns the canonical behavior and appearance of reusable primitives and components, while screen HTML/CSS owns unique hierarchy, responsive layout, media, effects, and art direction. Screenshots and visual diffs are review evidence only. Agents can query a token group, primitive, component, screen, or section and receive either a focused packet or a deep handoff packet with the transitive screen → component → primitive → token graph, approved source paths, viewport/state context, targets, evidence status, and unresolved decisions.

## Core Contracts

Each app-owned Blueprint project should be structured around stable, addressable boundaries: project, board, token group, primitive, primitive state set, component, screen, and screen section. Those boundaries are primarily an agent-consumable sidecar contract, exposed through structured files, source refs, data attributes, query scripts, and extraction packets rather than visible dashboard chrome. Every boundary must have a stable ID, an owning source file, dependency metadata, notes, and enough style context to inspect it without reverse-engineering the canvas DOM.

Query outputs and extraction packets share one canonical boundary shape. The minimum packet fields are `id`, `kind`, `projectId`, `sourceFiles`, `data`, `styleRefs`, `styleEvidence`, `dependencies.uses`, `dependencies.usedBy`, `notes`, `prototypeOnly`, and `implementationHints`. Focused extraction preserves that single-boundary view. Deep extraction adds `boundaries`, `resolvedTokens`, role-aware `tokenUsage`, and traversal metadata so an implementation agent can consume the selected screen, section, primitive, or state set without manually chasing references.

Baseline validation keeps existing four-file projects loadable. These projects are reported as `baseline-compatible`; their generic family projection remains usable but is not high-fidelity evidence. A sidecar becomes `high-fidelity` through declared, governed prototype sources, and missing declared sources fail closed. Strict handoff validation remains opt-in and checks the richer production contract. The separate readiness report surfaces ready, pending, unresolved, or blocked evidence without deleting uncertainty; a `ready` report is not a replacement for strict validation.

High-fidelity projects also carry a locked universal base set: the 27 base primitives declared in `starter/design/blueprint/primitives.json`, with their named state sets and states, are the shared floor every prototype-era sidecar must keep. Base primitives inherit each app's design through token values, and apps may add primitives, state sets, and states — but never remove or reduce the base set. Baseline validation enforces the floor for any project declaring `manifest.prototypeHost`; legacy baseline projects without `prototypeHost` keep their documented `baseline-compatible` classification and stay exempt.

## Canvas Review Loop

For a high-fidelity sidecar, the Primitives board and every component or screen consumer instantiate the same app-owned canonical primitive source. Blueprint materializes token JSON as CSS custom properties, recursively replaces `<blueprint-use kind="primitive|component" ref="…">` declarations with the referenced app roots, annotates those roots directly without layout wrappers, and mounts each screen document in an isolated frame. Screen-local HTML/CSS can use ordinary browser grid, flex, positioning, overlays, responsive rules, typography, and controlled sidecar assets; Blueprint does not translate a restricted layout-keyword language into the final screen. Generic family renderers remain an explicitly labeled fallback for baseline-compatible projects only.

Visible affordances stay minimal. Primitive cards do not render copy or terminal controls; their boundary IDs and typed extraction tool calls remain machine-readable metadata for agents and review artifacts. The screen frame keeps its existing compact copy/screenshot/save controls. Browser smoke also writes machine-readable review manifests and canvas-side style evidence artifacts, linking project ID, boundary ID, board/screen context, explicit captured/capture-ready/unresolved capture status, exact governed source/state/viewport context when available, an optional MCP packet tool call, rendered snippet, computed-style summary, and unresolved/captured style evidence status. By default local evidence goes under `.blueprint-artifacts/`; set `BLUEPRINT_ARTIFACT_ROOT` to route evidence into a workstream artifact folder. These artifacts connect what a person reviewed to the structured graph and canonical app-owned sources without treating screenshots or canvas DOM as editable source.

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
src/mcp/         typed MCP schemas, nine project and exploration tools, and stdio server lifecycle
src/scripts/     repository validation, extraction, scope, and browser-smoke harnesses
fixtures/        app-owned proof fixtures and invalid fixture
starter/         copyable design/blueprint starter shape
docs/            kit, query, screen-composition, and reference-import guidance
```

## Commands

```text
npm run dev
npm run typecheck
npm run check:fixtures
npm test
npm run extract:artifacts
npm run scan:scope
npm run build
npm run smoke:browser
npm run qa
```

## Agent MCP

Blueprint exposes one local stdio MCP server for agents. Build the server and static review site with:

```text
npm run build
```

Configure the agent host to start `blueprint-mcp` from the app repo root. The server exposes exactly nine typed tools:

```json
{
  "init": { "projectId": "my-app", "name": "My App", "out": "design/blueprint", "force": false },
  "validate": { "project": "design/blueprint", "mode": "baseline | readiness | strict" },
  "index": { "project": "design/blueprint" },
  "query": { "project": "design/blueprint", "query": { "type": "show", "boundary": "screen:home" } },
  "explore": { "project": "design/blueprint", "operation": { "type": "create", "screenId": "home", "state": "initial", "framePresetId": "phone", "title": "Home hero options", "intent": "Compare three hero arrangements", "candidateLabels": ["A", "B", "C"] } },
  "promote": { "project": "design/blueprint", "explorationId": "home-hero-options", "candidateId": "b", "expectedBaseDigest": "<digest>", "expectedCurrentDigest": "<digest>", "expectedCandidateDigest": "<digest>" },
  "extract": { "project": "design/blueprint", "boundary": "screen:home", "mode": "focused | deep" },
  "capture": { "project": "design/blueprint", "boundary": "screen:<id>", "state": "<state>", "viewport": "<frame-preset-id>", "out": ".blueprint-artifacts/screen.png" },
  "serve": { "project": "design/blueprint", "port": 4173, "explorationId": "home-hero-options" }
}
```

The MCP interface is single-project by design: every tool call works against one app-owned project path. `serve` defaults to `design/blueprint` from the server process working directory, reloads structured and governed source edits without an app-specific runtime branch, and can return a focused review URL for one saved exploration. `explore` creates or archives a persistent comparison without adding its candidates to canonical route rows. Creation copies the current governed screen into a frozen baseline and two to five editable candidate sources; the agent then edits those candidate files and uses `query` to inspect their current digests. `promote` is the only operation that changes the canonical screen. It requires the explicit exploration, candidate, and compare-and-swap digests, preserves the previous screen as numbered history, and keeps the canonical screen ID stable. An unresolved or archived exploration and all of its sources remain available for later review.

`init` preserves a neutral token, canonical primitive, and reusable component foundation while leaving the `home` phone and `web-home` browser screens intentionally empty. Readiness validation reports the fidelity tier and evidence state; strict validation checks the production handoff contract. `capture` selects an explicit canonical screen, named state, and declared viewport, waits for controlled fonts/media, and writes a screen PNG. Missing browser support fails during preflight with remediation rather than after rendering starts. Query and extraction packets expose source refs and the dependency graph; captures remain corroborating evidence under ignored `.blueprint-artifacts/`.

`npm run extract:artifacts` writes canonical primitive and screen packets under `.blueprint-artifacts/extraction-query/` by default. `npm run smoke:browser` renders the dark Blueprint canvas, verifies the Primitives board is driven by starter, Nova Care, and Atlas Pay sidecar data, verifies the Screens board renders structured screen sections inside reusable mobile and desktop frames without restoring the rejected metadata-card projection, proves visible-boundary synchronization, review-loop affordances, no-dashboard constraints, and single-project rendering, then writes screenshots, review manifests, and canvas-side style evidence under `.blueprint-artifacts/browser-smoke/` by default. Set `BLUEPRINT_ARTIFACT_ROOT=<path>` to place either command's evidence under a caller-provided artifact root.

## Workstream

```text
.agent-workstream/
```

Each dated workstream remains the source for its own scope, validation, and closure evidence. Future implementation should continue from the relevant workstream documents rather than relying on chat context.

---
name: blueprint-handoff
description: Validate and extract implementation handoff context from an app-owned Blueprint sidecar through the Blueprint MCP server. Use when briefing an implementation agent on a screen, section, component, or primitive with its governed sources, dependencies, tokens, brand, targets, evidence, and blockers.
---

# Blueprint Handoff

The sidecar and governed sources are the source of truth. Canvas DOM and captures only corroborate them.

## Tools

- Required: `mcp__blueprint__validate`, `index`, `query`, `extract`.
- For visual evidence: `capture`.
- If a tool is missing, stop and ask for a restart with the `blueprint` MCP server enabled. Don't fall back to a CLI.
- A running MCP server keeps its tool code, tool text, and canvas page from the build that started it. Its validation workers and the starter come from the build on disk. After a new Blueprint build, ask for a restart of the MCP server in each session on this sidecar. The sessions share one runtime. Then run `migrate`.

## Inputs

- Sidecar path (default `<app-root>/design/blueprint`)
- Target boundary as `<kind>:<id>`
- Implementation target
- Whether visual evidence is needed

Read the sidecar's `AGENTS.md`, its manifest, `brand.json`, and the target's sources.

## Inspect

1. `validate` → `{"project":"<sidecar>","mode":"baseline"}`. If it reports an older schema, send the sidecar through `migrate` in `blueprint-edit-canvas` first. `extract` and `query` refuse an older schema.
2. `index` → `{"project":"<sidecar>"}`
3. `query` → `{"project":"<sidecar>","query":{"type":"show","boundary":"<kind>:<id>"}}`
4. Use `uses` / `used-by` for dependency direction and `{"type":"sections","screen":"<id>"}` for a screen's sections.
5. `query` `show` on `project:root` for the brand guideline: voice, marks with their approved variants, clear space and minimum sizes, and usage rules.

## Gate

1. `validate` with `"mode":"readiness"` and `"out":"<app-root>/.blueprint-artifacts/handoff/readiness.json"`, then check `tier` in the summary it returns and read the file for the details. `ok: true` alone is not readiness: the tier can still be `pending` or `unresolved`.
2. Stop the handoff if any of these apply:
   - The target is an empty base frame.
   - The tier is `pending`, `unresolved`, or `blocked`.
   - Governed sources, implementation targets, or style evidence are missing.
   - Unresolved decisions affect implementation.
   - `brand.json` is missing or is still the starter placeholder: its tagline says to replace the brand, or its marks are described as placeholders.
3. Send design fixes through `blueprint-edit-canvas`. If the user accepts an exception, label the handoff non-ready and list the exact blockers.
4. `validate` with `"mode":"strict"`. Require `ok: true` and an empty `findings` list. Strict requires a brand.
5. Call it production-ready only when strict passes and the tier is `ready`.

## Extract

```json
{"project":"<sidecar>","boundary":"<kind>:<id>","mode":"deep","out":"<app-root>/.blueprint-artifacts/handoff/<kind>-<id>.json"}
```

- The deep packet carries the transitive boundaries, resolved tokens, and the full `brand`.
- Any boundary that places a logo with `<blueprint-use kind="brand-mark">` lists `brand.json` and the mark's SVG in its `sourceFiles`. Build the logo from that SVG and its declared variant, not from a capture.
- Use `focused` (the default) only when transitive dependencies aren't needed.

## Capture

```json
{"project":"<sidecar>","boundary":"screen:<id>","state":"<state>","viewport":"<preset-or-condition-id>","out":"<app-root>/.blueprint-artifacts/handoff/screen-<id>.png"}
```

- Screens render a declared review condition. Components and primitives (`component:<id>`, `primitive:<id>`) crop to their own box. They take `variant` and `size`, and `viewport` only sets the width.
- Never infer dependencies from the image.

## Return

Verified values only:

- Boundary ID and purpose
- Validation result and readiness tier
- Deep packet path
- Governed source files
- Production relationship and targets
- Dependencies and resolved token roles
- Variants, sizes, states, slots, viewports, and bindings
- Accessibility, notes, and implementation hints, quoted as written
- Brand voice, plus each mark the target places with its variant and minimum size
- Style evidence and capture path
- Prototype-only caveats and unresolved decisions
- Exact blockers or accepted exceptions

Don't commit `.blueprint-artifacts/`.

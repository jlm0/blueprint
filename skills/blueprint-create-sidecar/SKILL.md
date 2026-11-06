---
name: blueprint-create-sidecar
description: Initialize an app-owned Blueprint sidecar through the Blueprint MCP server. Use when asked to add Blueprint to an app or create `design/blueprint`. Use blueprint-edit-canvas when the sidecar already exists.
---

# Blueprint Create Sidecar

MCP is the agent surface; the canvas is for human review. JSON plus governed HTML/CSS are the source of truth.

## Tools

- Required: `mcp__blueprint__init`, `index`.
- For a new product: `inspo`.
- For review: `serve`.
- If a tool is missing, stop and ask for a restart with the `blueprint` MCP server enabled. Don't hand-copy the starter.
- A running MCP server keeps its tool code, tool text, and canvas page from the build that started it. Its validation workers and the starter come from the build on disk. After a new Blueprint build, ask for a restart of the MCP server in each session on this sidecar. The sessions share one runtime. Then run `migrate`.

## Steps

1. Resolve the app root (given path or `git rev-parse --show-toplevel`). Sidecar path: `<app-root>/design/blueprint`.
2. Inspect the destination. If a sidecar exists, switch to `blueprint-edit-canvas`.
3. Never pass `force: true` without explicit approval. It overwrites colliding starter files; it is not a reset.
4. `init`:
   ```json
   {"projectId":"<stable-id>","name":"<App Name>","out":"<abs-app-root>/design/blueprint","force":false}
   ```
   It writes the project ID into every file and the app name into the manifest and `brand.json`.
   For a new product, add `"start":"inspo"`. The sidecar then has `inspo.json` and an empty `inspo/` folder, and it has no `brand.json` and no `brand/`. Ask the person whether the app is a new product when you cannot tell.
5. `init` validates the new sidecar in baseline mode and returns the result in `validation`. Require `validation.ok: true`. Do not call `validate` after `init`. Use the returned `out` as the sidecar path.
6. Read `AGENTS.md`, `manifest.json`, `tokens.json`, `primitives.json`, `components.json`, `screens.json`, and `brand.json` when it exists. `AGENTS.md` carries the full authoring rules.
7. `index` → `{"project":"<sidecar>"}`. It returns every boundary reference plus the declared `pages` and `componentGroups` with their members.
8. For an inspo start, open the board first. Run `serve` with `"focus":"project:inspo"` and share the URL. Ask the person to paste image links in chat and say what they like in each image. Save each link with the `inspo` tool as `AGENTS.md` describes. The `add` operation requires `url` and a kebab-case `id`. Do not write `brand.json` until the person approves a direction.
9. For the brand, tokens, and first screens, continue with `blueprint-edit-canvas`. Write the prose on each component, screen, page, and token you add by its `references/prose.md`.

## Starter contract

- Two declared pages, each with one empty frame: `screen:home` on `phone` in page `mobile`, and `screen:web-home` on `desktop-web` in page `web`.
- One declared component group, `actions`, holding `component:action-cluster`.
- The closed set of 33 primitives, each with its Blueprint floor of variants, sizes, states, and slots, and its Blueprint text. Never add or remove a primitive. App-specific pieces become components.
- With `"start":"inspo"`: an empty inspo board and no brand. Git ignores the images in `inspo/`, and `inspo.json` keeps their links.
- Without `start`: a placeholder `brand.json`. `init` sets its name, but the tagline, personality, voice, and `mark`/`wordmark` SVGs are stand-ins, and both marks are described as placeholders. Replace them with the app's real brand before designing screens.
- No placeholder product content. Empty starter frames are not implementation evidence.

## Review

- `serve` → `{"project":"<sidecar>"}`. Return the exact `url`. It stays stable per repo; pass `port` only if the user asks for one.
- Add `"focus":"<kind>:<id>"` to get a URL that opens one boundary's page, such as `project:root` for the brand or `screen:home`.
- Valid edits appear live. An edit with only style errors also appears. While the project has a contract error, the canvas keeps its last valid state. A runtime that has no valid state shows the error page.

## Output

- Report the sidecar path, the `validation` result of `init`, the `index.results` count, the declared pages, and the review URL.
- Put evidence under `.blueprint-artifacts/` (gitignored). Don't claim readiness or strict handoff for an empty starter.

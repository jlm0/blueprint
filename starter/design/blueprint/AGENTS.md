# Blueprint Agent Instructions

This folder is a Blueprint sidecar. Treat the structured files here as the source of truth for sidecar-first agent work:

- Use the `blueprint` CLI first. Start with `blueprint validate --project <this-folder>`, then use `blueprint index --project <this-folder>` to find stable boundary IDs before editing.
- Use `blueprint query --project <this-folder> --type show --boundary <kind:id>` and related query modes to inspect one boundary. Use `blueprint extract --project <this-folder> --boundary <kind:id>` for handoff packets, and `blueprint capture --project <this-folder> --boundary screen:<id> --out <file.png>` when a reviewed screen PNG is needed as evidence.
- Add new screens, sections, primitives, state sets, tokens, notes, dependencies, and prototype-only flags by updating `manifest.json`, `tokens.json`, `primitives.json`, and `screens.json`. Keep IDs stable and app-owned.
- For new screens and primitives, record dependency intent in structured fields before relying on the rendered canvas. Use production relationship, binding, implementation target, and style evidence fields when the project opts into strict handoff readiness.
- Run `blueprint validate --project <this-folder>` before handing work to another agent. If strict readiness is expected, also run `blueprint validate --project <this-folder> --mode strict` and resolve or document every error.
- Raw HTML, CSS, JavaScript, captured PNGs, screenshots, and rendered canvas inspection are fallback/debug evidence. Do not use them as the primary source when a structured sidecar field or CLI packet can answer the question.
- Keep this folder single-project. Do not add a dashboard, registry, SaaS state, production app code generation, or cross-app project manager here.

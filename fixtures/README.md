# Fixtures

Sample sidecars that the tests, `npm run check:fixtures`, and the browser smoke test run against. Each valid fixture covers both a phone app and a desktop web app, and each one goes further than the last.

| Fixture | Domain | What it proves | Passes |
| --- | --- | --- | --- |
| [`valid/mira-ai`](valid/mira-ai/design/blueprint) | AI research assistant | A polished product built only from the starter's tokens and primitives, unchanged. Screens and components are the only authored layer. | baseline |
| [`valid/umbra-gaming`](valid/umbra-gaming/design/blueprint) | Game season hub and launch site | Expressive art direction: a dark retheme through token values, bundled fonts, local SVG art, and declared local-value exceptions. | baseline |
| [`valid/meridian-finance`](valid/meridian-finance/design/blueprint) | Business banking | The full production handoff: implementation targets for every boundary, multi-state flows, screen versions, a saved exploration, and history. | baseline, readiness, strict |
| [`invalid/broken`](invalid/broken/design/blueprint) | None | One broken rule per screen, token, or primitive, each named after the rule it breaks. Validation reports a fixed list of errors. | fails by design |

`readiness` and `strict` need implementation targets for every primitive. The starter cannot know those for your app, so Mira and Umbra stop at baseline, and Meridian shows what a finished mapping looks like.

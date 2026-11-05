import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { lintLocalStyleValues } from '../src/core/style-lint';
import { collectStyleRuleIssues } from '../src/core/style-rules';
import { createReadinessReport, validateProject } from '../src/prototype/validate-project';

const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';
const starterRoot = 'starter/design/blueprint';
const screenCss = 'prototype/screens/transactions.css';

describe('local style value lint', () => {
  it('keeps token-driven screen and component CSS clean', async () => {
    assert.deepEqual(lintLocalStyleValues(await loadProjectFromFs(meridianRoot)), []);
  });

  it('flags literal colors and lengths that restate a same-role token, but not unique composition lengths', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    bundle.prototypeSourceContents[screenCss] += `
.drift {
  color: #ff0000;
  padding: 20px 3px;
  border-radius: 5px;
  gap: 5px;
  background: var(--app-color-background, #fff);
  mask-image: linear-gradient(#000 0 0);
}`;
    assert.deepEqual(
      lintLocalStyleValues(bundle).map(issue => [issue.property, issue.category, issue.tokenStyleRef]),
      [['color', 'color', undefined], ['padding', 'spacing', '--app-space-5']]
    );

    const strict = validateProject(bundle, { mode: 'strict' });
    assert.equal(strict.ok, false);
    assert.match(strict.errors.join('\n'), /screen\.transactions prototype\/screens\/transactions\.css color: "#ff0000" uses a literal color/);
    assert.match(strict.errors.join('\n'), /padding: "20px 3px" restates token --app-space-5; use var\(--app-space-5\)/);
    const baseline = validateProject(bundle);
    assert.match(baseline.errors.join('\n'), /color: "#ff0000" uses a literal color/);
    assert.doesNotMatch(baseline.errors.join('\n'), /border-radius|gap: "5px"/);
    const readiness = createReadinessReport(bundle);
    assert.equal(readiness.tier, 'blocked');
    assert.ok(readiness.blockers.some(item => item.path === `screen.transactions.localValues.${screenCss}.color`));
  });

  it('tells the agent to replace only the part of a value that restates a token', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    bundle.prototypeSourceContents[screenCss] += '\n.part { padding: 3px 20px; margin: 20px; }';
    const errors = validateProject(bundle, { mode: 'strict' }).errors.join('\n');
    assert.match(errors, /padding: "3px 20px" restates token --app-space-5; use var\(--app-space-5\) or declare the literal in prototype\.localValueExceptions\. Fix: replace "20px" in "3px 20px" with var\(--app-space-5\) in prototype\/screens\/transactions\.css\./);
    assert.match(errors, /margin: "20px" restates token --app-space-5; use var\(--app-space-5\) or declare the literal in prototype\.localValueExceptions\. Fix: replace "20px" with var\(--app-space-5\) in prototype\/screens\/transactions\.css\./);
  });

  it('names a root for each owner of a stylesheet in a selector-root fix', async () => {
    const shared = async (ownerCount: number): Promise<string[]> => {
      const bundle = await loadProjectFromFs(meridianRoot);
      const screens = bundle.screens.screens.slice(0, ownerCount);
      assert.equal(screens.length, ownerCount);
      for (const screen of screens) {
        assert.ok(screen.prototype);
        screen.prototype.styles = ['prototype/shared.css'];
      }
      bundle.prototypeSourceContents['prototype/shared.css'] = '.stray { margin: 0; }';
      return collectStyleRuleIssues(bundle).filter(issue => issue.rule === 'selector-root' && issue.location === 'prototype/shared.css').map(issue => issue.message);
    };
    const root = (bundle: { screens: { screens: { id: string }[] } }, index: number): string => `[data-blueprint-screen="${bundle.screens.screens[index].id}"]`;
    const bundle = await loadProjectFromFs(meridianRoot);
    assert.deepEqual(await shared(2), [
      `selector ".stray" does not start at the root of any of the 2 boundaries that use prototype/shared.css. Fix: write this selector once for each boundary in prototype/shared.css, and start each copy with one root: ${root(bundle, 0)}, ${root(bundle, 1)}. Or move this rule to the stylesheet of the boundary that it styles.`
    ]);
    assert.deepEqual(await shared(4), [
      `selector ".stray" does not start at the root of any of the 4 boundaries that use prototype/shared.css. Fix: write this selector once for each boundary in prototype/shared.css, and start each copy with one root: ${root(bundle, 0)}, ${root(bundle, 1)}, ${root(bundle, 2)}, and 1 more boundary that lists this stylesheet. Or move this rule to the stylesheet of the boundary that it styles.`
    ]);
  });

  it('clears selector-root on a shared stylesheet when each owner has its own selector', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    const screens = bundle.screens.screens.slice(0, 2);
    for (const screen of screens) {
      assert.ok(screen.prototype);
      screen.prototype.styles = ['prototype/shared.css'];
    }
    const selectors = screens.map(screen => `[data-blueprint-screen="${screen.id}"] .stray`).join(', ');
    bundle.prototypeSourceContents['prototype/shared.css'] = `${selectors} { margin: 0; }`;
    assert.deepEqual(collectStyleRuleIssues(bundle).filter(issue => issue.rule === 'selector-root' && issue.location === 'prototype/shared.css'), []);
  });

  it('holds canonical primitive CSS to the same token-only rule', async () => {
    const bundle = await loadProjectFromFs(starterRoot);
    assert.deepEqual(lintLocalStyleValues(bundle), []);
    bundle.prototypeSourceContents['prototype/primitives/button.css'] += '\n.drift { color: #ffffff; gap: 8px; }';
    assert.deepEqual(
      lintLocalStyleValues(bundle).map(issue => [issue.boundary, issue.property, issue.tokenStyleRef]),
      [['primitive.button', 'color', undefined], ['primitive.button', 'gap', '--app-space-2']]
    );
  });

  it('accepts literals declared in prototype.localValueExceptions', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    bundle.prototypeSourceContents[screenCss] += '\n.brand-mark { color: #ff0000; }';
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'transactions');
    assert.ok(screen?.prototype);
    screen.prototype.localValueExceptions = [
      ...screen.prototype.localValueExceptions ?? [],
      { property: 'color', value: '#FF0000', reason: 'Partner brand mark color is contractually fixed.' }
    ];
    assert.deepEqual(lintLocalStyleValues(bundle), []);
  });

  it('does not read a literal in a CSS string as a value', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    bundle.prototypeSourceContents[screenCss] += '\n.quote::before { content: "use color: #fff here"; }\n.gap::after { content: "rgb(0, 0, 0)"; gap: 3px; }';
    assert.deepEqual(lintLocalStyleValues(bundle), []);
  });

  it('does not read a literal in a CSS comment as a value', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    bundle.prototypeSourceContents[screenCss] += '\n/* color: #fff */\n.note { /* color: #fff; */ gap: /* #fff */ 3px; }';
    assert.deepEqual(lintLocalStyleValues(bundle), []);
  });

  it('still reads a literal beside a string, a comment, or a url, and reports the value as written', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    bundle.prototypeSourceContents[screenCss] += `
.next {
  content: "a" /* b */;
  background:   url("a.png")   #FF0000 /* hero */ ;
  color: rgb(0, 0, 0) !important;
  padding: 20px;
  margin: var(--app-space-5, 20px);
  --local: #123456;
  border-color: var(--missing, rgb(0, 0, 0));
}`;
    assert.deepEqual(
      lintLocalStyleValues(bundle).map(issue => [issue.property, issue.value, issue.category, issue.tokenStyleRef]),
      [
        ['background', 'url("a.png") #FF0000', 'color', undefined],
        ['color', 'rgb(0, 0, 0) !important', 'color', undefined],
        ['padding', '20px', 'spacing', '--app-space-5'],
        ['--local', '#123456', 'color', undefined],
        ['border-color', 'var(--missing, rgb(0, 0, 0))', 'color', undefined]
      ]
    );
  });

  it('keeps reading a stylesheet that postcss cannot parse', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    bundle.prototypeSourceContents[screenCss] += '\n.open { color: #ff0000; content: "#00ff00"; gap: 8px; padding: 20px }\n.never-closed { margin: 0;';
    assert.deepEqual(
      lintLocalStyleValues(bundle).map(issue => [issue.property, issue.value, issue.category]),
      [['color', '#ff0000', 'color'], ['gap', '8px', 'spacing'], ['padding', '20px', 'spacing']]
    );
    assert.match(validateProject(bundle).errors.join('\n'), /prototype\/screens\/transactions\.css cannot be parsed, so Blueprint cannot check its rules\./);
    assert.equal(validateProject(bundle, { mode: 'strict' }).ok, false);
  });
});

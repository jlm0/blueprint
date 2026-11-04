import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { lintLocalStyleValues } from '../src/core/style-lint';
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
    assert.equal(validateProject(bundle).ok, true);
    const readiness = createReadinessReport(bundle);
    assert.equal(readiness.tier, 'blocked');
    assert.ok(readiness.blockers.some(item => item.path === `screen.transactions.localValues.${screenCss}.color`));
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
    assert.equal(validateProject(bundle).ok, true);
    assert.equal(validateProject(bundle, { mode: 'strict' }).ok, false);
  });
});

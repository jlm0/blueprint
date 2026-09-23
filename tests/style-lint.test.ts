import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { lintLocalStyleValues } from '../src/core/style-lint';
import { createReadinessReport, validateProject } from '../src/core/validate';

const denseRoot = 'fixtures/app-owned/dense-ops/design/blueprint';
const starterRoot = 'starter/design/blueprint';
const screenCss = 'prototype/screens/service-health.css';

describe('local style value lint', () => {
  it('keeps token-driven screen and component CSS clean', async () => {
    assert.deepEqual(lintLocalStyleValues(await loadProjectFromFs(denseRoot)), []);
  });

  it('flags literal colors and lengths that restate a same-role token, but not unique composition lengths', async () => {
    const bundle = await loadProjectFromFs(denseRoot);
    bundle.prototypeSourceContents[screenCss] += `
.drift {
  color: #ff0000;
  padding: 14px 3px;
  border-radius: 3px;
  gap: 5px;
  background: var(--ops-color-canvas, #fff);
  mask-image: linear-gradient(#000 0 0);
}`;
    assert.deepEqual(
      lintLocalStyleValues(bundle).map(issue => [issue.property, issue.category, issue.tokenStyleRef]),
      [['color', 'color', undefined], ['padding', 'spacing', '--ops-space-cell']]
    );

    const strict = validateProject(bundle, { mode: 'strict' });
    assert.equal(strict.ok, false);
    assert.match(strict.errors.join('\n'), /screen\.service-health prototype\/screens\/service-health\.css color: "#ff0000" uses a literal color/);
    assert.match(strict.errors.join('\n'), /padding: "14px 3px" restates token --ops-space-cell; use var\(--ops-space-cell\)/);
    assert.equal(validateProject(bundle).ok, true);
    const readiness = createReadinessReport(bundle);
    assert.equal(readiness.tier, 'blocked');
    assert.ok(readiness.blockers.some(item => item.path === `screen.service-health.localValues.${screenCss}.color`));
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
    const bundle = await loadProjectFromFs(denseRoot);
    bundle.prototypeSourceContents[screenCss] += '\n.brand-mark { color: #ff0000; }';
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'service-health');
    assert.ok(screen?.prototype);
    screen.prototype.localValueExceptions = [
      ...screen.prototype.localValueExceptions ?? [],
      { property: 'color', value: '#FF0000', reason: 'Partner brand mark color is contractually fixed.' }
    ];
    assert.deepEqual(lintLocalStyleValues(bundle), []);
  });
});

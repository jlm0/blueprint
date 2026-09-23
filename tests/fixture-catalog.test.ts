import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { createReadinessReport, validateProject } from '../src/core/validate';

const brokenRoot = 'fixtures/invalid/broken/design/blueprint';
const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';

const baselineDefects = [
  'primitive.checkbox.stateSet.state is missing locked base state "disabled-on"',
  'primitive.tooltip.prototype.source "prototype/primitives/tooltip.html" does not exist',
  'broken-sidecar/primitive/tooltip state "top" cannot compile',
  'broken-sidecar/primitive/tooltip state "bottom" cannot compile',
  'primitive "badge" does not declare prototype state "celebrating"',
  'screen "unknown-component" renders undeclared component "citation-card"',
  'Prototype resource URL "https://images.example.com/cover.png"'
];

const strictDefects = [
  ...baselineDefects,
  'screen.literal-color prototype/screens/literal-color.css color: "#ff3d7f" uses a literal color',
  'screen.hand-built-control prototype/screens/hand-built-control.html:4 hand-builds a native <button>',
  'token-group.color --app-color-muted (#b4b4bb) on --app-color-surface (#ffffff) has contrast 2.06:1',
  'screen.unmarked-section.section.summary needs a data-blueprint-section="summary" marker'
];

describe('fixture catalog', () => {
  it('reports exactly the planted baseline defects in the broken fixture', async () => {
    const result = validateProject(await loadProjectFromFs(brokenRoot));
    assert.equal(result.ok, false);
    assertExactDefects(result.errors, baselineDefects);
  });

  it('reports exactly the planted baseline and strict defects in the broken fixture', async () => {
    const result = validateProject(await loadProjectFromFs(brokenRoot), { mode: 'strict' });
    assert.equal(result.ok, false);
    assertExactDefects(result.errors, strictDefects);
  });

  it('passes baseline validation for every valid fixture', async () => {
    const entries = await readdir('fixtures/valid', { withFileTypes: true });
    const roots = entries.filter(entry => entry.isDirectory()).map(entry => path.join('fixtures/valid', entry.name, 'design/blueprint'));
    assert.ok(roots.length >= 3);
    for (const root of roots) {
      const result = validateProject(await loadProjectFromFs(root));
      assert.deepEqual(result.errors, [], root);
    }
  });

  it('passes strict validation and readiness for the full handoff fixture', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    assert.deepEqual(validateProject(bundle, { mode: 'strict' }).errors, []);
    const readiness = createReadinessReport(bundle);
    assert.equal(readiness.tier, 'ready');
    assert.deepEqual(readiness.blockers, []);
  });
});

function assertExactDefects(errors: string[], expected: string[]): void {
  assert.equal(errors.length, expected.length, errors.join('\n'));
  for (const defect of expected) {
    assert.equal(errors.filter(error => error.includes(defect)).length, 1, `expected exactly one error containing: ${defect}`);
  }
}

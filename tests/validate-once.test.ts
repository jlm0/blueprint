import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { createReadinessReport, validateProject, validateProjectReadiness } from '../src/core/validate';
import { validateBlueprint } from '../src/mcp/operations';

const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';

describe('readiness validation', () => {
  it('runs the prototype source graph once for the baseline and the readiness report', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    let runs = 0;
    const { baseline, readiness } = validateProjectReadiness(bundle, () => {
      runs += 1;
      return [{ boundaryId: 'umbra-gaming/screen/launch', state: 'default', message: 'stub failure' }];
    });
    assert.equal(runs, 1);
    assert.ok(baseline.errors.includes('Prototype source graph umbra-gaming/screen/launch state "default" cannot compile: stub failure'));
    assert.ok(readiness.blockers.some(item => item.path === 'prototypeSourceGraph.umbra-gaming/screen/launch.default'));

    assert.deepEqual(validateProjectReadiness(bundle), {
      baseline: validateProject(bundle),
      readiness: createReadinessReport(bundle)
    });
  });

  it('keeps the readiness output of the validate tool', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    const output = await validateBlueprint({ project: umbraRoot, mode: 'readiness' });
    assert.equal(output.mode, 'readiness');
    assert.deepEqual(output.errors, validateProject(bundle).errors);
    assert.deepEqual(output.mode === 'readiness' ? output.readiness : undefined, createReadinessReport(bundle));
  });
});

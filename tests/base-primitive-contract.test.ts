import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BASE_PRIMITIVE_CONTRACT } from '../src/core/base-primitives';
import { loadProjectFromFs } from '../src/core/load';
import { collectDesignFindings } from '../src/core/findings';
import { validateProject } from '../src/core/validate';
import type { BlueprintProjectBundle, PrimitiveStateSet } from '../src/core/types';

const starterRoot = 'starter/design/blueprint';
const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';
const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';
const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';

describe('Blueprint closed primitive set', () => {
  it('is carried in full by the canonical starter declaration', async () => {
    const starter = await loadProjectFromFs(starterRoot);
    const starterById = new Map(starter.primitives.primitives.map(primitive => [primitive.id, primitive]));

    assert.equal(BASE_PRIMITIVE_CONTRACT.length, 33);
    assert.deepEqual(starter.primitives.primitives.map(primitive => primitive.id).sort(), BASE_PRIMITIVE_CONTRACT.map(entry => entry.id).sort());
    for (const entry of BASE_PRIMITIVE_CONTRACT) {
      const primitive = starterById.get(entry.id);
      assert.ok(primitive, `starter base declaration is missing ${entry.id}`);
      for (const required of entry.stateSets) {
        const stateSet: PrimitiveStateSet | undefined = primitive.stateSets.find(candidate => candidate.id === required.id);
        assert.ok(stateSet, `starter ${entry.id} is missing locked state set ${required.id}`);
        const stateIds: string[] = stateSet.states.map(state => state.id);
        assert.deepEqual(
          required.states.filter(state => !stateIds.includes(state)),
          [],
          `starter ${entry.id}.${required.id} must carry every locked state`
        );
      }
    }
  });

  it('accepts compliant high-fidelity projects carrying the themed base set', async () => {
    for (const root of [starterRoot, miraRoot, umbraRoot, meridianRoot]) {
      const bundle = await loadProjectFromFs(root);
      assert.ok(bundle.manifest.prototypeHost, `${root} should declare the prototype-era contract`);
      assert.equal(validateProject(bundle).ok, true, `${root} should remain baseline-valid`);
    }
  });

  it('rejects a high-fidelity project missing a base primitive', async () => {
    const broken = cloneBundle(await loadProjectFromFs(meridianRoot));
    broken.primitives.primitives = broken.primitives.primitives.filter(primitive => primitive.id !== 'switch');

    const result = validateProject(broken);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /missing locked base primitive "switch"/);
    assert.match(result.errors.join('\n'), /primitive set is closed/);
    assert.match(result.errors.join('\n'), /app-specific pieces are components built from primitives/);
  });

  it('rejects a high-fidelity project with a reduced base state set', async () => {
    const broken = cloneBundle(await loadProjectFromFs(meridianRoot));
    const switchPrimitive = requirePrimitive(broken, 'switch');
    const stateSet = switchPrimitive.stateSets.find(candidate => candidate.id === 'state');
    assert.ok(stateSet);
    stateSet.states = stateSet.states.filter(state => state.id !== 'disabled-on');

    const result = validateProject(broken);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /primitive\.switch\.stateSet\.state is missing locked base state "disabled-on"/);
    assert.match(result.errors.join('\n'), /primitive set is closed/);
  });

  it('rejects a high-fidelity project missing a required base state-set id', async () => {
    const broken = cloneBundle(await loadProjectFromFs(meridianRoot));
    const button = requirePrimitive(broken, 'button');
    button.stateSets = button.stateSets.filter(stateSet => stateSet.id !== 'interaction');

    const result = validateProject(broken);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /primitive\.button\.stateSets is missing locked base state-set "interaction"/);
    assert.match(result.errors.join('\n'), /primitive set is closed/);
  });

  it('allows app-added state sets and states on the fixed primitives', async () => {
    const extended = cloneBundle(await loadProjectFromFs(meridianRoot));
    const switchStateSet = requirePrimitive(extended, 'switch').stateSets.find(candidate => candidate.id === 'state');
    assert.ok(switchStateSet);
    switchStateSet.states.push({ id: 'indeterminate', name: 'Indeterminate', tokens: [], prototypeOnly: false, notes: [], implementationHints: [] });

    requirePrimitive(extended, 'card').stateSets.push({
      id: 'priority',
      name: 'Priority States',
      description: 'App-added card priority treatments.',
      styleRefs: [],
      states: [{ id: 'flagged', name: 'Flagged', tokens: [], prototypeOnly: false, notes: [], implementationHints: [] }]
    });

    assert.equal(validateProject(extended).ok, true, validateProject(extended).errors.join('\n'));
    assert.equal(validateProject(extended, { mode: 'strict' }).errors.some(error => /primitive set/.test(error)), false);
  });

  it('flags primitives outside the set and blocks them in strict validation', async () => {
    const extended = cloneBundle(await loadProjectFromFs(meridianRoot));
    const chip = structuredClone(requirePrimitive(extended, 'badge'));
    chip.id = 'stat-chip';
    chip.name = 'Stat Chip';
    extended.primitives.primitives.push(chip);

    assert.equal(validateProject(extended).ok, true, 'existing sidecars with extra primitives stay baseline-valid');
    assert.match(
      validateProject(extended, { mode: 'strict' }).errors.join('\n'),
      /primitive "stat-chip" is not in the Blueprint primitive set; rebuild it as a component from primitives/
    );
    assert.deepEqual(
      collectDesignFindings(extended).filter(finding => finding.rule === 'primitive-set').map(finding => finding.boundaryId),
      ['meridian-finance/primitive/stat-chip']
    );
  });

  it('requires primitives added to the set after sidecars existed only in strict validation', async () => {
    const older = cloneBundle(await loadProjectFromFs(meridianRoot));
    older.primitives.primitives = older.primitives.primitives.filter(primitive => primitive.id !== 'table-row');

    assert.equal(validateProject(older).errors.some(error => /missing locked base primitive "table-row"/.test(error)), false);
    assert.match(validateProject(older, { mode: 'strict' }).errors.join('\n'), /missing locked base primitive "table-row"/);
  });

  it('applies the locked floor independently of the prototype host declaration', async () => {
    const broken = cloneBundle(await loadProjectFromFs(meridianRoot));
    delete (broken.manifest as Partial<BlueprintProjectBundle['manifest']>).prototypeHost;
    broken.primitives.primitives = broken.primitives.primitives.filter(primitive => primitive.id !== 'button');

    const result = validateProject(broken);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /manifest\.prototypeHost must declare/);
    assert.match(result.errors.join('\n'), /missing locked base primitive "button"/);
    assert.match(result.errors.join('\n'), /primitive set is closed/);
  });
});

function requirePrimitive(bundle: BlueprintProjectBundle, primitiveId: string) {
  const primitive = bundle.primitives.primitives.find(candidate => candidate.id === primitiveId);
  assert.ok(primitive, `expected primitive ${primitiveId}`);
  return primitive;
}

function cloneBundle(bundle: BlueprintProjectBundle): BlueprintProjectBundle {
  return structuredClone(bundle);
}

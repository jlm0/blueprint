import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadProjectFromFs } from '../src/core/load';
import { screenFrameLabel, screenRoutePath } from '../src/core/screen-naming';
import type { ScreenDefinition } from '../src/core/types';
import { validateProject } from '../src/core/validate';

const novaRoot = 'fixtures/app-owned/nova-care/design/blueprint';

describe('Blueprint screen frame naming', () => {
  it('derives Route · Frame name and adds Vn only when declared', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const screen = bundle.screens.screens[0];
    assert.ok(screen);

    assert.equal(screenRoutePath(screen), '/care');
    assert.equal(screenFrameLabel(screen), 'Care · Care Home');

    const versioned = structuredClone(screen);
    versioned.version = 2;
    assert.equal(screenFrameLabel(versioned), 'Care · Care Home · V2');

    const savings = structuredClone(screen);
    savings.name = 'Move money';
    savings.productionRelationship = { kind: 'existing-route', routePath: '/SAVINGS' };
    assert.equal(screenFrameLabel(savings), 'Savings · Move money');

    const fallback = structuredClone(screen);
    fallback.id = 'web-home';
    delete fallback.productionRelationship;
    assert.equal(screenFrameLabel(fallback), 'Web Home · Care Home');
  });

  it('publishes the optional positive integer version in the screen JSON schema', async () => {
    const schema = JSON.parse(await readFile('schema/blueprint-project.schema.json', 'utf8')) as {
      $defs: { screen: { properties: Record<string, unknown> } };
    };
    assert.deepEqual(schema.$defs.screen.properties.version, { type: 'integer', minimum: 1 });
  });

  it('requires versions only for duplicate route and frame names', async () => {
    const bundle = await loadProjectFromFs(novaRoot);
    const first = bundle.screens.screens[0];
    assert.ok(first);
    const second = structuredClone(first);
    second.id = 'home-alternative';
    bundle.screens.screens.push(second);

    const missing = validateProject(bundle);
    assert.equal(missing.ok, false);
    assert.match(missing.errors.join('\n'), /must each declare a unique consecutive version starting at 1/);

    first.version = 1;
    second.version = 2;
    const valid = validateProject(bundle);
    assert.equal(valid.ok, true, valid.errors.join('\n'));
  });

  it('rejects singleton, invalid, duplicate, and non-consecutive versions', async () => {
    const singleton = await loadProjectFromFs(novaRoot);
    const only = singleton.screens.screens[0];
    assert.ok(only);
    only.version = 1;
    assert.match(validateProject(singleton).errors.join('\n'), /must be omitted because .* has only one screen/);

    const invalid = await loadProjectFromFs(novaRoot);
    const invalidScreen = invalid.screens.screens[0];
    assert.ok(invalidScreen);
    invalidScreen.version = 1.5;
    assert.match(validateProject(invalid).errors.join('\n'), /version must be a positive integer/);

    const duplicate = await versionedPair();
    duplicate.screens.screens[1]!.version = 1;
    assert.match(validateProject(duplicate).errors.join('\n'), /must use unique consecutive versions 1, 2; received 1, 1/);

    const nonConsecutive = await versionedPair();
    nonConsecutive.screens.screens[1]!.version = 3;
    assert.match(validateProject(nonConsecutive).errors.join('\n'), /must use unique consecutive versions 1, 2; received 1, 3/);
  });
});

async function versionedPair() {
  const bundle = await loadProjectFromFs(novaRoot);
  const first = bundle.screens.screens[0];
  assert.ok(first);
  const second = structuredClone(first) as ScreenDefinition;
  second.id = 'home-alternative';
  first.version = 1;
  second.version = 2;
  bundle.screens.screens.push(second);
  return bundle;
}

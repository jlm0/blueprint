import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { collectProseAdvisories } from '../src/core/prose-advisories';
import { assertCurrentSchema, BLUEPRINT_SCHEMA_VERSION } from '../src/core/schema-version';
import type { BlueprintProjectBundle } from '../src/core/types';
import { validateProject } from '../src/core/validate';

const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';

async function mira(): Promise<BlueprintProjectBundle> {
  return structuredClone(await loadProjectFromFs(miraRoot));
}

describe('project schema version', () => {
  it('refuses a project while any structured file is on an older schema, naming each file', async () => {
    const bundle = await mira();
    bundle.manifest.schemaVersion = '1.0.0';
    bundle.screens.schemaVersion = '1.0.0';

    const fix = `and Blueprint now reads "${BLUEPRINT_SCHEMA_VERSION}". Fix: run the migrate tool on this project, then fix what validate reports.`;
    assert.deepEqual(validateProject(bundle).errors, [
      `manifest.json is on schema "1.0.0", ${fix}`,
      `screens.json is on schema "1.0.0", ${fix}`
    ]);
    assert.throws(() => assertCurrentSchema(bundle), /manifest\.json is on schema "1\.0\.0"/);
  });
});

describe('screen and token contract', () => {
  it('holds pages, screens, sections, and their uses to a fixed shape, naming each fix', async () => {
    const bundle = await mira();
    const page = bundle.screens.pages[0]!;
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'workspace')!;
    const section = screen.sections.find(candidate => candidate.id === 'thread-header')!;
    delete (page as { description?: string }).description;
    Object.assign(screen, { layout: 'split' });
    delete (screen as { styleEvidence?: unknown }).styleEvidence;
    screen.productionRelationship = { kind: 'route' as 'new-route', routePath: '/threads/:threadId' };
    Object.assign(section, { emphasis: 'high' });
    delete (section as { implementationTargets?: unknown }).implementationTargets;
    Object.assign(section.uses[0]!, { weight: 2 });
    section.name = 'Thread Header';

    const errors = validateProject(bundle).errors.join('\n');
    assert.match(errors, /screens\.page\.web\.description is missing\. Fix: say which screens the page holds, in 120 characters or fewer\./);
    assert.match(errors, /screen\.workspace has unknown field "layout"\. Fix: remove it/);
    assert.match(errors, /screen\.workspace is missing "styleEvidence"\. Fix: add it; every field except "version", "productionRelationship" is required\./);
    assert.match(errors, /screen\.workspace\.productionRelationship is missing "notes"\. Fix: add it/);
    assert.match(errors, /screen\.workspace\.productionRelationship\.kind "route" is not a relationship kind\. Fix: set it to one of "new-route"/);
    assert.match(errors, /screen\.workspace\.section\.thread-header has unknown field "emphasis"\. Fix: remove it/);
    assert.match(errors, /screen\.workspace\.section\.thread-header is missing "implementationTargets"\. Fix: add it/);
    assert.match(errors, /screen\.workspace\.section\.thread-header\.uses\[0\] has unknown field "weight"\. Fix: remove it/);
    assert.match(errors, /screen\.workspace\.section\.thread-header\.name "Thread Header" is in title case\. Fix: write it in sentence case, "Thread header"/);
  });

  it('holds token groups and tokens to a fixed shape, naming each fix', async () => {
    const bundle = await mira();
    const group = bundle.tokens.tokenGroups.find(candidate => candidate.id === 'color')!;
    const token = group.tokens.find(candidate => candidate.id === 'surface')!;
    group.name = 'Color Roles';
    delete (group as { notes?: unknown }).notes;
    Object.assign(token, { alias: 'card' });
    token.type = 'colour' as 'color';
    token.styleRef = 'app-color-surface';
    token.description = '';

    const errors = validateProject(bundle).errors.join('\n');
    assert.match(errors, /tokenGroup\.color\.name "Color Roles" is in title case\. Fix: write it in sentence case, "Color roles"/);
    assert.match(errors, /tokenGroup\.color is missing "notes"\. Fix: add it; every field is required\./);
    assert.match(errors, /tokenGroup\.color\.token\.surface has unknown field "alias"\. Fix: remove it/);
    assert.match(errors, /tokenGroup\.color\.token\.surface\.type "colour" is not a token type\. Fix: set it to one of "color"/);
    assert.match(errors, /tokenGroup\.color\.token\.surface\.styleRef "app-color-surface" is not a CSS custom property\. Fix: set it to the property prototypes read/);
    assert.match(errors, /tokenGroup\.color\.token\.surface\.description is missing\. Fix: say where the token applies, in 120 characters or fewer\./);
  });

  it('lints the prose of screens, sections, and tokens, and reports advisories against their boundaries', async () => {
    const bundle = await mira();
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'workspace')!;
    const section = screen.sections.find(candidate => candidate.id === 'thread-header')!;
    const token = bundle.tokens.tokenGroups[0]!.tokens[0]!;
    section.description = 'The thread title and model picker; the share action sits on the right.';
    section.uses[0]!.reason = 'A seamless model picker.';
    token.description = 'app canvas';
    screen.notes = ['The thread is shown after each reply.'];
    section.notes = ['Check the title fits. Verify the picker fits.'];

    const errors = validateProject(bundle).errors.join('\n');
    assert.match(errors, /screen\.workspace\.section\.thread-header\.description has a semicolon\. Fix: split it into two sentences\./);
    assert.match(errors, /screen\.workspace\.section\.thread-header\.uses\[0\]\.reason .*"seamless"/);
    assert.match(errors, /tokenGroup\.color\.token\.background\.description is not written as sentences\. Fix: start with a capital letter and end with a period\./);

    const advisories = collectProseAdvisories(bundle);
    const passive = advisories.find(advisory => advisory.rule === 'passive-voice' && advisory.kind === 'screen');
    assert.deepEqual(passive && { boundaryId: passive.boundaryId, localId: passive.localId, field: passive.field }, {
      boundaryId: 'mira-ai/screen/workspace',
      localId: 'workspace',
      field: 'notes[0]'
    });
    const rotation = advisories.find(advisory => advisory.rule === 'synonym-rotation' && advisory.kind === 'section');
    assert.equal(rotation?.boundaryId, 'mira-ai/section/workspace/thread-header');
    assert.match(rotation?.message ?? '', /other text on this section uses "check"/);
  });
});

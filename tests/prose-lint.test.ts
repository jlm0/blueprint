import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BASE_PRIMITIVE_CONTRACT } from '../src/core/base-primitives';
import { BASE_PRIMITIVE_TEXT } from '../src/core/base-primitive-text';
import { loadProjectFromFs } from '../src/core/load';
import { lintProse, lintSynonymRotation, MAX_SENTENCE_WORDS } from '../src/core/prose-lint';
import { reusableProseFields } from '../src/core/reusable-contract';
import { collectProseAdvisories } from '../src/core/reusable-validate';
import type { BlueprintProjectBundle } from '../src/core/types';
import { validateProject } from '../src/core/validate';

const starterRoot = 'starter/design/blueprint';
const fixtureRoots = ['mira-ai', 'umbra-gaming', 'meridian-finance'].map(id => `fixtures/valid/${id}/design/blueprint`);

const rules = (text: string): string[] => lintProse(text).map(issue => issue.rule);

describe('reusable prose linting', () => {
  it('rejects the structural Simplified Technical English faults', () => {
    assert.deepEqual(rules('The panel closes; the list reloads.'), ['semicolon']);
    assert.deepEqual(rules('Spin up the job when the row opens.'), ['phrasal-verb']);
    assert.deepEqual(rules('A seamless picker for dates.'), ['marketing-adjective']);
    assert.deepEqual(rules('Perform an analysis of the log.'), ['nominalization']);
    assert.deepEqual(rules('Shows the title and'), ['sentence-form', 'dangling-conjunction']);
    assert.deepEqual(rules('shows the title.'), ['sentence-form']);
    assert.deepEqual(rules('Shows the title.\nShows the body.'), ['line-break']);
    assert.deepEqual(rules(`Every ${Array.from({ length: MAX_SENTENCE_WORDS }, () => 'word').join(' ')}.`), ['long-sentence']);
  });

  it('says how to turn a bare path or a lowercase id label into a sentence', () => {
    assert.match(lintProse('packages/ui/src/button.tsx')[0].message, /names a file but does not say what it holds\. Fix: write a sentence, such as "`packages\/ui\/src\/button\.tsx` renders it\.", or record the path in implementationTargets\./);
    assert.match(lintProse('starting: only feed sessions dispatch it.')[0].message, /starts with the id "starting" outside backticks\. Fix: write it as "`starting`: …"/);
    assert.deepEqual(lintProse('`starting`: Only feed sessions dispatch it.'), []);
  });

  it('reports passive voice and compound tenses as advisories, and never flags hedges', () => {
    assert.deepEqual(lintProse('The file is deleted by the host.').map(issue => [issue.rule, issue.level]), [['passive-voice', 'advisory']]);
    assert.deepEqual(lintProse('The job has finished.').map(issue => [issue.rule, issue.level]), [['present-perfect', 'advisory']]);
    assert.deepEqual(lintProse('The request may have failed. It could be a timeout. The disk might have filled.'), []);
    assert.deepEqual(lintProse("The task couldn't have run."), []);
  });

  it('ignores inline code and does not end sentences at abbreviations', () => {
    assert.deepEqual(lintProse('Set `gap: 4px; padding: 0` on the root.'), []);
    const twenty = Array.from({ length: 20 }, () => 'word').join(' ');
    assert.deepEqual(rules(`Compare A vs. B in the ${twenty} test.`), ['long-sentence']);
    assert.deepEqual(rules(`It ships in the U.S. Then ${twenty} today.`), []);
  });

  it('flags a second word for the same action across one reusable', () => {
    const issues = lintSynonymRotation(['Shows the title.', 'Displays the body.', 'Shows the footer.']);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].textIndex, 1);
    assert.match(issues[0].message, /"display" where other text on this reusable uses "show"/);
    assert.deepEqual(lintSynonymRotation(['Shows the title.', 'Shows the body.']), []);
  });
});

describe('Blueprint primitive text', () => {
  it('covers every primitive in the set and passes the prose rules', () => {
    assert.deepEqual(Object.keys(BASE_PRIMITIVE_TEXT).sort(), BASE_PRIMITIVE_CONTRACT.map(entry => entry.id).sort());
    for (const [id, text] of Object.entries(BASE_PRIMITIVE_TEXT)) {
      const prose = [
        text.description,
        text.accessibility,
        ...text.notes,
        ...[text.variants, text.sizes, text.states, text.slots].flatMap(entries => Object.values(entries).map(entry => entry.description))
      ];
      for (const line of prose) {
        assert.deepEqual(lintProse(line).filter(issue => issue.level === 'error'), [], `${id}: "${line}"`);
      }
    }
  });

  it('is what the starter and every fixture carry, word for word', async () => {
    for (const root of [starterRoot, ...fixtureRoots]) {
      const bundle = await loadProjectFromFs(root);
      for (const primitive of bundle.primitives.primitives) {
        const text = BASE_PRIMITIVE_TEXT[primitive.id];
        assert.ok(text, `${root} ${primitive.id} is a Blueprint primitive`);
        assert.equal(primitive.description, text.description, `${root} ${primitive.id}.description`);
        assert.equal(primitive.accessibility, text.accessibility, `${root} ${primitive.id}.accessibility`);
        assert.deepEqual(primitive.notes, text.notes, `${root} ${primitive.id}.notes`);
        for (const key of ['variants', 'sizes', 'states'] as const) {
          for (const value of primitive[key].values.filter(candidate => text[key][candidate.id])) {
            assert.deepEqual({ name: value.name, description: value.description }, text[key][value.id], `${root} ${primitive.id}.${key}.${value.id}`);
          }
        }
      }
    }
  });

  it('leaves no prose errors in the starter or fixtures, including the text apps write', async () => {
    for (const root of [starterRoot, ...fixtureRoots]) {
      const bundle = await loadProjectFromFs(root);
      for (const reusable of [...bundle.primitives.primitives, ...bundle.components.components]) {
        for (const field of reusableProseFields(reusable)) {
          assert.deepEqual(lintProse(field.text).filter(issue => issue.level === 'error'), [], `${root} ${reusable.id}.${field.path}: "${field.text}"`);
        }
      }
    }
  });
});

describe('reusable prose validation', () => {
  it('rejects app prose that breaks a rule, with the fix', async () => {
    const bundle = structuredClone(await loadProjectFromFs(starterRoot));
    const cluster = requireComponent(bundle, 'action-cluster');
    cluster.description = 'Groups the closing actions; primary first.';
    cluster.states.values[0].description = 'A robust resting state.';
    bundle.components.groups[0].description = 'actions that close a region';

    const errors = validateProject(bundle).errors;
    assert.ok(errors.includes('component.action-cluster.description has a semicolon. Fix: split it into two sentences.'), errors.join('\n'));
    assert.ok(errors.some(error => error.startsWith(`component.action-cluster.states.${cluster.states.values[0].id}.description uses the marketing word "robust".`)), errors.join('\n'));
    assert.ok(errors.some(error => error.startsWith('components.group.actions.description is not written as sentences.')), errors.join('\n'));
  });

  it('rejects edits to Blueprint primitive text and says how to restore it', async () => {
    const bundle = structuredClone(await loadProjectFromFs(starterRoot));
    const button = requirePrimitive(bundle, 'button');
    button.description = 'Our button.';
    button.notes = ['Use it for the checkout flow.'];
    button.variants.values[0].description = 'The main action.';

    const errors = validateProject(bundle).errors;
    assert.ok(errors.some(error => error.startsWith(`primitive.button.description is not Blueprint's text. Fix: set it to "${BASE_PRIMITIVE_TEXT.button.description}", or run the migrate tool`)), errors.join('\n'));
    assert.ok(errors.some(error => /^primitive\.button\.notes are not Blueprint's notes\. Fix: .* move app guidance to implementationHints/.test(error)), errors.join('\n'));
    assert.ok(errors.some(error => error.startsWith('primitive.button.variants.primary.description is not Blueprint\'s text.')), errors.join('\n'));
  });

  it('lints the values and slots an app adds to a Blueprint primitive', async () => {
    const bundle = structuredClone(await loadProjectFromFs(starterRoot));
    requirePrimitive(bundle, 'card').variants.values.push({ id: 'flagged', name: 'Flagged', description: 'Marks a card; it needs attention.' });

    assert.ok(validateProject(bundle).errors.includes('primitive.card.variants.flagged.description has a semicolon. Fix: split it into two sentences.'));
  });

  it('rejects a placeholder description once an axis has more than one value', async () => {
    const bundle = structuredClone(await loadProjectFromFs(starterRoot));
    const cluster = requireComponent(bundle, 'action-cluster');
    cluster.sizes.values.push({ id: 'sm', name: 'Small', description: 'Dense toolbars.' });

    assert.ok(validateProject(bundle).errors.some(error => error.startsWith(`component.action-cluster.sizes.default.description says "${cluster.sizes.values[0].description}", but component.action-cluster.sizes has 2 values.`)));
  });

  it('returns wording advisories without failing validation', async () => {
    const bundle = structuredClone(await loadProjectFromFs(starterRoot));
    const cluster = requireComponent(bundle, 'action-cluster');
    cluster.description = 'Groups the actions that close a region. They are ordered by the host.';
    cluster.accessibility = 'A group of buttons that displays them in order.';
    cluster.uses[0].reason = 'Shows each action.';

    assert.equal(validateProject(bundle).ok, true, validateProject(bundle).errors.join('\n'));
    const advisories = collectProseAdvisories(bundle).filter(advisory => advisory.localId === 'action-cluster');
    assert.deepEqual(advisories.map(advisory => [advisory.field, advisory.rule]), [
      ['description', 'passive-voice'],
      ['accessibility', 'synonym-rotation']
    ]);
    assert.equal(advisories[0].boundaryId, 'starter-app/component/action-cluster');
  });
});

function requirePrimitive(bundle: BlueprintProjectBundle, id: string) {
  const primitive = bundle.primitives.primitives.find(candidate => candidate.id === id);
  assert.ok(primitive, `expected primitive ${id}`);
  return primitive;
}

function requireComponent(bundle: BlueprintProjectBundle, id: string) {
  const component = bundle.components.components.find(candidate => candidate.id === id);
  assert.ok(component, `expected component ${id}`);
  return component;
}

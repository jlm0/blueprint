import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lintHandBuiltControls } from '../src/core/control-lint';
import { loadProjectFromFs } from '../src/core/load';
import { createReadinessReport, validateProject } from '../src/prototype/validate-project';

const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';
const brokenRoot = 'fixtures/invalid/broken/design/blueprint';
const screenSource = 'prototype/screens/transactions.html';

describe('hand-built control lint', () => {
  it('reports native controls that duplicate a canonical primitive in screen source', async () => {
    const issues = lintHandBuiltControls(await loadProjectFromFs(brokenRoot));
    assert.deepEqual(
      issues.map(issue => [issue.boundary, issue.sourceRef, issue.line, issue.element, issue.primitiveId]),
      [['screen.hand-built-control', 'prototype/screens/hand-built-control.html', 4, 'button', 'button']]
    );
  });

  it('maps native elements and input types to their base primitives and honors the native opt-out', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    assert.deepEqual(lintHandBuiltControls(bundle), []);
    bundle.prototypeSourceContents[screenSource] = bundle.prototypeSourceContents[screenSource].replace('</main>', `
  <input type="checkbox" /><input type="radio" /><input type="range" /><input type="email" /><input type="hidden" />
  <select></select><textarea></textarea><input type="submit" />
  <button type="button" data-blueprint-native="Full-row hit target wraps composed content">Row</button>
</main>`);
    assert.deepEqual(
      lintHandBuiltControls(bundle).map(issue => `${issue.element}:${issue.primitiveId}`),
      ['input:checkbox', 'input:radio', 'input:slider', 'input:input', 'select:select', 'textarea:textarea', 'input:button']
    );
    const withoutTextarea = { ...bundle, primitives: { ...bundle.primitives, primitives: bundle.primitives.primitives.filter(primitive => primitive.id !== 'textarea') } };
    assert.ok(lintHandBuiltControls(withoutTextarea).some(issue => issue.element === 'textarea' && issue.primitiveId === 'input'));

    const strict = validateProject(bundle, { mode: 'strict' });
    assert.match(
      strict.errors.join('\n'),
      /screen\.transactions prototype\/screens\/transactions\.html:\d+ hand-builds a native <select>; use <blueprint-use kind="primitive" ref="select">/
    );
    assert.equal(createReadinessReport(bundle).tier, 'blocked');
  });

  it('reads a control past a greater-than sign in a value, and not inside a comment', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    const original = bundle.prototypeSourceContents[screenSource];
    const lint = (markup: string): string[] => {
      bundle.prototypeSourceContents[screenSource] = original.replace('</main>', `${markup}</main>`);
      return lintHandBuiltControls(bundle).map(issue => `${issue.element}:${issue.primitiveId}`);
    };

    assert.deepEqual(lint('<button title="a>b">Row</button>'), ['button:button']);
    assert.deepEqual(lint('<input title="a>b" type="checkbox">'), ['input:checkbox']);
    assert.deepEqual(lint('<button title="a>b" data-blueprint-native="Full-row hit target">Row</button>'), []);
    assert.deepEqual(lint('<!-- <button>Row</button> -->'), []);
    assert.deepEqual(lint('<!-- <input type="checkbox"> --><textarea><select></textarea>'), ['textarea:textarea']);
    assert.deepEqual(lint('<input data-type="hidden">'), ['input:input']);
  });

  it('does not report controls rendered by canonical primitive sources', async () => {
    const bundle = await loadProjectFromFs(meridianRoot);
    const button = bundle.primitives.primitives.find(primitive => primitive.id === 'button');
    assert.ok(button?.prototype);
    assert.match(bundle.prototypeSourceContents[button.prototype.source], /<button\b/);
    assert.deepEqual(lintHandBuiltControls(bundle), []);
  });
});

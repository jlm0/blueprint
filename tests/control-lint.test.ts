import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lintHandBuiltControls } from '../src/core/control-lint';
import { loadProjectFromFs } from '../src/core/load';
import { createReadinessReport, validateProject } from '../src/core/validate';

const denseRoot = 'fixtures/app-owned/dense-ops/design/blueprint';
const stillRoot = 'fixtures/app-owned/still-meditation/design/blueprint';
const screenSource = 'prototype/screens/service-health.html';

describe('hand-built control lint', () => {
  it('reports native controls that duplicate a canonical primitive in screen source', async () => {
    const issues = lintHandBuiltControls(await loadProjectFromFs(stillRoot));
    assert.deepEqual(
      issues.map(issue => [issue.boundary, issue.sourceRef, issue.line, issue.element, issue.primitiveId]),
      [
        ['screen.home', 'prototype/screens/home.html', 17, 'button', 'button'],
        ['screen.home', 'prototype/screens/home.html', 96, 'button', 'button']
      ]
    );
  });

  it('maps native elements and input types to their base primitives and honors the native opt-out', async () => {
    const bundle = await loadProjectFromFs(denseRoot);
    assert.deepEqual(lintHandBuiltControls(bundle), []);
    bundle.prototypeSourceContents[screenSource] = bundle.prototypeSourceContents[screenSource].replace('</main>', `
  <input type="checkbox" /><input type="radio" /><input type="range" /><input type="email" /><input type="hidden" />
  <select></select><textarea></textarea><input type="submit" />
  <button type="button" data-blueprint-native="Full-row hit target wraps composed content">Row</button>
</main>`);
    assert.deepEqual(
      lintHandBuiltControls(bundle).map(issue => `${issue.element}:${issue.primitiveId}`),
      ['input:checkbox', 'input:radio', 'input:slider', 'input:input', 'select:select', 'textarea:input', 'input:button']
    );

    const strict = validateProject(bundle, { mode: 'strict' });
    assert.match(
      strict.errors.join('\n'),
      /screen\.service-health prototype\/screens\/service-health\.html:\d+ hand-builds a native <select>; use <blueprint-use kind="primitive" ref="select">/
    );
    assert.equal(createReadinessReport(bundle).tier, 'blocked');
  });

  it('does not report controls rendered by canonical primitive sources', async () => {
    const bundle = await loadProjectFromFs(denseRoot);
    const button = bundle.primitives.primitives.find(primitive => primitive.id === 'button');
    assert.ok(button?.prototype);
    assert.match(bundle.prototypeSourceContents[button.prototype.source], /<button\b/);
    assert.deepEqual(lintHandBuiltControls(bundle), []);
  });
});

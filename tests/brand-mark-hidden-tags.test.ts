import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { brandMarkSourceIssues } from '../src/core/brand-lint';

describe('brand mark source', () => {
  const hide = (element: string): string => `<svg viewBox="0 0 1 1"></x a="><p a='">'${element}</svg>`;

  it('refuses a blocked element that a browser can read where the tokenizer reads an attribute', () => {
    for (const element of ['<script>alert(1)</script>', '<foreignObject></foreignObject>', '<image></image>', '<style></style>', '<blueprint-use></blueprint-use>']) {
      assert.ok(brandMarkSourceIssues(hide(element)).some(issue => issue.includes('self-contained')), element);
    }
  });

  it('reports a mark with too many unclosed tags, in place of a raw error', () => {
    const issues = brandMarkSourceIssues(`<svg viewBox="0 0 1 1">${'<a '.repeat(200_000)}>`);
    assert.ok(issues.some(issue => /too many unclosed tags.*Fix: close each tag/s.test(issue)), issues.join('|'));
  });
});

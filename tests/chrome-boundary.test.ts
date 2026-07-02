import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const chromeTokenPrefix = '--bp-chrome-';
const sampleTokenPrefix = '--bp-sample-';
const inheritedGlobalProperties = ['color-scheme', 'font-family', 'background', 'color'];

describe('Blueprint quiet chrome boundary', () => {
  it('keeps host chrome tokens explicitly namespaced and out of legacy root aliases', async () => {
    const css = await readFile('src/app/styles.css', 'utf8');
    const rootBlock = blockBody(css, ':root');
    const customProperties = [...rootBlock.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(match => match[1] ?? '');
    const unnamespaced = customProperties.filter(name => !name.startsWith(chromeTokenPrefix));

    assert.ok(customProperties.includes('--bp-chrome-canvas-bg'), 'root should define the Blueprint chrome canvas token');
    assert.deepEqual(unnamespaced, [], `root custom properties must be chrome-namespaced: ${unnamespaced.join(', ')}`);
    assert.doesNotMatch(css, /var\(--(?:canvas-bg|grid-dot|chip-bg|fg|muted-fg|surface-\d+|border|primary|primary-fg|secondary|destructive|success|warning|r-(?:sm|md|lg|xl|2xl))\)/);
  });

  it('moves inherited browser-global styling out of root, universal, and generic button selectors', async () => {
    const css = await readFile('src/app/styles.css', 'utf8');
    const rootBlock = blockBody(css, ':root');

    for (const property of inheritedGlobalProperties) {
      assert.doesNotMatch(rootBlock, new RegExp(`(^|\\n)\\s*${property}\\s*:`, 'i'), `:root must not carry inherited ${property}`);
    }

    assert.doesNotMatch(css, /(^|\n)\s*\*\s*\{/m, 'unscoped universal reset can leak into app samples');
    assert.doesNotMatch(css, /(^|\n)\s*button\s*\{/m, 'generic button rule can leak into app samples');
    assert.match(css, /\.bp-chrome-shell\b/, 'host chrome should expose a namespaced shell class');
    assert.match(css, /\.bp-chrome-board-switcher\b/, 'board switcher should expose a namespaced chrome class');
  });

  it('confines chrome-only token references to explicitly chrome-scoped rules', async () => {
    const css = await readFile('src/app/styles.css', 'utf8');
    const rules = ruleBlocks(css);
    const chromeTokenReferences = rules.filter(rule => rule.body.includes(`var(${chromeTokenPrefix}`));
    const leaks = chromeTokenReferences.filter(rule => !isChromeScopedRule(rule.selector));

    assert.deepEqual(
      leaks.map(rule => rule.selector),
      [],
      'chrome-only tokens must not be referenced by app-sample or generic rules'
    );
    assert.ok(
      rules.some(rule => rule.body.includes(sampleTokenPrefix)),
      'protected sample blocks should use sample-scoped fallback tokens where reusable styling is needed'
    );
  });
});

function blockBody(css: string, selector: string): string {
  const match = new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(css);
  assert.ok(match, `Missing CSS block for ${selector}`);
  return match[1] ?? '';
}

function ruleBlocks(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  const expression = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(expression)) {
    rules.push({
      selector: (match[1] ?? '').trim(),
      body: match[2] ?? ''
    });
  }
  return rules;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isChromeScopedRule(selector: string): boolean {
  return selector
    .split(',')
    .map(part => part.trim())
    .every(part => part === 'body' || part.startsWith('.bp-chrome-'));
}

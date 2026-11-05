import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type Browser, chromium } from 'playwright';
import { createElementIndex } from '../../src/app/frame-output';
import { listCssOutputItems } from '../../src/core/css';
import { loadProjectFromFs } from '../../src/core/load';
import { createPrototypeDocumentCompiler } from '../../src/prototype/compiler';

const projects = [
  'starter/design/blueprint',
  ...readdirSync('fixtures/valid').map(name => path.join('fixtures/valid', name, 'design/blueprint'))
];

/** The rule check ignores each pseudo-class and each pseudo-element, so the browser must test the selector without them. */
function withoutIgnoredPseudos(selector: string): string {
  return selector.replace(/::?(?!is\b|where\b)[a-zA-Z-]+(\((?:[^()]|\([^()]*\))*\))?/g, '').trim();
}

describe('Blueprint rule check against the browser', () => {
  let browser: Browser;
  let dead = 0;
  let live = 0;

  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  for (const projectPath of projects) {
    it(`calls no rule of ${projectPath} dead that the browser can match`, async () => {
      const bundle = await loadProjectFromFs(projectPath);
      const compile = createPrototypeDocumentCompiler(bundle);
      const page = await browser.newPage();
      await page.addInitScript({ content: 'globalThis.__name = target => target;' });
      try {
        for (const screen of bundle.screens.screens) {
          for (const state of screen.prototype.states) {
            const output = compile({ target: { kind: 'screen', id: screen.id }, state });
            const { canMatch } = createElementIndex(output.body, output.state);
            const deadSelectors = output.sheets.flatMap(sheet => (listCssOutputItems(sheet) ?? []).flatMap(item => {
              if (!item.selectors) return [];
              live += item.selectors.filter(canMatch).length;
              return item.selectors.filter(selector => !canMatch(selector)).map(selector => selector.text);
            }));
            dead += deadSelectors.length;
            await page.setContent(output.html);
            const matched = await page.evaluate(selectors => selectors.filter(selector => {
              try {
                return selector !== '' && document.querySelector(selector) !== null;
              } catch {
                return false;
              }
            }), [...new Set(deadSelectors.map(withoutIgnoredPseudos))]);
            assert.deepEqual(matched, [], `The rule check calls these selectors dead on screen ${screen.id} in state ${state}.`);
          }
        }
      } finally {
        await page.close();
      }
    });
  }

  for (const [markup, selector] of [
    ['<table><tr><td>Cell</td></tr></table>', 'tbody'],
    ['<table><td>Cell</td></table>', 'tr'],
    ['<table><col></table>', 'colgroup'],
    ['<image src="a.png" alt="">', 'img'],
    ['<p data-tone="one" data-tone="two">Text</p>', '[data-tone="one"]']
  ] as const) {
    it(`calls ${selector} live in ${markup}, as the browser does`, async () => {
      const page = await browser.newPage();
      try {
        await page.setContent(markup);
        assert.equal(await page.evaluate(wanted => document.querySelector(wanted) !== null, selector), true, 'The browser must match this selector, or the row proves nothing.');
      } finally {
        await page.close();
      }
      const [item] = listCssOutputItems(`${selector} { color: red; }`) ?? [];
      assert.equal(createElementIndex(markup, 'default').canMatch(item.selectors![0]), true);
    });
  }

  it('calls some rules dead and some rules live', () => {
    assert.ok(dead > 0, 'The rule check calls no rule dead, so it prunes nothing.');
    assert.ok(live > 0, 'The rule check calls each rule dead.');
  });
});

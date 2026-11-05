import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { loadProjectFromFs } from '../../src/core/load';
import { normalizeLiteralValues } from '../../src/core/migrate-values';
import { compilePrototypeDocument } from '../../src/prototype/compiler';
import { withProjectCopy } from '../support/project-copies';

const MERIDIAN = 'fixtures/valid/meridian-finance/design/blueprint';
const SHEET = 'prototype/screens/home.css';
const SOURCE = 'prototype/screens/home.html';

async function readTextFiles(root: string, directory = ''): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [file, text] of await readTextFiles(root, relative)) files.set(file, text);
    } else if (/\.(json|html|css)$/.test(entry.name)) {
      files.set(relative, await readFile(path.join(root, relative), 'utf8'));
    }
  }
  return files;
}

describe('the value repairs of migrate keep the compiled look', () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch();
  });
  after(async () => {
    await browser.close();
  });

  async function read(project: string, probes: Record<string, string[]>): Promise<Record<string, string>> {
    const bundle = await loadProjectFromFs(project);
    const { html } = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'home' } });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const values = await page.evaluate(wanted => {
      const found: Record<string, string> = {};
      for (const [selector, properties] of Object.entries(wanted)) {
        const style = getComputedStyle(document.querySelector(selector)!);
        for (const property of properties) found[`${selector} ${property}`] = style.getPropertyValue(property);
      }
      return found;
    }, probes);
    await page.close();
    return values;
  }

  it('reads the same computed value for a whole color, a shorthand, a gradient, a shadow, a size, a length, and an svg paint', async () => {
    await withProjectCopy(async project => {
      const tokens = JSON.parse(await readFile(path.join(project, 'tokens.json'), 'utf8')).tokenGroups.flatMap((group: { tokens: unknown[] }) => group.tokens) as Array<{ type: string; value: string; styleRef: string }>;
      const sole = (type: string, form: RegExp): { value: string; styleRef: string }[] => tokens.filter(token => token.type === type && form.test(token.value) && tokens.filter(other => other.type === type && other.value.toLowerCase() === token.value.toLowerCase()).length === 1);
      const [ink, line] = sole('color', /^#[0-9a-f]{6}$/i);
      const space = sole('space', /^[1-9]\d*px$/)[0];
      const radius = sole('radius', /^[1-9]\d*px$/)[0];
      const size = sole('typography', /^\d+(?:\.\d+)?px$/)[0];
      const css = await readFile(path.join(project, SHEET), 'utf8');
      await writeFile(path.join(project, SHEET), `${css}
[data-blueprint-screen="home"] .home__probe-color { color: ${ink.value}; }
[data-blueprint-screen="home"] .home__probe-border { border: 1px solid ${line.value}; }
[data-blueprint-screen="home"] .home__probe-gradient { background-image: linear-gradient(90deg, ${ink.value} 0%, ${line.value} 100%); }
[data-blueprint-screen="home"] .home__probe-shadow { box-shadow: 0 0 1px ${ink.value}; }
[data-blueprint-screen="home"] .home__probe-size { font-size: ${size.value}; padding: ${space.value} 7px; border-radius: ${radius.value}; }
`);
      const html = await readFile(path.join(project, SOURCE), 'utf8');
      const probe = `<i class="home__probe-color"></i><i class="home__probe-border"></i><i class="home__probe-gradient"></i><i class="home__probe-shadow"></i><i class="home__probe-size"></i><svg class="home__probe-svg"><rect class="home__probe-rect" fill="${ink.value}" stroke="${line.value}"/><linearGradient><stop class="home__probe-stop" stop-color="${line.value}"/></linearGradient></svg>`;
      const closing = html.lastIndexOf('</');
      await writeFile(path.join(project, SOURCE), `${html.slice(0, closing)}${probe}${html.slice(closing)}`);

      const probes = {
        '.home__probe-color': ['color'],
        '.home__probe-border': ['border-top-color', 'border-left-width', 'border-top-style'],
        '.home__probe-gradient': ['background-image'],
        '.home__probe-shadow': ['box-shadow'],
        '.home__probe-size': ['font-size', 'padding-top', 'padding-right', 'border-top-left-radius'],
        '.home__probe-rect': ['fill', 'stroke'],
        '.home__probe-stop': ['stop-color']
      };
      const literal = await read(project, probes);

      const writes = new Map<string, string>();
      const changes: string[] = [];
      normalizeLiteralValues(await readTextFiles(project), writes, changes);
      assert.deepEqual(changes.map(line => line.split(' to var')[0].replace(/\d+/g, 'N')), [
        'Rewrote N SVG paint attributes in N source',
        'Rewrote N literal colors in N stylesheet',
        'Rewrote N raw font size in N stylesheet',
        'Rewrote N restated lengths in N stylesheet'
      ]);
      for (const [file, text] of writes) await writeFile(path.join(project, file), text);
      const repairedCss = writes.get(SHEET)!;
      assert.ok(repairedCss.includes(`linear-gradient(90deg, var(${ink.styleRef}) 0%, var(${line.styleRef}) 100%)`), 'the gradient reads the tokens');
      assert.ok(repairedCss.includes(`border: 1px solid var(${line.styleRef})`), 'the shorthand reads the token');
      assert.ok(repairedCss.includes(`padding: var(${space.styleRef}) 7px`), 'the length reads the token');
      assert.ok(writes.get(SOURCE)!.includes(`stop-color="var(${line.styleRef})"`), 'the svg paint reads the token');

      assert.deepEqual(await read(project, probes), literal);
    }, MERIDIAN);
  });
});

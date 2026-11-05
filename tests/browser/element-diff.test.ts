import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Browser, chromium, type Page } from 'playwright';
import { build, type Rollup } from 'vite';
import { PAINT_ROWS } from './element-diff-rows';

const WIDTH = 240;
const HEIGHT = 160;

function documentWith(css: string, body = '<p class="a">Text</p>'): string {
  return `<!doctype html><html><head><style>body { margin: 0; } ${css}</style></head><body>${body}</body></html>`;
}

const LIST = '<ul class="a"><li>Text</li></ul>';
const FIELD = '<input class="a" placeholder="Text">';
const BOX = '<div class="a" style="width: 80px; height: 80px; background: rgb(200, 0, 0);"><span style="position: absolute; left: 4px; top: 4px; width: 20px; height: 20px; background: rgb(0, 0, 200);"></span></div>';
const OVERLAP = '<div style="position: relative; height: 80px;"><div class="a" style="position: absolute; inset: 0; background: rgb(200, 0, 0);"></div><div style="position: absolute; inset: 0; z-index: 1; background: rgb(0, 0, 200);"></div></div>';
const IMAGE = '<img class="a" alt="" width="80" height="40" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==" style="background: rgb(220, 220, 220);">';
const ART = (attributes: string): string => `<svg width="80" height="80" viewBox="0 0 80 80"><defs><linearGradient id="g"><stop class="b" offset="0"/><stop offset="1" stop-color="white"/></linearGradient></defs><rect class="a" x="10" y="10" width="60" height="60" fill="url(#g)" stroke="black" ${attributes}/></svg>`;
const BACKGROUND = 'width: 120px; height: 80px; background-image: linear-gradient(red, blue); background-size: 40px 40px; background-repeat: no-repeat;';

const PAINTS: ReadonlyArray<{ name: string; before: string; after: string; body?: string }> = [
  { name: 'a radius on a background', before: '.a { border-radius: 0; height: 40px; background: red; }', after: '.a { border-radius: 20px; height: 40px; background: red; }', body: '<div class="a"></div>' },
  { name: 'a radius on a line', before: '.a { border-radius: 0; height: 40px; border: 2px solid red; }', after: '.a { border-radius: 20px; height: 40px; border: 2px solid red; }', body: '<div class="a"></div>' },
  { name: 'a radius that clips a child', before: '.a { border-radius: 0; overflow: hidden; height: 40px; } .a div { height: 40px; background: red; }', after: '.a { border-radius: 20px; overflow: hidden; height: 40px; } .a div { height: 40px; background: red; }', body: '<div class="a"><div></div></div>' },
  { name: 'a visible child of a hidden element', before: '.a { visibility: hidden; } .a span { visibility: visible; color: black; }', after: '.a { visibility: hidden; } .a span { visibility: visible; color: red; }', body: '<p class="a"><span>Text</span></p>' },
  { name: 'an element that stops being hidden', before: '.a { display: none; height: 40px; background: red; }', after: '.a { height: 40px; background: red; }', body: '<div class="a"></div>' },
  { name: 'an element that stops being transparent', before: '.a { opacity: 0; height: 40px; background: red; }', after: '.a { opacity: 1; height: 40px; background: red; }', body: '<div class="a"></div>' },
  { name: 'a child of an element that fades in', before: '@keyframes fade { from { opacity: 0; } to { opacity: 1; } } .a { animation: fade 1s forwards; } .a span { color: black; }', after: '@keyframes fade { from { opacity: 0; } to { opacity: 1; } } .a { animation: fade 1s forwards; } .a span { color: red; }', body: '<p class="a"><span>Text</span></p>' },
  { name: 'text-shadow', before: '.a { text-shadow: none; }', after: '.a { text-shadow: 2px 2px 0 red; }' },
  { name: 'letter-spacing', before: '.a { letter-spacing: normal; display: inline-block; width: 200px; }', after: '.a { letter-spacing: 2px; display: inline-block; width: 200px; }' },
  { name: 'word-spacing', before: '.a { word-spacing: normal; width: 200px; }', after: '.a { word-spacing: 12px; width: 200px; }', body: '<p class="a">Two words</p>' },
  { name: 'text-transform', before: '.a { text-transform: none; width: 200px; }', after: '.a { text-transform: uppercase; width: 200px; }' },
  { name: 'text-indent', before: '.a { text-indent: 0; width: 200px; }', after: '.a { text-indent: 12px; width: 200px; }' },
  { name: 'text-align', before: '.a { text-align: left; width: 200px; }', after: '.a { text-align: right; width: 200px; }' },
  { name: 'font-variant', before: '.a { font-variant: normal; width: 200px; }', after: '.a { font-variant: small-caps; width: 200px; }' },
  { name: '-webkit-text-fill-color', before: '.a { -webkit-text-fill-color: black; }', after: '.a { -webkit-text-fill-color: red; }' },
  { name: '-webkit-text-stroke', before: '.a { -webkit-text-stroke: 0 red; }', after: '.a { -webkit-text-stroke: 1px red; }' },
  { name: 'clip-path', before: `.a { position: relative; clip-path: none; }`, after: `.a { position: relative; clip-path: inset(0 40px 0 0); }`, body: BOX },
  { name: 'mask-image', before: '.a { position: relative; }', after: '.a { position: relative; mask-image: linear-gradient(transparent, black); }', body: BOX },
  { name: 'backdrop-filter', before: '.a { position: absolute; inset: 0; }', after: '.a { position: absolute; inset: 0; backdrop-filter: invert(1); }', body: '<div style="width: 80px; height: 80px; background: rgb(200, 0, 0);"></div><div class="a"></div>' },
  { name: 'mix-blend-mode', before: '.a { position: relative; }', after: '.a { position: relative; mix-blend-mode: difference; }', body: `<div style="background: rgb(0, 200, 0);">${BOX}</div>` },
  { name: 'object-fit', before: '.a { object-fit: fill; }', after: '.a { object-fit: none; }', body: IMAGE },
  { name: 'object-position', before: '.a { object-fit: contain; object-position: 0 0; }', after: '.a { object-fit: contain; object-position: 100% 0; }', body: IMAGE },
  { name: 'background-position', before: `.a { ${BACKGROUND} background-position: 0 0; }`, after: `.a { ${BACKGROUND} background-position: 40px 0; }`, body: '<div class="a"></div>' },
  { name: 'background-size', before: `.a { ${BACKGROUND} }`, after: `.a { ${BACKGROUND} background-size: 80px 40px; }`, body: '<div class="a"></div>' },
  { name: 'background-repeat', before: `.a { ${BACKGROUND} }`, after: `.a { ${BACKGROUND} background-repeat: repeat; }`, body: '<div class="a"></div>' },
  { name: 'translate', before: '.a { position: relative; translate: none; }', after: '.a { position: relative; translate: 10px 0; }', body: BOX },
  { name: 'rotate', before: '.a { position: relative; rotate: none; }', after: '.a { position: relative; rotate: 10deg; }', body: BOX },
  { name: 'scale', before: '.a { position: relative; scale: none; }', after: '.a { position: relative; scale: 0.5; }', body: BOX },
  { name: 'z-index', before: '.a { z-index: 0; }', after: '.a { z-index: 2; }', body: OVERLAP },
  { name: 'overflow', before: '.a { position: relative; overflow: visible; width: 10px; height: 10px; }', after: '.a { position: relative; overflow: hidden; width: 10px; height: 10px; }', body: '<div class="a" style="background: rgb(200, 0, 0);"><span style="display: block; width: 40px; height: 40px; background: rgb(0, 0, 200);"></span></div>' },
  { name: 'outline-offset', before: '.a { outline: 1px solid red; outline-offset: 0; margin: 20px; width: 40px; height: 40px; }', after: '.a { outline: 1px solid red; outline-offset: 6px; margin: 20px; width: 40px; height: 40px; }', body: '<div class="a"></div>' },
  { name: 'accent-color', before: '.a { accent-color: auto; }', after: '.a { accent-color: rgb(200, 0, 0); }', body: '<input class="a" type="checkbox" checked>' },
  { name: 'stroke-width', before: '.a { stroke-width: 1; }', after: '.a { stroke-width: 4; }', body: ART('') },
  { name: 'stroke-dasharray', before: '.a { stroke-dasharray: none; }', after: '.a { stroke-dasharray: 4 4; }', body: ART('') },
  { name: 'fill-opacity', before: '.a { fill-opacity: 1; }', after: '.a { fill-opacity: 0.4; }', body: ART('') },
  { name: 'stop-color', before: '.b { stop-color: black; }', after: '.b { stop-color: red; }', body: ART('') },
  { name: 'a rule on the html element', before: 'html { background: white; }', after: 'html { background: red; }' },
  { name: 'the color of a placeholder', before: '.a::placeholder { color: black; }', after: '.a::placeholder { color: red; }', body: FIELD },
  { name: 'the color of a list marker', before: '.a { margin: 0 0 0 40px; padding: 0; } .a li::marker { color: black; }', after: '.a { margin: 0 0 0 40px; padding: 0; } .a li::marker { color: red; }', body: LIST },
  { name: 'the color of a ::after part', before: '.a::after { content: "x"; color: black; }', after: '.a::after { content: "x"; color: red; }' }
];

const NO_PAINT: ReadonlyArray<{ name: string; before: string; after: string; body?: string }> = [
  { name: 'a :hover rule', before: '.a:hover { color: black; }', after: '.a:hover { color: red; }' },
  { name: 'a :focus rule', before: '.a:focus { color: black; }', after: '.a:focus { color: red; }' },
  { name: 'a color on an element with no text', before: '.a { color: black; width: 10px; height: 10px; }', after: '.a { color: red; width: 10px; height: 10px; }', body: '<div class="a"></div>' },
  { name: 'a ::before rule with no content', before: '.a::before { color: black; }', after: '.a::before { color: red; }' },
  { name: 'a rule on a hidden element', before: '.a { display: none; color: black; } .a span { color: black; }', after: '.a { display: none; color: black; } .a span { color: red; }', body: '<p class="a"><span>Text</span></p>' },
  { name: 'a background on an element with display none', before: '.a { display: none; background: white; }', after: '.a { display: none; background: red; }', body: '<div class="a"></div>' },
  { name: 'a background on an element with opacity 0', before: '.a { opacity: 0; height: 40px; background: white; } .a span { color: black; }', after: '.a { opacity: 0; height: 40px; background: red; } .a span { color: red; }', body: '<div class="a"><span>Text</span></div>' },
  { name: 'a background on an element with visibility hidden', before: '.a { visibility: hidden; height: 40px; background: white; }', after: '.a { visibility: hidden; height: 40px; background: red; }', body: '<div class="a"></div>' },
  { name: 'a radius with nothing to round', before: '.a { border-radius: 0; height: 40px; }', after: '.a { border-radius: 20px; height: 40px; }', body: '<div class="a"></div>' }
];

describe('the element diff of two documents', () => {
  let browser: Browser;
  let page: Page;
  let shot: Page;

  before(async () => {
    const built = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: 'src/app/element-diff.ts', formats: ['iife'], name: 'elementDiff', fileName: () => 'element-diff.js' }
      }
    }) as Rollup.RollupOutput | Rollup.RollupOutput[];
    const output = Array.isArray(built) ? built[0] : built;
    browser = await chromium.launch({ args: ['--disable-gpu', '--disable-lcd-text'] });
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    shot = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: output.output[0].code });
  });

  after(async () => {
    await browser?.close();
  });

  const diff = (first: string, second: string): Promise<{ changed: boolean; outlines: unknown[] }> => page.evaluate(
    ({ first: a, second: b, width, height }) => (globalThis as unknown as { elementDiff: { diffPrototypeDocuments: (a: string, b: string, w: number, h: number) => Promise<{ changed: boolean; outlines: unknown[] }> } })
      .elementDiff.diffPrototypeDocuments(a, b, width, height),
    { first, second, width: WIDTH, height: HEIGHT }
  );

  const pixels = async (html: string): Promise<string> => {
    await shot.setContent(html, { waitUntil: 'load' });
    return (await shot.screenshot({ animations: 'disabled' })).toString('base64');
  };

  for (const item of PAINTS) {
    it(`reads ${item.name}`, async () => {
      const first = documentWith(item.before, item.body);
      const second = documentWith(item.after, item.body);
      assert.notEqual(await pixels(first), await pixels(second), 'This row must paint, or it proves nothing.');
      assert.equal((await diff(first, second)).changed, true);
    });
  }

  for (const item of PAINT_ROWS) {
    it(`reads ${item.name}`, async () => {
      const first = documentWith(item.before, item.beforeBody ?? item.body);
      const second = documentWith(item.after, item.body);
      if (!item.motion) assert.notEqual(await pixels(first), await pixels(second), 'This row must paint, or it proves nothing.');
      assert.equal((await diff(first, second)).changed, true);
    });
  }

  for (const item of NO_PAINT) {
    it(`does not count ${item.name}`, async () => {
      const first = documentWith(item.before, item.body);
      const second = documentWith(item.after, item.body);
      assert.equal(await pixels(first), await pixels(second), 'This row must not paint, or it proves nothing.');
      assert.deepEqual(await diff(first, second), { changed: false, outlines: [] });
    });
  }

  const CORNER = 'position: absolute; width: 40px; height: 40px; background: red;';

  it('outlines the place that a box leaves and the place that it reaches', async () => {
    const body = '<div class="a"></div>';
    const result = await diff(documentWith(`.a { ${CORNER} left: 10px; top: 10px; }`, body), documentWith(`.a { ${CORNER} left: 120px; top: 100px; }`, body));
    assert.deepEqual(result, { changed: true, outlines: [{ left: 10, top: 10, right: 50, bottom: 50 }, { left: 120, top: 100, right: 160, bottom: 140 }] });
  });

  it('outlines the old box of a box that shrinks', async () => {
    const body = '<div class="a"></div>';
    const result = await diff(documentWith(`.a { ${CORNER} left: 10px; top: 10px; width: 100px; height: 100px; }`, body), documentWith(`.a { ${CORNER} left: 10px; top: 10px; }`, body));
    assert.deepEqual(result, { changed: true, outlines: [{ left: 10, top: 10, right: 110, bottom: 110 }] });
  });

  it('outlines the old box of an element that stops painting', async () => {
    const body = '<div class="a"></div>';
    const result = await diff(documentWith(`.a { ${CORNER} left: 10px; top: 10px; }`, body), documentWith(`.a { ${CORNER} left: 10px; top: 10px; display: none; }`, body));
    assert.deepEqual(result, { changed: true, outlines: [{ left: 10, top: 10, right: 50, bottom: 50 }] });
  });

  it('answers changed when a document never finishes its load', { timeout: 30_000 }, async () => {
    await page.route('**/never-answers.png', () => undefined);
    const hanging = documentWith('', '<img src="https://blueprint.invalid/never-answers.png" alt="">');
    assert.deepEqual(await diff(documentWith(''), hanging), { changed: true, outlines: [] });
  });

  it('answers changed with no outline for an element that fills the frame', async () => {
    const whole = '.a { position: fixed; inset: 0; background: ';
    const result = await diff(documentWith(`${whole}white; }`, '<div class="a"></div>'), documentWith(`${whole}red; }`, '<div class="a"></div>'));
    assert.deepEqual(result, { changed: true, outlines: [] });
  });
});

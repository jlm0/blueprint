import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Browser, chromium, type Page } from 'playwright';
import { build, type Rollup } from 'vite';
import { loadProjectFromFs } from '../../src/core/load';
import { compilePrototypeDocument } from '../../src/prototype/compiler';
import { PROTOTYPE_ASSET_PATH_PREFIX } from '../../src/prototype/host-policy';

const ORIGIN = 'http://thumbnail.test';
const WIDTH = 240;
const HEIGHT = 320;
const SHA = 'a'.repeat(64);
const SMALL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; img-src data: ${ORIGIN}${PROTOTYPE_ASSET_PATH_PREFIX}; font-src data: ${ORIGIN}${PROTOTYPE_ASSET_PATH_PREFIX}; style-src 'unsafe-inline'">`;

function documentWith(css: string, body = ''): string {
  return `<!doctype html><html><head>${CSP}<style>${css}</style></head><body>${body}</body></html>`;
}

const FULL = 'width: 100%; height: 100vh;';
const ROWS: ReadonlyArray<{ name: string; html: string }> = [
  { name: 'a plain frame', html: documentWith(`body { margin: 0; background: #fff; } .a { ${FULL} background: #be123c; }`, '<div class="a"></div>') },
  { name: 'a token on the root', html: documentWith(`:root { --ink: #0f766e; } body { margin: 0; background: #fff; } .a { ${FULL} background: var(--ink); }`, '<div class="a"></div>') },
  { name: 'a short fade that fills both ways', html: documentWith(`@keyframes fade { from { opacity: 0; } to { opacity: 1; } } body { margin: 0; background: #fff; } .a { ${FULL} background: #be123c; animation: fade 300ms both; }`, '<div class="a"></div>') },
  { name: 'a fade with a delay', html: documentWith(`@keyframes fade { from { opacity: 0; } to { opacity: 1; } } body { margin: 0; background: #fff; } .a { ${FULL} background: #be123c; animation: fade 100ms 100ms both; }`, '<div class="a"></div>') },
  { name: 'a transition from a starting style', html: documentWith(`body { margin: 0; background: #fff; } .a { ${FULL} background: #be123c; transition: opacity 200ms; } @starting-style { .a { opacity: 0; } }`, '<div class="a"></div>') },
  { name: 'an html background on a short page', html: documentWith('html { background: #be123c; } body { margin: 0; }', '<p>Short</p>') },
  { name: 'a body background on a short page', html: documentWith('body { margin: 0; background: #0f766e; }', '<p>Short</p>') },
  { name: 'a linked image', html: documentWith('body { margin: 0; background: #fff; } img { display: block; width: 100%; height: 100vh; }', `<img alt="" src="${ORIGIN}${PROTOTYPE_ASSET_PATH_PREFIX}${SHA}">`) },
  { name: 'a linked image in a rule', html: documentWith(`body { margin: 0; } .a { ${FULL} background: url("${ORIGIN}${PROTOTYPE_ASSET_PATH_PREFIX}${SHA}") center / cover; }`, '<div class="a"></div>') },
  { name: 'a body with its own display and height', html: documentWith('body { margin: 0; display: flex; justify-content: flex-end; background: #fff; } .a { width: 80px; height: 80px; background: #be123c; }', '<div class="a"></div>') },
  { name: 'an element that overflows the frame', html: documentWith('body { margin: 0; background: #fff; } .a { position: absolute; left: 120px; top: 160px; width: 900px; height: 900px; background: #be123c; }', '<div class="a"></div>') }
];

describe('Blueprint frame thumbnail render', () => {
  let browser: Browser;
  let page: Page;

  const screenshotOf = async (html: string, width: number, height: number): Promise<string> => {
    await page.evaluate(async ({ html, width, height }) => {
      const twin = document.createElement('iframe');
      twin.id = 'guard-twin';
      twin.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;border:0;z-index:2147483647;background:#fff;`;
      twin.setAttribute('sandbox', 'allow-same-origin');
      const loaded = new Promise<void>(resolve => {
        twin.onload = () => resolve();
      });
      twin.srcdoc = html;
      document.body.append(twin);
      await loaded;
      await twin.contentDocument?.fonts.ready;
    }, { html, width, height });
    const shot = await page.screenshot({ clip: { x: 0, y: 0, width, height }, animations: 'disabled' });
    await page.evaluate(() => document.getElementById('guard-twin')?.remove());
    return shot.toString('base64');
  };

  /** A pixel counts when its color differs from the screenshot by more than 30 in total. The answer is a percent of all pixels. */
  const differenceFromFrame = async (html: string, width = WIDTH, height = HEIGHT): Promise<number> => {
    const png = await screenshotOf(html, width, height);
    const answer = await page.evaluate(async ({ html, png, width, height }) => {
      const thumbnails = (globalThis as unknown as { frameThumbnails: { renderFrameThumbnail: (html: string, width: number, height: number, pixelRatio: number) => Promise<Blob | null> } }).frameThumbnails;
      const blob = await thumbnails.renderFrameThumbnail(html, width, height, 1);
      if (!blob) return undefined;
      const pixels = (image: CanvasImageSource, outWidth: number, outHeight: number): Uint8ClampedArray => {
        const canvas = document.createElement('canvas');
        canvas.width = outWidth;
        canvas.height = outHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
        context.fillStyle = '#fff';
        context.fillRect(0, 0, outWidth, outHeight);
        context.drawImage(image, 0, 0, outWidth, outHeight);
        return context.getImageData(0, 0, outWidth, outHeight).data;
      };
      const thumbnail = await createImageBitmap(blob);
      const left = pixels(thumbnail, thumbnail.width, thumbnail.height);
      const truth = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const right = pixels(truth, thumbnail.width, thumbnail.height);
      let count = 0;
      for (let index = 0; index < left.length; index += 4) {
        if (Math.abs(left[index] - right[index]) + Math.abs(left[index + 1] - right[index + 1]) + Math.abs(left[index + 2] - right[index + 2]) > 30) count += 1;
      }
      return { percent: 100 * count / (thumbnail.width * thumbnail.height), width: thumbnail.width, height: thumbnail.height };
    }, { html, png, width, height });
    assert.ok(answer, 'The render must answer an image.');
    assert.equal(answer.width, width);
    assert.equal(answer.height, height);
    return answer.percent;
  };

  before(async () => {
    const built = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: 'src/app/frame-thumbnails.ts', formats: ['iife'], name: 'frameThumbnails', fileName: () => 'frame-thumbnails.js' }
      }
    }) as Rollup.RollupOutput | Rollup.RollupOutput[];
    const output = Array.isArray(built) ? built[0] : built;
    browser = await chromium.launch({ args: ['--disable-gpu', '--disable-lcd-text'] });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.route(`${ORIGIN}/`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.route(`${ORIGIN}${PROTOTYPE_ASSET_PATH_PREFIX}${SHA}`, route => route.fulfill({ contentType: 'image/png', body: Buffer.from(SMALL_PNG, 'base64') }));
    await page.goto(`${ORIGIN}/`);
    await page.evaluate('globalThis.__name = target => target');
    await page.addScriptTag({ content: output.output[0].code });
  });

  after(async () => {
    await browser.close();
  });

  for (const row of ROWS) {
    it(`matches the frame for ${row.name}`, async () => {
      const difference = await differenceFromFrame(row.html);
      assert.ok(difference < 0.5, `The thumbnail differs in ${difference}% of pixels.`);
    });
  }

  it('matches a frame of a real project with linked fonts and images', { timeout: 120_000 }, async () => {
    const bundle = await loadProjectFromFs('fixtures/valid/meridian-finance/design/blueprint');
    const contents = bundle.prototypeAssetContents;
    await page.route(`${ORIGIN}${PROTOTYPE_ASSET_PATH_PREFIX}*`, async route => {
      const hash = route.request().url().split('/').at(-1) as string;
      const { createHash } = await import('node:crypto');
      const asset = Object.values(contents).find(item => createHash('sha256').update(Buffer.from(item.base64, 'base64')).digest('hex') === hash);
      if (!asset) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: asset.mediaType, body: Buffer.from(asset.base64, 'base64') });
    });
    const linked = { ...bundle, prototypeAssetContents: Object.fromEntries(await Promise.all(Object.entries(contents).map(async ([ref, item]) => {
      const { createHash } = await import('node:crypto');
      const bytes = Buffer.from(item.base64, 'base64');
      return [ref, { sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: item.mediaType, size: bytes.length }];
    }))) };
    const screen = bundle.screens.screens.find(item => item.prototype?.states.length);
    assert.ok(screen?.prototype);
    const preset = bundle.manifest.framePresets[0];
    const { html } = compilePrototypeDocument({ bundle: linked as never, target: { kind: 'screen', id: screen.id }, state: screen.prototype.states[0], framePreset: preset, assetOrigin: ORIGIN });
    assert.ok(html.includes(`${ORIGIN}${PROTOTYPE_ASSET_PATH_PREFIX}`), 'The document must link an asset, or this test proves nothing.');
    const difference = await differenceFromFrame(html, preset.width, preset.height);
    assert.ok(difference < 0.5, `${screen.id} differs in ${difference}% of pixels.`);
  });

  const renderAnswers = (html: string): Promise<boolean> => page.evaluate(async ({ html, width, height }) => {
    const thumbnails = (globalThis as unknown as { frameThumbnails: { renderFrameThumbnail: (html: string, width: number, height: number) => Promise<Blob | null> } }).frameThumbnails;
    return await thumbnails.renderFrameThumbnail(html, width, height) !== null;
  }, { html, width: WIDTH, height: HEIGHT });

  it('renders at half the size of the frame by default', async () => {
    const size = await page.evaluate(async ({ html, width, height }) => {
      const thumbnails = (globalThis as unknown as { frameThumbnails: { renderFrameThumbnail: (html: string, width: number, height: number) => Promise<Blob | null> } }).frameThumbnails;
      const image = await createImageBitmap(await thumbnails.renderFrameThumbnail(html, width, height) as Blob);
      return [image.width, image.height];
    }, { html: documentWith('', '<p>Text</p>'), width: WIDTH, height: HEIGHT });
    assert.deepEqual(size, [WIDTH / 2, HEIGHT / 2]);
  });

  it('answers no image for a document over the limit', async () => {
    const limit = await page.evaluate(() => (globalThis as unknown as { frameThumbnails: { FRAME_THUMBNAIL_DOCUMENT_LIMIT: number } }).frameThumbnails.FRAME_THUMBNAIL_DOCUMENT_LIMIT);
    assert.equal(await renderAnswers(documentWith('', `<p>${'x'.repeat(limit)}</p>`)), false);
    assert.equal(await renderAnswers(documentWith('', `<p>${'x'.repeat(1000)}</p>`)), true);
  });

  it('answers no image when an asset takes the document over the limit', async () => {
    const limit = await page.evaluate(() => (globalThis as unknown as { frameThumbnails: { FRAME_THUMBNAIL_DOCUMENT_LIMIT: number } }).frameThumbnails.FRAME_THUMBNAIL_DOCUMENT_LIMIT);
    const large = 'b'.repeat(64);
    await page.route(`${ORIGIN}${PROTOTYPE_ASSET_PATH_PREFIX}${large}`, route => route.fulfill({ contentType: 'image/png', body: Buffer.alloc(limit) }));
    assert.equal(await renderAnswers(documentWith('', `<img alt="" src="${ORIGIN}${PROTOTYPE_ASSET_PATH_PREFIX}${large}">`)), false);
    const encoded = 'c'.repeat(64);
    await page.route(`${ORIGIN}${PROTOTYPE_ASSET_PATH_PREFIX}${encoded}`, route => route.fulfill({ contentType: 'image/png', body: Buffer.alloc(Math.floor(limit * 0.9)) }));
    assert.equal(await renderAnswers(documentWith('', `<img alt="" src="${ORIGIN}${PROTOTYPE_ASSET_PATH_PREFIX}${encoded}">`)), false);
  });

  it('fetches nothing for the asset source in the policy of a document', async () => {
    const seen: string[] = [];
    page.on('request', request => seen.push(request.url()));
    assert.equal(await renderAnswers(documentWith('', '<p>Text</p>')), true);
    assert.deepEqual(seen.filter(url => url.includes(PROTOTYPE_ASSET_PATH_PREFIX)), []);
  });
});

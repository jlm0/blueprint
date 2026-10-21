import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { validateInspoContract } from '../src/core/inspo-contract';
import type { InspoFile } from '../src/core/types';
import {
  INSPO_USER_AGENT,
  downloadInspoImage,
  isPublicAddress,
  normalizeInspoUrl,
  sniffImageType,
  type InspoFetcher
} from '../src/mcp/inspo-download';
import { initializeBlueprint, inspoBlueprint, validateBlueprint } from '../src/mcp/operations';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const DRIBBBLE_IMAGE = 'https://cdn.dribbble.com/userupload/49381265/file/bd890cdbe486a74acf66627e0ab9a2e9.png?resize=1504x1128&vertical=center';

type Route = (url: URL) => Response;

interface FakeFetcher extends InspoFetcher {
  requests: Array<{ url: string; headers: Record<string, string> }>;
}

function fakeFetcher(routes: Record<string, Route>, addresses: Record<string, string[]> = {}): FakeFetcher {
  const requests: FakeFetcher['requests'] = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url: url.href, headers: { ...(init.headers as Record<string, string>) } });
      const route = routes[url.href];
      return route ? route(url) : new Response('missing', { status: 404 });
    },
    lookup: async hostname => addresses[hostname] ?? ['93.184.216.34']
  };
}

const image = (bytes: Buffer, type = 'image/png'): Route => () => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } });
const redirect = (location: string): Route => () => new Response(null, { status: 302, headers: { location } });

async function withSidecar(start: 'inspo' | undefined, fn: (out: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-inspo-'));
  try {
    const out = path.join(tempDir, 'app', 'design', 'blueprint');
    await initializeBlueprint({ projectId: 'app', name: 'App', out, ...(start ? { start } : {}) } as Parameters<typeof initializeBlueprint>[0]);
    await fn(out);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe('inspo image links', () => {
  it('accepts https image addresses and strips the Dribbble resize query', () => {
    assert.equal(normalizeInspoUrl(DRIBBBLE_IMAGE).href, 'https://cdn.dribbble.com/userupload/49381265/file/bd890cdbe486a74acf66627e0ab9a2e9.png');
    assert.equal(normalizeInspoUrl(' https://images.example.com/a.png?w=400#top ').href, 'https://images.example.com/a.png?w=400');
  });

  it('rejects links that Blueprint cannot download, with a fix', () => {
    assert.throws(() => normalizeInspoUrl('not a link'), /is not a link\. Fix:/);
    assert.throws(() => normalizeInspoUrl('http://images.example.com/a.png'), /does not use https\. Fix:/);
    assert.throws(() => normalizeInspoUrl('https://user:secret@images.example.com/a.png'), /user name or password\. Fix:/);
    assert.throws(() => normalizeInspoUrl('https://dribbble.com/shots/123-brand'), /Dribbble page.*Fix:.*cdn\.dribbble\.com/);
  });

  it('treats loopback, private, link-local, and mapped addresses as private', () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '172.16.4.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip']) {
      assert.equal(isPublicAddress(address), false, address);
    }
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
      assert.equal(isPublicAddress(address), true, address);
    }
  });

  it('identifies images by their bytes, not their names', () => {
    assert.equal(sniffImageType(PNG), 'png');
    assert.equal(sniffImageType(JPEG), 'jpg');
    assert.equal(sniffImageType(Buffer.from('GIF89a....')), 'gif');
    assert.equal(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'webp');
    assert.equal(sniffImageType(Buffer.from('<!doctype html>')), undefined);
  });

  it('downloads with the project User-Agent and follows https redirects', async () => {
    const fetcher = fakeFetcher({
      'https://cdn.dribbble.com/userupload/49381265/file/bd890cdbe486a74acf66627e0ab9a2e9.png': redirect('https://cdn2.example.com/final.png'),
      'https://cdn2.example.com/final.png': image(PNG)
    });
    const downloaded = await downloadInspoImage(DRIBBBLE_IMAGE, fetcher);
    assert.equal(downloaded.extension, 'png');
    assert.deepEqual(downloaded.bytes, PNG);
    assert.equal(fetcher.requests.length, 2);
    for (const request of fetcher.requests) {
      assert.equal(request.headers['User-Agent'], INSPO_USER_AGENT);
      assert.deepEqual(Object.keys(request.headers).sort(), ['Accept', 'User-Agent']);
      assert.doesNotMatch(request.headers.Accept ?? '', /webp/, 'naming WebP makes image CDNs send a lossy copy instead of the original');
    }
    assert.match(INSPO_USER_AGENT, /github\.com\/jlm0\/blueprint/);
  });

  it('refuses private hosts on every redirect hop', async () => {
    await assert.rejects(
      downloadInspoImage('https://intranet.example.com/a.png', fakeFetcher({}, { 'intranet.example.com': ['10.0.0.5'] })),
      /local or private address\. Fix:/
    );
    const hop = fakeFetcher({ 'https://images.example.com/a.png': redirect('https://127.0.0.1/a.png') });
    await assert.rejects(downloadInspoImage('https://images.example.com/a.png', hop), /local or private address/);
    assert.equal(hop.requests.length, 1);
    await assert.rejects(
      downloadInspoImage('https://images.example.com/a.png', fakeFetcher({ 'https://images.example.com/a.png': redirect('http://images.example.com/a.png') })),
      /redirects to a link without https/
    );
    const loop = fakeFetcher({ 'https://images.example.com/a.png': redirect('https://images.example.com/a.png') });
    await assert.rejects(downloadInspoImage('https://images.example.com/a.png', loop), /redirects more than 4 times/);
  });

  it('refuses challenge pages, web pages, other data, and oversized images', async () => {
    const url = 'https://images.example.com/a.png';
    const respond = (route: Route) => fakeFetcher({ [url]: route });
    await assert.rejects(
      downloadInspoImage(url, respond(() => new Response('', { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } }))),
      /refuses downloads from tools\. Fix:/
    );
    await assert.rejects(downloadInspoImage(url, respond(() => new Response('', { status: 403 }))), /refuses downloads from tools/);
    await assert.rejects(downloadInspoImage(url, respond(() => new Response('', { status: 500 }))), /returned HTTP 500\. Fix:/);
    await assert.rejects(downloadInspoImage(url, respond(image(PNG, 'text/html; charset=utf-8'))), /is a web page, not an image/);
    await assert.rejects(downloadInspoImage(url, respond(image(Buffer.from('plain text'), 'image/png'))), /not a PNG, JPEG, WebP, or GIF image/);
    await assert.rejects(
      downloadInspoImage(url, respond(() => new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(21 * 1024 * 1024) } }))),
      /larger than 20 MiB/
    );
  });
});

describe('inspo.json contract', () => {
  const valid: InspoFile = {
    schemaVersion: '2.0.0',
    projectId: 'app',
    entries: [{ id: 'ref-1', sourceUrl: 'https://images.example.com/a.png', image: 'inspo/ref-1.png', aspects: ['wordmark'], stance: 'like', note: 'love the tight kerning', reading: 'The wordmark uses tight letter spacing.' }],
    directions: [{ aspect: 'wordmark', statement: 'Set the wordmark with tight letter spacing.', entryIds: ['ref-1'], status: 'proposed' }]
  };

  it('accepts a valid board and keeps the note of the person unlinted', () => {
    const errors: string[] = [];
    validateInspoContract(errors, valid, 'app');
    assert.deepEqual(errors, []);
  });

  it('rejects unknown fields, foreign images, unknown entries, and duplicate aspects', () => {
    const errors: string[] = [];
    validateInspoContract(errors, {
      ...valid,
      extra: true,
      entries: [{ ...valid.entries[0]!, image: 'brand/mark.svg', aspects: ['wordmark', 'wordmark'], stance: 'meh' as 'like' }],
      directions: [
        { ...valid.directions[0]!, entryIds: ['ref-9'] },
        { ...valid.directions[0]!, status: 'done' as 'approved' }
      ]
    } as InspoFile, 'other');
    const text = errors.join('\n');
    assert.match(text, /extra/);
    assert.match(text, /projectId "app" does not match the manifest/);
    assert.match(text, /image "brand\/mark\.svg" is not the cached copy/);
    assert.match(text, /lists an aspect twice/);
    assert.match(text, /stance "meh" is not a stance/);
    assert.match(text, /names "ref-9", which is not an entry/);
    assert.match(text, /direction\.wordmark appears twice/);
    assert.match(text, /status is not a status/);
    assert.ok(errors.every(error => error.includes('Fix:')), text);
  });
});

describe('inspo tool', () => {
  it('starts a new sidecar with an empty, git-ignored inspo board and no brand', async () => {
    await withSidecar('inspo', async out => {
      const names = (await readdir(out)).sort();
      assert.ok(names.includes('inspo') && names.includes('inspo.json'));
      assert.equal(names.includes('brand.json'), false);
      assert.equal(names.includes('brand'), false);
      assert.equal(await readFile(path.join(out, 'inspo', '.gitignore'), 'utf8'), '*\n!.gitignore\n');
      assert.deepEqual(JSON.parse(await readFile(path.join(out, 'inspo.json'), 'utf8')), { schemaVersion: '2.0.0', projectId: 'app', entries: [], directions: [] });
      const readiness = await validateBlueprint({ project: out, mode: 'readiness' });
      assert.ok(readiness.mode === 'readiness' && readiness.readiness.items.some(item => item.path === 'inspo.entries'));
    });
  });

  it('adds, updates, and syncs entries with the words of the person', async () => {
    await withSidecar('inspo', async out => {
      const fetcher = fakeFetcher({
        'https://cdn.dribbble.com/userupload/49381265/file/bd890cdbe486a74acf66627e0ab9a2e9.png': image(PNG),
        'https://images.example.com/b.jpg': image(JPEG, 'image/jpeg')
      });
      const note = 'I like the mark — that chunky, rounded "b"; not the gradient';
      const added = await inspoBlueprint({ project: out, operation: { type: 'add', url: DRIBBBLE_IMAGE, aspects: ['mark'], note } }, undefined, fetcher);
      assert.deepEqual(added.downloaded, ['inspo/ref-1.png']);
      const entry = (added.inspo as unknown as InspoFile).entries[0]!;
      assert.deepEqual(entry, {
        id: 'ref-1',
        sourceUrl: 'https://cdn.dribbble.com/userupload/49381265/file/bd890cdbe486a74acf66627e0ab9a2e9.png',
        image: 'inspo/ref-1.png',
        aspects: ['mark'],
        stance: 'like',
        note,
        reading: ''
      });
      assert.deepEqual(await readFile(path.join(out, 'inspo', 'ref-1.png')), PNG);

      const second = await inspoBlueprint({ project: out, operation: { type: 'add', url: 'https://images.example.com/b.jpg', stance: 'avoid' } }, undefined, fetcher);
      assert.equal((second.inspo as unknown as InspoFile).entries[1]!.image, 'inspo/ref-2.jpg');
      await assert.rejects(inspoBlueprint({ project: out, operation: { type: 'add', url: 'https://images.example.com/b.jpg', id: 'ref-1' } }, undefined, fetcher), /"ref-1" already exists\. Fix:/);

      const updated = await inspoBlueprint({ project: out, operation: { type: 'update', id: 'ref-1', reading: 'The mark is a heavy, rounded letter b.' } });
      assert.equal((updated.inspo as unknown as InspoFile).entries[0]!.note, note);
      await assert.rejects(inspoBlueprint({ project: out, operation: { type: 'update', id: 'ref-1' } }), /changes nothing\. Fix:/);
      await assert.rejects(inspoBlueprint({ project: out, operation: { type: 'update', id: 'ref-7', note: 'x' } }), /no entry "ref-7"\. Fix: use one of these ids: "ref-1", "ref-2"/);

      await rm(path.join(out, 'inspo', 'ref-1.png'));
      await rm(path.join(out, 'inspo', 'ref-2.jpg'));
      const partial = await inspoBlueprint({ project: out, operation: { type: 'sync' } }, undefined, fakeFetcher({ 'https://images.example.com/b.jpg': image(JPEG, 'image/jpeg') }));
      assert.deepEqual(partial.downloaded, ['inspo/ref-2.jpg']);
      assert.deepEqual(partial.failed.map(failure => failure.id), ['ref-1']);
      assert.match(partial.failed[0]!.error, /HTTP 404/);
      const synced = await inspoBlueprint({ project: out, operation: { type: 'sync' } }, undefined, fetcher);
      assert.deepEqual(synced.downloaded, ['inspo/ref-1.png']);
      assert.deepEqual(synced.failed, []);
      assert.ok(existsSync(path.join(out, 'inspo', 'ref-1.png')));
    });
  });

  it('proposes directions, keeps approval until the statement changes, and gates the brand on approval', async () => {
    await withSidecar('inspo', async out => {
      const fetcher = fakeFetcher({ 'https://images.example.com/a.png': image(PNG), 'https://images.example.com/b.png': image(PNG) });
      await inspoBlueprint({ project: out, operation: { type: 'add', url: 'https://images.example.com/a.png', note: 'this mark' } }, undefined, fetcher);
      await inspoBlueprint({ project: out, operation: { type: 'add', url: 'https://images.example.com/b.png', note: 'these colors' } }, undefined, fetcher);

      await assert.rejects(inspoBlueprint({ project: out, operation: { type: 'direction', aspect: 'mark', status: 'approved' } }), /statement.*entryIds|Fix:/);
      const proposed = await inspoBlueprint({ project: out, operation: { type: 'direction', aspect: 'mark', statement: 'Draw the mark as one heavy, rounded letter.', entryIds: ['ref-1'] } });
      assert.equal((proposed.inspo as unknown as InspoFile).directions[0]!.status, 'proposed');
      const approved = await inspoBlueprint({ project: out, operation: { type: 'direction', aspect: 'mark', status: 'approved' } });
      assert.equal((approved.inspo as unknown as InspoFile).directions[0]!.status, 'approved');
      const kept = await inspoBlueprint({ project: out, operation: { type: 'direction', aspect: 'mark', entryIds: ['ref-1'] } });
      assert.equal((kept.inspo as unknown as InspoFile).directions[0]!.status, 'approved');
      const reworded = await inspoBlueprint({ project: out, operation: { type: 'direction', aspect: 'mark', statement: 'Draw the mark as one heavy letter.' } });
      assert.equal((reworded.inspo as unknown as InspoFile).directions[0]!.status, 'proposed');

      await assert.rejects(
        inspoBlueprint({ project: out, operation: { type: 'remove', id: 'ref-1' } }),
        /"mark" direction comes only from inspo entry "ref-1"\. Fix:/
      );
      await inspoBlueprint({ project: out, operation: { type: 'direction', aspect: 'mark', entryIds: ['ref-1', 'ref-2'] } });
      const removed = await inspoBlueprint({ project: out, operation: { type: 'remove', id: 'ref-1' } });
      const board = removed.inspo as unknown as InspoFile;
      assert.deepEqual(board.entries.map(entry => entry.id), ['ref-2']);
      assert.deepEqual(board.directions[0]!.entryIds, ['ref-2']);
      assert.equal(existsSync(path.join(out, 'inspo', 'ref-1.png')), false);

      const starter = path.join(process.cwd(), 'starter', 'design', 'blueprint');
      const brand = JSON.parse(await readFile(path.join(starter, 'brand.json'), 'utf8'));
      brand.projectId = 'app';
      await writeFile(path.join(out, 'brand.json'), `${JSON.stringify(brand, null, 2)}\n`);
      await cp(path.join(starter, 'brand'), path.join(out, 'brand'), { recursive: true });
      const gated = await validateBlueprint({ project: out, mode: 'baseline' });
      assert.equal(gated.ok, false);
      assert.match(gated.errors.join('\n'), /brand\.json exists, but inspo\.json has no approved direction\. Fix:/);
      await assert.rejects(inspoBlueprint({ project: out, operation: { type: 'direction', aspect: 'color', statement: 'Use the two warm colors.', entryIds: ['ref-2'] } }));

      await rm(path.join(out, 'brand.json'));
      await inspoBlueprint({ project: out, operation: { type: 'direction', aspect: 'mark', status: 'approved' } });
      await writeFile(path.join(out, 'brand.json'), `${JSON.stringify(brand, null, 2)}\n`);
      assert.equal((await validateBlueprint({ project: out, mode: 'baseline' })).ok, true);
    });
  });

  it('refuses a sidecar that has a brand and no inspo board', async () => {
    await withSidecar(undefined, async out => {
      assert.equal(existsSync(path.join(out, 'inspo.json')), false);
      await assert.rejects(
        inspoBlueprint({ project: out, operation: { type: 'sync' } }, undefined, fakeFetcher({})),
        /has a brand\.json and no inspo\.json.*Fix:/
      );
    });
  });
});

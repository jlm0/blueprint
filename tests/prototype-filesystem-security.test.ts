import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadProjectFromFs } from '../src/core/load';

const fixtureRoot = path.resolve('fixtures/red/high-fidelity-prototype/design/blueprint');
const mebibyte = 1024 * 1024;
const fixedJsonByteLimit = 1 * mebibyte;
const prototypeSourceByteLimit = 2 * mebibyte;
const prototypeAssetByteLimit = 16 * mebibyte;
const projectInputByteLimit = 32 * mebibyte;

test('loads ordinary governed regular files within the bounded project policy', async t => {
  const { projectRoot } = await temporaryProject(t);
  const bundle = await loadProjectFromFs(projectRoot);

  assert.match(bundle.prototypeSourceContents['prototype/screens/waitlist.html'] ?? '', /data-blueprint-screen="waitlist"/);
  assert.ok(bundle.prototypeAssetContents['prototype/assets/product-preview.svg']);
});

test('allows an in-root symlink whose canonical target is a regular file', async t => {
  const { projectRoot } = await temporaryProject(t);
  const sourcePath = path.join(projectRoot, 'prototype/screens/waitlist.html');
  const inRootTarget = path.join(projectRoot, 'prototype/screens/waitlist-canonical.html');
  await writeFile(inRootTarget, await readFile(sourcePath));
  await unlink(sourcePath);
  await symlink(inRootTarget, sourcePath);

  const bundle = await loadProjectFromFs(projectRoot);
  assert.match(bundle.prototypeSourceContents['prototype/screens/waitlist.html'] ?? '', /data-blueprint-screen="waitlist"/);
});

test('rejects a governed source symlink whose canonical target escapes the project root', async t => {
  const { tempRoot, projectRoot } = await temporaryProject(t);
  const outsideSource = path.join(tempRoot, 'outside-source.html');
  await writeFile(outsideSource, '<main>outside-source-marker</main>', 'utf8');
  const sourcePath = path.join(projectRoot, 'prototype/screens/waitlist.html');
  await unlink(sourcePath);
  await symlink(outsideSource, sourcePath);

  await assert.rejects(
    () => loadProjectFromFs(projectRoot),
    /prototype source "prototype\/screens\/waitlist\.html" resolves outside the canonical Blueprint source root/
  );
});

test('rejects a governed asset symlink whose canonical target escapes the project root', async t => {
  const { tempRoot, projectRoot } = await temporaryProject(t);
  const outsideAsset = path.join(tempRoot, 'outside-asset.svg');
  await writeFile(outsideAsset, '<svg xmlns="http://www.w3.org/2000/svg"><text>outside-asset-marker</text></svg>', 'utf8');
  const assetPath = path.join(projectRoot, 'prototype/assets/product-preview.svg');
  await unlink(assetPath);
  await symlink(outsideAsset, assetPath);

  await assert.rejects(
    () => loadProjectFromFs(projectRoot),
    /prototype asset "prototype\/assets\/product-preview\.svg" resolves outside the canonical Blueprint source root/
  );
});

test('rejects a fixed JSON symlink whose canonical target escapes the project root', async t => {
  const { tempRoot, projectRoot } = await temporaryProject(t);
  const manifestPath = path.join(projectRoot, 'manifest.json');
  const outsideManifest = path.join(tempRoot, 'outside-manifest.json');
  await writeFile(outsideManifest, await readFile(manifestPath));
  await unlink(manifestPath);
  await symlink(outsideManifest, manifestPath);

  await assert.rejects(
    () => loadProjectFromFs(projectRoot),
    /fixed JSON "manifest\.json" resolves outside the canonical Blueprint source root/
  );
});

test('rejects an independently stored exploration record whose symlink escapes the project root', async t => {
  const { tempRoot, projectRoot } = await temporaryProject(t);
  const recordsRoot = path.join(projectRoot, 'explorations');
  await mkdir(recordsRoot);
  const outsideRecord = path.join(tempRoot, 'outside-exploration.json');
  await writeFile(outsideRecord, '{}', 'utf8');
  await symlink(outsideRecord, path.join(recordsRoot, 'escape.json'));

  await assert.rejects(
    () => loadProjectFromFs(projectRoot),
    /fixed JSON "explorations\/escape\.json" resolves outside the canonical Blueprint source root/
  );
});

test('rejects a governed input whose canonical target is not a regular file', async t => {
  const { projectRoot } = await temporaryProject(t);
  const sourcePath = path.join(projectRoot, 'prototype/screens/waitlist.html');
  await unlink(sourcePath);
  await mkdir(sourcePath);

  await assert.rejects(
    () => loadProjectFromFs(projectRoot),
    /prototype source "prototype\/screens\/waitlist\.html" must resolve to a regular file/
  );
});

test('rejects a fixed JSON file over the per-file byte limit before parsing it', async t => {
  const { projectRoot } = await temporaryProject(t);
  const tokenPath = path.join(projectRoot, 'tokens.json');
  const original = await readFile(tokenPath, 'utf8');
  await writeFile(tokenPath, `${original}${' '.repeat(fixedJsonByteLimit + 1)}`, 'utf8');

  await assert.rejects(
    () => loadProjectFromFs(projectRoot),
    new RegExp(`fixed JSON "tokens\\.json" exceeds the ${fixedJsonByteLimit}-byte per-file limit`)
  );
});

test('rejects a governed source over the per-file byte limit', async t => {
  const { projectRoot } = await temporaryProject(t);
  const sourcePath = path.join(projectRoot, 'prototype/screens/waitlist.html');
  await writeFile(sourcePath, `<main>${'x'.repeat(prototypeSourceByteLimit + 1)}</main>`, 'utf8');

  await assert.rejects(
    () => loadProjectFromFs(projectRoot),
    new RegExp(`prototype source "prototype/screens/waitlist\\.html" exceeds the ${prototypeSourceByteLimit}-byte per-file limit`)
  );
});

test('rejects a governed asset over the per-file byte limit', async t => {
  const { projectRoot } = await temporaryProject(t);
  const assetPath = path.join(projectRoot, 'prototype/assets/product-preview.svg');
  await writeFile(assetPath, Buffer.alloc(prototypeAssetByteLimit + 1, 0x61));

  await assert.rejects(
    () => loadProjectFromFs(projectRoot),
    new RegExp(`prototype asset "prototype/assets/product-preview\\.svg" exceeds the ${prototypeAssetByteLimit}-byte per-file limit`)
  );
});

test('rejects aggregate governed input over the project byte limit', async t => {
  const { projectRoot } = await temporaryProject(t);
  const screensPath = path.join(projectRoot, 'screens.json');
  const screens = JSON.parse(await readFile(screensPath, 'utf8')) as {
    screens: Array<{ prototype?: { assetRefs: string[] } }>;
  };
  const aggregateRefs = Array.from({ length: 3 }, (_, index) => `prototype/assets/aggregate-${index}.bin`);
  screens.screens[0]!.prototype!.assetRefs.push(...aggregateRefs);
  await writeFile(screensPath, `${JSON.stringify(screens, null, 2)}\n`, 'utf8');
  await Promise.all(
    aggregateRefs.map(assetRef => writeFile(path.join(projectRoot, assetRef), Buffer.alloc(11 * mebibyte, 0x61)))
  );

  await assert.rejects(
    () => loadProjectFromFs(projectRoot),
    new RegExp(`total loaded Blueprint input exceeds the ${projectInputByteLimit}-byte aggregate limit`)
  );
});

async function temporaryProject(t: test.TestContext): Promise<{ tempRoot: string; projectRoot: string }> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'blueprint-filesystem-security-'));
  const projectRoot = path.join(tempRoot, 'design/blueprint');
  await cp(fixtureRoot, projectRoot, { recursive: true });
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });
  return { tempRoot, projectRoot };
}

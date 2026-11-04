import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { BlueprintProjectSnapshot, BlueprintProjectSnapshotDelta } from '../src/core/activity';
import { applyProjectBundleDelta, diffProjectBundles } from '../src/core/bundle-delta';
import type { LinkedProjectBundle } from '../src/core/types';
import { fetchLiveProjectSnapshot } from '../src/app/project-snapshot';
import { exploreBlueprint } from '../src/mcp/operations';
import { readValidatedProject } from '../src/mcp/project-validation';
import { ServeProjectSnapshots, type ServeProjectSnapshot } from '../src/mcp/serve-snapshot';

const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';

describe('project snapshot deltas', () => {
  it('rebuilds each published bundle exactly from the previous one and its delta', async () => {
    await withProjectCopy(async project => {
      const snapshots = new ServeProjectSnapshots(project, {
        debounceMs: 5,
        onChanged: () => undefined,
        onFailed: () => undefined,
        read: root => readValidatedProject(root)
      });
      try {
        const initial = await snapshots.start();
        let previous = initial;
        const publish = async (changedPath: string, edit: () => Promise<void>): Promise<{ current: ServeProjectSnapshot; delta: BlueprintProjectSnapshotDelta }> => {
          await edit();
          snapshots.schedule(changedPath);
          const current = await snapshots.settled();
          assert.equal(current.error, undefined, current.error);
          assert.notEqual(current.revision, previous.revision, changedPath);
          const delta = snapshots.deltaFrom(previous.revision, current);
          assert.ok(delta, changedPath);
          assert.equal(delta.base, previous.revision);
          assert.equal(delta.revision, current.revision);
          const wire = roundTrip(delta);
          const applied = applyProjectBundleDelta(roundTrip(previous.linkedBundle!), wire.delta);
          assert.deepStrictEqual(applied, roundTrip(current.linkedBundle!), changedPath);
          assert.equal(JSON.stringify(applied), JSON.stringify(current.linkedBundle), changedPath);
          assert.equal(snapshots.deltaFrom(current.revision, current), undefined);
          assert.equal(snapshots.deltaFrom('unknown-revision', current), undefined);
          previous = current;
          return { current, delta: wire };
        };

        const sourcePath = path.join(project, 'prototype/screens/hub.html');
        const source = await publish('prototype/screens/hub.html', async () => {
          await writeFile(sourcePath, `${await readFile(sourcePath, 'utf8')}\n<!-- delta edit -->\n`);
        });
        assert.deepEqual(Object.keys(source.delta.delta.fields), []);
        assert.deepEqual(Object.keys(source.delta.delta.prototypeSourceContents.set), ['prototype/screens/hub.html']);
        assert.deepEqual(source.delta.delta.prototypeAssetContents, { set: {}, remove: [] });

        const components = await publish('components.json', async () => {
          await editJson(path.join(project, 'components.json'), (file: { components: Array<{ description: string }> }) => {
            file.components[0].description = `${file.components[0].description} Edited for a delta.`;
          });
        });
        assert.deepEqual(Object.keys(components.delta.delta.fields), ['components']);
        assert.deepEqual(components.delta.delta.prototypeSourceContents, { set: {}, remove: [] });
        assert.equal(snapshots.deltaFrom(initial.revision, components.current), undefined);
        assert.equal(snapshots.deltaFrom(source.current.revision, source.current), undefined);

        const addedRef = 'prototype/assets/art/eclipse-copy.svg';
        const added = await publish('screens.json', async () => {
          await cp(path.join(project, 'prototype/assets/art/eclipse.svg'), path.join(project, addedRef));
          await editScreenAssetRefs(project, 'hub', refs => [...refs, addedRef]);
        });
        assert.deepEqual(Object.keys(added.delta.delta.fields), ['screens']);
        assert.deepEqual(Object.keys(added.delta.delta.prototypeAssetContents.set), [addedRef]);
        assert.match((added.delta.delta.prototypeAssetContents.set[addedRef] as { sha256: string }).sha256, /^[0-9a-f]{64}$/);
        assert.deepEqual(Object.keys(added.delta.delta.sourceFiles.set), ['prototypeSources']);

        const removed = await publish('screens.json', async () => {
          await editScreenAssetRefs(project, 'hub', refs => refs.filter(ref => ref !== addedRef));
          await rm(path.join(project, addedRef));
        });
        assert.deepEqual(removed.delta.delta.prototypeAssetContents, { set: {}, remove: [addedRef] });

        const explored = await publish('explorations', async () => {
          await exploreBlueprint({
            project,
            operation: {
              type: 'create',
              id: 'delta-hero',
              screenId: 'launch',
              state: 'default',
              framePresetId: 'desktop-web-page',
              title: 'Delta hero',
              intent: 'Check that an exploration change travels as a delta.',
              candidateLabels: ['A', 'B']
            }
          });
        });
        assert.deepEqual(Object.keys(explored.delta.delta.fields), ['explorations']);
        assert.ok(Object.keys(explored.delta.delta.prototypeSourceContents.set).length > 0);
        assert.ok(Object.keys(explored.delta.delta.sourceFiles.set).includes('explorationRecords'));
      } finally {
        snapshots.close();
      }
    });
  });

  it('reproduces key order and removed optional fields', () => {
    const previous = linkedBundle({ 'b.html': 'b', 'c.html': 'c' }, true);
    const next = linkedBundle({ 'a.html': 'a', 'b.html': 'b2', 'c.html': 'c' }, false);
    const delta = roundTrip(diffProjectBundles(previous, next));
    assert.deepEqual(delta.removedFields, ['brand']);
    assert.deepEqual(delta.prototypeSourceContents.order, ['a.html', 'b.html', 'c.html']);
    const applied = applyProjectBundleDelta(previous, delta);
    assert.equal(JSON.stringify(applied), JSON.stringify(next));
    assert.equal('brand' in applied, false);
    assert.deepEqual(Object.keys(previous.prototypeSourceContents), ['b.html', 'c.html']);
    assert.equal(previous.prototypeSourceContents['b.html'], 'b');

    const appended = linkedBundle({ 'b.html': 'b', 'c.html': 'c', 'd.html': 'd' }, true);
    assert.equal(diffProjectBundles(previous, appended).prototypeSourceContents.order, undefined);
  });
});

describe('canvas live snapshot', () => {
  const snapshotUrl = new URL('http://127.0.0.1:4173/__blueprint/project');
  const base = linkedBundle({ 'a.html': 'a' }, true);
  const next = linkedBundle({ 'a.html': 'a2' }, true);
  const full: BlueprintProjectSnapshot = { version: 1, revision: 'r2', bundle: next };

  it('applies a delta whose base is the revision the canvas holds', async () => {
    const requests = await withAnswers([{ version: 1, revision: 'r2', base: 'r1', delta: diffProjectBundles(base, next) }], async () => {
      const snapshot = await fetchLiveProjectSnapshot(snapshotUrl, 'r2', { revision: 'r1', bundle: roundTrip(base) });
      assert.equal(snapshot.revision, 'r2');
      assert.deepStrictEqual(snapshot.bundle, roundTrip(next));
    });
    assert.deepEqual(requests, ['revision=r2&base=r1']);
  });

  it('fetches the full bundle when a delta names another base, or the canvas holds no revision', async () => {
    const mismatched = await withAnswers([{ version: 1, revision: 'r2', base: 'r0', delta: diffProjectBundles(base, next) }, full], async () => {
      const snapshot = await fetchLiveProjectSnapshot(snapshotUrl, 'r2', { revision: 'r1', bundle: roundTrip(base) });
      assert.deepStrictEqual(snapshot.bundle, roundTrip(next));
    });
    assert.deepEqual(mismatched, ['revision=r2&base=r1', 'revision=r2']);

    const unheld = await withAnswers([full], async () => {
      const snapshot = await fetchLiveProjectSnapshot(snapshotUrl, 'r2', undefined);
      assert.deepStrictEqual(snapshot, { revision: 'r2', bundle: roundTrip(next) });
    });
    assert.deepEqual(unheld, ['revision=r2']);
  });
});

function linkedBundle(sources: Record<string, string>, withBrand: boolean): LinkedProjectBundle {
  const bundle = {
    manifest: { project: { id: 'delta', name: 'Delta' } },
    tokens: { tokenGroups: [] },
    primitives: { primitives: [] },
    components: { components: [], groups: [] },
    screens: { screens: [] },
    ...(withBrand ? { brand: { name: 'Delta' } } : {}),
    explorations: { explorations: [] },
    history: { entries: [] },
    sourceRoot: '/delta',
    sourceFiles: { manifest: '/delta/manifest.json', explorationRecords: [] },
    prototypeSourceContents: sources,
    prototypeAssetContents: { 'art.svg': { mediaType: 'image/svg+xml', sha256: 'a'.repeat(64) } }
  };
  return bundle as unknown as LinkedProjectBundle;
}

async function withAnswers(answers: unknown[], run: () => Promise<void>): Promise<string[]> {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input: string | URL | Request) => {
    requests.push(new URL(input instanceof Request ? input.url : input).searchParams.toString());
    const answer = answers.shift();
    assert.ok(answer, 'The canvas sent more snapshot requests than expected.');
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return requests;
}

async function editJson<T>(filePath: string, edit: (value: T) => void): Promise<void> {
  const value = JSON.parse(await readFile(filePath, 'utf8')) as T;
  edit(value);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function editScreenAssetRefs(project: string, screenId: string, edit: (refs: string[]) => string[]): Promise<void> {
  await editJson(path.join(project, 'screens.json'), (file: { screens: Array<{ id: string; prototype: { assetRefs: string[] } }> }) => {
    const screen = file.screens.find(candidate => candidate.id === screenId)!;
    screen.prototype.assetRefs = edit(screen.prototype.assetRefs);
  });
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function withProjectCopy(run: (project: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-delta-'));
  try {
    const project = path.join(tempDir, 'design', 'blueprint');
    await cp(umbraRoot, project, { recursive: true });
    await run(project);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

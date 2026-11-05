import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import type { BlueprintProjectBundle } from '../src/core/types';
import { validateProject } from '../src/prototype/validate-project';
import { exploreBlueprint, serveBlueprint } from '../src/mcp/operations';
import { loadValidatedProject, type ProjectReader } from '../src/mcp/project-validation';
import { readValidatedProject } from '../src/mcp/project-validation-worker';
import { ServeProjectSnapshots, type ServeProjectSnapshotOptions } from '../src/mcp/serve-snapshot';
import { settleFileEvents } from './support/serve-watched';

const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';
const brokenRoot = 'fixtures/invalid/broken/design/blueprint';

interface Counts {
  loads: number;
  validations: number;
}

describe('serve project snapshots', () => {
  it('loads and validates once per change, and reads never load or validate', async () => {
    await withProjectCopy(async project => {
      const counts: Counts = { loads: 0, validations: 0 };
      const changes: Array<{ revision: string; changedPaths: string[] }> = [];
      const snapshots = countingSnapshots(project, counts, { onChanged: change => changes.push(change) });
      try {
        const initial = await snapshots.start();
        assert.equal(initial.error, undefined);
        assert.deepEqual(counts, { loads: 1, validations: 1 });
        for (let read = 0; read < 5; read += 1) {
          assert.equal(snapshots.current, initial);
          assert.equal(await snapshots.settled(), initial);
        }
        assert.deepEqual(counts, { loads: 1, validations: 1 });

        await renameProject(project, 'Renamed Once');
        for (const changedPath of ['manifest.json', 'manifest.json', 'tokens.json']) {
          snapshots.schedule(changedPath);
        }
        assert.equal(snapshots.current, initial);
        const changed = await snapshots.settled();
        assert.equal(changed.bundle?.manifest.project.name, 'Renamed Once');
        assert.notEqual(changed.revision, initial.revision);
        assert.deepEqual(changes, [{ revision: changed.revision, changedPaths: ['manifest.json', 'tokens.json'] }]);
        for (let read = 0; read < 5; read += 1) {
          assert.equal(await snapshots.settled(), changed);
        }
        assert.deepEqual(counts, { loads: 2, validations: 2 });
      } finally {
        snapshots.close();
      }
    });
  });

  it('answers a read that does not wait during a reload, and coalesces the changes that arrive meanwhile', async () => {
    await withProjectCopy(async project => {
      const counts: Counts = { loads: 0, validations: 0 };
      let releaseLoad: (() => void) | undefined;
      let reportBlocked: (() => void) | undefined;
      const blocked = new Promise<void>(resolve => {
        reportBlocked = resolve;
      });
      const snapshots = new ServeProjectSnapshots(project, {
        debounceMs: 5,
        onChanged: () => undefined,
        onFailed: () => undefined,
        read: root => readValidatedProject(root, {
          load: async loadRoot => {
            counts.loads += 1;
            if (counts.loads === 2) {
              await new Promise<void>(resolve => {
                releaseLoad = resolve;
                reportBlocked?.();
              });
            }
            return loadProjectFromFs(loadRoot);
          },
          validate: bundle => {
            counts.validations += 1;
            return validateProject(bundle);
          }
        })
      });
      try {
        const initial = await snapshots.start();
        await renameProject(project, 'Renamed During Reload');
        snapshots.schedule('manifest.json');
        await blocked;

        assert.equal(snapshots.busy, true);
        assert.equal(snapshots.current, initial);
        let settled = false;
        const waiting = snapshots.settled().then(snapshot => {
          settled = true;
          return snapshot;
        });
        snapshots.schedule('tokens.json');
        snapshots.schedule('screens.json');
        await delay(30);
        assert.equal(settled, false);
        assert.deepEqual(counts, { loads: 2, validations: 1 });

        releaseLoad?.();
        const after = await waiting;
        assert.equal(after.bundle?.manifest.project.name, 'Renamed During Reload');
        assert.equal(snapshots.busy, false);
        assert.deepEqual(counts, { loads: 3, validations: 3 });
      } finally {
        snapshots.close();
      }
    });
  });

  it('keeps the last good bundle with the error and outdated files while the project is invalid', async () => {
    await withProjectCopy(async project => {
      const counts: Counts = { loads: 0, validations: 0 };
      const changes: Array<{ revision: string; changedPaths: string[] }> = [];
      const failures: Array<{ message: string; outdatedFiles: unknown[] }> = [];
      const snapshots = countingSnapshots(project, counts, {
        onChanged: change => changes.push(change),
        onFailed: failure => failures.push(failure)
      });
      try {
        const initial = await snapshots.start();
        const manifestPath = path.join(project, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        await writeFile(manifestPath, `${JSON.stringify({ ...manifest, schemaVersion: '1.0.0' }, null, 2)}\n`, 'utf8');
        snapshots.schedule('manifest.json');
        const invalid = await snapshots.settled();
        assert.equal(invalid.bundle, initial.bundle);
        assert.equal(invalid.revision, initial.revision);
        assert.match(invalid.error ?? '', /manifest\.json is on schema "1\.0\.0"/);
        assert.deepEqual(invalid.outdatedFiles, [{ file: 'manifest.json', version: '1.0.0' }]);

        snapshots.schedule('manifest.json');
        await snapshots.settled();
        assert.equal(failures.length, 1);
        assert.deepEqual(failures[0]?.outdatedFiles, [{ file: 'manifest.json', version: '1.0.0' }]);

        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        snapshots.schedule('manifest.json');
        const recovered = await snapshots.settled();
        assert.equal(recovered.error, undefined);
        assert.notEqual(recovered.revision, initial.revision);
        assert.deepEqual(changes.map(change => change.revision), [recovered.revision]);
        assert.deepEqual(counts, { loads: 4, validations: 4 });
      } finally {
        snapshots.close();
      }
    });
  });
});

describe('project validation worker', () => {
  it('answers with the same result as the in-process load and validate', async () => {
    for (const root of [umbraRoot, brokenRoot, 'fixtures/valid/missing-project/design/blueprint']) {
      const local = await readValidatedProject(root);
      assert.deepStrictEqual(await loadValidatedProject(root), local, root);
    }
    const valid = await loadValidatedProject(umbraRoot);
    assert.equal(valid.error, undefined);
    assert.match(valid.fingerprint ?? '', /^[0-9a-f]{64}$/);
    const broken = await loadValidatedProject(brokenRoot);
    assert.equal(broken.bundle, undefined);
    assert.match(broken.error ?? '', /\S/);
  });
});

describe('serve with an exploration', () => {
  it('reads the project once on a fresh start and not again when it reuses the runtime', async () => {
    await withProjectCopy(async project => {
      await exploreBlueprint({ project, operation: launchExploration('launch-hero') });
      let reads = 0;
      const read: ProjectReader = root => {
        reads += 1;
        return readValidatedProject(root);
      };
      await settleFileEvents(project);
      const started = await serveBlueprint({ project, port: 0, explorationId: 'launch-hero' }, undefined, undefined, read);
      try {
        assert.equal(started.runtime, 'started');
        assert.equal(started.selection?.explorationId, 'launch-hero');
        assert.equal(reads, 1);

        const reused = await serveBlueprint({ project, port: 0, explorationId: 'launch-hero' }, undefined, started, read);
        assert.equal(reused.runtime, 'reused');
        assert.equal(reused.selection?.explorationId, 'launch-hero');
        assert.equal(reads, 1);

        await exploreBlueprint({ project, operation: { type: 'archive', explorationId: 'launch-hero' } });
        await exploreBlueprint({ project, operation: launchExploration('launch-wording') });
        const added = await serveBlueprint({ project, port: 0, explorationId: 'launch-wording' }, undefined, started, read);
        assert.equal(added.runtime, 'reused');
        assert.equal(added.selection?.explorationId, 'launch-wording');

        await assert.rejects(
          serveBlueprint({ project, port: 0, explorationId: 'missing-exploration' }, undefined, started, read),
          /missing-exploration/
        );
      } finally {
        await started.close();
      }
    });
  });
});

function launchExploration(id: string) {
  return {
    type: 'create' as const,
    id,
    screenId: 'launch',
    state: 'default',
    framePresetId: 'desktop-web-page',
    title: 'Launch hero',
    intent: 'Compare hero directions without changing the canonical canvas.',
    candidateLabels: ['A', 'B', 'C']
  };
}

function countingSnapshots(
  project: string,
  counts: Counts,
  events: Partial<Pick<ServeProjectSnapshotOptions, 'onChanged' | 'onFailed'>>
): ServeProjectSnapshots {
  return new ServeProjectSnapshots(project, {
    debounceMs: 5,
    onChanged: events.onChanged ?? (() => undefined),
    onFailed: events.onFailed ?? (() => undefined),
    read: root => readValidatedProject(root, {
      load: (loadRoot): Promise<BlueprintProjectBundle> => {
        counts.loads += 1;
        return loadProjectFromFs(loadRoot);
      },
      validate: bundle => {
        counts.validations += 1;
        return validateProject(bundle);
      }
    })
  });
}

async function renameProject(project: string, name: string): Promise<void> {
  const manifestPath = path.join(project, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.project.name = name;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function withProjectCopy(run: (project: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-serve-snapshot-'));
  try {
    const project = path.join(tempDir, 'design', 'blueprint');
    await cp(umbraRoot, project, { recursive: true });
    await run(project);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

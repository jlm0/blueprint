import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BLUEPRINT_SCHEMA_VERSION } from '../src/core/schema-version';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { canvasLocationParams } from '../src/core/canvas-location';
import { loadProjectFromFs } from '../src/core/load';
import type { BlueprintProjectBundle } from '../src/core/types';
import { inspectPrototypeSourceGraph } from '../src/prototype/compiler';
import { createReadinessReport, validateProject } from '../src/prototype/validate-project';
import { findLiveBlueprintActivityRuntime } from '../src/mcp/activity';
import { createBlueprintMcpServer } from '../src/mcp/create-server';
import type { InspoFetcher } from '../src/mcp/inspo-download';
import {
  blueprintServeRuntimeKey,
  exploreBlueprint,
  initializeBlueprint,
  inspoBlueprint,
  promoteBlueprint,
  queryBlueprint,
  readBlueprintSelection,
  restoreBlueprint,
  serveBlueprint,
  validateBlueprint,
  type BlueprintServeHandle
} from '../src/mcp/operations';
import {
  createWorkerValidator,
  loadValidatedProject,
  projectValidationRuns,
  workerProjectValidator,
  type ProjectReader,
  type ProjectValidationRunMessage,
  type ProjectValidator,
  type ValidationReport,
  type ValidationRun
} from '../src/mcp/project-validation';
import { answerProjectTask, ProjectValidationSession, projectFingerprint } from '../src/mcp/project-validation-worker';
import { runInOrder } from '../src/mcp/operation-support';
import { withProjectMutation } from '../src/mcp/project-files';
import type { QueryInput } from '../src/mcp/schemas';
import { inProcessValidator } from './support/in-process-validator';
import { fileDigests, grownScreenId, growProject, umbraRoot, withProjectCopy } from './support/project-copies';
import { rewriteUntilSeen, serveWatched, settleFileEvents } from './support/serve-watched';

const brokenRoot = 'fixtures/invalid/broken/design/blueprint';
const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WORKER_FAILURE = /Blueprint validation stopped[\s\S]*Fix: call the tool again\./;
const STALL_ATTEMPTS = 4;
const STALL_SHARE_OF_CALL = 0.5;
const SCREEN_COPIES_FOR_STALL = 80;

const supportWorker = (name: string): URL => new URL(`./support/${name}`, import.meta.url);

const FAILING_WORKERS = [
  { failure: 'a crash', options: { url: supportWorker('crashing-worker.mjs') }, text: /exit code 7[\s\S]*Fix: call the tool again\./ },
  { failure: 'an uncaught error', options: { url: supportWorker('throwing-worker.mjs') }, text: /The worker failed on purpose\.[\s\S]*Fix: call the tool again\./ },
  {
    failure: 'an out-of-memory stop',
    options: { url: supportWorker('memory-hog-worker.mjs'), resourceLimits: { maxOldGenerationSizeMb: 64 } },
    text: /memory limit[\s\S]*Fix: call the tool again\./
  }
] as const;

describe('transaction order of worker checks', () => {
  it('writes nothing when the worker reports that the projected bundle is invalid', async () => {
    await withProjectCopy(async project => {
      await breakTokensProjectId(project);
      const before = await fileDigests(project);
      await assert.rejects(
        exploreBlueprint({ project, operation: launchExploration('launch-hero') }),
        /so Blueprint wrote nothing\. Fix:[\s\S]*tokens\.projectId "someone-else"/
      );
      assert.deepEqual(await fileDigests(project), before);
    });
  });

  it('rolls back when the worker reports that the written files are invalid', async () => {
    await withProjectCopy(async project => {
      let before: Record<string, string> = {};
      const validate: ProjectValidator = {
        ...workerProjectValidator,
        projected: async (bundle, signal) => {
          const check = await workerProjectValidator.projected(bundle, signal);
          await breakTokensProjectId(project);
          before = await fileDigests(project);
          return check;
        }
      };
      await assert.rejects(
        exploreBlueprint({ project, operation: launchExploration('launch-hero') }, undefined, validate),
        /Persisted exploration mutation failed baseline validation:[\s\S]*tokens\.projectId "someone-else"/
      );
      assert.deepEqual(await fileDigests(project), before);
    });
  });

  for (const { failure, options, text } of FAILING_WORKERS) {
    it(`writes nothing after ${failure} in the check of the projected bundle`, async () => {
      await withProjectCopy(async project => {
        const before = await fileDigests(project);
        await assert.rejects(exploreBlueprint({ project, operation: launchExploration('launch-hero') }, undefined, createWorkerValidator(options)), text);
        assert.deepEqual(await fileDigests(project), before);
      });
    });

    it(`rolls back after ${failure} in the check of the written files`, async () => {
      await withProjectCopy(async project => {
        const before = await fileDigests(project);
        const validate: ProjectValidator = { ...workerProjectValidator, persisted: createWorkerValidator(options).persisted };
        await assert.rejects(exploreBlueprint({ project, operation: launchExploration('launch-hero') }, undefined, validate), text);
        assert.deepEqual(await fileDigests(project), before);
      });
    });
  }

  it('stops the real worker with an out-of-memory error, and writes nothing', async () => {
    await withProjectCopy(async project => {
      const before = await fileDigests(project);
      const validate = createWorkerValidator({ resourceLimits: { maxOldGenerationSizeMb: 8 } });
      await assert.rejects(exploreBlueprint({ project, operation: launchExploration('launch-hero') }, undefined, validate), WORKER_FAILURE);
      assert.deepEqual(await fileDigests(project), before);
    });
  });

  it('rolls back promote and restore after a crash in the check of the written files, as explore does', async () => {
    await withProjectCopy(async project => {
      const crash: ProjectValidator = { ...workerProjectValidator, persisted: createWorkerValidator({ url: supportWorker('crashing-worker.mjs') }).persisted };
      await exploreBlueprint({ project, operation: launchExploration('launch-hero') });
      const promote = await promoteInput(project, 'launch-hero');
      const beforePromote = await fileDigests(project);
      await assert.rejects(promoteBlueprint(promote, undefined, crash), WORKER_FAILURE);
      assert.deepEqual(await fileDigests(project), beforePromote);

      await promoteBlueprint(promote);
      const restore = await restoreInput(project);
      const beforeRestore = await fileDigests(project);
      await assert.rejects(restoreBlueprint(restore, undefined, crash), WORKER_FAILURE);
      assert.deepEqual(await fileDigests(project), beforeRestore);
    });
  });

  it('rolls back inspo after a crash in the check of the written files, and leaves no image behind', async () => {
    await withInspoProject(async project => {
      const crash: ProjectValidator = { ...workerProjectValidator, persisted: createWorkerValidator({ url: supportWorker('crashing-worker.mjs') }).persisted };
      const before = await fileDigests(project);
      await assert.rejects(
        inspoBlueprint({ project, operation: { type: 'add', id: 'ref-1', url: 'https://images.example.com/a.png', note: 'this mark' } }, undefined, pngFetcher(), crash),
        WORKER_FAILURE
      );
      assert.deepEqual(await fileDigests(project), before);
    });
  });

  it('stops the worker and writes nothing when the caller aborts the check of the projected bundle', async () => {
    await withProjectCopy(async project => {
      const before = await fileDigests(project);
      const validate = createWorkerValidator({ url: supportWorker('hanging-worker.mjs') });
      await assertAbortStopsWorker(signal => exploreBlueprint({ project, operation: launchExploration('launch-hero') }, signal, validate));
      assert.deepEqual(await fileDigests(project), before);
    });
  });

  it('stops the worker and rolls back when the caller aborts the check of the written files', async () => {
    await withProjectCopy(async project => {
      const before = await fileDigests(project);
      const validate: ProjectValidator = {
        ...workerProjectValidator,
        persisted: createWorkerValidator({ url: supportWorker('hanging-worker.mjs') }).persisted
      };
      await assertAbortStopsWorker(
        signal => exploreBlueprint({ project, operation: launchExploration('launch-hero') }, signal, validate),
        { skipWorkers: 1 }
      );
      assert.deepEqual(await fileDigests(project), before);
    });
  });

  it('stops a real validation when the caller aborts it, and it answers with the reason', async () => {
    await withProjectCopy(async project => {
      await assertAbortStopsWorker(signal => validateBlueprint({ project, mode: 'baseline' }, signal));
    });
  });

  it('commits nothing when the abort arrives after the check and before the commit', async () => {
    await withProjectCopy(async project => {
      const before = await fileDigests(project);
      const directoriesBefore = await directoryTimes(project);
      const controller = new AbortController();
      const validate: ProjectValidator = {
        ...workerProjectValidator,
        projected: async (bundle, signal) => {
          const check = await workerProjectValidator.projected(bundle, signal);
          controller.abort(new Error('Stopped by the test.'));
          return check;
        }
      };
      await assert.rejects(exploreBlueprint({ project, operation: launchExploration('launch-hero') }, controller.signal, validate), /Stopped by the test\./);
      assert.deepEqual(await fileDigests(project), before);
      assert.deepEqual(await directoryTimes(project), directoriesBefore, 'No file appeared, even for a rollback to remove.');
    });
  });

  it('does not start a worker for a call that is already aborted', async () => {
    const workers = recordWorkers();
    try {
      const controller = new AbortController();
      controller.abort(new Error('Stopped by the test.'));
      await assert.rejects(workerProjectValidator.persisted(umbraRoot, 'none', controller.signal), /Stopped by the test\./);
      assert.equal(workers.started.length, 0);
    } finally {
      workers.stop();
    }
  });
});

describe('mutations of one project in one process', () => {
  it('runs the second mutation after the commit of the first', async () => {
    await withProjectCopy(async project => {
      const events: string[] = [];
      let releaseFirst: () => void = () => undefined;
      const firstHeld = new Promise<void>(resolve => {
        releaseFirst = resolve;
      });
      let reportFirstStarted: () => void = () => undefined;
      const firstStarted = new Promise<void>(resolve => {
        reportFirstStarted = resolve;
      });
      const first = inProcessValidator(bundle => validateProject(bundle));
      const held: ProjectValidator = {
        ...first,
        projected: async bundle => {
          events.push('first check starts');
          reportFirstStarted();
          await firstHeld;
          events.push('first check ends');
          return first.projected(bundle);
        },
        persisted: async (root, fingerprint) => {
          events.push('first commit ended');
          return first.persisted(root, fingerprint);
        }
      };
      const second = inProcessValidator(bundle => {
        events.push('second check');
        return validateProject(bundle);
      });
      const firstMutation = exploreBlueprint({ project, operation: launchExploration('launch-hero') }, undefined, held);
      await firstStarted;
      const secondMutation = exploreBlueprint({ project, operation: hubExploration('hub-wording') }, undefined, second);
      await delay(100);
      assert.deepEqual(events, ['first check starts']);
      releaseFirst();
      await firstMutation;
      await secondMutation;
      assert.deepEqual(events, ['first check starts', 'first check ends', 'first commit ended', 'second check']);
    });
  });

  it('refuses the second of two promotes with the same digests, so that no commit overwrites the other', async () => {
    await withProjectCopy(async project => {
      await exploreBlueprint({ project, operation: launchExploration('launch-hero') });
      const input = await promoteInput(project, 'launch-hero');
      const results = await Promise.allSettled([promoteBlueprint(input), promoteBlueprint(input)]);
      assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
      assert.match(String((results[1] as PromiseRejectedResult).reason), /must be active before promotion/);
    });
  });

  it('answers an abort while the mutation waits, and runs nothing for it', async () => {
    await withProjectCopy(async project => {
      let release: () => void = () => undefined;
      const held = new Promise<void>(resolve => {
        release = resolve;
      });
      const inner = inProcessValidator(bundle => validateProject(bundle));
      let checks = 0;
      const first = exploreBlueprint({ project, operation: launchExploration('launch-hero') }, undefined, {
        ...inner,
        projected: async bundle => {
          checks += 1;
          await held;
          return inner.projected(bundle);
        }
      });
      const controller = new AbortController();
      const waiting = exploreBlueprint({ project, operation: launchExploration('launch-wording') }, controller.signal, {
        ...inner,
        projected: async bundle => {
          checks += 1;
          return inner.projected(bundle);
        }
      });
      await delay(50);
      controller.abort(new Error('Stopped by the test.'));
      await assert.rejects(waiting, /Stopped by the test\./);
      release();
      await first;
      assert.equal(checks, 1);
      assert.equal(existsSync(path.join(project, 'explorations', 'launch-wording.json')), false);
    });
  });
});

describe('one validation per mutation', () => {
  for (const withRuntime of [false, true]) {
    const label = withRuntime ? 'and the serve runtime in this process' : 'with no serve runtime';
    it(`validates the content of explore, promote, and restore once, with the follow-up validate ${label}`, async () => {
      await withUnvalidatedProjectCopy(async project => {
        const served = withRuntime ? await serveWatched(project) : undefined;
        try {
          await assertOneValidation(project, served, () => exploreBlueprint({ project, operation: launchExploration('launch-hero') }));
          const promote = await promoteInput(project, 'launch-hero');
          await assertOneValidation(project, served, () => promoteBlueprint(promote));
          const restore = await restoreInput(project);
          await assertOneValidation(project, served, () => restoreBlueprint(restore));
        } finally {
          await served?.close();
        }
      });
    });

    it(`validates the content of each inspo mutation once, with the follow-up validate ${label}`, async () => {
      await withInspoProject(async project => {
        const served = withRuntime ? await serveWatched(project) : undefined;
        try {
          await assertOneValidation(project, served, () => inspoBlueprint({
            project,
            operation: { type: 'add', id: 'ref-1', url: 'https://images.example.com/a.png', aspects: ['mark'], note: 'this mark' }
          }, undefined, pngFetcher()));
          await assertOneValidation(project, served, () => inspoBlueprint({ project, operation: { type: 'update', id: 'ref-1', reading: 'A round mark.' } }));
        } finally {
          await served?.close();
        }
      });
    });
  }

  it('validates a file edit once when validate starts before the runtime reloads the edit', async () => {
    await withUnvalidatedProjectCopy(async project => {
      const served = await serveWatched(project);
      try {
        const before = (await served.settledProject!())?.revision;
        await renameProject(project, `Edited By Hand ${randomUUID()}`);
        const runs = recordRuns();
        try {
          const report = await validateBlueprint({ project, mode: 'baseline' });
          assert.equal(report.ok, true);
          await waitForNewRevision(served, before);
          assert.deepEqual(runs.of(projectFingerprint(await loadProjectFromFs(project))), ['source-graph', 'baseline'].sort());
        } finally {
          runs.stop();
        }
      } finally {
        await served.close();
      }
    });
  });

  it('starts a serve reload that a mutation overlaps after the mutation commits, so the reload validates nothing again', async () => {
    await withUnvalidatedProjectCopy(async project => {
      let releaseProjected: () => void = () => undefined;
      const projectedGate = new Promise<void>(resolve => {
        releaseProjected = resolve;
      });
      let projectedHeld = false;
      const order: string[] = [];
      const onWorker = (): void => {
        order.push('worker');
      };
      subscribe('worker_threads', onWorker);
      const runs = recordRuns();
      const pending: Promise<unknown>[] = [];
      try {
        const mutation = exploreBlueprint({ project, operation: launchExploration('launch-hero') }, undefined, {
          projected: async (bundle, signal) => {
            projectedHeld = true;
            await projectedGate;
            return workerProjectValidator.projected(bundle, signal);
          },
          persisted: (projectRoot, projectedFingerprint, signal) => {
            order.push('persisted');
            return workerProjectValidator.persisted(projectRoot, projectedFingerprint, signal);
          }
        });
        pending.push(mutation);
        await waitUntil(() => projectedHeld);
        const reload = loadValidatedProject(project);
        pending.push(reload);
        await delay(100);
        assert.deepEqual(order, [], 'The reload started its worker while the mutation held its projected step.');
        releaseProjected();
        const [, reloaded] = await Promise.all([mutation, reload]);
        assert.deepEqual(order, ['worker', 'persisted', 'worker', 'worker']);
        assert.ok(reloaded.bundle?.explorations.explorations.some(exploration => exploration.id === 'launch-hero'));
        assert.deepEqual(runs.of(projectFingerprint(await loadProjectFromFs(project))), ['baseline', 'source-graph']);
      } finally {
        releaseProjected();
        await Promise.allSettled(pending);
        runs.stop();
        unsubscribe('worker_threads', onWorker);
      }
    });
  });

  it('reuses the source graph result for strict and readiness on the same content', async () => {
    await withUnvalidatedProjectCopy(async project => {
      const runs = recordRuns();
      try {
        await validateBlueprint({ project, mode: 'baseline' });
        await validateBlueprint({ project, mode: 'strict' });
        await validateBlueprint({ project, mode: 'readiness' });
        await validateBlueprint({ project, mode: 'strict' });
        await validateBlueprint({ project, mode: 'baseline' });
        const fingerprint = projectFingerprint(await loadProjectFromFs(project));
        assert.deepEqual(runs.of(fingerprint), ['baseline', 'readiness', 'source-graph', 'strict']);
      } finally {
        runs.stop();
      }
    });
  });

  it('takes the source graph issues of each mode from the memo, and does not inspect the sources again', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    const issue = { boundaryId: 'screen:launch', state: 'default', message: 'Seeded by the test.' };
    const memo = [{ fingerprint: projectFingerprint(bundle), sourceGraphIssues: [issue] }];
    for (const mode of ['baseline', 'strict', 'readiness'] as const) {
      const reply = await answerProjectTask({ kind: 'report', project: umbraRoot, mode }, memo);
      assert.ok('value' in reply, mode);
      const report = reply.value as ValidationReport;
      assert.match(report.errors.join('\n'), /Seeded by the test\./, mode);
      if (mode === 'readiness') assert.match(JSON.stringify(report.readiness), /Seeded by the test\./);
      assert.equal(reply.runs.includes('source-graph'), false, mode);
    }
  });

  it('gives the same output with and without the memo, in each mode, on valid and invalid projects', async () => {
    for (const root of [umbraRoot, meridianRoot, brokenRoot]) {
      const bundle = await loadProjectFromFs(root);
      const direct = {
        baseline: validateProject(bundle),
        strict: validateProject(bundle, { mode: 'strict' }),
        readiness: { ...validateProject(bundle), readiness: createReadinessReport(bundle) }
      };
      for (const mode of ['baseline', 'strict', 'readiness'] as const) {
        const first = await validateBlueprint({ project: root, mode });
        const second = await validateBlueprint({ project: root, mode });
        assert.deepStrictEqual(second, first, `${root} ${mode}`);
        assert.deepStrictEqual(first.errors, direct[mode].errors, `${root} ${mode}`);
        if (mode === 'readiness') {
          assert.deepStrictEqual(first.mode === 'readiness' ? first.readiness : undefined, direct.readiness.readiness, root);
        }
      }
    }
  });
});

describe('a memo result is never stale', () => {
  it('validates again after a one-byte source change, and answers the new result', async () => {
    await withUnvalidatedProjectCopy(async project => {
      const sourcePath = path.join(project, 'prototype/screens/launch.html');
      const original = await readFile(sourcePath);
      const runs = recordRuns();
      try {
        assert.equal((await validateBlueprint({ project, mode: 'baseline' })).ok, true);
        const firstFingerprint = projectFingerprint(await loadProjectFromFs(project));
        assert.deepEqual(runs.of(firstFingerprint), ['baseline', 'source-graph']);

        const marker = Buffer.from('data-blueprint-section="nav"');
        const at = original.indexOf(marker);
        assert.ok(at >= 0, 'The fixture marks the nav section.');
        const changed = Buffer.from(original);
        changed[at + marker.length - 2] = 'x'.charCodeAt(0);
        await writeFile(sourcePath, changed);

        const after = await validateBlueprint({ project, mode: 'baseline' });
        assert.equal(after.ok, false);
        assert.match(after.errors.join('\n'), /marks undeclared section "nax"/);
        const changedFingerprint = projectFingerprint(await loadProjectFromFs(project));
        assert.notEqual(changedFingerprint, firstFingerprint);
        assert.deepEqual(runs.of(changedFingerprint), ['baseline', 'source-graph']);

        await writeFile(sourcePath, original);
        assert.equal((await validateBlueprint({ project, mode: 'baseline' })).ok, true);
        assert.deepEqual(runs.of(firstFingerprint), ['baseline', 'source-graph'], 'The memo answers the same content again.');
      } finally {
        runs.stop();
      }
    });
  });

  it('validates again after a one-byte change of an asset or of a JSON file', async () => {
    await withProjectCopy(async project => {
      assert.equal((await validateBlueprint({ project, mode: 'baseline' })).ok, true);
      const bundle = await loadProjectFromFs(project);
      const assetPath = path.join(project, Object.keys(bundle.prototypeAssetContents)[0]!);
      const asset = await readFile(assetPath);
      asset[asset.length - 1] = asset[asset.length - 1]! ^ 1;
      await writeFile(assetPath, asset);
      const runs = recordRuns();
      try {
        await validateBlueprint({ project, mode: 'baseline' });
        const afterAsset = projectFingerprint(await loadProjectFromFs(project));
        assert.deepEqual(runs.of(afterAsset), ['baseline', 'source-graph']);

        await renameProject(project, `${bundle.manifest.project.name}x`);
        await validateBlueprint({ project, mode: 'baseline' });
        const afterJson = projectFingerprint(await loadProjectFromFs(project));
        assert.notEqual(afterJson, afterAsset);
        assert.deepEqual(runs.of(afterJson), ['baseline', 'source-graph']);
      } finally {
        runs.stop();
      }
    });
  });

  it('changes the fingerprint for one changed byte in each input', async () => {
    await withProjectCopy(async project => {
      const bundle = await loadProjectFromFs(project);
      const first = projectFingerprint(bundle);
      const copy = (): BlueprintProjectBundle => structuredClone(bundle);
      assert.equal(projectFingerprint(copy()), first, 'A copy of the bundle has the same fingerprint.');

      const assetRef = Object.keys(bundle.prototypeAssetContents)[0]!;
      const sourceRef = Object.keys(bundle.prototypeSourceContents)[0]!;
      const changes: Array<[string, (changed: BlueprintProjectBundle) => void]> = [
        ['manifest', changed => { changed.manifest.project.name += 'x'; }],
        ['tokens', changed => { changed.tokens.projectId += 'x'; }],
        ['primitives', changed => { changed.primitives.primitives[0]!.id += 'x'; }],
        ['components', changed => { changed.components.components[0]!.id += 'x'; }],
        ['screens', changed => { changed.screens.screens[0]!.id += 'x'; }],
        ['explorations', changed => { changed.explorations.projectId += 'x'; }],
        ['history', changed => { changed.history.projectId += 'x'; }],
        ['brand', changed => { changed.brand = { schemaVersion: BLUEPRINT_SCHEMA_VERSION } as unknown as BlueprintProjectBundle['brand']; }],
        ['inspo', changed => { changed.inspo = { schemaVersion: BLUEPRINT_SCHEMA_VERSION } as unknown as BlueprintProjectBundle['inspo']; }],
        ['source text', changed => { changed.prototypeSourceContents[sourceRef] += 'x'; }],
        ['source added', changed => { changed.prototypeSourceContents['prototype/screens/added.css'] = ''; }],
        ['asset bytes', changed => { changed.prototypeAssetContents[assetRef]!.base64 += 'A'; }],
        ['asset type', changed => { changed.prototypeAssetContents[assetRef]!.mediaType += 'x'; }]
      ];
      const seen = new Set([first]);
      for (const [name, change] of changes) {
        const changed = copy();
        change(changed);
        const fingerprint = projectFingerprint(changed);
        assert.equal(seen.has(fingerprint), false, name);
        seen.add(fingerprint);
      }
    });
  });

  it('changes the fingerprint when a prototype file of the bundle no longer exists', async () => {
    await withProjectCopy(async project => {
      const bundle = await loadProjectFromFs(project);
      const first = projectFingerprint(bundle);
      const copy = structuredClone(bundle);
      await rm(path.join(project, bundle.screens.screens[0]!.prototype!.source));
      assert.notEqual(projectFingerprint(copy), first);
    });
  });

  it('keeps the fingerprint across the order of records and the source file index, which a projection does not keep', async () => {
    await withProjectCopy(async project => {
      await exploreBlueprint({ project, operation: launchExploration('launch-hero') });
      await exploreBlueprint({ project, operation: hubExploration('hub-wording') });
      const bundle = await loadProjectFromFs(project);
      const first = projectFingerprint(bundle);
      const reordered: BlueprintProjectBundle = {
        ...structuredClone(bundle),
        sourceFiles: { ...bundle.sourceFiles, prototypeSources: [] },
        explorations: { ...bundle.explorations, explorations: [...bundle.explorations.explorations].reverse() }
      };
      assert.equal(projectFingerprint(reordered), first);
    });
  });

  it('reads the inspo image of a readiness report from the disk each time', async () => {
    await withInspoProject(async project => {
      await inspoBlueprint({ project, operation: { type: 'add', id: 'ref-1', url: 'https://images.example.com/a.png', note: 'this mark' } }, undefined, pngFetcher());
      const imagePath = path.join(project, 'inspo', 'ref-1.png');
      const readinessPaths = async (): Promise<string[]> => {
        const report = await validateBlueprint({ project, mode: 'readiness' });
        return report.mode === 'readiness' ? report.readiness.items.map(item => item.path) : [];
      };
      assert.equal((await readinessPaths()).includes('inspo.entry.ref-1.image'), false);
      const image = await readFile(imagePath);
      await rm(imagePath);
      assert.equal((await readinessPaths()).includes('inspo.entry.ref-1.image'), true, 'The same bundle with the image gone reports the missing image.');
      await writeFile(imagePath, image);
      assert.equal((await readinessPaths()).includes('inspo.entry.ref-1.image'), false);
    });
  });

  it('reads the style evidence artifact of a readiness report from the disk each time', async () => {
    await withProjectCopy(async project => {
      const primitivesPath = path.join(project, 'primitives.json');
      const primitives = JSON.parse(await readFile(primitivesPath, 'utf8'));
      const primitive = primitives.primitives.find((candidate: { prototypeOnly?: boolean; styleRefs?: unknown[] }) => !candidate.prototypeOnly && candidate.styleRefs?.length);
      assert.ok(primitive, 'The fixture has a primitive with a style reference.');
      primitive.styleEvidence = primitive.styleRefs.map((styleRef: string) => ({ styleRef, status: 'linked-artifact-pending', artifactRef: 'evidence.png' }));
      await writeFile(primitivesPath, `${JSON.stringify(primitives, null, 2)}\n`);
      const blockersOnArtifact = async (): Promise<number> => {
        const report = await validateBlueprint({ project, mode: 'readiness' });
        return report.mode === 'readiness'
          ? report.readiness.blockers.filter(item => item.source === 'declared-missing-artifact' && item.artifactRef === 'evidence.png').length
          : -1;
      };
      const missing = await blockersOnArtifact();
      assert.ok(missing > 0);
      await writeFile(path.join(project, 'evidence.png'), PNG);
      assert.equal(await blockersOnArtifact(), 0);
      await rm(path.join(project, 'evidence.png'));
      assert.equal(await blockersOnArtifact(), missing);
    });
  });
});

describe('runtime snapshot for focus and selection', () => {
  it('answers focus from the runtime snapshot, with no worker and no load', async () => {
    await withProjectCopy(async project => {
      const served = await serveWatched(project);
      const workers = recordWorkers();
      try {
        const focused = await serveBlueprint({ project, port: 0, focus: 'screen:launch' }, undefined, served);
        assert.equal(new URL(focused.url).searchParams.get('screen'), 'launch');
        assert.equal(workers.started.length, 0);
      } finally {
        workers.stop();
        await served.close();
      }
    });
  });

  it('reads through a worker when the snapshot lacks the focus target, and keeps the error text', async () => {
    await withProjectCopy(async project => {
      const served = await serveWatched(project);
      const workers = recordWorkers();
      try {
        const screensPath = path.join(project, 'screens.json');
        const screens = JSON.parse(await readFile(screensPath, 'utf8'));
        screens.screens[0].id = 'renamed-just-now';
        await writeFile(screensPath, `${JSON.stringify(screens, null, 2)}\n`);
        const focused = await serveBlueprint({ project, port: 0, focus: 'screen:renamed-just-now' }, undefined, served);
        assert.equal(new URL(focused.url).searchParams.get('screen'), 'renamed-just-now');
        assert.ok(workers.started.length >= 1);

        const bundle = await loadProjectFromFs(project);
        const expected = (() => {
          try {
            canvasLocationParams(bundle, 'screen:not-a-screen');
            return '';
          } catch (error) {
            return (error as Error).message;
          }
        })();
        assert.notEqual(expected, '');
        await assert.rejects(serveBlueprint({ project, port: 0, focus: 'screen:not-a-screen' }, undefined, served), { message: expected });
      } finally {
        workers.stop();
        await served.close();
      }
    });
  });

  it('reads through a worker when the project is invalid, as the old read did', async () => {
    await withProjectCopy(async project => {
      const served = await serveWatched(project);
      try {
        await breakTokensProjectId(project);
        await waitForError(served);
        const workers = recordWorkers();
        try {
          const focused = await serveBlueprint({ project, port: 0, focus: 'screen:launch' }, undefined, served);
          assert.equal(new URL(focused.url).searchParams.get('screen'), 'launch');
          assert.ok(workers.started.length >= 1, 'A snapshot with an error must not answer focus.');
        } finally {
          workers.stop();
        }
      } finally {
        await served.close();
      }
    });
  });

  it('refuses focus on an older schema through the worker read', async () => {
    await withProjectCopy(async project => {
      const manifestPath = path.join(project, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, schemaVersion: '1.0.0' }, null, 2)}\n`);
      await assert.rejects(serveBlueprint({ project, port: 0, focus: 'screen:launch' }), /manifest\.json is on schema "1\.0\.0"/);
    });
  });

  it('answers selection from the runtime snapshot, and reads through a worker when the project is invalid', async () => {
    await withProjectCopy(async project => {
      const served = await serveWatched(project);
      try {
        const runtime = await findLiveBlueprintActivityRuntime(await blueprintServeRuntimeKey(project));
        assert.ok(runtime);
        const page = await (await fetch(served.url)).text();
        const canvasToken = /"canvasToken":"([^"]+)"/.exec(page)?.[1] ?? '';
        const selection = { boundaryId: 'umbra-gaming/screen/launch', kind: 'screen', localId: 'launch', label: 'Launch', context: [] };
        const put = await fetch(new URL('/__blueprint/selection', served.url), {
          method: 'PUT',
          headers: { 'x-blueprint-canvas-token': canvasToken },
          body: JSON.stringify({ selection })
        });
        assert.equal(put.status, 204);

        const workers = recordWorkers();
        try {
          const output = await readBlueprintSelection({ project });
          const screens = JSON.parse(await readFile(path.join(project, 'screens.json'), 'utf8'));
          const launch = screens.screens.find((screen: { id: string }) => screen.id === 'launch');
          assert.deepEqual(output.selection?.files, [launch.prototype.source, ...launch.prototype.styles]);
          assert.equal(workers.started.length, 0);

          await breakTokensProjectId(project);
          await waitForError(served);
          const startedBefore = workers.started.length;
          const invalid = await readBlueprintSelection({ project });
          assert.deepEqual(invalid.selection?.files, output.selection?.files);
          assert.ok(workers.started.length > startedBefore, 'A snapshot with an error must not answer selection.');
        } finally {
          workers.stop();
        }
      } finally {
        await served.close();
      }
    });
  });

  it('waits for the settled snapshot with no fixed delay', async () => {
    await withProjectCopy(async project => {
      const served = await serveWatched(project);
      try {
        const winner = await Promise.race([served.settledProject!(), delay(150, 'fixed delay')]);
        assert.notEqual(winner, 'fixed delay');
      } finally {
        await served.close();
      }
    });
  });

  it('stops waiting at the deadline when a reload does not end, and reads through the worker', async () => {
    await withProjectCopy(async project => {
      let release: () => void = () => undefined;
      const held = new Promise<void>(resolve => {
        release = resolve;
      });
      let reads = 0;
      const read: ProjectReader = async (root, signal) => {
        reads += 1;
        if (reads > 1) await held;
        return loadValidatedProject(root, signal);
      };
      await settleFileEvents(project);
      const served = await serveBlueprint({ project, port: 0 }, undefined, undefined, read);
      try {
        await renameProject(project, 'Reload Held');
        await rewriteUntilSeen(path.join(project, 'manifest.json'), () => reads > 1);
        const startedAt = Date.now();
        const focused = await Promise.race([
          serveBlueprint({ project, port: 0, focus: 'screen:launch' }, undefined, served, read),
          delay(60_000, undefined, { ref: false }).then(() => assert.fail('The call does not stop at the deadline.'))
        ]);
        assert.equal(new URL(focused.url).searchParams.get('screen'), 'launch');
        assert.ok(Date.now() - startedAt >= 4_500, 'The call waits for the deadline.');
      } finally {
        release();
        await served.close();
      }
    });
  });
});

describe('the event loop during validation', () => {
  it('keeps running through validate in each mode, migrate, and explore on the real server path', async () => {
    await withProjectCopy(async project => {
      await growProject(project, SCREEN_COPIES_FOR_STALL);
      const server = createBlueprintMcpServer();
      const client = new Client({ name: 'stall-guard', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        let round = 0;
        const callTool = (name: string, args: Record<string, unknown>) => async (): Promise<void> => {
          const result = await client.callTool({ name, arguments: { project, ...args } }, { timeout: 600_000 });
          assert.ok(result.structuredContent, JSON.stringify(result.content));
        };
        const newContent = async (): Promise<void> => {
          round += 1;
          await renameProject(project, `Stall Guard ${round}`);
        };
        await assertEventLoopRuns('validate baseline', newContent, callTool('validate', { mode: 'baseline' }));
        await assertEventLoopRuns('validate strict', newContent, callTool('validate', { mode: 'strict' }));
        await assertEventLoopRuns('validate readiness', newContent, callTool('validate', { mode: 'readiness' }));
        await assertEventLoopRuns('migrate', newContent, callTool('migrate', { dryRun: true }));
        await assertEventLoopRuns('explore', newContent, () => callTool('explore', {
          operation: { ...launchExploration(`stall-${grownScreenId(round)}`), screenId: grownScreenId(round) }
        })());
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});

// Machine load slows both the pause and the call, and a real stall takes most of the call in each attempt, so the guard compares the two.
async function assertEventLoopRuns(name: string, prepare: () => Promise<void>, call: () => Promise<void>): Promise<void> {
  const attempts: Array<{ callMs: number; longestPauseMs: number }> = [];
  for (let attempt = 0; attempt < STALL_ATTEMPTS; attempt += 1) {
    await prepare();
    const measured = await measureEventLoop(call);
    attempts.push(measured);
    if (measured.longestPauseMs < measured.callMs * STALL_SHARE_OF_CALL) return;
  }
  assert.fail(`${name} stalls the event loop for more than half of the call in each attempt: ${JSON.stringify(attempts)}`);
}

async function measureEventLoop(call: () => Promise<void>): Promise<{ callMs: number; longestPauseMs: number }> {
  let previous = performance.now();
  let longestPauseMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longestPauseMs = Math.max(longestPauseMs, now - previous);
    previous = now;
  }, 5);
  const startedAt = performance.now();
  try {
    await call();
    await delay(10);
    return { callMs: performance.now() - startedAt, longestPauseMs };
  } finally {
    clearInterval(timer);
  }
}

async function assertOneValidation(project: string, served: BlueprintServeHandle | undefined, mutate: () => Promise<unknown>): Promise<void> {
  const before = served ? (await served.settledProject!())?.revision : undefined;
  const runs = recordRuns();
  try {
    await mutate();
    if (served) await waitForNewRevision(served, before);
    const report = await validateBlueprint({ project, mode: 'baseline' });
    assert.equal(report.ok, true, report.errors.join('\n'));
    const fingerprint = projectFingerprint(await loadProjectFromFs(project));
    assert.deepEqual(runs.of(fingerprint), ['baseline', 'source-graph']);
    await validateBlueprint({ project, mode: 'baseline' });
    assert.deepEqual(runs.of(fingerprint), ['baseline', 'source-graph']);
  } finally {
    runs.stop();
  }
}

async function waitForNewRevision(served: BlueprintServeHandle, revision: string | undefined): Promise<void> {
  await waitUntil(async () => {
    const settled = await served.settledProject!();
    return settled !== undefined && settled.revision !== revision;
  });
}

describe('project mutation queue', () => {
  it('keeps the queue closed for the next call when a waiting call aborts', async () => {
    const queue = new Map<string, Promise<void>>();
    const events: string[] = [];
    let finishFirst: () => void = () => undefined;
    const first = runInOrder(queue, 'project', undefined, () => new Promise<void>(resolve => {
      finishFirst = () => {
        events.push('first finished');
        resolve();
      };
    }));
    const controller = new AbortController();
    const waiting = runInOrder(queue, 'project', controller.signal, async () => {
      events.push('aborted call ran');
    });
    controller.abort();
    await assert.rejects(waiting, /abort/i);
    assert.equal(queue.has('project'), true);
    const third = runInOrder(queue, 'project', undefined, async () => {
      events.push('third ran');
    });
    await delay(20);
    assert.deepEqual(events, []);
    finishFirst();
    await Promise.all([first, third]);
    assert.deepEqual(events, ['first finished', 'third ran']);
    await delay(0);
    assert.equal(queue.size, 0);
  });

  it('takes the place of a mutation in the same tick as the call, so calls run in call order', async () => {
    await withProjectCopy(async project => {
      let started = false;
      const running = withProjectMutation(project, undefined, async () => {
        started = true;
      });
      for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
      assert.equal(started, true);
      await running;
    });
  });

  it('ends a worker that never answers at the deadline, with a Fix line', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    const hanging = createWorkerValidator({ url: supportWorker('hanging-worker.mjs'), deadlineMs: 200 });
    await assert.rejects(hanging.projected(bundle), /did not answer in time.*Fix:/s);
  });

  it('does not hold the project queue during an inspo download, and keeps both changes', async () => {
    await withInspoProject(async project => {
      await inspoBlueprint({ project, operation: { type: 'add', id: 'ref-1', url: 'https://images.example.com/a.png', note: 'first' } }, undefined, pngFetcher());
      let releaseDownload: () => void = () => undefined;
      const download = new Promise<void>(resolve => {
        releaseDownload = resolve;
      });
      const stalled: InspoFetcher = {
        ...pngFetcher(),
        fetch: async (url, init) => {
          await download;
          return pngFetcher().fetch(url, init);
        }
      };
      const adding = inspoBlueprint({ project, operation: { type: 'add', id: 'ref-2', url: 'https://images.example.com/b.png', note: 'second' } }, undefined, stalled);
      await delay(50);
      await inspoBlueprint({ project, operation: { type: 'update', id: 'ref-1', note: 'changed during the download' } }, undefined, pngFetcher());
      releaseDownload();
      await adding;
      const inspo = JSON.parse(await readFile(path.join(project, 'inspo.json'), 'utf8'));
      assert.deepEqual(inspo.entries.map((entry: { id: string; note: string }) => [entry.id, entry.note]), [['ref-1', 'changed during the download'], ['ref-2', 'second']]);
    });
  });

  it('does not hold the project queue during an inspo sync, and keeps both changes', async () => {
    await withInspoProject(async project => {
      await inspoBlueprint({ project, operation: { type: 'add', id: 'ref-1', url: 'https://images.example.com/a.png', note: 'first' } }, undefined, pngFetcher());
      const imagePath = path.join(project, 'inspo', 'ref-1.png');
      await rm(imagePath);
      let releaseDownload: () => void = () => undefined;
      const download = new Promise<void>(resolve => {
        releaseDownload = resolve;
      });
      const stalled: InspoFetcher = {
        ...pngFetcher(),
        fetch: async (url, init) => {
          await download;
          return pngFetcher().fetch(url, init);
        }
      };
      const syncing = inspoBlueprint({ project, operation: { type: 'sync' } }, undefined, stalled);
      await delay(50);
      await inspoBlueprint({ project, operation: { type: 'update', id: 'ref-1', note: 'changed during the sync' } }, undefined, pngFetcher());
      releaseDownload();
      const synced = await syncing;
      assert.deepEqual(synced.downloaded, ['inspo/ref-1.png']);
      assert.equal(existsSync(imagePath), true);
      const inspo = JSON.parse(await readFile(path.join(project, 'inspo.json'), 'utf8'));
      assert.equal(inspo.entries[0].note, 'changed during the sync');
    });
  });

  it('reports an inspo entry id that another call took during the download, and writes no image', async () => {
    await withInspoProject(async project => {
      let releaseDownload: () => void = () => undefined;
      const download = new Promise<void>(resolve => {
        releaseDownload = resolve;
      });
      const stalled: InspoFetcher = {
        ...pngFetcher(),
        fetch: async (url, init) => {
          await download;
          return pngFetcher().fetch(url, init);
        }
      };
      const adding = inspoBlueprint({ project, operation: { type: 'add', id: 'shared', url: 'https://images.example.com/b.png', note: 'second' } }, undefined, stalled);
      await delay(50);
      await inspoBlueprint({ project, operation: { type: 'add', id: 'shared', url: 'https://images.example.com/a.jpg', note: 'first' } }, undefined, pngFetcher());
      releaseDownload();
      await assert.rejects(adding, /Inspo entry "shared" already exists/);
    });
  });

  it('ends an inspo download when the caller aborts during a hung address lookup, and frees the queue', async () => {
    await withInspoProject(async project => {
      const controller = new AbortController();
      const hung: InspoFetcher = { ...pngFetcher(), lookup: () => new Promise<string[]>(() => undefined) };
      const adding = inspoBlueprint({ project, operation: { type: 'add', id: 'ref-1', url: 'https://images.example.com/a.png', note: 'first' } }, controller.signal, hung);
      await delay(50);
      controller.abort();
      await assert.rejects(adding, /abort/i);
      await inspoBlueprint({ project, operation: { type: 'add', id: 'ref-2', url: 'https://images.example.com/b.png', note: 'second' } }, undefined, pngFetcher());
    });
  });
});

describe('validation memo and the disk', () => {
  it('reads the file list of the fingerprint, so a file change during validation cannot store a wrong result', async () => {
    await withProjectCopy(async project => {
      const bundle = await loadProjectFromFs(project);
      const session = new ProjectValidationSession(bundle, []);
      const style = bundle.screens.screens[0].prototype?.styles[0];
      assert.ok(style);
      await rename(path.join(project, style), path.join(project, `${style}.moved`));
      assert.deepEqual(session.result('baseline').errors, []);
      const later = await loadProjectFromFs(project).catch(() => undefined);
      if (later) {
        const fresh = new ProjectValidationSession(later, [session.memo]);
        assert.notEqual(fresh.memo.fingerprint, session.memo.fingerprint);
      }
    });
  });

  it('lets a caller give the file check of a validation', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    assert.equal(validateProject(bundle, { fileExists: () => true }).ok, true);
    const missing = validateProject(bundle, { fileExists: () => false });
    assert.ok(missing.errors.some(error => error.includes('does not exist')));
  });
});

describe('source graph memo after a token value edit', () => {
  const changed = (bundle: BlueprintProjectBundle, change: (next: BlueprintProjectBundle) => void): BlueprintProjectBundle => {
    const next = structuredClone(bundle);
    change(next);
    return next;
  };
  const setFirstToken = (value: string) => (next: BlueprintProjectBundle): void => {
    next.tokens.tokenGroups[0].tokens[0].value = value;
  };

  it('compiles nothing for an edit of a safe token value', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    const first = new ProjectValidationSession(bundle, []);
    assert.deepEqual(first.sourceGraphIssues(), []);
    assert.deepEqual(first.runs, ['source-graph']);
    const edited = changed(bundle, setFirstToken('#123456'));
    const next = new ProjectValidationSession(edited, [first.memo]);
    assert.notEqual(next.memo.fingerprint, first.memo.fingerprint);
    assert.deepEqual(next.sourceGraphIssues(), inspectPrototypeSourceGraph(edited));
    assert.deepEqual(next.runs, []);
    const later = new ProjectValidationSession(changed(bundle, setFirstToken('#654321')), [next.memo]);
    later.sourceGraphIssues();
    assert.deepEqual(later.runs, []);
  });

  it('compiles again for an unsafe token value, and again after the fix', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    const first = new ProjectValidationSession(bundle, []);
    first.sourceGraphIssues();
    const unsafe = new ProjectValidationSession(changed(bundle, setFirstToken('red; }')), [first.memo]);
    assert.ok(unsafe.sourceGraphIssues().length > 0);
    assert.deepEqual(unsafe.runs, ['source-graph']);
    const fixed = new ProjectValidationSession(changed(bundle, setFirstToken('#123456')), [unsafe.memo]);
    assert.deepEqual(fixed.sourceGraphIssues(), []);
    assert.deepEqual(fixed.runs, ['source-graph']);
  });

  it('compiles again when anything other than a token value changes', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    const first = new ProjectValidationSession(bundle, []);
    first.sourceGraphIssues();
    const source = Object.keys(bundle.prototypeSourceContents)[0];
    const edits: Array<[string, (next: BlueprintProjectBundle) => void]> = [
      ['a source file', next => { next.prototypeSourceContents[source] = `${next.prototypeSourceContents[source]} `; }],
      ['a styleRef', next => { next.tokens.tokenGroups[0].tokens[0].styleRef = '--renamed-token'; }],
      ['a token id', next => { next.tokens.tokenGroups[0].tokens[0].id = 'renamed-token'; }],
      ['a token value and a screen name', next => {
        setFirstToken('#123456')(next);
        next.screens.screens[0].name = 'Renamed';
      }]
    ];
    for (const [name, change] of edits) {
      const next = new ProjectValidationSession(changed(bundle, change), [first.memo]);
      next.sourceGraphIssues();
      assert.deepEqual(next.runs, ['source-graph'], name);
    }
  });
});

async function waitForError(served: BlueprintServeHandle): Promise<void> {
  await waitUntil(async () => (await served.settledProject!())?.error !== undefined);
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() > deadline) assert.fail('The condition did not hold in time.');
    await delay(25);
  }
}

function recordRuns(): { of: (fingerprint: string) => ValidationRun[]; stop: () => void } {
  const seen: ProjectValidationRunMessage[] = [];
  const listener = (message: unknown): void => {
    seen.push(message as ProjectValidationRunMessage);
  };
  subscribe(projectValidationRuns.name, listener);
  return {
    of: fingerprint => seen.filter(message => message.fingerprint === fingerprint).map(message => message.run).sort(),
    stop: () => {
      unsubscribe(projectValidationRuns.name, listener);
    }
  };
}

function recordWorkers(): { started: Worker[]; stop: () => void } {
  const started: Worker[] = [];
  const listener = (message: unknown): void => {
    started.push((message as { worker: Worker }).worker);
  };
  subscribe('worker_threads', listener);
  return { started, stop: () => { unsubscribe('worker_threads', listener); } };
}

async function assertAbortStopsWorker(
  call: (signal: AbortSignal) => Promise<unknown>,
  { skipWorkers = 0 }: { skipWorkers?: number } = {}
): Promise<void> {
  const exits = new Map<Worker, Promise<void>>();
  const controller = new AbortController();
  const listener = (message: unknown): void => {
    const { worker } = message as { worker: Worker };
    exits.set(worker, new Promise(resolve => worker.once('exit', () => resolve())));
    if (exits.size > skipWorkers) setImmediate(() => controller.abort(new Error('Stopped by the test.')));
  };
  subscribe('worker_threads', listener);
  try {
    await assert.rejects(call(controller.signal), /Stopped by the test\./);
    assert.ok(exits.size > skipWorkers, 'A worker started.');
    const stopped = await Promise.race([Promise.all(exits.values()).then(() => 'stopped'), delay(10_000, 'running')]);
    assert.equal(stopped, 'stopped', 'The worker stops after the abort.');
  } finally {
    unsubscribe('worker_threads', listener);
    await Promise.all([...exits.keys()].map(worker => worker.terminate()));
  }
}

async function directoryTimes(root: string): Promise<Record<string, number>> {
  const times: Record<string, number> = { [root]: (await stat(root)).mtimeMs };
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) Object.assign(times, await directoryTimes(path.join(root, entry.name)));
  }
  return times;
}

async function breakTokensProjectId(project: string): Promise<void> {
  const tokensPath = path.join(project, 'tokens.json');
  const tokens = JSON.parse(await readFile(tokensPath, 'utf8'));
  await writeFile(tokensPath, `${JSON.stringify({ ...tokens, projectId: 'someone-else' }, null, 2)}\n`);
}

// The memo holds results by content, so a plain copy of a fixture can hit the entry of an earlier test.
async function withUnvalidatedProjectCopy<T>(run: (project: string) => Promise<T>): Promise<T> {
  return withProjectCopy(async project => {
    await renameProject(project, `Copy ${randomUUID()}`);
    return run(project);
  });
}

async function renameProject(project: string, name: string): Promise<void> {
  const manifestPath = path.join(project, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.project.name = name;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function firstQueryResult(project: string, query: QueryInput['query']): Promise<unknown> {
  const output = await queryBlueprint({ project, query });
  return 'results' in output ? output.results[0] : undefined;
}

async function promoteInput(project: string, explorationId: string) {
  const inspection = await firstQueryResult(project, { type: 'exploration', explorationId }) as {
    exploration: { target: { baseDigest: string } };
    currentDigest: string;
    candidateDigests: Record<string, string>;
  };
  return {
    project,
    explorationId,
    candidateId: 'b',
    expectedBaseDigest: inspection.exploration.target.baseDigest,
    expectedCurrentDigest: inspection.currentDigest,
    expectedCandidateDigest: inspection.candidateDigests.b!
  };
}

async function restoreInput(project: string) {
  const version = await firstQueryResult(project, { type: 'history-version', screenId: 'launch', version: 1 }) as {
    currentDigest: string;
    versionDigest: string;
  };
  return {
    project,
    screenId: 'launch',
    version: 1,
    expectedCurrentDigest: version.currentDigest,
    expectedVersionDigest: version.versionDigest
  };
}

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

function hubExploration(id: string) {
  return { ...launchExploration(id), screenId: 'hub', framePresetId: 'phone' };
}

function pngFetcher(): InspoFetcher {
  return {
    fetch: async () => new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } }),
    lookup: async () => ['93.184.216.34']
  };
}

async function withInspoProject(run: (project: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-validation-worker-'));
  try {
    const project = path.join(tempDir, 'app', 'design', 'blueprint');
    await initializeBlueprint({ projectId: 'app', name: `App ${randomUUID()}`, out: project, force: false, start: 'inspo' });
    await run(project);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}


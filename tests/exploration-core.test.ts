import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  archiveExploration,
  computeCanonicalScreenDigest,
  computeExplorationCandidateDigest,
  computeHistoryVersionDigest,
  createExplorationMetadata,
  inspectExploration,
  inspectScreenHistory,
  listExplorations,
  listScreenHistory,
  promoteExploration,
  restoreScreenHistory,
  type ExplorationMutationResult,
  type PromotionResult,
  type RestoreHistoryResult
} from '../src/core/exploration';
import { loadProjectFromFs } from '../src/core/load';
import {
  explorationRecordFile,
  explorationRecordRef,
  historyRecordFile,
  historyRecordRef
} from '../src/core/storage-records';
import type { BlueprintProjectBundle } from '../src/core/types';
import { validateProject } from '../src/core/validate';

const miraRoot = 'fixtures/valid/mira-ai/design/blueprint';
const meridianRoot = 'fixtures/valid/meridian-finance/design/blueprint';
const workspaceTarget = { screenId: 'workspace', state: 'default', framePresetId: 'desktop-web' };
const transferTarget = { screenId: 'transfer', state: 'review', framePresetId: 'desktop-web' };

describe('persistent screen exploration core', () => {
  it('keeps explorations optional and outside canonical screen boundaries', async () => {
    const bundle = await loadProjectFromFs(miraRoot);

    assert.deepEqual(bundle.explorations.explorations, []);
    assert.deepEqual(bundle.sourceFiles.explorationRecords, []);
    assert.deepEqual(bundle.sourceFiles.historyRecords, []);
    assert.deepEqual(bundle.sourceFiles.explorationSources, []);
    assert.deepEqual(bundle.sourceFiles.historySources, []);
    assert.deepEqual(bundle.history.entries, []);
    assert.deepEqual(bundle.screens.screens.map(screen => screen.id), ['workspace', 'chat']);
    assert.equal(validateProject(bundle).ok, true);
  });

  it('persists and reloads a baseline plus 2-5 deterministic candidate copies through governed loading', async () => {
    await withFixture(miraRoot, async root => {
      const bundle = await loadProjectFromFs(root);
      const created = createExplorationMetadata(bundle, {
        ...workspaceTarget,
        title: 'A very long exploration title intended to prove generated identifiers remain safely bounded for filesystem use',
        intent: 'Compare thread density.',
        candidateLabels: ['A', 'B', 'C']
      });

      assert.ok(created.exploration.id.length <= 64);
      assert.match(created.exploration.id, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
      assert.equal(created.sourceWrites.length, 8, 'baseline and three candidates should each copy HTML and CSS');
      await persistExplorationMutation(root, created);

      const reloaded = await loadProjectFromFs(root);
      const validation = validateProject(reloaded);
      assert.equal(validation.ok, true, validation.errors.join('\n'));
      assert.equal(reloaded.explorations.explorations.length, 1);
      assert.equal(reloaded.sourceFiles.explorationRecords.length, 1);
      assert.equal(reloaded.sourceFiles.explorationSources.length, 8);
      assert.equal(reloaded.sourceFiles.prototypeSources.length, bundle.sourceFiles.prototypeSources.length);
      assert.deepEqual(reloaded.screens.screens.map(screen => screen.id), ['workspace', 'chat']);
      assert.deepEqual(listExplorations(reloaded)[0]?.candidates.map(candidate => candidate.label), ['A', 'B', 'C']);
      assert.equal(inspectExploration(reloaded, created.exploration.id).currentDigest, created.exploration.target.baseDigest);
    });
  });

  it('rejects ambiguous active targets and invalid pairing, IDs, labels, lifecycles, digests, and sources', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    assert.throws(() => createExplorationMetadata(bundle, {
      screenId: 'workspace',
      state: 'loading',
      framePresetId: 'desktop-web',
      title: 'Wrong state',
      intent: 'Invalid pairing.',
      candidateLabels: ['A', 'B']
    }), /does not declare review state/);
    assert.throws(() => createExplorationMetadata(bundle, {
      id: '../unsafe',
      ...workspaceTarget,
      title: 'Unsafe',
      intent: 'Invalid id.',
      candidateLabels: ['A', 'B']
    }), /must use 1-64 lowercase/);
    assert.throws(() => createExplorationMetadata(bundle, {
      ...workspaceTarget,
      title: 'Duplicate labels',
      intent: 'Invalid labels.',
      candidateLabels: ['A', 'a']
    }), /Duplicate candidate label/);

    const created = createExplorationMetadata(bundle, explorationInput('uniqueness'));
    const activeBundle = applyMutation(bundle, created);
    assert.throws(() => createExplorationMetadata(activeBundle, explorationInput('second')), /already has active exploration/);

    const invalid = structuredClone(activeBundle);
    const exploration = invalid.explorations.explorations[0]!;
    exploration.lifecycle = 'archived';
    exploration.selectedCandidateId = exploration.candidates[0]!.id;
    exploration.target.baseDigest = '0'.repeat(64);
    exploration.candidates[1]!.id = exploration.candidates[0]!.id;
    exploration.candidates[1]!.label = exploration.candidates[0]!.label;
    delete invalid.prototypeSourceContents[exploration.candidates[0]!.prototype.source];
    const errors = validateProject(invalid).errors.join('\n');
    assert.match(errors, /baseDigest is stale/);
    assert.match(errors, /duplicate candidate id/);
    assert.match(errors, /duplicate candidate label/);
    assert.match(errors, /missing or empty/);
    assert.match(errors, /only when lifecycle is "promoted"/);
  });

  it('archives without deleting candidate sources', async () => {
    const bundle = await loadProjectFromFs(miraRoot);
    const created = createExplorationMetadata(bundle, explorationInput('archive'));
    const activeBundle = applyMutation(bundle, created);
    const before = structuredClone(activeBundle.prototypeSourceContents);

    const archived = archiveExploration(activeBundle, created.exploration.id);

    assert.equal(archived.exploration.lifecycle, 'archived');
    assert.deepEqual(archived.prototypeSourceContents, before);
    assert.deepEqual(archived.sourceWrites, []);
    assert.equal(activeBundle.explorations.explorations[0]?.lifecycle, 'active', 'archive must be atomic in memory');
  });

  it('rejects stale promotion digests, stores V1 outside screens.json, and restores it without losing V2', async () => {
    await withFixture(meridianRoot, async root => {
      const original = await loadProjectFromFs(root);
      const created = createExplorationMetadata(original, explorationInput('promotion', transferTarget));
      await persistExplorationMutation(root, created);
      const bundle = await loadProjectFromFs(root);
      const exploration = bundle.explorations.explorations.find(candidate => candidate.id === created.exploration.id)!;
      const candidate = exploration.candidates[1]!;
      const candidateHtml = bundle.prototypeSourceContents[candidate.prototype.source]!.replace(
        'Approve this wire',
        'Approve this selected wire'
      );
      bundle.prototypeSourceContents[candidate.prototype.source] = candidateHtml;
      await writeFile(path.join(root, candidate.prototype.source), candidateHtml);

      const expectedCurrentDigest = computeCanonicalScreenDigest(bundle, 'transfer');
      const expectedCandidateDigest = computeExplorationCandidateDigest(bundle, exploration.id, candidate.id);
      const input = {
        explorationId: exploration.id,
        candidateId: candidate.id,
        expectedBaseDigest: exploration.target.baseDigest,
        expectedCurrentDigest,
        expectedCandidateDigest
      };
      assert.throws(() => promoteExploration(bundle, { ...input, expectedCurrentDigest: '0'.repeat(64) }), /expectedCurrentDigest is stale/);
      assert.throws(() => promoteExploration(bundle, { ...input, expectedCandidateDigest: '0'.repeat(64) }), /expectedCandidateDigest is stale/);

      const promoted = promoteExploration(bundle, input);
      assert.equal(bundle.screens.screens.find(screen => screen.id === 'transfer')?.version, undefined, 'promotion must not mutate its input bundle');
      assert.equal(promoted.promotedScreen.id, 'transfer');
      assert.equal(promoted.promotedScreen.version, undefined);
      assert.equal(promoted.historicalVersion.screenId, 'transfer');
      assert.equal(promoted.historicalVersion.version, 1);
      assert.equal(promoted.historicalVersion.screen.id, 'transfer');
      assert.equal(promoted.exploration.lifecycle, 'promoted');
      assert.equal(promoted.exploration.selectedCandidateId, candidate.id);
      assert.equal(promoted.exploration.promotedScreenId, 'transfer');
      assert.match(promoted.prototypeSourceContents['prototype/screens/transfer.html'] ?? '', /Approve this selected wire/);

      await persistPromotion(root, promoted);
      const reloaded = await loadProjectFromFs(root);
      const validation = validateProject(reloaded);
      assert.equal(validation.ok, true, validation.errors.join('\n'));
      const strictValidation = validateProject(reloaded, { mode: 'strict' });
      assert.equal(strictValidation.ok, true, strictValidation.errors.join('\n'));
      assert.deepEqual(
        reloaded.screens.screens.map(screen => ({ id: screen.id, version: screen.version })),
        original.screens.screens.map(screen => ({ id: screen.id, version: screen.version }))
      );
      assert.equal(reloaded.history.entries.length, original.history.entries.length + 1);
      assert.equal(reloaded.sourceFiles.historyRecords.length, original.sourceFiles.historyRecords.length + 1);
      assert.equal(listScreenHistory(reloaded, 'transfer')[0]?.version, 1);
      assert.equal(reloaded.explorations.explorations.find(candidate => candidate.id === exploration.id)?.lifecycle, 'promoted');

      const inspectedV1 = inspectScreenHistory(reloaded, 'transfer', 1);
      const restored = restoreScreenHistory(reloaded, {
        screenId: 'transfer',
        version: 1,
        expectedCurrentDigest: inspectedV1.currentDigest,
        expectedVersionDigest: inspectedV1.versionDigest
      });
      assert.equal(restored.historicalVersion.version, 2);
      assert.equal(restored.historicalVersion.replacedBy.type, 'history-restore');
      assert.match(restored.prototypeSourceContents['prototype/screens/transfer.html'] ?? '', /Approve this wire/);
      assert.throws(() => restoreScreenHistory(reloaded, {
        screenId: 'transfer',
        version: 1,
        expectedCurrentDigest: '0'.repeat(64),
        expectedVersionDigest: computeHistoryVersionDigest(reloaded, 'transfer', 1)
      }), /expectedCurrentDigest is stale/);
      await persistRestore(root, reloaded.manifest.project.id, restored);
      const restoredReloaded = await loadProjectFromFs(root);
      assert.equal(validateProject(restoredReloaded).ok, true);
      assert.deepEqual(listScreenHistory(restoredReloaded, 'transfer').map(entry => entry.version), [2, 1]);

      const nextCreated = createExplorationMetadata(restoredReloaded, explorationInput('promotion-next', transferTarget));
      const nextBundle = applyMutation(restoredReloaded, nextCreated);
      const nextCandidate = nextCreated.exploration.candidates[0]!;
      const nextPromoted = promoteExploration(nextBundle, {
        explorationId: nextCreated.exploration.id,
        candidateId: nextCandidate.id,
        expectedBaseDigest: nextCreated.exploration.target.baseDigest,
        expectedCurrentDigest: computeCanonicalScreenDigest(nextBundle, 'transfer'),
        expectedCandidateDigest: computeExplorationCandidateDigest(nextBundle, nextCreated.exploration.id, nextCandidate.id)
      });
      assert.equal(nextPromoted.promotedScreen.version, undefined);
      assert.equal(nextPromoted.historicalVersion.version, 3);
    });
  });
});

function explorationInput(title: string, target = workspaceTarget) {
  return {
    ...target,
    title,
    intent: 'Compare the layout.',
    candidateLabels: ['A', 'B', 'C']
  };
}

function applyMutation(bundle: BlueprintProjectBundle, mutation: ExplorationMutationResult): BlueprintProjectBundle {
  return {
    ...structuredClone(bundle),
    explorations: structuredClone(mutation.explorations),
    prototypeSourceContents: { ...mutation.prototypeSourceContents }
  };
}

async function persistExplorationMutation(root: string, mutation: ExplorationMutationResult): Promise<void> {
  const projectId = mutation.explorations.projectId;
  const recordRef = explorationRecordRef(mutation.exploration.id);
  await mkdir(path.dirname(path.join(root, recordRef)), { recursive: true });
  await writeFile(
    path.join(root, recordRef),
    `${JSON.stringify(explorationRecordFile(projectId, mutation.exploration), null, 2)}\n`
  );
  await persistSourceWrites(root, mutation.sourceWrites);
}

async function persistPromotion(root: string, mutation: PromotionResult): Promise<void> {
  await writeFile(path.join(root, 'screens.json'), `${JSON.stringify(mutation.screens, null, 2)}\n`);
  const explorationRef = explorationRecordRef(mutation.exploration.id);
  const historyRef = historyRecordRef(mutation.historicalVersion.screenId, mutation.historicalVersion.version);
  await mkdir(path.dirname(path.join(root, explorationRef)), { recursive: true });
  await mkdir(path.dirname(path.join(root, historyRef)), { recursive: true });
  await writeFile(
    path.join(root, explorationRef),
    `${JSON.stringify(explorationRecordFile(mutation.explorations.projectId, mutation.exploration), null, 2)}\n`
  );
  await writeFile(
    path.join(root, historyRef),
    `${JSON.stringify(historyRecordFile(mutation.history.projectId, mutation.historicalVersion), null, 2)}\n`
  );
  await persistSourceWrites(root, mutation.sourceWrites);
}

async function persistRestore(root: string, projectId: string, mutation: RestoreHistoryResult): Promise<void> {
  await writeFile(path.join(root, 'screens.json'), `${JSON.stringify(mutation.screens, null, 2)}\n`);
  const historyRef = historyRecordRef(mutation.historicalVersion.screenId, mutation.historicalVersion.version);
  await mkdir(path.dirname(path.join(root, historyRef)), { recursive: true });
  await writeFile(
    path.join(root, historyRef),
    `${JSON.stringify(historyRecordFile(projectId, mutation.historicalVersion), null, 2)}\n`
  );
  await persistSourceWrites(root, mutation.sourceWrites);
}

async function persistSourceWrites(root: string, writes: ExplorationMutationResult['sourceWrites']): Promise<void> {
  for (const write of writes) {
    const absolutePath = path.join(root, write.path);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, write.content);
  }
}

async function withFixture(fixtureRoot: string, run: (root: string) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'blueprint-exploration-'));
  const root = path.join(tempRoot, 'design', 'blueprint');
  try {
    await cp(fixtureRoot, root, { recursive: true });
    await run(root);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

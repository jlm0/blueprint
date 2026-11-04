import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import type { BlueprintProjectBundle, ValidationResult } from '../src/core/types';
import { createReadinessReport, validateProject, validateProjectReadiness } from '../src/prototype/validate-project';
import type { InspoFetcher } from '../src/mcp/inspo-download';
import type { ProjectValidator } from '../src/mcp/project-validation';
import { inProcessValidator } from './support/in-process-validator';
import type { QueryInput } from '../src/mcp/schemas';
import {
  exploreBlueprint,
  initializeBlueprint,
  inspoBlueprint,
  promoteBlueprint,
  queryBlueprint,
  restoreBlueprint,
  validateBlueprint
} from '../src/mcp/operations';

const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('readiness validation', () => {
  it('runs the prototype source graph once for the baseline and the readiness report', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    let runs = 0;
    const { baseline, readiness } = validateProjectReadiness(bundle, () => {
      runs += 1;
      return [{ boundaryId: 'umbra-gaming/screen/launch', state: 'default', message: 'stub failure' }];
    });
    assert.equal(runs, 1);
    assert.ok(baseline.errors.includes('Prototype source graph umbra-gaming/screen/launch state "default" cannot compile: stub failure'));
    assert.ok(readiness.blockers.some(item => item.path === 'prototypeSourceGraph.umbra-gaming/screen/launch.default'));

    assert.deepEqual(validateProjectReadiness(bundle), {
      baseline: validateProject(bundle),
      readiness: createReadinessReport(bundle)
    });
  });

  it('keeps the readiness output of the validate tool', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    const output = await validateBlueprint({ project: umbraRoot, mode: 'readiness' });
    assert.equal(output.mode, 'readiness');
    assert.deepEqual(output.errors, validateProject(bundle).errors);
    assert.deepEqual(output.mode === 'readiness' ? output.readiness : undefined, createReadinessReport(bundle));
  });
});

describe('mutation validation', () => {
  it('validates explore, promote, restore, and inspo once each when the written files match the projection', async () => {
    await withProjectCopy(async project => {
      const counter = countingValidator();
      await exploreBlueprint({ project, operation: launchExploration('launch-hero') }, undefined, counter.validate);
      assert.equal(counter.take(), 1, 'explore create');

      const inspection = await firstQueryResult(project, { type: 'exploration', explorationId: 'launch-hero' }) as {
        exploration: { target: { baseDigest: string } };
        currentDigest: string;
        candidateDigests: Record<string, string>;
      };
      await promoteBlueprint({
        project,
        explorationId: 'launch-hero',
        candidateId: 'b',
        expectedBaseDigest: inspection.exploration.target.baseDigest,
        expectedCurrentDigest: inspection.currentDigest,
        expectedCandidateDigest: inspection.candidateDigests.b!
      }, undefined, counter.validate);
      assert.equal(counter.take(), 1, 'promote');

      const version = await firstQueryResult(project, { type: 'history-version', screenId: 'launch', version: 1 }) as {
        currentDigest: string;
        versionDigest: string;
      };
      await restoreBlueprint({
        project,
        screenId: 'launch',
        version: 1,
        expectedCurrentDigest: version.currentDigest,
        expectedVersionDigest: version.versionDigest
      }, undefined, counter.validate);
      assert.equal(counter.take(), 1, 'restore');

      await exploreBlueprint({ project, operation: launchExploration('launch-copy') }, undefined, counter.validate);
      await exploreBlueprint({ project, operation: { type: 'archive', explorationId: 'launch-copy' } }, undefined, counter.validate);
      assert.equal(counter.take(), 2, 'explore create and archive');
      assert.equal(validateProject(await loadProjectFromFs(project)).ok, true);
    });

    const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-validate-once-'));
    try {
      const out = path.join(tempDir, 'app', 'design', 'blueprint');
      await initializeBlueprint({ projectId: 'app', name: 'App', out, force: false, start: 'inspo' });
      const counter = countingValidator();
      await inspoBlueprint({
        project: out,
        operation: { type: 'add', url: 'https://images.example.com/a.png', aspects: ['mark'], note: 'this mark' }
      }, undefined, pngFetcher(), counter.validate);
      assert.equal(counter.take(), 1, 'inspo add');
      await inspoBlueprint({ project: out, operation: { type: 'update', id: 'ref-1', reading: 'A round mark.' } }, undefined, pngFetcher(), counter.validate);
      assert.equal(counter.take(), 1, 'inspo update');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('validates the written files in full when they differ from the projection, and rolls back an invalid result', async () => {
    await withProjectCopy(async project => {
      const tokensPath = path.join(project, 'tokens.json');
      let calls = 0;
      const validate = (bundle: BlueprintProjectBundle): ValidationResult => {
        calls += 1;
        if (calls === 1) {
          const tokens = JSON.parse(readFileSync(tokensPath, 'utf8'));
          writeFileSync(tokensPath, `${JSON.stringify({ ...tokens, projectId: 'someone-else' }, null, 2)}\n`, 'utf8');
        }
        return validateProject(bundle);
      };
      await assert.rejects(
        exploreBlueprint({ project, operation: launchExploration('launch-hero') }, undefined, inProcessValidator(validate)),
        /Persisted exploration mutation failed baseline validation:[\s\S]*tokens\.projectId "someone-else"/
      );
      assert.equal(calls, 2);
      assert.equal(existsSync(path.join(project, 'explorations', 'launch-hero.json')), false);
    });
  });
});

async function firstQueryResult(project: string, query: QueryInput['query']): Promise<unknown> {
  const output = await queryBlueprint({ project, query });
  return 'results' in output ? output.results[0] : undefined;
}

function countingValidator(): { validate: ProjectValidator; take: () => number } {
  let calls = 0;
  return {
    validate: inProcessValidator(bundle => {
      calls += 1;
      return validateProject(bundle);
    }),
    take: () => {
      const taken = calls;
      calls = 0;
      return taken;
    }
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

function pngFetcher(): InspoFetcher {
  return {
    fetch: async () => new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } }),
    lookup: async () => ['93.184.216.34']
  };
}

async function withProjectCopy(run: (project: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-validate-once-'));
  try {
    const project = path.join(tempDir, 'design', 'blueprint');
    await cp(umbraRoot, project, { recursive: true });
    await run(project);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

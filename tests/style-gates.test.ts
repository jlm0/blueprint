import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { readValidatedProject } from '../src/mcp/project-validation-worker';
import {
  exploreBlueprint,
  initializeBlueprint,
  inspoBlueprint,
  promoteBlueprint,
  queryBlueprint,
  restoreBlueprint
} from '../src/mcp/operations';
import type { QueryInput } from '../src/mcp/schemas';
import { validateProject } from '../src/prototype/validate-project';
import { inProcessValidator } from './support/in-process-validator';
import { withProjectCopy } from './support/project-copies';

const MERIDIAN = 'fixtures/valid/meridian-finance/design/blueprint';
const IMPORTANT_RULE = '{ margin: 0 !important; }';

async function appendRule(project: string, file: string, selector: string): Promise<void> {
  const target = path.join(project, file);
  await writeFile(target, `${await readFile(target, 'utf8')}\n${selector} ${IMPORTANT_RULE}\n`);
}

async function queryFirst(project: string, query: QueryInput['query']): Promise<Record<string, any>> {
  const output = await queryBlueprint({ project, query }) as { results: Array<Record<string, any>> };
  return output.results[0]!;
}

async function promoteInput(project: string, explorationId: string, candidateId: string) {
  const inspection = await queryFirst(project, { type: 'exploration', explorationId });
  return {
    project,
    explorationId,
    candidateId,
    expectedBaseDigest: inspection.exploration.target.baseDigest as string,
    expectedCurrentDigest: inspection.currentDigest as string,
    expectedCandidateDigest: inspection.candidateDigests[candidateId] as string
  };
}

async function restoreInput(project: string, screenId: string, version: number) {
  const inspection = await queryFirst(project, { type: 'history-version', screenId, version });
  return {
    project,
    screenId,
    version,
    expectedCurrentDigest: inspection.currentDigest as string,
    expectedVersionDigest: inspection.versionDigest as string
  };
}

describe('the gates read one validation result', () => {
  it('opens a project with only style errors for the canvas, and reports the errors', async () => {
    await withProjectCopy(async project => {
      await appendRule(project, 'prototype/screens/launch.css', '[data-blueprint-screen="launch"]');
      const read = await readValidatedProject(project);
      assert.equal(read.error, undefined);
      assert.equal(read.bundle?.manifest.project.id, 'umbra-gaming');
      assert.deepEqual(read.styleErrors, ['screen.launch prototype/screens/launch.css margin: "0 !important" uses !important. Fix: delete !important from this declaration in prototype/screens/launch.css.']);
    });
  });

  it('stops the canvas on a contract error, and names only the contract errors there', async () => {
    await withProjectCopy(async project => {
      await appendRule(project, 'prototype/screens/launch.css', '[data-blueprint-screen="launch"]');
      const tokensPath = path.join(project, 'tokens.json');
      const tokens = JSON.parse(await readFile(tokensPath, 'utf8'));
      tokens.projectId = 'someone-else';
      await writeFile(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`);
      const read = await readValidatedProject(project);
      assert.equal(read.bundle, undefined);
      assert.match(read.error ?? '', /tokens\.projectId "someone-else"/);
      assert.doesNotMatch(read.error ?? '', /uses !important/);
      assert.equal(read.styleErrors.length, 1);
    });
  });

  it('lets inspo write through a style error, and refuses a contract error', async () => {
    await withProjectCopy(async project => {
      await initializeBlueprint({ projectId: 'app', name: 'App', out: path.join(project, 'app', 'design', 'blueprint'), force: false, start: 'inspo' });
      const sidecar = path.join(project, 'app', 'design', 'blueprint');
      await appendRule(sidecar, 'prototype/primitives/icon.css', '[data-blueprint-primitive="icon"]');
      assert.deepEqual(validateProject(await loadProjectFromFs(sidecar)).contractErrors, []);
      const written = await inspoBlueprint({ project: sidecar, operation: { type: 'sync' } });
      assert.equal(written.command, 'inspo');

      const tokensPath = path.join(sidecar, 'tokens.json');
      const tokens = JSON.parse(await readFile(tokensPath, 'utf8'));
      tokens.projectId = 'someone-else';
      await writeFile(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`);
      await assert.rejects(inspoBlueprint({ project: sidecar, operation: { type: 'sync' } }), /tokens\.projectId "someone-else"/);
    });
  });

  it('refuses explore on a style error', async () => {
    await withProjectCopy(async project => {
      await appendRule(project, 'prototype/screens/launch.css', '[data-blueprint-screen="launch"]');
      await assert.rejects(exploreBlueprint({
        project,
        operation: {
          type: 'create',
          id: 'launch-hero',
          screenId: 'launch',
          state: 'default',
          framePresetId: 'desktop-web-page',
          title: 'Launch hero',
          intent: 'Compare hero directions without changing the canonical canvas.',
          candidateLabels: ['A', 'B']
        }
      }), /uses !important/);
    });
  });
});

describe('explore archive refuses only the errors that it adds', () => {
  const archive = (project: string, explorationId: string, validate?: Parameters<typeof exploreBlueprint>[2]) => (
    exploreBlueprint({ project, operation: { type: 'archive', explorationId } }, undefined, validate)
  );
  const lifecycle = async (project: string, explorationId: string): Promise<string> => (
    JSON.parse(await readFile(path.join(project, `explorations/${explorationId}.json`), 'utf8')).exploration.lifecycle
  );

  it('archives each of two active explorations that hold one candidate error each', async () => {
    await withProjectCopy(async project => {
      const created = await exploreBlueprint({
        project,
        operation: {
          type: 'create',
          id: 'home-hero-layout',
          screenId: 'home',
          state: 'default',
          framePresetId: 'phone',
          title: 'Home hero layout',
          intent: 'Compare two hero layouts.',
          candidateLabels: ['Stacked', 'Split']
        }
      });
      const candidateSheet = created.exploration.candidates[0].prototype.styles.find(style => style.includes('.exploration-'))!;
      await appendRule(project, 'prototype/screens/transactions.exploration-ledger-density-compact.css', '[data-blueprint-screen="transactions"]');
      await appendRule(project, candidateSheet, '[data-blueprint-screen="home"]');
      assert.equal(validateProject(await loadProjectFromFs(project)).styleErrors.length, 2);

      await archive(project, 'ledger-density');
      assert.equal(await lifecycle(project, 'ledger-density'), 'archived');
      await archive(project, 'home-hero-layout');
      assert.equal(await lifecycle(project, 'home-hero-layout'), 'archived');
    }, MERIDIAN);
  });

  it('archives a clean exploration while a canonical style error stays', async () => {
    await withProjectCopy(async project => {
      await appendRule(project, 'prototype/screens/overview.css', '[data-blueprint-screen="overview"]');
      assert.equal(validateProject(await loadProjectFromFs(project)).styleErrors.length, 1);

      await archive(project, 'ledger-density');
      assert.equal(await lifecycle(project, 'ledger-density'), 'archived');
    }, MERIDIAN);
  });

  it('refuses an archive that adds an error, names only that error, and writes nothing', async () => {
    await withProjectCopy(async project => {
      await appendRule(project, 'prototype/screens/overview.css', '[data-blueprint-screen="overview"]');
      const added = 'exploration.ledger-density: the archive added this error. Fix: delete the archive call.';
      // No rule reads the lifecycle of an archived exploration today, so only a validator seam can make an archive add an error.
      const validate = inProcessValidator(bundle => {
        const result = validateProject(bundle);
        const archived = bundle.explorations.explorations.some(exploration => exploration.id === 'ledger-density' && exploration.lifecycle === 'archived');
        return archived ? { ...result, ok: false, errors: [...result.errors, added], styleErrors: [...result.styleErrors, added] } : result;
      });
      const record = path.join(project, 'explorations/ledger-density.json');
      const before = await readFile(record, 'utf8');

      await assert.rejects(archive(project, 'ledger-density', validate), (error: Error) => {
        assert.equal(error.message, `The change adds the errors below, so Blueprint wrote nothing. Fix: correct each error below, then call the tool again.\n${added}`);
        return true;
      });
      assert.equal(await readFile(record, 'utf8'), before);
    }, MERIDIAN);
  });
});

describe('validate agrees with promote and restore', () => {
  for (const candidateId of ['comfortable', 'compact'] as const) {
    it(`promotes the meridian candidate ${candidateId}`, async () => {
      await withProjectCopy(async project => {
        const expected = await readFile(path.join(project, `prototype/screens/transactions.exploration-ledger-density-${candidateId}.html`), 'utf8');
        const output = await promoteBlueprint(await promoteInput(project, 'ledger-density', candidateId));
        assert.equal(output.candidateId, candidateId);
        assert.equal(await readFile(path.join(project, 'prototype/screens/transactions.html'), 'utf8'), expected);
        assert.deepEqual(validateProject(await loadProjectFromFs(project)).errors, []);
      }, MERIDIAN);
    });
  }

  it('refuses a candidate that fails a rule, and names the candidate file', async () => {
    await withProjectCopy(async project => {
      const file = 'prototype/screens/transactions.exploration-ledger-density-compact.css';
      await appendRule(project, file, '[data-blueprint-screen="transactions"]');
      const input = await promoteInput(project, 'ledger-density', 'compact');
      await assert.rejects(promoteBlueprint(input), (error: Error) => {
        assert.match(error.message, /^The change failed baseline validation, so Blueprint wrote nothing\. Fix: /);
        assert.ok(!error.message.includes('prototype/screens/transactions.css'), error.message);
        assert.ok(error.message.includes(`screen.transactions ${file} margin: "0 !important" uses !important. Fix: delete !important from this declaration in ${file}.`), error.message);
        return true;
      });
    }, MERIDIAN);
  });

  it('restores the meridian history record that passes each rule', async () => {
    await withProjectCopy(async project => {
      const output = await restoreBlueprint(await restoreInput(project, 'home', 1));
      assert.equal(output.restoredFromVersion, 1);
      assert.deepEqual(validateProject(await loadProjectFromFs(project)).errors, []);
    }, MERIDIAN);
  });

  it('refuses a history record that fails a rule, names the history file, and writes nothing', async () => {
    await withProjectCopy(async project => {
      const file = 'prototype/screens/home.history-home-v1.css';
      await appendRule(project, file, '[data-blueprint-screen="home"]');
      assert.deepEqual(validateProject(await loadProjectFromFs(project)).errors, [], 'validate does not read a history record');
      const before = await readFile(path.join(project, 'prototype/screens/home.css'), 'utf8');
      const input = await restoreInput(project, 'home', 1);
      await assert.rejects(restoreBlueprint(input), (error: Error) => {
        assert.match(error.message, /^The change failed baseline validation, so Blueprint wrote nothing\. Fix: /);
        assert.ok(!error.message.includes('prototype/screens/home.css'), error.message);
        assert.ok(error.message.includes(`screen.home ${file} margin: "0 !important" uses !important. Fix: delete !important from this declaration in ${file}.`), error.message);
        return true;
      });
      assert.equal(await readFile(path.join(project, 'prototype/screens/home.css'), 'utf8'), before);
    }, MERIDIAN);
  });

  it('lints a file that two candidates share once, and reports it for each candidate', async () => {
    const bundle = await loadProjectFromFs(MERIDIAN);
    const exploration = bundle.explorations.explorations.find(item => item.id === 'ledger-density')!;
    const [first, second] = exploration.candidates;
    const sheet = first.prototype.styles.find(file => file.includes('/screens/'))!;
    second.prototype = { ...second.prototype, source: first.prototype.source, styles: first.prototype.styles };
    bundle.prototypeSourceContents[sheet] += '\n[data-blueprint-screen="transactions"] { margin: 0 !important; }\n';
    const linted: string[] = [];
    const { styleErrors } = validateProject(bundle, { onCandidateFileLint: file => linted.push(file) });
    assert.deepEqual(linted.filter(file => file === sheet), [sheet]);
    assert.deepEqual(linted.filter(file => file === first.prototype.source), [first.prototype.source]);
    const expected = `screen.transactions ${sheet} margin: "0 !important" uses !important. Fix: delete !important from this declaration in ${sheet}.`;
    assert.deepEqual(styleErrors, [
      `exploration.ledger-density candidate.${first.id}: ${expected}`,
      `exploration.ledger-density candidate.${second.id}: ${expected}`
    ]);
  });

  it('reads a shared sheet again only when the other source forwards another class', async () => {
    const bundle = await loadProjectFromFs(MERIDIAN);
    const exploration = bundle.explorations.explorations.find(item => item.id === 'ledger-density')!;
    const [first, second] = exploration.candidates;
    const sheet = first.prototype.styles.find(file => file.includes('/screens/'))!;
    second.prototype = { ...second.prototype, styles: first.prototype.styles };
    bundle.prototypeSourceContents[sheet] += '\n[data-blueprint-screen="transactions"] .ledger-tag { color: var(--app-color-foreground); }\n';
    bundle.prototypeSourceContents[second.prototype.source] += '<blueprint-use kind="primitive" ref="badge" class="ledger-tag"></blueprint-use>';
    const linted: string[] = [];
    const { styleErrors } = validateProject(bundle, { onCandidateFileLint: file => linted.push(file) });
    assert.equal(linted.filter(file => file === sheet).length, 2);
    assert.deepEqual(styleErrors.map(error => error.split(':')[0]), [`exploration.ledger-density candidate.${second.id}`]);
    assert.match(styleErrors[0], /reaches the root that <blueprint-use class="ledger-tag"> places/);
  });

  it('does not read an archived candidate or a frozen baseline', async () => {
    await withProjectCopy(async project => {
      const recordPath = path.join(project, 'explorations/ledger-density.json');
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      record.exploration.lifecycle = 'archived';
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      await appendRule(project, 'prototype/screens/transactions.exploration-ledger-density-compact.css', '[data-blueprint-screen="transactions"]');
      assert.deepEqual(validateProject(await loadProjectFromFs(project)).errors, []);
    }, MERIDIAN);

    await withProjectCopy(async project => {
      const { computeExplorationBaselineDigest } = await import('../src/core/exploration');
      await appendRule(project, 'prototype/screens/transactions.exploration-ledger-density-baseline.css', '[data-blueprint-screen="transactions"]');
      const recordPath = path.join(project, 'explorations/ledger-density.json');
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      record.exploration.target.baseDigest = computeExplorationBaselineDigest(await loadProjectFromFs(project), 'ledger-density');
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      assert.deepEqual(validateProject(await loadProjectFromFs(project)).errors, []);
    }, MERIDIAN);
  });
});

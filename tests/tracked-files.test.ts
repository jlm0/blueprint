import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const THIS_FILE = 'tests/tracked-files.test.ts';

function trackedLinesMatching(pattern: string): string[] {
  const result = spawnSync('git', ['grep', '-nIE', pattern, '--', '.', `:!${THIS_FILE}`], { encoding: 'utf8' });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result.stdout.split('\n').filter(Boolean);
}

describe('the tracked files of this public repo', () => {
  it('hold no path of a home directory on a local machine', () => {
    const lines = trackedLinesMatching('/(Users|home)/[a-z][a-z0-9_-]*/').filter(line => !line.includes('/Users/example/'));
    assert.deepEqual(lines, [], 'Fix: remove the local path from each listed file. Read a local project through an environment variable or a temporary copy.');
  });

  it('hold no link to the gitignored docs folder', () => {
    assert.deepEqual(trackedLinesMatching('docs/[a-zA-Z]'), [], 'Fix: remove the docs/ link from each listed file, because docs/ is not in the repo.');
  });
});

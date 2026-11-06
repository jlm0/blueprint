import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const SKILL_NAMES = ['blueprint-create-sidecar', 'blueprint-edit-canvas', 'blueprint-handoff'];

function install(target: string): string {
  return execFileSync('npm', ['run', '--silent', 'skills:install', '--', '--target', target], { encoding: 'utf8' });
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, encoding: 'utf8' }).sort().map(entry => {
    const full = path.join(root, entry);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) return [entry, `link ${readlinkSync(full)}`];
    return [entry, stat.isDirectory() ? 'directory' : `file ${readFileSync(full, 'utf8')}`];
  }));
}

describe('the skills:install step', () => {
  let root: string;
  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'blueprint-skills-install-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('links each skill, keeps a backup of an existing directory, and gives the same result on a second run', () => {
    const target = path.join(root, 'skills');
    mkdirSync(path.join(target, 'blueprint-handoff'), { recursive: true });
    writeFileSync(path.join(target, 'blueprint-handoff', 'SKILL.md'), 'an older copy');

    install(target);
    for (const name of SKILL_NAMES) {
      assert.ok(lstatSync(path.join(target, name)).isSymbolicLink(), `${name} is not a symlink`);
      assert.equal(realpathSync(path.join(target, name)), realpathSync(path.join('skills', name)));
    }
    const backups = readdirSync(path.join(root, 'skills-backup'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^blueprint-handoff-/);
    assert.equal(readFileSync(path.join(root, 'skills-backup', backups[0], 'SKILL.md'), 'utf8'), 'an older copy');

    const first = snapshot(root);
    install(target);
    assert.deepEqual(snapshot(root), first);
  });
});

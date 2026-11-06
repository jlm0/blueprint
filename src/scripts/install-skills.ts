import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SKILL_SOURCE = fileURLToPath(new URL('../../skills/', import.meta.url));
const MAX_BACKUPS_PER_RUN = 100;

function freeBackupPath(base: string): string {
  for (let attempt = 1; attempt <= MAX_BACKUPS_PER_RUN; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`${base} and ${MAX_BACKUPS_PER_RUN - 1} numbered copies already exist. Fix: move the old backups out of ${path.dirname(base)}, then run the step again.`);
}

function linksTo(link: string, source: string): boolean {
  return path.resolve(path.dirname(link), readlinkSync(link)) === path.resolve(source);
}

function installSkill(name: string, targetRoot: string, backupRoot: string, stamp: string): string {
  const source = path.join(SKILL_SOURCE, name);
  const target = path.join(targetRoot, name);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() && linksTo(target, source)) return `${name}: already linked to ${source}`;
  let moved = '';
  if (existing) {
    mkdirSync(backupRoot, { recursive: true });
    const backup = freeBackupPath(path.join(backupRoot, `${name}-${stamp}`));
    renameSync(target, backup);
    moved = `, after it moved the old entry to ${backup}`;
  }
  symlinkSync(source, target, 'dir');
  return `${name}: linked to ${source}${moved}`;
}

function main(): void {
  const { values } = parseArgs({ options: { target: { type: 'string' } } });
  const targetRoot = path.resolve(values.target ?? path.join(homedir(), '.agents', 'skills'));
  const backupRoot = `${targetRoot}-backup`;
  const stamp = new Date().toISOString().replaceAll(':', '-');
  mkdirSync(targetRoot, { recursive: true });
  const names = readdirSync(SKILL_SOURCE, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const name of names) console.log(installSkill(name, targetRoot, backupRoot, stamp));
}

main();

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { ProjectFilePoll } from '../src/mcp/project-poll';

describe('project file poll', () => {
  it('reports each file whose size, mtime, or inode changed, and each file that appeared or went away', async () => {
    await withTree(async root => {
      await writeFiles(root, ['size.txt', 'mtime.txt', 'nested/inode.txt', 'gone.txt', 'kept.txt']);
      const inodePath = path.join(root, 'nested/inode.txt');
      const fixedTime = new Date(2_000_000_000_000);
      await utimes(inodePath, fixedTime, fixedTime);
      const poll = new ProjectFilePoll(root);
      assert.deepEqual(await poll.pass(), []);

      await writeFile(path.join(root, 'size.txt'), 'longer content');
      const later = new Date(Date.now() + 60_000);
      await utimes(path.join(root, 'mtime.txt'), later, later);
      const before = await stat(inodePath, { bigint: true });
      await writeFile(`${inodePath}.next`, 'nested/inode.txt');
      await rename(`${inodePath}.next`, inodePath);
      await utimes(inodePath, fixedTime, fixedTime);
      const after = await stat(inodePath, { bigint: true });
      assert.deepEqual([after.size, after.mtimeNs], [before.size, before.mtimeNs]);
      assert.notEqual(after.ino, before.ino);
      await rm(path.join(root, 'gone.txt'));
      await writeFile(path.join(root, 'nested/new.txt'), 'new');

      assert.deepEqual(await poll.pass(), ['gone.txt', 'mtime.txt', 'nested/inode.txt', 'nested/new.txt', 'size.txt']);
      assert.deepEqual(await poll.pass(), []);
    });
  });

  it('skips .git, node_modules, and .blueprint-artifacts, as the watcher does', async () => {
    await withTree(async root => {
      const skipped = ['.git/HEAD', 'node_modules/pkg/index.js', '.blueprint-artifacts/capture.png', 'prototype/node_modules/x.js'];
      await writeFiles(root, skipped);
      const poll = new ProjectFilePoll(root);
      await poll.pass();
      for (const fileRef of skipped) await writeFile(path.join(root, fileRef), 'changed content');
      await writeFile(path.join(root, '.git/index'), 'new');
      assert.deepEqual(await poll.pass(), []);
    });
  });

  it('runs one pass at a time, so a pass that starts during another reports only the later changes', async () => {
    await withTree(async root => {
      await writeFiles(root, ['a.txt']);
      const poll = new ProjectFilePoll(root);
      await poll.pass();
      await writeFile(path.join(root, 'a.txt'), 'changed content');
      const [first, second] = await Promise.all([poll.pass(), poll.pass()]);
      assert.deepEqual([first, second], [['a.txt'], []]);
    });
  });

  it('reports a change on each interval, and stops when it closes', async () => {
    await withTree(async root => {
      await writeFiles(root, ['a.txt', 'b.txt']);
      const poll = new ProjectFilePoll(root);
      await poll.pass();
      const reported: string[] = [];
      poll.every(50, changedPath => reported.push(changedPath));
      try {
        await writeFile(path.join(root, 'a.txt'), 'changed content');
        const deadline = performance.now() + 5_000;
        while (!reported.includes('a.txt')) {
          assert.ok(performance.now() < deadline, 'The poll did not report a.txt within 5 s.');
          await delay(10);
        }
      } finally {
        poll.close();
      }
      await writeFile(path.join(root, 'b.txt'), 'changed content');
      await delay(300);
      assert.deepEqual(reported, ['a.txt']);
    });
  });

  it('reports each file as gone when the project directory goes away', async () => {
    await withTree(async root => {
      const project = path.join(root, 'project');
      await writeFiles(project, ['a.txt', 'nested/b.txt']);
      const poll = new ProjectFilePoll(project);
      await poll.pass();
      await rm(project, { recursive: true });
      assert.deepEqual(await poll.pass(), ['a.txt', 'nested/b.txt']);
    });
  });
});

async function withTree(use: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'blueprint-project-poll-'));
  try {
    await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFiles(root: string, fileRefs: string[]): Promise<void> {
  for (const fileRef of fileRefs) {
    await mkdir(path.dirname(path.join(root, fileRef)), { recursive: true });
    await writeFile(path.join(root, fileRef), fileRef);
  }
}

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const repoRoot = process.cwd();

describe('built MCP worker', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'blueprint-built-worker-'));
  const project = path.join(temp, 'design', 'blueprint');
  const runFile = path.join(temp, 'runs.log');
  const workerPath = path.join(temp, 'dist', 'mcp', 'project-validation-worker.js');
  let client: Client;

  const runCount = (): number => readFileSync(runFile, 'utf8').split('\n').filter(Boolean).length;
  const validate = () => client.callTool({ name: 'validate', arguments: { project } });

  before(async () => {
    for (const name of ['dist', 'starter', 'package.json']) {
      cpSync(path.join(repoRoot, name), path.join(temp, name), { recursive: true });
    }
    symlinkSync(path.join(repoRoot, 'node_modules'), path.join(temp, 'node_modules'));
    cpSync(path.join(repoRoot, 'fixtures/valid/umbra-gaming/design/blueprint'), project, { recursive: true });
    writeFileSync(runFile, '');
    const preload = path.join(temp, 'record-runs.mjs');
    writeFileSync(preload, `
      import { subscribe } from 'node:diagnostics_channel';
      import { appendFileSync } from 'node:fs';
      import { isMainThread } from 'node:worker_threads';
      if (isMainThread) subscribe('blueprint:project-validation-run', message => appendFileSync(${JSON.stringify(runFile)}, message.run + '\\n'));
    `);
    client = new Client({ name: 'built-worker-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['--import', preload, path.join(temp, 'dist/mcp/server.js')],
      cwd: temp,
      stderr: 'inherit'
    }));
  });

  after(async () => {
    await client.close();
    rmSync(temp, { recursive: true, force: true });
  });

  it('validates on the built worker, and answers known content from the memo', async () => {
    const first = await validate();
    assert.equal(first.isError, undefined, JSON.stringify(first.content));
    assert.ok(runCount() >= 1);
    const known = runCount();
    await validate();
    assert.equal(runCount(), known);
  });

  it('validates again after the worker file changes, because new code can give a new result', async () => {
    await validate();
    const known = runCount();
    appendFileSync(workerPath, '\n// A rebuild changes this file.\n');
    await validate();
    assert.ok(runCount() > known);
  });

  it('reports a missing worker file with a Fix line', async () => {
    renameSync(workerPath, `${workerPath}.moved`);
    try {
      const result = await validate();
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /Fix:/);
    } finally {
      renameSync(`${workerPath}.moved`, workerPath);
    }
  });
});

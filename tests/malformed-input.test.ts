import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { validateProject } from '../src/core/validate';

const starterRoot = 'starter/design/blueprint';
const structuredFiles = ['manifest.json', 'tokens.json', 'primitives.json', 'components.json', 'screens.json', 'brand.json'];
const wrongValues: unknown[] = ['fun', {}, 1, null];

type Mutation = (file: Record<string, unknown>, value: unknown) => void;

function mutationsFor(file: Record<string, unknown>): Array<{ label: string; apply: Mutation }> {
  const mutations: Array<{ label: string; apply: Mutation }> = [];
  for (const [key, child] of Object.entries(file)) {
    mutations.push({ label: key, apply: (next, value) => { next[key] = value; } });
    const first = Array.isArray(child) ? child[0] : undefined;
    if (first && typeof first === 'object') {
      for (const inner of Object.keys(first as object)) {
        mutations.push({
          label: `${key}[0].${inner}`,
          apply: (next, value) => { ((next[key] as unknown[])[0] as Record<string, unknown>)[inner] = value; }
        });
      }
    } else if (child && typeof child === 'object' && !Array.isArray(child)) {
      for (const inner of Object.keys(child)) {
        mutations.push({
          label: `${key}.${inner}`,
          apply: (next, value) => { (next[key] as Record<string, unknown>)[inner] = value; }
        });
      }
    }
  }
  return mutations;
}

async function withStarterCopy(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'blueprint-malformed-'));
  try {
    await cp(starterRoot, root, { recursive: true });
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('malformed Blueprint input', () => {
  it('reports each wrong field type with a Fix, and never crashes', async () => {
    await withStarterCopy(async root => {
      const crashes: string[] = [];
      for (const fileName of structuredFiles) {
        const original = await readFile(path.join(root, fileName), 'utf8');
        const parsed = JSON.parse(original) as Record<string, unknown>;
        for (const { label, apply } of mutationsFor(parsed)) {
          for (const value of wrongValues) {
            const next = structuredClone(parsed);
            apply(next, value);
            await writeFile(path.join(root, fileName), JSON.stringify(next));
            try {
              validateProject(await loadProjectFromFs(root));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (error instanceof TypeError || !/Fix: .+/.test(message)) {
                crashes.push(`${fileName} ${label}=${JSON.stringify(value)}: ${message}`);
              }
            }
          }
        }
        await writeFile(path.join(root, fileName), original);
      }
      assert.deepEqual(crashes, []);
    });
  });

  it('reports a JSON syntax error with the file name and a Fix', async () => {
    await withStarterCopy(async root => {
      for (const fileName of structuredFiles) {
        const original = await readFile(path.join(root, fileName), 'utf8');
        await writeFile(path.join(root, fileName), '{ "schemaVersion": ');
        await assert.rejects(loadProjectFromFs(root), (error: Error) => {
          assert.match(error.message, new RegExp(`${fileName.replace('.', '\\.')}.*Fix: .+`));
          return true;
        });
        await writeFile(path.join(root, fileName), original);
      }
    });
  });

  it('reports a missing project folder with a Fix', async () => {
    await assert.rejects(loadProjectFromFs('/nonexistent-blueprint/design/blueprint'), (error: Error) => {
      assert.match(error.message, /does not exist.*Fix: .+/);
      return true;
    });
  });
});

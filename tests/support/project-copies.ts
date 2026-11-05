import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';

export async function withProjectCopy<T>(run: (project: string) => Promise<T>, fixture = umbraRoot): Promise<T> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-validation-worker-'));
  try {
    const project = path.join(tempDir, 'design', 'blueprint');
    await cp(fixture, project, { recursive: true });
    return await run(project);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** An id cannot end in a number, so the index of a grown screen reads as letters. */
export function grownScreenId(index: number): string {
  const letters = index.toString(26).replace(/./g, digit => String.fromCharCode(97 + parseInt(digit, 26)));
  return `grown-${letters}-screen`;
}

/** Adds screens with their own large sources, so that one validation takes long enough to show a stall of the event loop. */
export async function growProject(project: string, screenCopies: number): Promise<void> {
  const screensPath = path.join(project, 'screens.json');
  const screens = JSON.parse(await readFile(screensPath, 'utf8'));
  const launch = screens.screens.find((screen: { id: string }) => screen.id === 'launch');
  const markup = (await readFile(path.join(project, launch.prototype.source), 'utf8')).replaceAll(/\s*data-blueprint-section="[^"]*"/g, '');
  for (let index = 0; index < screenCopies; index += 1) {
    const id = grownScreenId(index);
    const source = `prototype/screens/${id}.html`;
    await writeFile(path.join(project, source), `${markup.repeat(12)}\n<!-- ${index} -->\n`);
    screens.screens.push({
      ...structuredClone(launch),
      id,
      name: `Launch ${id}`,
      prototype: { ...structuredClone(launch.prototype), source }
    });
  }
  await writeFile(screensPath, `${JSON.stringify(screens, null, 2)}\n`);
}

export async function fileDigests(root: string): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        digests[path.relative(root, full)] = createHash('sha256').update(await readFile(full)).digest('hex');
      }
    }
  };
  await walk(root);
  return digests;
}

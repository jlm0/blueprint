import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadProjectFromFs } from '../core/load';
import { validateProject } from '../core/validate';

const appOwnedRoot = 'fixtures/app-owned';

async function main(): Promise<void> {
  const validRoots = await discoverProjectRoots(appOwnedRoot);
  let failures = 0;

  for (const root of validRoots) {
    const bundle = await loadProjectFromFs(root);
    const result = validateProject(bundle);
    if (!result.ok) {
      failures += 1;
      console.error(`FAIL valid fixture ${root}`);
      for (const error of result.errors) {
        console.error(`  - ${error}`);
      }
    } else {
      console.log(`PASS valid fixture ${root}`);
    }
  }

  if (validRoots.length < 2) {
    failures += 1;
    console.error(`FAIL expected at least two app-owned fixtures, found ${validRoots.length}`);
  }

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }

  console.log(`Fixture validation complete: ${validRoots.length} valid.`);
}

async function discoverProjectRoots(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name, 'design', 'blueprint'));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

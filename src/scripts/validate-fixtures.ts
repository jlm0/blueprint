import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadProjectFromFs } from '../core/load';
import type { ValidationMode } from '../core/types';
import { createReadinessReport, validateProject } from '../core/validate';

const validRoot = 'fixtures/valid';
const invalidRoot = 'fixtures/invalid';

async function main(): Promise<void> {
  let failures = 0;

  for (const root of await discoverProjectRoots(validRoot)) {
    const bundle = await loadProjectFromFs(root);
    const handoff = Boolean(bundle.manifest.handoffContractVersion);
    const modes: ValidationMode[] = handoff ? ['baseline', 'strict'] : ['baseline'];
    for (const mode of modes) {
      const result = validateProject(bundle, { mode });
      if (result.ok) {
        console.log(`PASS ${mode} ${root}`);
        continue;
      }
      failures += 1;
      console.error(`FAIL ${mode} ${root}`);
      for (const error of result.errors) {
        console.error(`  - ${error}`);
      }
    }
    if (handoff) {
      const readiness = createReadinessReport(bundle);
      if (readiness.tier === 'ready') {
        console.log(`PASS readiness ${root}`);
      } else {
        failures += 1;
        console.error(`FAIL readiness ${root} is ${readiness.tier}`);
        for (const blocker of readiness.blockers) {
          console.error(`  - ${blocker.path}: ${blocker.message}`);
        }
      }
    }
  }

  for (const root of await discoverProjectRoots(invalidRoot)) {
    const result = validateProject(await loadProjectFromFs(root));
    if (result.ok) {
      failures += 1;
      console.error(`FAIL invalid fixture ${root} passed validation`);
    } else {
      console.log(`PASS invalid fixture ${root} reports ${result.errors.length} errors`);
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

async function discoverProjectRoots(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name, 'design', 'blueprint'))
    .sort();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

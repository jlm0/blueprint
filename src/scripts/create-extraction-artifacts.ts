import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadProjectFromFs } from '../core/load';
import {
  createExtractionPacket,
  queryPrototypeOnly,
  querySections,
  queryUsedBy,
  queryUses,
  showBoundary
} from '../core/query';

const artifactRoot =
  process.env.BLUEPRINT_ARTIFACT_ROOT ??
  '.blueprint-artifacts/extraction-query';
const projectRoot = 'fixtures/app-owned/nova-care/design/blueprint';

async function main(): Promise<void> {
  const bundle = await loadProjectFromFs(projectRoot);
  const extractionRoot = path.join(artifactRoot, 'extraction');
  const queryRoot = path.join(artifactRoot, 'query');
  await mkdir(extractionRoot, { recursive: true });
  await mkdir(queryRoot, { recursive: true });

  await writeJson(path.join(extractionRoot, 'primitive-action-button.json'), createExtractionPacket(bundle, 'primitive:action-button'));
  await writeJson(path.join(extractionRoot, 'screen-home.json'), createExtractionPacket(bundle, 'screen:home'));
  await writeJson(path.join(queryRoot, 'show-screen-home.json'), showBoundary(bundle, 'screen:home'));
  await writeJson(path.join(queryRoot, 'uses-screen-home.json'), queryUses(bundle, 'screen:home'));
  await writeJson(path.join(queryRoot, 'used-by-action-button.json'), queryUsedBy(bundle, 'primitive:action-button'));
  await writeJson(path.join(queryRoot, 'sections-screen-home.json'), querySections(bundle, 'home'));
  await writeJson(path.join(queryRoot, 'prototype-only.json'), queryPrototypeOnly(bundle));

  console.log(`Extraction and query artifacts written under ${artifactRoot}.`);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

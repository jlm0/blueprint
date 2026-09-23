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
const projectRoot = 'fixtures/valid/mira-ai/design/blueprint';

async function main(): Promise<void> {
  const bundle = await loadProjectFromFs(projectRoot);
  const extractionRoot = path.join(artifactRoot, 'extraction');
  const queryRoot = path.join(artifactRoot, 'query');
  await mkdir(extractionRoot, { recursive: true });
  await mkdir(queryRoot, { recursive: true });

  await writeJson(path.join(extractionRoot, 'primitive-button.json'), createExtractionPacket(bundle, 'primitive:button'));
  await writeJson(path.join(extractionRoot, 'screen-chat.json'), createExtractionPacket(bundle, 'screen:chat'));
  await writeJson(path.join(queryRoot, 'show-screen-chat.json'), showBoundary(bundle, 'screen:chat'));
  await writeJson(path.join(queryRoot, 'uses-screen-chat.json'), queryUses(bundle, 'screen:chat'));
  await writeJson(path.join(queryRoot, 'used-by-button.json'), queryUsedBy(bundle, 'primitive:button'));
  await writeJson(path.join(queryRoot, 'sections-screen-chat.json'), querySections(bundle, 'chat'));
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

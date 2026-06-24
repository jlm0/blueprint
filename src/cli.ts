#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadProjectFromFs } from './core/load';
import { validateProject } from './core/validate';
import {
  createExtractionPacket,
  listBoundaryReferences,
  queryPrototypeOnly,
  querySections,
  queryUsedBy,
  queryUses,
  showBoundary
} from './core/query';
import type { ValidationMode } from './core/types';

type Command = 'init' | 'validate' | 'index' | 'query' | 'extract';
type QueryType = 'show' | 'uses' | 'used-by' | 'sections' | 'prototype-only';
type ExtractMode = 'focused' | 'deep';

interface Args {
  command?: Command;
  project?: string;
  projectId?: string;
  name?: string;
  out?: string;
  boundary?: string;
  screen?: string;
  type?: QueryType;
  mode?: string;
  force: boolean;
  help: boolean;
}

const packageRoot = findPackageRoot();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(helpText());
    return;
  }

  if (args.command === 'init') {
    await commandInit(args);
    return;
  }

  if (args.command === 'validate') {
    await commandValidate(args);
    return;
  }

  if (args.command === 'index') {
    await commandIndex(args);
    return;
  }

  if (args.command === 'query') {
    await commandQuery(args);
    return;
  }

  if (args.command === 'extract') {
    await commandExtract(args);
    return;
  }
}

async function commandInit(args: Args): Promise<void> {
  const out = requireArg(args.out, '--out');
  const projectId = requireArg(args.projectId, '--project-id');
  const name = requireArg(args.name, '--name');
  const destination = path.resolve(out);

  if (existsSync(destination)) {
    const entries = await readdir(destination);
    if (entries.length > 0 && !args.force) {
      throw new Error(`Destination is not empty: ${normalize(destination)}. Re-run with --force to overwrite Blueprint starter files in place.`);
    }
  }

  const starterRoot = path.join(packageRoot, 'starter', 'design', 'blueprint');
  await mkdir(destination, { recursive: true });
  await cp(starterRoot, destination, { recursive: true, force: true });
  await rewriteStarterProject(destination, projectId, name);

  const bundle = await loadProjectFromFs(destination);
  const validation = validateProject(bundle);
  if (!validation.ok) {
    throw new Error(`Initialized project failed baseline validation:\n${validation.errors.join('\n')}`);
  }

  await writeOutput(
    {
      command: 'init',
      projectId,
      name,
      out: normalize(destination),
      files: (await readdir(destination)).sort(),
      validation,
      nextCommands: [
        `blueprint validate --project ${normalize(destination)}`,
        `blueprint index --project ${normalize(destination)}`,
        `blueprint query --project ${normalize(destination)} --type show --boundary screen:home`,
        `blueprint extract --project ${normalize(destination)} --boundary screen:home --out packet.json`
      ]
    },
    undefined
  );
}

async function commandValidate(args: Args): Promise<void> {
  const project = requireArg(args.project, '--project');
  const mode = validationMode(args.mode);
  const bundle = await loadProjectFromFs(project);
  const result = validateProject(bundle, { mode });
  await writeOutput(
    {
      command: 'validate',
      project: normalize(path.resolve(project)),
      projectId: bundle.manifest.project.id,
      mode,
      ...result
    },
    args.out
  );
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function commandIndex(args: Args): Promise<void> {
  const project = requireArg(args.project, '--project');
  const bundle = await loadProjectFromFs(project);
  await writeOutput(
    {
      command: 'index',
      project: normalize(path.resolve(project)),
      projectId: bundle.manifest.project.id,
      results: listBoundaryReferences(bundle)
    },
    args.out
  );
}

async function commandQuery(args: Args): Promise<void> {
  const project = requireArg(args.project, '--project');
  const type = requireQueryType(args.type);
  const bundle = await loadProjectFromFs(project);
  let output: unknown;

  if (type === 'show') {
    output = showBoundary(bundle, requireArg(args.boundary, '--boundary'));
  }
  if (type === 'uses') {
    output = queryUses(bundle, requireArg(args.boundary, '--boundary'));
  }
  if (type === 'used-by') {
    output = queryUsedBy(bundle, requireArg(args.boundary, '--boundary'));
  }
  if (type === 'sections') {
    output = querySections(bundle, requireArg(args.screen, '--screen'));
  }
  if (type === 'prototype-only') {
    output = queryPrototypeOnly(bundle);
  }

  await writeOutput(output, args.out);
}

async function commandExtract(args: Args): Promise<void> {
  const project = requireArg(args.project, '--project');
  const boundary = requireArg(args.boundary, '--boundary');
  const mode = extractMode(args.mode);
  const bundle = await loadProjectFromFs(project);
  const packet = createExtractionPacket(bundle, boundary, { mode });
  if (args.out) {
    await writeOutput(packet, args.out, { printOutSummary: true });
    return;
  }
  await writeOutput(packet, undefined);
}

async function rewriteStarterProject(destination: string, projectId: string, name: string): Promise<void> {
  const manifestPath = path.join(destination, 'manifest.json');
  const tokensPath = path.join(destination, 'tokens.json');
  const primitivesPath = path.join(destination, 'primitives.json');
  const screensPath = path.join(destination, 'screens.json');

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.project.id = projectId;
  manifest.project.name = name;
  manifest.project.sourceRoot = normalize(destination);

  const tokens = JSON.parse(await readFile(tokensPath, 'utf8'));
  tokens.projectId = projectId;

  const primitives = JSON.parse(await readFile(primitivesPath, 'utf8'));
  primitives.projectId = projectId;

  const screens = JSON.parse(await readFile(screensPath, 'utf8'));
  screens.projectId = projectId;

  await Promise.all([
    writeJsonFile(manifestPath, manifest),
    writeJsonFile(tokensPath, tokens),
    writeJsonFile(primitivesPath, primitives),
    writeJsonFile(screensPath, screens)
  ]);
}

async function writeOutput(value: unknown, out?: string, options: { printOutSummary?: boolean } = {}): Promise<void> {
  if (out) {
    const resolved = path.resolve(out);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeJsonFile(resolved, value);
    if (options.printOutSummary) {
      process.stdout.write(`${JSON.stringify({ ok: true, out: normalize(resolved) }, null, 2)}\n`);
    }
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseArgs(argv: string[]): Args {
  const [maybeCommand, ...rest] = argv;
  const args: Args = {
    command: isCommand(maybeCommand) ? maybeCommand : undefined,
    force: false,
    help: maybeCommand === '--help' || maybeCommand === '-h'
  };

  if (maybeCommand && !args.command && !args.help) {
    throw new Error(`Unknown command "${maybeCommand}".\n${helpText()}`);
  }

  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (key === '--force') {
      args.force = true;
      continue;
    }
    if (key === '--help' || key === '-h') {
      args.help = true;
      continue;
    }
    if (!key?.startsWith('--')) {
      throw new Error(`Unexpected argument "${key}".`);
    }
    const value = rest[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${key}.`);
    }
    index += 1;

    if (key === '--project') {
      args.project = value;
    } else if (key === '--project-id') {
      args.projectId = value;
    } else if (key === '--name') {
      args.name = value;
    } else if (key === '--out') {
      args.out = value;
    } else if (key === '--boundary') {
      args.boundary = value;
    } else if (key === '--screen') {
      args.screen = value;
    } else if (key === '--type') {
      args.type = value as QueryType;
    } else if (key === '--mode') {
      args.mode = value;
    } else {
      throw new Error(`Unknown argument ${key}.`);
    }
  }

  return args;
}

function isCommand(value: string | undefined): value is Command {
  return value === 'init' || value === 'validate' || value === 'index' || value === 'query' || value === 'extract';
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function requireQueryType(value: string | undefined): QueryType {
  if (value === 'show' || value === 'uses' || value === 'used-by' || value === 'sections' || value === 'prototype-only') {
    return value;
  }
  throw new Error('--type must be one of show, uses, used-by, sections, prototype-only.');
}

function validationMode(value: string | undefined): ValidationMode {
  if (!value || value === 'baseline') {
    return 'baseline';
  }
  if (value === 'strict') {
    return 'strict';
  }
  throw new Error('--mode must be "baseline" or "strict".');
}

function extractMode(value: string | undefined): ExtractMode {
  if (!value || value === 'focused') {
    return 'focused';
  }
  if (value === 'deep') {
    return 'deep';
  }
  throw new Error('--mode must be "focused" or "deep".');
}

function findPackageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json')) && existsSync(path.join(current, 'starter'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
}

function normalize(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function helpText(): string {
  return `blueprint <command>

Commands:
  init --project-id <id> --name <name> --out <design/blueprint> [--force]
  validate --project <path> [--mode baseline|strict] [--out file]
  index --project <path> [--out file]
  query --project <path> --type <show|uses|used-by|sections|prototype-only> [--boundary kind:id] [--screen id] [--out file]
  extract --project <path> --boundary kind:id [--mode focused|deep] [--out file]
`;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

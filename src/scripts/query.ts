import { writeFile } from 'node:fs/promises';
import { loadProjectFromFs } from '../core/load';
import {
  createExtractionPacket,
  queryPrototypeOnly,
  querySections,
  queryUsedBy,
  queryUses,
  showBoundary
} from '../core/query';

type Command = 'show' | 'uses' | 'used-by' | 'sections' | 'prototype-only' | 'extract';

interface Args {
  command: Command;
  project: string;
  boundary?: string;
  screen?: string;
  out?: string;
  mode?: 'focused' | 'deep';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bundle = await loadProjectFromFs(args.project);
  let output: unknown;

  if (args.command === 'show') {
    output = showBoundary(bundle, requireArg(args.boundary, '--boundary'));
  }
  if (args.command === 'uses') {
    output = queryUses(bundle, requireArg(args.boundary, '--boundary'));
  }
  if (args.command === 'used-by') {
    output = queryUsedBy(bundle, requireArg(args.boundary, '--boundary'));
  }
  if (args.command === 'sections') {
    output = querySections(bundle, requireArg(args.screen, '--screen'));
  }
  if (args.command === 'prototype-only') {
    output = queryPrototypeOnly(bundle);
  }
  if (args.command === 'extract') {
    output = createExtractionPacket(bundle, requireArg(args.boundary, '--boundary'), { mode: args.mode ?? 'focused' });
  }

  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (args.out) {
    await writeFile(args.out, serialized, 'utf8');
  } else {
    process.stdout.write(serialized);
  }
}

function parseArgs(argv: string[]): Args {
  const [command] = argv;
  if (!isCommand(command)) {
    throw new Error(`Usage: npm run query -- <show|uses|used-by|sections|prototype-only|extract> --project <path> [--boundary kind:id] [--screen id] [--out file]`);
  }

  const args: Args = {
    command,
    project: ''
  };

  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--')) {
      continue;
    }
    if (!value) {
      throw new Error(`Missing value for ${key}.`);
    }
    index += 1;

    if (key === '--project') {
      args.project = value;
    } else if (key === '--boundary') {
      args.boundary = value;
    } else if (key === '--screen') {
      args.screen = value;
    } else if (key === '--out') {
      args.out = value;
    } else if (key === '--mode') {
      if (value !== 'focused' && value !== 'deep') {
        throw new Error(`--mode must be "focused" or "deep", received "${value}".`);
      }
      args.mode = value;
    } else {
      throw new Error(`Unknown argument ${key}.`);
    }
  }

  if (!args.project) {
    throw new Error('Missing --project path.');
  }

  return args;
}

function isCommand(value: string | undefined): value is Command {
  return value === 'show' || value === 'uses' || value === 'used-by' || value === 'sections' || value === 'prototype-only' || value === 'extract';
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

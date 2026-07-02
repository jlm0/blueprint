import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const runtimeRoots = ['src/app', 'src/core', 'src/index.ts', 'index.html', 'package.json'];
const forbiddenRuntimeTerms = [
  'reference',
  'reference-app',
  'packages/ui',
  'dashboard',
  'inspector',
  'marketing hero',
  'hero page',
  'figma clone',
  'project manager',
  'central project manager',
  'centralized project manager'
];
const forbiddenRuntimePackages = [
  'react',
  'react-dom',
  'next',
  'svelte',
  'vue',
  'preact',
  'solid-js',
  'lit',
  'alpinejs',
  'handlebars',
  'mustache',
  'mobx',
  'rxjs'
];

async function main(): Promise<void> {
  const files = await collectFiles(runtimeRoots);
  const violations: string[] = [];

  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    const lower = raw.toLowerCase();
    for (const term of forbiddenRuntimeTerms) {
      if (lower.includes(term)) {
        violations.push(`${file} contains forbidden runtime term "${term}"`);
      }
    }
  }

  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies
  };

  for (const packageName of forbiddenRuntimePackages) {
    if (dependencies[packageName]) {
      violations.push(`package.json includes framework-like dependency "${packageName}"`);
    }
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`FAIL ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Scope scan passed: runtime is app-agnostic and no framework/view/templating/reactivity packages are present.');
}

async function collectFiles(entries: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const entry of entries) {
    const statFiles = await collectFile(entry);
    files.push(...statFiles);
  }
  return files;
}

async function collectFile(entry: string): Promise<string[]> {
  const dirent = await safeReaddir(entry);
  if (!dirent) {
    return [entry];
  }

  const files: string[] = [];
  for (const child of dirent) {
    const childPath = path.join(entry, child.name);
    if (child.isDirectory()) {
      files.push(...(await collectFile(childPath)));
    } else if (/\.(ts|css|html|json)$/.test(child.name)) {
      files.push(childPath);
    }
  }
  return files;
}

async function safeReaddir(entry: string) {
  try {
    return await readdir(entry, { withFileTypes: true });
  } catch {
    return null;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

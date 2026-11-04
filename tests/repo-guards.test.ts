import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function bareImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specifiers = [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([@a-z][\w@./-]*)['"]/g)].map(match => match[1]);
  return specifiers
    .filter(specifier => !builtins.has(specifier) && !specifier.startsWith('virtual:'))
    .map(specifier => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'));
}

describe('repository guards', () => {
  it('declares every package that source and tests import', () => {
    const declared = new Set([
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
      ...Object.keys(manifest.peerDependencies ?? {})
    ]);
    const missing = [...sourceFiles('src'), ...sourceFiles('tests')]
      .flatMap(file => bareImports(file).filter(name => !declared.has(name)).map(name => `${file}: ${name}`));
    assert.deepEqual(missing, []);
  });

  it('declares each package the MCP runtime imports for its consumers', () => {
    const runtime = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies ?? {})]);
    const missing = [...sourceFiles('src/mcp'), ...sourceFiles('src/core'), ...sourceFiles('src/prototype')]
      .flatMap(file => bareImports(file).filter(name => !runtime.has(name)).map(name => `${file}: ${name}`));
    assert.deepEqual(missing, []);
    assert.equal(manifest.peerDependenciesMeta?.playwright?.optional, true);
    assert.ok(manifest.devDependencies.playwright, 'tests and the smoke script import playwright');
  });

  it('keeps every MCP import visible to the bundler', () => {
    const hidden = sourceFiles('src/mcp').filter(file => /new Function\(/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(hidden, []);
    assert.match(readFileSync('vite.mcp.config.ts', 'utf8'), /runtimePackages = new Set\(\[[^\]]*'playwright'/);
  });

  it('runs the local Codex hook from the built file', { skip: !existsSync('.codex/hooks.json') }, () => {
    const config = JSON.parse(readFileSync('.codex/hooks.json', 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commands = Object.values(config.hooks).flat().flatMap(entry => entry.hooks).map(hook => hook.command);
    assert.ok(commands.length > 0);
    for (const command of commands) {
      assert.match(command, /dist\/mcp\/codex-activity-hook\.js/);
      assert.doesNotMatch(command, /tsx|src\/hooks/);
    }
  });

  it('loads starter sources with a glob that covers every starter source file', () => {
    const source = readFileSync('src/app/fixture-projects.ts', 'utf8');
    assert.doesNotMatch(source, /starter\/design\/blueprint\/(prototype|brand)\/[^'"]*\?raw/);
    assert.match(source, /import\.meta\.glob/);
    const extensions = new Set(
      [...listFiles('starter/design/blueprint/prototype'), ...listFiles('starter/design/blueprint/brand')].map(file => path.extname(file))
    );
    assert.deepEqual([...extensions].sort(), ['.css', '.html', '.svg']);
  });

  it('states which tools still work on an older schema', () => {
    const instructions = readFileSync('src/mcp/create-server.ts', 'utf8');
    const agents = readFileSync('starter/design/blueprint/AGENTS.md', 'utf8');
    assert.doesNotMatch(instructions, /Every tool except migrate refuses/);
    assert.match(instructions, /validate reports each file on an older schema and serve shows a notice/);
    assert.doesNotMatch(agents, /refuses the folder until then, and the canvas/);
    assert.match(agents, /`validate` reports each file on an older schema and `serve` shows a notice/);
  });

  it('names the first tool and the moment to serve in the server instructions', () => {
    const instructions = readFileSync('src/mcp/create-server.ts', 'utf8');
    assert.match(instructions, /Start with validate, then index, then focused query calls/);
    assert.match(instructions, /Call serve when a person needs to see/);
  });
});

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

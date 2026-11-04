import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

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

/** The HTML tag scans in a source file, found through the syntax tree, so a string or comment never counts. */
function htmlTagRegexes(text: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node) && /^\/<[a-zA-Z([\\]/.test(node.text)) {
      found.push(node.text);
    }
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp') {
      const pattern = node.arguments?.[0];
      if (pattern && (ts.isStringLiteralLike(pattern) || ts.isTemplateExpression(pattern))) {
        const start = ts.isTemplateExpression(pattern) ? pattern.head.text : pattern.text;
        if (start.startsWith('<')) {
          found.push(pattern.getText());
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true));
  return found;
}

/** The source of each regex literal and each `RegExp` call with a written pattern, found through the syntax tree. */
function regexPatterns(text: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node)) {
      found.push(node.text.slice(1, node.text.lastIndexOf('/')));
    }
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp') {
      const pattern = node.arguments?.[0];
      if (pattern && ts.isStringLiteralLike(pattern)) {
        found.push(pattern.text);
      } else if (pattern && ts.isTemplateExpression(pattern)) {
        found.push([pattern.head.text, ...pattern.templateSpans.map(span => span.literal.text)].join(''));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true));
  return found;
}

function cssSyntaxPatterns(text: string): string[] {
  return regexPatterns(text).filter(pattern => /url\\\(|@import|var\\\(|\\s\*:|(?<!\(\?):\\s\*|\b(?:color|background|margin|padding|border|font)[-\w]*:/i.test(pattern));
}

const SVG_ATTRIBUTE_SCANS = [
  {
    file: 'src/core/brand-lint.ts',
    pattern: 'url\\(\\s*["\']?(?!#)',
    reason: 'scans brand mark SVG text, because a mark must not reach out through an attribute such as fill or style'
  },
  {
    file: 'src/core/brand-lint.ts',
    pattern: '@import\\b',
    reason: 'scans brand mark SVG text, and a mark with a real stylesheet is already refused for its <style> element'
  },
  {
    file: 'src/core/brand-lint.ts',
    pattern: '(?:fill|stroke|stop-color|flood-color|color)\\s*(?:=\\s*["\']|:\\s*)\\s*(?:#[0-9a-f]{3,8}\\b|(?:rgb|hsl|hwb|lab|lch|oklab|oklch)a?\\()',
    reason: 'scans presentation attributes and style attributes of brand mark SVG text'
  },
  {
    file: 'src/prototype/compiler.ts',
    pattern: 'url\\(\\s*([\'"]?)#([^\'")\\s]+)\\1\\s*\\)',
    reason: 'rescopes fragment references in the attributes of an inlined brand mark SVG'
  }
] as const;

describe('repository guards', () => {
  it('keeps HTML tag scans in src/core/markup.ts', () => {
    const scans = [...sourceFiles('src/core'), ...sourceFiles('src/prototype')]
      .filter(file => file !== path.join('src', 'core', 'markup.ts'))
      .flatMap(file => htmlTagRegexes(readFileSync(file, 'utf8')).map(pattern => `${file}: ${pattern}`));
    assert.deepEqual(scans, [], 'Fix: read the markup through src/core/markup.ts.');
  });

  it('recognizes each form of an HTML tag scan, and nothing else', () => {
    for (const scan of [
      'const a = /<script\\b/i;',
      'const a = /<(?:a|area)\\b/gi;',
      'const a = /<[a-z]+>/;',
      'const a = /<\\/style/i;',
      'a.replace(/<\\s*script/, "");',
      'const a = new RegExp("<div");',
      'const a = new RegExp(`</${name}`);',
      'const a = RegExp(\'<slot\\\\b\', "gi");'
    ]) {
      assert.equal(htmlTagRegexes(scan).length, 1, scan);
    }
    for (const other of [
      'const a = "/<script";',
      '// /<script/',
      'const a = value.replace(/</g, "&lt;");',
      'const a = /url\\(/;',
      'const a = new RegExp(`\\\\b${name}`);',
      'const a = new RegExp(pattern);',
      'const a = b / c < d / e;'
    ]) {
      assert.deepEqual(htmlTagRegexes(other), [], other);
    }
  });

  it('keeps CSS syntax scans in src/core/css.ts, except the named scans of SVG attribute text', () => {
    const scans = [...sourceFiles('src/core'), ...sourceFiles('src/prototype')]
      .filter(file => file !== path.join('src', 'core', 'css.ts'))
      .flatMap(file => cssSyntaxPatterns(readFileSync(file, 'utf8')).map(pattern => `${file.split(path.sep).join('/')}: ${pattern}`));
    assert.deepEqual(
      scans.sort(),
      SVG_ATTRIBUTE_SCANS.map(scan => `${scan.file}: ${scan.pattern}`).sort(),
      'Fix: read the CSS through src/core/css.ts. Only a scan of SVG attribute text may stay outside it, and it needs a named reason here.'
    );
  });

  it('recognizes each form of a CSS syntax scan, and nothing else', () => {
    for (const scan of [
      'const a = /url\\(/i;',
      'const a = /@import\\b/i;',
      'const a = /var\\([^()]*\\)/gi;',
      'const a = /color\\s*:/;',
      'const a = /([-\\w]+)\\s*:\\s*([^;{}]+?)/g;',
      'const a = /background:\\s/;',
      'a.replace(/URL\\(/gi, "");',
      'const a = new RegExp("url\\\\(");',
      'const a = new RegExp(`@import ${name}`);',
      'const a = RegExp(`${name}\\\\s*:`, "g");'
    ]) {
      assert.equal(cssSyntaxPatterns(scan).length, 1, scan);
    }
    for (const other of [
      'const a = "url\\\\(";',
      '// /url\\(/',
      'const a = /curl /;',
      'const a = /^https:\\/\\//;',
      'const a = /^([a-z][\\w-]*):\\s/;',
      'const a = new RegExp(pattern);'
    ]) {
      assert.deepEqual(cssSyntaxPatterns(other), [], other);
    }
  });

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

  for (const [fixture, rule] of [
    ['src/core/imports-prototype.ts', 'no-restricted-imports'],
    ['src/core/markup.ts', 'no-restricted-imports'],
    ['src/core/css.ts', 'no-restricted-imports'],
    ['src/prototype/imports-mcp.ts', 'no-restricted-imports'],
    ['src/mcp/imports-app.ts', 'no-restricted-imports'],
    ['src/mcp/imports-validate-project.ts', 'no-restricted-imports'],
    ['src/mcp/imports-core-validate.ts', 'no-restricted-imports'],
    ['src/mcp/imports-validation-worker.ts', 'no-restricted-imports'],
    ['src/app/imports-mcp.ts', 'no-restricted-imports'],
    ['src/app/imports-schemas.ts', 'no-restricted-imports'],
    ['src/app/imports-zod.ts', 'no-restricted-imports'],
    ['src/prototype/imports-schemas.ts', 'no-restricted-imports'],
    ['src/core/migrations/imports-schema.ts', 'no-restricted-imports'],
    ['cycle-a.ts', 'no-cycle']
  ] as const) {
    it(`fails lint on the wrong import in ${fixture}`, () => {
      const result = spawnSync('node_modules/.bin/oxlint', [`tests/lint-fixtures/${fixture}`], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stdout, new RegExp(rule));
    });
  }

  it('keeps the schemas and zod out of the site bundle', () => {
    assert.deepEqual(siteBundleSchemaImports('src/app/main.ts'), []);
  });

  it('reports schemas that the site bundle reaches through core', () => {
    const reached = siteBundleSchemaImports('tests/lint-fixtures/src/app/reaches-schemas-through-core.ts');
    assert.ok(reached.includes('zod/v4'), reached.join('\n'));
    assert.ok(reached.includes('src/core/schemas/screens.ts'), reached.join('\n'));
  });

  it('fails lint when src/mcp/operations.ts grows past its line limit', () => {
    const fixture = 'tests/lint-fixtures/src/mcp/operations.ts';
    assert.equal(readFileSync(fixture, 'utf8').split('\n').length - 1, 801, 'The fixture has one line more than the limit in .oxlintrc.json.');
    const result = spawnSync('node_modules/.bin/oxlint', [fixture], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /max-lines/);
  });

  it('keeps one method check and one plain-text header in the serve server, and no poll of the snapshots', () => {
    const source = readFileSync('src/mcp/serve-server.ts', 'utf8');
    assert.equal(source.split("'Method not allowed'").length - 1, 1, 'Fix: list the methods of the route in SERVE_ROUTES.');
    assert.equal(source.split("'text/plain; charset=utf-8'").length - 1, 1, 'Fix: answer with writePlainText.');
    assert.doesNotMatch(source, /\.busy\b/, 'Fix: wait with snapshots.settled().');
  });

  it('names each file read of validation, because the validation memo must cover it', () => {
    const reads = [...sourceFiles('src/core'), ...sourceFiles('src/prototype')]
      .filter(file => !['browser-preflight.ts', 'load.ts', 'filesystem-containment.ts'].includes(path.basename(file)))
      .flatMap(file => [...readFileSync(file, 'utf8').matchAll(/\b(?:existsSync|readFileSync|statSync|lstatSync|readdirSync|accessSync|readFile|stat|lstat|readdir|access|open)\((?!\))[^\n]*/g)]
        .filter(match => /^(?:existsSync|readFileSync|statSync|lstatSync|readdirSync|accessSync)\(/.test(match[0]) || /node:fs/.test(readFileSync(file, 'utf8')))
        .map(match => `${file.split(path.sep).join('/')}: ${match[0].slice(0, match[0].indexOf('('))}`));
    assert.deepEqual(reads.sort(), [
      'src/core/validate.ts: existsSync',
      'src/core/validate.ts: existsSync'
    ], 'Fix: add the new file input to projectFingerprint in src/mcp/project-validation-worker.ts when a baseline or strict result reads it, or keep it in the readiness rules, which run on each call.');
  });

  it('keeps the compiler free of clocks and random values', () => {
    const impure = sourceFiles('src/prototype')
      .filter(file => /Math\.random|Date\.now|new Date\(|randomUUID|performance\.now/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(impure, []);
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

/** Each schema module and zod import that a browser entry reaches through imports that survive the build. */
function siteBundleSchemaImports(entry: string): string[] {
  const reached = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
    if (relative.startsWith('src/core/schemas/')) reached.add(relative);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const follow = (specifier: string): void => {
      if (specifier === 'zod' || specifier.startsWith('zod/')) reached.add(specifier);
      if (!specifier.startsWith('.')) return;
      const target = path.resolve(path.dirname(file), specifier);
      for (const candidate of [`${target}.ts`, path.join(target, 'index.ts')]) {
        if (existsSync(candidate)) visit(candidate);
      }
    };
    const walk = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) follow(node.moduleSpecifier.text);
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) follow(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) follow(node.arguments[0].text);
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit(path.resolve(entry));
  return [...reached].sort();
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

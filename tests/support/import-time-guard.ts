import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** One constant setup that a module may run at import time, by its whole source text on one line. */
export interface ImportTimeAllowEntry {
  file: string;
  text: string;
}

export interface ImportTimeWork {
  file: string;
  line: number;
  text: string;
  reason: string;
}

export interface ImportTimeReport {
  work: ImportTimeWork[];
  staleAllowEntries: ImportTimeAllowEntry[];
}

export const ENTRY_MODULE = 'src/app/main.ts';

function singleLine(node: ts.Node): string {
  return node.getText().replaceAll(/\s+/g, ' ');
}

function isStatic(node: ts.PropertyDeclaration): boolean {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false;
}

function isAmbient(node: ts.ModuleDeclaration): boolean {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false;
}

/** Reads the top level of one module, and skips each function body and each instance field, because import does not run them. */
export function importTimeWorkInSource(file: string, text: string): ImportTimeWork[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const work: ImportTimeWork[] = [];
  const report = (node: ts.Node, reason: string): void => {
    work.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: singleLine(node), reason });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isPropertyDeclaration(node) && !isStatic(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
      report(node, 'the call runs at import time');
      return;
    }
    if (ts.isAwaitExpression(node)) {
      report(node, 'the await runs at import time');
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause) report(statement, 'the import runs a module only for its side effects');
    } else if (ts.isModuleDeclaration(statement) && !isAmbient(statement)) {
      report(statement, 'the namespace body runs at import time');
    } else if (ts.isVariableStatement(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isExportAssignment(statement)) {
      visit(statement);
    } else if (
      !ts.isFunctionDeclaration(statement)
      && !ts.isInterfaceDeclaration(statement)
      && !ts.isTypeAliasDeclaration(statement)
      && !ts.isExportDeclaration(statement)
      && !ts.isModuleDeclaration(statement)
      && !ts.isEmptyStatement(statement)
    ) {
      report(statement, 'the statement runs at import time');
    }
  }
  return work;
}

export function appModules(root: string = process.cwd()): string[] {
  const walk = (directory: string): string[] => readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return walk(relative);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && relative !== ENTRY_MODULE ? [relative] : [];
  });
  return walk('src/app').sort();
}

export function readImportTimeWork(
  files: readonly string[],
  allowList: readonly ImportTimeAllowEntry[],
  root: string = process.cwd()
): ImportTimeReport {
  const used = new Set<ImportTimeAllowEntry>();
  const work = files.flatMap(file => importTimeWorkInSource(file, readFileSync(path.join(root, file), 'utf8'))).filter(found => {
    const allowed = allowList.find(entry => entry.file === found.file && entry.text === found.text);
    if (allowed) used.add(allowed);
    return !allowed;
  });
  return { work, staleAllowEntries: allowList.filter(entry => !used.has(entry)) };
}

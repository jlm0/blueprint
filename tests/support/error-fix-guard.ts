import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Source directories whose messages reach a person or a build log, not an agent; each other directory of `src` is read, so that a new one cannot escape the guard. */
export const NON_AGENT_DIRECTORIES: ReadonlyMap<string, string> = new Map([
  ['app', 'The canvas shows its errors to the person who reviews it.'],
  ['hooks', 'A hook writes to the log of the agent runtime, and it stops no tool.'],
  ['scripts', 'A build script writes to the log of the developer who runs it.']
]);

export const ERROR_SOURCE_DIRECTORIES: readonly string[] = readdirSync('src', { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !NON_AGENT_DIRECTORIES.has(entry.name))
  .map(entry => `src/${entry.name}`)
  .sort();

/** Top-level files count too, so that a new file such as `src/index.ts` cannot escape the guard. */
export function errorSourcePaths(root: string): string[] {
  return readdirSync(path.join(root, 'src'), { withFileTypes: true })
    .filter(entry => (entry.isDirectory() ? !NON_AGENT_DIRECTORIES.has(entry.name) : isSourceFile(entry.name)))
    .map(entry => `src/${entry.name}`)
    .sort();
}

export type ErrorSiteKind = 'new-error' | 'throw' | 'push' | 'assign' | 'list' | 'blocker' | 'refine' | 'log';

/** One place where a message can end with no `Fix:`: the text that the guard could not prove. */
export interface FixGap {
  file: string;
  line: number;
  text: string;
  reason: string;
}

export interface ErrorSite {
  file: string;
  line: number;
  kind: ErrorSiteKind;
  text: string;
  gaps: FixGap[];
}

export interface GenericFixText {
  file: string;
  line: number;
  fix: string;
}

export interface FixAllowEntry {
  file: string;
  /** The whole source expression that the guard cannot prove, on one line, so that a new expression in the same file gets no excuse. */
  match: string;
  reason: string;
}

export interface ErrorSiteReport {
  sites: ErrorSite[];
  genericFixes: GenericFixText[];
  /** Allow list entries that matched no expression, so they no longer excuse anything. */
  staleAllowEntries: FixAllowEntry[];
}

interface Binding {
  expression: ts.Expression;
  env: Env;
}

type Env = ReadonlyMap<ts.ParameterDeclaration, Binding>;

const NO_BINDINGS: Env = new Map();
const COLLECTOR_NAME = /(?:^|[a-z])(?:errors|Errors|issues|Issues)$/;
const ERROR_CLASS_NAME = /Error$/;
const BUILT_IN_ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError']);
/** A field of a result that a guarded site filled, so its value needs no second trace. */
const CHECKED_LISTS = new Set(['errors', 'contractErrors']);
const ARRAY_PASS_THROUGH = new Set(['filter', 'slice', 'sort', 'reverse', 'concat', 'flat', 'join', 'toSorted']);
const CALLBACK_RECEIVERS = new Set(['map', 'flatMap', 'forEach', 'filter', 'find']);

/** Words that say "something is wrong" and name no change. */
export const BANNED_FIX_TEXT: readonly RegExp[] = [
  /^correct (?:the|this|that|it)\b/i,
  /^fix (?:the|this|that|it)\b/i,
  /^see (?:the )?(?:docs?|documentation|readme|error|message|log|above|below)\b/i,
  /^check (?:the|this|your) (?:file|input|error|project|value|docs?)\b/i,
  /^resolve (?:the|this|that|it)\b/i,
  /^(?:edit|update|change) (?:the|this) file\b/i,
  /^try again\b/i,
  /^retry\b/i,
  /^contact\b/i,
  /^consult\b/i
];

function isSourceFile(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.d.ts');
}

function sourceFiles(sourcePath: string): string[] {
  if (!statSync(sourcePath).isDirectory()) return isSourceFile(sourcePath) ? [sourcePath] : [];
  return readdirSync(sourcePath, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(sourcePath, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return isSourceFile(entry.name) ? [full] : [];
  });
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function singleLine(node: ts.Node): string {
  return node.getText().replaceAll(/\s+/g, ' ');
}

function literalProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === name) return property.initializer;
  }
  return undefined;
}

/** Walks a message expression through the type checker and names each path that can end without a `Fix:`. */
class MessageTracer {
  private readonly active = new Set<ts.Node>();
  private callers: Map<ts.Node, ts.CallExpression[]> | undefined;

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly root: string,
    private readonly sources: readonly ts.SourceFile[],
    private readonly allowList: readonly FixAllowEntry[],
    readonly usedAllowEntries: Set<FixAllowEntry>
  ) {}

  private gap(node: ts.Node, reason: string): FixGap[] {
    const source = node.getSourceFile();
    const file = path.relative(this.root, source.fileName).split(path.sep).join('/');
    const text = singleLine(node);
    const allowed = this.allowList.find(entry => entry.file === file && text === entry.match);
    if (allowed) {
      this.usedAllowEntries.add(allowed);
      return [];
    }
    return [{ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text, reason }];
  }

  gaps(node: ts.Expression, env: Env = NO_BINDINGS): FixGap[] {
    const expression = unwrap(node);
    if (this.active.has(expression)) return [];
    this.active.add(expression);
    const found = this.trace(expression, env);
    this.active.delete(expression);
    return found;
  }

  private trace(expression: ts.Expression, env: Env): FixGap[] {
    if (ts.isStringLiteralLike(expression)) {
      return expression.text.includes('Fix:') ? [] : this.gap(expression, 'the text has no Fix:');
    }
    if (ts.isTemplateExpression(expression)) return this.traceTemplate(expression, env);
    if (ts.isBinaryExpression(expression)) return this.traceBinary(expression, env);
    if (ts.isConditionalExpression(expression)) {
      if (isCaughtErrorMessage(expression)) return this.gap(expression, 'the message comes from a caught error');
      return [...this.gaps(expression.whenTrue, env), ...this.gaps(expression.whenFalse, env)];
    }
    if (ts.isPropertyAccessExpression(expression) && CHECKED_LISTS.has(expression.name.text)) return [];
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) return this.traceReference(expression, env);
    if (ts.isElementAccessExpression(expression)) return this.traceElement(expression, env);
    if (ts.isCallExpression(expression)) return this.traceCall(expression, env);
    if (ts.isNewExpression(expression)) {
      const argument = messageArgument(expression);
      return argument ? this.gaps(argument, env) : this.gap(expression, 'the error has no message');
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.flatMap(element => this.gaps(ts.isSpreadElement(element) ? element.expression : element, env));
    }
    if (ts.isObjectLiteralExpression(expression)) return this.traceObject(expression, env);
    return this.gap(expression, 'the guard cannot read this expression');
  }

  /** One key of a table can hold any of its values, so each value must hold a `Fix:`. */
  private traceElement(element: ts.ElementAccessExpression, env: Env): FixGap[] {
    const declaration = this.declarationOf(element.expression);
    const initial = declaration && ts.isVariableDeclaration(declaration) && declaration.initializer ? unwrap(declaration.initializer) : undefined;
    if (initial && ts.isObjectLiteralExpression(initial)) {
      return initial.properties.flatMap(property => (ts.isPropertyAssignment(property) ? this.gaps(property.initializer, env) : []));
    }
    return this.gaps(element.expression, env);
  }

  private traceObject(object: ts.ObjectLiteralExpression, env: Env): FixGap[] {
    const message = literalProperty(object, 'message');
    if (message) return this.gaps(message, env);
    const shorthand = object.properties.find(property => ts.isShorthandPropertyAssignment(property) && property.name.text === 'message');
    if (shorthand && ts.isShorthandPropertyAssignment(shorthand)) {
      const declaration = this.checker.getShorthandAssignmentValueSymbol(shorthand)?.valueDeclaration;
      if (declaration) return this.traceDeclared(declaration, shorthand.name, env);
    }
    return this.gap(object, 'the object has no message');
  }

  private traceTemplate(template: ts.TemplateExpression, env: Env): FixGap[] {
    const literals = [template.head.text, ...template.templateSpans.map(span => span.literal.text)];
    if (literals.some(text => text.includes('Fix:'))) return [];
    if (template.templateSpans.some(span => this.gaps(span.expression, env).length === 0)) return [];
    return this.gap(template, 'the template has no Fix:');
  }

  private traceBinary(binary: ts.BinaryExpression, env: Env): FixGap[] {
    const kind = binary.operatorToken.kind;
    if (kind === ts.SyntaxKind.PlusToken) {
      const passes = this.gaps(binary.left, env).length === 0 || this.gaps(binary.right, env).length === 0;
      return passes ? [] : this.gap(binary, 'the joined text has no Fix:');
    }
    if (kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken) {
      return [...this.gaps(binary.left, env), ...this.gaps(binary.right, env)];
    }
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) return this.gaps(binary.right, env);
    return this.gap(binary, 'the guard cannot read this expression');
  }

  private traceCall(call: ts.CallExpression, env: Env): FixGap[] {
    const callee = call.expression;
    if (isReflectConstruct(call)) {
      const argument = reflectedMessage(call);
      return argument ? this.gaps(argument, env) : this.gap(call, 'the error has no message');
    }
    if (ts.isPropertyAccessExpression(callee)) {
      if (ARRAY_PASS_THROUGH.has(callee.name.text)) return this.gaps(callee.expression, env);
      if ((callee.name.text === 'map' || callee.name.text === 'flatMap') && call.arguments[0]) return this.traceCallback(call.arguments[0], call, env);
    }
    const declaration = this.declarationOf(callee);
    if (!declaration || !ts.isFunctionLike(declaration) || declaration.getSourceFile().isDeclarationFile) {
      return this.gap(call, 'the guard cannot follow this call');
    }
    return this.traceFunctionBody(declaration as ts.FunctionLikeDeclaration, this.bind(declaration as ts.FunctionLikeDeclaration, call, env));
  }

  private bind(fn: ts.FunctionLikeDeclaration, call: ts.CallExpression, env: Env): Env {
    const bindings = new Map<ts.ParameterDeclaration, Binding>();
    fn.parameters.forEach((parameter, index) => {
      const argument = call.arguments[index];
      if (argument && !ts.isSpreadElement(argument)) bindings.set(parameter, { expression: argument, env });
    });
    return bindings;
  }

  private traceCallback(node: ts.Expression, site: ts.Node, env: Env): FixGap[] {
    const target = unwrap(node);
    if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) return this.traceFunctionBody(target, env);
    const declaration = this.declarationOf(target);
    if (declaration && ts.isFunctionLike(declaration) && !declaration.getSourceFile().isDeclarationFile) {
      return this.traceFunctionBody(declaration as ts.FunctionLikeDeclaration, NO_BINDINGS);
    }
    return this.gap(site, 'the guard cannot follow this callback');
  }

  private traceFunctionBody(fn: ts.FunctionLikeDeclaration, env: Env): FixGap[] {
    if (!fn.body) return this.gap(fn, 'the function has no body');
    if (!ts.isBlock(fn.body)) return this.gaps(fn.body, env);
    const returns: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    if (returns.length === 0) return this.gap(fn, 'the function returns no message');
    return returns.flatMap(expression => this.gaps(expression, env));
  }

  private declarationOf(node: ts.Expression): ts.Declaration | undefined {
    const symbol = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (!symbol) return undefined;
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
    return resolved.valueDeclaration ?? resolved.declarations?.[0];
  }

  private traceReference(reference: ts.Expression, env: Env): FixGap[] {
    const declaration = this.declarationOf(reference);
    if (!declaration) return this.gap(reference, 'the guard cannot resolve this name');
    return this.traceDeclared(declaration, reference, env);
  }

  private traceDeclared(declaration: ts.Declaration, reference: ts.Expression, env: Env): FixGap[] {
    if (ts.isFunctionLike(declaration)) return this.traceFunctionBody(declaration as ts.FunctionLikeDeclaration, NO_BINDINGS);
    if (ts.isVariableDeclaration(declaration)) return this.traceVariable(declaration, reference, env);
    if (ts.isPropertyAssignment(declaration)) return this.gaps(declaration.initializer, env);
    if (ts.isParameter(declaration)) return this.traceParameter(declaration, reference, env);
    if (ts.isBindingElement(declaration) && CHECKED_LISTS.has((declaration.propertyName ?? declaration.name).getText())) return [];
    return this.gap(reference, 'the guard cannot follow this value');
  }

  private traceVariable(declaration: ts.VariableDeclaration, reference: ts.Expression, env: Env): FixGap[] {
    const holder = ts.isVariableDeclarationList(declaration.parent) ? declaration.parent.parent : undefined;
    if (holder && ts.isForOfStatement(holder)) return this.gaps(holder.expression, env);
    const assigned = this.assignedValues(declaration);
    if (!declaration.initializer && assigned.length === 0) return this.gap(reference, 'the variable has no first value');
    const initial = declaration.initializer ? unwrap(declaration.initializer) : undefined;
    const first = !initial
      ? []
      : ts.isArrayLiteralExpression(initial) && initial.elements.length === 0 ? this.tracePushes(declaration, reference, env) : this.gaps(initial, env);
    return [...first, ...assigned.flatMap(value => this.gaps(value, env))];
  }

  private assignedValues(declaration: ts.VariableDeclaration): ts.Expression[] {
    const symbol = this.checker.getSymbolAtLocation(declaration.name);
    const values: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = unwrap(node.left);
        const holder = ts.isElementAccessExpression(target) || (ts.isPropertyAccessExpression(target) && target.name.text === 'message') ? unwrap(target.expression) : target;
        if (ts.isIdentifier(holder) && this.checker.getSymbolAtLocation(holder) === symbol) values.push(node.right);
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.getSourceFile());
    return values;
  }

  isCaughtVariable(node: ts.Expression): boolean {
    const value = unwrap(node);
    const declaration = ts.isIdentifier(value) ? this.declarationOf(value) : undefined;
    if (!declaration) return false;
    if (ts.isVariableDeclaration(declaration)) return ts.isCatchClause(declaration.parent);
    const owner = ts.isParameter(declaration) ? declaration.parent : undefined;
    return Boolean(
      owner &&
      (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
      ts.isCallExpression(owner.parent) &&
      ts.isPropertyAccessExpression(owner.parent.expression) &&
      owner.parent.expression.name.text === 'catch'
    );
  }

  private tracePushes(declaration: ts.VariableDeclaration, reference: ts.Expression, env: Env): FixGap[] {
    const symbol = this.checker.getSymbolAtLocation(declaration.name);
    const found: FixGap[] = [];
    let pushes = 0;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'push' || node.expression.name.text === 'unshift') &&
        ts.isIdentifier(node.expression.expression) &&
        this.checker.getSymbolAtLocation(node.expression.expression) === symbol
      ) {
        pushes += 1;
        for (const argument of node.arguments) found.push(...this.gaps(ts.isSpreadElement(argument) ? argument.expression : argument, env));
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.getSourceFile());
    return pushes === 0 ? this.gap(reference, 'the list stays empty in this file') : found;
  }

  private traceParameter(parameter: ts.ParameterDeclaration, reference: ts.Expression, env: Env): FixGap[] {
    const bound = env.get(parameter);
    if (bound) return this.gaps(bound.expression, bound.env);
    const owner = parameter.parent;
    if ((ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) && ts.isCallExpression(owner.parent)) {
      const call = owner.parent;
      if (ts.isPropertyAccessExpression(call.expression) && CALLBACK_RECEIVERS.has(call.expression.name.text)) {
        return this.gaps(call.expression.expression, env);
      }
    }
    if (ts.isFunctionLike(owner)) {
      const index = (owner as ts.FunctionLikeDeclaration).parameters.indexOf(parameter);
      const calls = this.callsOf(owner);
      const passed = calls.flatMap(call => call.arguments[index] ?? []);
      if (passed.length > 0) return passed.flatMap(argument => this.gaps(argument));
    }
    return this.gap(reference, 'the message comes from a parameter that no call site fills');
  }

  private callsOf(owner: ts.Node): ts.CallExpression[] {
    if (!this.callers) {
      const callers = new Map<ts.Node, ts.CallExpression[]>();
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const declaration = this.declarationOf(node.expression);
          if (declaration) callers.set(declaration, [...(callers.get(declaration) ?? []), node]);
        }
        ts.forEachChild(node, visit);
      };
      this.sources.forEach(visit);
      this.callers = callers;
    }
    return this.callers.get(owner) ?? [];
  }

  isCollector(receiver: ts.Expression, seen = new Set<ts.Node>()): boolean {
    const target = unwrap(receiver);
    const name = ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : '';
    if (COLLECTOR_NAME.test(name)) return true;
    const declaration = ts.isIdentifier(target) ? this.declarationOf(target) : undefined;
    if (!declaration || !ts.isParameter(declaration) || seen.has(declaration)) return false;
    seen.add(declaration);
    const index = declaration.parent.parameters.indexOf(declaration);
    return this.callsOf(declaration.parent).some(call => {
      const argument = call.arguments[index];
      return argument !== undefined && !ts.isSpreadElement(argument) && this.isCollector(argument, seen);
    });
  }

  shorthandGaps(property: ts.ShorthandPropertyAssignment): FixGap[] {
    const declaration = this.checker.getShorthandAssignmentValueSymbol(property)?.valueDeclaration;
    return declaration ? this.traceDeclared(declaration, property.name, NO_BINDINGS) : this.gap(property, 'the guard cannot resolve this name');
  }

  /** A pushed catch variable holds an error object and not a message, so the gap names the whole `push`. */
  pushedGaps(call: ts.CallExpression, argument: ts.Expression): FixGap[] {
    const value = ts.isSpreadElement(argument) ? argument.expression : argument;
    const declaration = ts.isIdentifier(value) ? this.declarationOf(value) : undefined;
    if (declaration && ts.isVariableDeclaration(declaration) && ts.isCatchClause(declaration.parent)) {
      return this.gap(call, 'the list holds a caught error');
    }
    return this.gaps(value);
  }

  /** The text that follows a `Fix: ` at the end of a literal, when a helper writes it. */
  fixHeads(expression: ts.Expression, env: Env = NO_BINDINGS, seen = new Set<ts.Node>()): string[] {
    const node = unwrap(expression);
    if (seen.has(node)) return [];
    seen.add(node);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isTemplateExpression(node)) return [node.head.text];
    if (ts.isConditionalExpression(node)) return [...this.fixHeads(node.whenTrue, env, seen), ...this.fixHeads(node.whenFalse, env, seen)];
    if (ts.isIdentifier(node)) {
      const declaration = this.declarationOf(node);
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return this.fixHeads(declaration.initializer, env, seen);
      return [];
    }
    if (ts.isCallExpression(node)) {
      const declaration = this.declarationOf(node.expression);
      if (!declaration || !ts.isFunctionLike(declaration) || declaration.getSourceFile().isDeclarationFile) return [];
      const fn = declaration as ts.FunctionLikeDeclaration;
      if (!fn.body) return [];
      if (!ts.isBlock(fn.body)) return this.fixHeads(fn.body, env, seen);
      const heads: string[] = [];
      const visit = (child: ts.Node): void => {
        if (ts.isFunctionLike(child)) return;
        if (ts.isReturnStatement(child) && child.expression) heads.push(...this.fixHeads(child.expression, env, seen));
        ts.forEachChild(child, visit);
      };
      ts.forEachChild(fn.body, visit);
      return heads;
    }
    return [];
  }
}

/** `error instanceof Error ? error.message : String(error)`, the form of a rethrown message. */
function isCaughtErrorMessage(expression: ts.ConditionalExpression): boolean {
  const condition = unwrap(expression.condition);
  return ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword;
}

function className(expression: ts.Expression): string {
  const callee = unwrap(expression);
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
}

function messageArgument(expression: ts.NewExpression): ts.Expression | undefined {
  return className(expression.expression) === 'AggregateError' ? expression.arguments?.[1] : expression.arguments?.[0];
}

function isReflectConstruct(call: ts.CallExpression): boolean {
  return singleLine(call.expression) === 'Reflect.construct';
}

function reflectedMessage(call: ts.CallExpression): ts.Expression | undefined {
  const [target, list] = call.arguments;
  const values = list && ts.isArrayLiteralExpression(unwrap(list)) ? (unwrap(list) as ts.ArrayLiteralExpression).elements : undefined;
  const value = values?.[target && className(target) === 'AggregateError' ? 1 : 0];
  return value && !ts.isSpreadElement(value) ? value : undefined;
}

/** The text of a zod `.refine` or `ctx.addIssue` that writes its message itself, with no `params.fix` for `agentErrorForIssue`. */
function refineMessage(call: ts.CallExpression): ts.Expression | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const method = call.expression.name.text;
  const options = method === 'refine' ? call.arguments[1] : method === 'addIssue' ? call.arguments[0] : undefined;
  if (!options) return undefined;
  if (ts.isStringLiteralLike(options) || ts.isTemplateExpression(options)) return options;
  if (!ts.isObjectLiteralExpression(options) || literalProperty(options, 'params')) return undefined;
  return literalProperty(options, 'message') ?? literalProperty(options, 'error');
}

function customErrorClasses(sources: readonly ts.SourceFile[]): Set<string> {
  const names = new Set<string>();
  const extendsAnError = (node: ts.ClassLikeDeclaration): boolean => Boolean(node.heritageClauses?.some(clause => (
    clause.token === ts.SyntaxKind.ExtendsKeyword &&
    clause.types.some(type => ts.isIdentifier(type.expression) && (BUILT_IN_ERRORS.has(type.expression.text) || ERROR_CLASS_NAME.test(type.expression.text) || names.has(type.expression.text)))
  )));
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name && extendsAnError(node)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  sources.forEach(visit);
  return names;
}

/** A list that a schema describes holds no message, so `errors: z.array(z.string())` is not a site. */
function isZodCall(expression: ts.Expression): boolean {
  let current = unwrap(expression);
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) current = unwrap(current.expression);
  return ts.isIdentifier(current) && current.text === 'z';
}

function isCollectorPush(call: ts.CallExpression, tracer: MessageTracer): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || (callee.name.text !== 'push' && callee.name.text !== 'unshift')) return false;
  return tracer.isCollector(callee.expression);
}

function writtenMessage(node: ts.BinaryExpression, tracer: MessageTracer): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const target = unwrap(node.left);
  if (ts.isElementAccessExpression(target)) return tracer.isCollector(target.expression);
  return ts.isPropertyAccessExpression(target) && target.name.text === 'message';
}

function isAdvisory(object: ts.ObjectLiteralExpression): boolean {
  const level = literalProperty(object, 'level');
  return Boolean(level && ts.isStringLiteralLike(level) && level.text === 'advisory');
}

/** A readiness item with `severity: 'blocker'` stops a handoff, so it counts as an error. */
function blockerItem(call: ts.CallExpression): ts.ObjectLiteralExpression | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'push') return undefined;
  const [argument] = call.arguments;
  if (!argument || !ts.isObjectLiteralExpression(argument)) return undefined;
  const severity = literalProperty(argument, 'severity');
  return severity && ts.isStringLiteralLike(severity) && severity.text === 'blocker' ? argument : undefined;
}

function isBuiltInErrorCall(node: ts.Expression): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && BUILT_IN_ERRORS.has(node.expression.text);
}

function isBanned(fix: string): boolean {
  return BANNED_FIX_TEXT.some(pattern => pattern.test(fix.trim()));
}

function endsWithEmptyFix(node: ts.Node & { text: string }): boolean {
  return (ts.isStringLiteralLike(node) || ts.isTemplateTail(node)) && /\S\s+Fix:\s*$/.test(node.text);
}

/** Reads every error site in the given directories through the type checker. */
export function readErrorSites(
  allowList: readonly FixAllowEntry[] = [],
  root: string = process.cwd(),
  sourcePaths: readonly string[] = errorSourcePaths(root)
): ErrorSiteReport {
  const files = sourcePaths.flatMap(sourcePath => sourceFiles(path.join(root, sourcePath)));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolveJsonModule: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['node'],
    typeRoots: [path.join(root, 'node_modules/@types')]
  });
  const sources = files.map(file => {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`The guard did not load ${file}. Fix: keep the file under ${sourcePaths.join(', ')} with a .ts name.`);
    return source;
  });
  const used = new Set<FixAllowEntry>();
  const tracer = new MessageTracer(program.getTypeChecker(), root, sources, allowList, used);
  const report: ErrorSiteReport = { sites: [], genericFixes: [], staleAllowEntries: [] };
  const errorClasses = customErrorClasses(sources);
  for (const source of sources) {
    const relative = path.relative(root, source.fileName).split(path.sep).join('/');
    const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const add = (node: ts.Node, kind: ErrorSiteKind, gaps: FixGap[]): void => {
      report.sites.push({ file: relative, line: lineOf(node), kind, text: singleLine(node), gaps });
    };
    const checkFix = (node: ts.Node, fix: string): void => {
      if (isBanned(fix)) report.genericFixes.push({ file: relative, line: lineOf(node), fix: fix.trim() });
    };
    const isErrorClass = (name: string): boolean => ERROR_CLASS_NAME.test(name) || errorClasses.has(name);
    const noMessage = (node: ts.Node): FixGap[] => [{ file: relative, line: lineOf(node), text: singleLine(node), reason: 'the error has no message' }];
    const isReflectedError = (node: ts.Node): node is ts.CallExpression => (
      ts.isCallExpression(node) && isReflectConstruct(node) && node.arguments[0] !== undefined && isErrorClass(className(node.arguments[0]))
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isNewExpression(node) && isErrorClass(className(node.expression))) ||
        (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && BUILT_IN_ERRORS.has(node.expression.text))
      ) {
        const argument = ts.isNewExpression(node) ? messageArgument(node) : node.arguments[node.expression.getText() === 'AggregateError' ? 1 : 0];
        add(node, 'new-error', argument ? tracer.gaps(argument) : noMessage(node));
      }
      if (isReflectedError(node)) {
        const argument = reflectedMessage(node);
        add(node, 'new-error', argument ? tracer.gaps(argument) : noMessage(node));
      }
      if (ts.isBinaryExpression(node) && writtenMessage(node, tracer)) {
        add(node, 'assign', tracer.gaps(node.right));
      }
      if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'errors') {
        add(node, 'list', tracer.shorthandGaps(node));
      }
      if (
        ts.isThrowStatement(node) &&
        !ts.isNewExpression(unwrap(node.expression)) &&
        !isBuiltInErrorCall(unwrap(node.expression)) &&
        !isReflectedError(unwrap(node.expression)) &&
        !tracer.isCaughtVariable(node.expression)
      ) {
        add(node, 'throw', tracer.gaps(node.expression));
      }
      if (ts.isPropertyAssignment(node) && node.name.getText() === 'errors' && !isZodCall(node.initializer)) {
        add(node, 'list', tracer.gaps(node.initializer));
      }
      if (ts.isCallExpression(node)) {
        if (singleLine(node.expression) === 'Promise.reject' && node.arguments[0] && !tracer.isCaughtVariable(node.arguments[0])) {
          add(node, 'throw', tracer.gaps(node.arguments[0]));
        }
        if (singleLine(node.expression) === 'console.error') {
          const parts = node.arguments.map(argument => tracer.gaps(argument));
          add(node, 'log', parts.length === 0 ? noMessage(node) : parts.some(gaps => gaps.length === 0) ? [] : parts.flat());
        }
        if (isCollectorPush(node, tracer)) {
          const messages = node.arguments.filter(argument => {
            const value = ts.isSpreadElement(argument) ? argument.expression : argument;
            if (!ts.isObjectLiteralExpression(value)) return true;
            return !isAdvisory(value) && Boolean(literalProperty(value, 'message'));
          });
          if (messages.length > 0) add(node, 'push', messages.flatMap(argument => tracer.pushedGaps(node, argument)));
        }
        const blocker = blockerItem(node);
        if (blocker) add(node, 'blocker', tracer.gaps(blocker));
        const refine = refineMessage(node);
        if (refine) add(node, 'refine', tracer.gaps(refine));
      }
      if (ts.isPropertyAssignment(node) && node.name.getText() === 'fix') {
        for (const head of tracer.fixHeads(node.initializer)) checkFix(node, head);
      }
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        for (const fix of node.text.split('Fix:').slice(1)) checkFix(node, fix);
        if (endsWithEmptyFix(node)) report.genericFixes.push({ file: relative, line: lineOf(node), fix: '(empty)' });
      }
      if (ts.isTemplateExpression(node)) {
        const parts = [node.head, ...node.templateSpans.map(span => span.literal)];
        node.templateSpans.forEach((span, index) => {
          const before = parts[index].text;
          if (/Fix:\s*$/.test(before)) for (const head of tracer.fixHeads(span.expression)) checkFix(node, head);
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  report.staleAllowEntries = allowList.filter(entry => !used.has(entry));
  return report;
}

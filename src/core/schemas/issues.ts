import type * as z from 'zod/v4';

const TYPE_WORDS: Readonly<Record<string, string>> = {
  array: 'a JSON array',
  boolean: 'true or false',
  int: 'a whole number',
  number: 'a JSON number',
  object: 'a JSON object',
  record: 'a JSON object',
  string: 'a JSON string'
};

const PROJECT_SCHEMA = 'schema/blueprint-project.schema.json';

/** A field that migrate fills from other files, so the agent must not write it by hand. */
const MIGRATE_REPAIRS: Readonly<Record<string, string>> = {
  'brand.json fonts': 'run the migrate tool, which fills fonts in brand.json from the font tokens and the @font-face rules'
};

function pathLabel(path: ReadonlyArray<PropertyKey>, root = 'the file'): string {
  return path.reduce<string>((label, key) => {
    if (typeof key === 'number') return `${label}[${key}]`;
    return label ? `${label}.${String(key)}` : String(key);
  }, '') || root;
}

function valueAt(raw: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  return path.reduce<unknown>((value, key) => (value as Record<PropertyKey, unknown> | null | undefined)?.[key], raw);
}

function quoted(values: readonly unknown[]): string {
  return values.map(value => JSON.stringify(value)).join(', ');
}

function plural(count: number | bigint, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function notAllowedValue(value: unknown, label: string, allowed: readonly unknown[]): { problem: string; fix: string } {
  return {
    problem: `is ${JSON.stringify(value) ?? 'missing'}, which is not an allowed value`,
    fix: allowed.length === 1 ? `set ${label} to ${quoted(allowed)}` : `set ${label} to one of ${quoted(allowed)}`
  };
}

const PROSE_FIELD_CONTENT: Readonly<Record<string, string>> = {
  accessibility: 'one line that says how assistive technology reads it',
  description: 'one line that says what it is and when to use it'
};

function proseContent(path: ReadonlyArray<PropertyKey>): string {
  const content = PROSE_FIELD_CONTENT[String(path.at(-1))];
  return content ? `: ${content}` : '';
}

function describeIssue(issue: z.core.$ZodIssue, label: string, raw: unknown, schema = PROJECT_SCHEMA): { problem: string; fix: string } {
  switch (issue.code) {
    case 'invalid_type': {
      const word = TYPE_WORDS[issue.expected] ?? `a JSON ${issue.expected}`;
      return valueAt(raw, issue.path) === undefined
        ? { problem: 'is missing', fix: `add ${label} as ${word}${proseContent(issue.path)}` }
        : { problem: `must be ${word}`, fix: `write ${label} as ${word}` };
    }
    case 'invalid_value':
      return notAllowedValue(valueAt(raw, issue.path), label, issue.values);
    case 'too_small':
      if (issue.origin === 'array') return { problem: `has fewer than ${plural(issue.minimum, 'item')}`, fix: `add items to ${label} until it has ${issue.minimum} or more` };
      if (issue.origin === 'string') return { problem: `is shorter than ${plural(issue.minimum, 'character')}`, fix: `write ${issue.minimum} or more characters in ${label}${proseContent(issue.path)}` };
      return issue.inclusive === false
        ? { problem: `must be greater than ${issue.minimum}`, fix: `set ${label} to a number greater than ${issue.minimum}` }
        : { problem: `must be ${issue.minimum} or greater`, fix: `set ${label} to ${issue.minimum} or greater` };
    case 'too_big':
      if (issue.origin === 'array') return { problem: `has more than ${plural(issue.maximum, 'item')}`, fix: `remove items from ${label} until it has ${issue.maximum} or fewer` };
      if (issue.origin === 'string') return { problem: `is longer than ${plural(issue.maximum, 'character')}`, fix: `shorten ${label} to ${issue.maximum} characters or fewer` };
      return { problem: `must be ${issue.maximum} or less`, fix: `set ${label} to ${issue.maximum} or less` };
    case 'invalid_format':
      return issue.pattern
        ? { problem: `does not match the pattern ${issue.pattern}`, fix: `change ${label} so that it matches ${issue.pattern}` }
        : { problem: `is not a valid ${issue.format}`, fix: `write ${label} as a valid ${issue.format}` };
    case 'not_multiple_of':
      return { problem: `must be a multiple of ${issue.divisor}`, fix: `set ${label} to a multiple of ${issue.divisor}` };
    case 'unrecognized_keys':
      return {
        problem: `has the unknown ${issue.keys.length > 1 ? 'fields' : 'field'} ${quoted(issue.keys)}`,
        fix: `remove ${issue.keys.length > 1 ? 'them' : 'it'} from ${label}`
      };
    case 'invalid_union':
      if ('options' in issue && issue.options) return notAllowedValue(valueAt(raw, issue.path), label, issue.options);
      return { problem: 'does not match an allowed shape', fix: `write ${label} in a shape that ${schema} allows` };
    case 'invalid_key':
      return { problem: 'is a key that is not allowed', fix: `rename ${label} to a key that ${schema} allows` };
    case 'invalid_element':
      return { problem: 'has a value that is not allowed', fix: `replace the value in ${label} with one that ${schema} allows` };
    case 'custom':
      return { problem: issue.message, fix: String(issue.params?.fix ?? `write ${label} in a shape that ${schema} allows`) };
  }
}

/** Writes the change that repairs one zod issue in the arguments of an MCP tool. */
export function toolArgumentFix(tool: string, issue: z.core.$ZodIssue, args: unknown): string {
  return describeIssue(issue, pathLabel(issue.path, `the arguments of tool ${tool}`), args, `the inputSchema of tool ${tool}`).fix;
}

/** Writes one zod issue as an agent error, so that no raw zod text reaches an agent. */
export function agentErrorForIssue(file: string, issue: z.core.$ZodIssue, raw: unknown): string {
  const label = pathLabel(issue.path);
  const { problem, fix } = describeIssue(issue, label, raw);
  return `${file}: ${label} ${problem}. Fix: ${MIGRATE_REPAIRS[`${file} ${label}`] ?? fix}.`;
}

/** Load refuses a file for each issue, so a caller that can act on the list needs the issues apart from the message. */
export class ProjectShapeError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join('\n'));
  }
}

/** Checks a structured file and leaves it as it is, because compiled output depends on its key order. */
export function structuredFileErrors(file: string, schema: z.ZodType, raw: unknown): string[] {
  const result = schema.safeParse(raw);
  return result.success ? [] : result.error.issues.map(issue => agentErrorForIssue(file, issue, raw));
}

function isUnreadable(issue: z.core.$ZodIssue, raw: unknown, required: ReadonlySet<string>): boolean {
  if (issue.code !== 'invalid_type') return false;
  const value = valueAt(raw, issue.path);
  if (value === undefined) return required.has(pathLabel(issue.path).replace(/\[\d+\]/g, '[]'));
  return !(issue.expected === 'int' && typeof value === 'number');
}

/** A pass that repairs a file runs before the file fits its schema, so it refuses only a wrong JSON type and a missing field that it reads. */
export function unreadableFileErrors(file: string, schema: z.ZodType, raw: unknown, required: ReadonlySet<string>): string[] {
  const result = schema.safeParse(raw);
  if (result.success) return [];
  return result.error.issues.filter(issue => isUnreadable(issue, raw, required)).map(issue => agentErrorForIssue(file, issue, raw));
}

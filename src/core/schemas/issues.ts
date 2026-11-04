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

function pathLabel(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((label, key) => {
    if (typeof key === 'number') return `${label}[${key}]`;
    return label ? `${label}.${String(key)}` : String(key);
  }, '') || 'the file';
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

function describeIssue(issue: z.core.$ZodIssue, label: string, raw: unknown): { problem: string; fix: string } {
  switch (issue.code) {
    case 'invalid_type': {
      const word = TYPE_WORDS[issue.expected] ?? `a JSON ${issue.expected}`;
      return valueAt(raw, issue.path) === undefined
        ? { problem: 'is missing', fix: `add ${label} as ${word}` }
        : { problem: `must be ${word}`, fix: `write ${label} as ${word}` };
    }
    case 'invalid_value':
      return notAllowedValue(valueAt(raw, issue.path), label, issue.values);
    case 'too_small':
      if (issue.origin === 'array') return { problem: `has fewer than ${plural(issue.minimum, 'item')}`, fix: `add items to ${label} until it has ${issue.minimum} or more` };
      if (issue.origin === 'string') return { problem: `is shorter than ${plural(issue.minimum, 'character')}`, fix: `write ${issue.minimum} or more characters in ${label}` };
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
      return { problem: 'does not match an allowed shape', fix: `write ${label} in a shape that schema/blueprint-project.schema.json allows` };
    case 'invalid_key':
      return { problem: 'is a key that is not allowed', fix: `rename ${label}` };
    case 'invalid_element':
      return { problem: 'has a value that is not allowed', fix: `correct the value in ${label}` };
    case 'custom':
      return { problem: issue.message, fix: String(issue.params?.fix ?? `correct ${label}`) };
  }
}

/** Writes one zod issue as an agent error, so that no raw zod text reaches an agent. */
export function agentErrorForIssue(file: string, issue: z.core.$ZodIssue, raw: unknown): string {
  const label = pathLabel(issue.path);
  const { problem, fix } = describeIssue(issue, label, raw);
  return `${file}: ${label} ${problem}. Fix: ${fix}.`;
}

/** Required fields that a reader uses without a check, so a missing one refuses the file; validate reports each other missing field with its own message. */
const REQUIRED_TO_READ: Readonly<Record<string, ReadonlySet<string>>> = {
  'manifest.json': new Set(['project', 'boards']),
  'tokens.json': new Set(['tokenGroups', 'tokenGroups[].tokens', 'tokenGroups[].tokens[].value']),
  'primitives.json': new Set(['primitives', 'primitives[].prototype', 'primitives[].prototype.source', 'primitives[].prototype.styles']),
  'components.json': new Set(['components', 'components[].prototype', 'components[].prototype.source', 'components[].prototype.styles']),
  'screens.json': new Set([
    'screens',
    'screens[].name',
    'screens[].sections',
    'screens[].sections[].uses',
    'screens[].prototype',
    'screens[].prototype.source',
    'screens[].prototype.styles',
    'screens[].prototype.states',
    'screens[].prototype.reviewConditions'
  ]),
  explorations: new Set([
    'exploration',
    'exploration.target',
    'exploration.target.baseline',
    'exploration.target.baseline.prototype',
    'exploration.target.baseline.prototype.source',
    'exploration.target.baseline.prototype.styles',
    'exploration.target.baseline.prototype.assetRefs',
    'exploration.candidates',
    'exploration.candidates[].prototype',
    'exploration.candidates[].prototype.source',
    'exploration.candidates[].prototype.styles',
    'exploration.candidates[].prototype.assetRefs'
  ]),
  history: new Set(['entry', 'entry.screen', 'entry.screen.prototype.source', 'entry.screen.prototype.styles'])
};

function isRequiredToRead(file: string, path: ReadonlyArray<PropertyKey>): boolean {
  const group = file.split('/')[0];
  return REQUIRED_TO_READ[group]?.has(pathLabel(path).replace(/\[\d+\]/g, '[]')) ?? false;
}

/** Load refuses a value of the wrong JSON type and a missing field that readers need; validate reports the rest. */
function refusesLoad(file: string, issue: z.core.$ZodIssue, raw: unknown): boolean {
  if (issue.code !== 'invalid_type') return false;
  const value = valueAt(raw, issue.path);
  if (value === undefined) return isRequiredToRead(file, issue.path);
  return !(issue.expected === 'int' && typeof value === 'number');
}

/** Checks a structured file and leaves it as it is, because compiled output depends on its key order and on fields a schema does not name. */
export function structuredFileErrors(file: string, schema: z.ZodType, raw: unknown): string[] {
  const result = schema.safeParse(raw);
  if (result.success) return [];
  return result.error.issues.filter(issue => refusesLoad(file, issue, raw)).map(issue => agentErrorForIssue(file, issue, raw));
}

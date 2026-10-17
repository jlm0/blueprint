import { lintProse } from './prose-lint';
import { isTitleCase, KEBAB_ID_PATTERN, toSentenceCase } from './reusable-contract';

export function checkClosedObject(
  errors: string[],
  label: string,
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  if (!isRecord(value)) return;
  const fields = [...required, ...optional];
  const unknown = Object.keys(value).filter(key => !fields.includes(key));
  const missing = required.filter(field => !(field in value));
  if (unknown.length > 0) {
    errors.push(`${label} has unknown field${unknown.length > 1 ? 's' : ''} ${quoteList(unknown)}. Fix: remove ${unknown.length > 1 ? 'them' : 'it'}; it carries only ${quoteList(fields)}.`);
  }
  if (missing.length > 0) {
    errors.push(`${label} is missing ${quoteList(missing)}. Fix: add ${missing.length > 1 ? 'them' : 'it'}; ${optional.length > 0 ? `every field except ${quoteList(optional)} is required` : 'every field is required'}.`);
  }
}

export function checkId(errors: string[], label: string, id: unknown): void {
  if (typeof id !== 'string' || !KEBAB_ID_PATTERN.test(id)) {
    errors.push(`${label}.id ${typeof id === 'string' ? `"${id}"` : 'is missing and'} is not kebab-case. Fix: use lowercase letters, digits, and single hyphens, such as "empty-state".`);
  }
}

export function checkName(errors: string[], label: string, name: unknown, limit: number): void {
  if (typeof name !== 'string' || !name.trim()) {
    errors.push(`${label} is missing. Fix: give it a short sentence-case name.`);
    return;
  }
  if (name.length > limit) {
    errors.push(`${label} "${name}" is ${name.length} characters. Fix: shorten it to ${limit} or fewer.`);
  }
  if (isTitleCase(name)) {
    errors.push(`${label} "${name}" is in title case. Fix: write it in sentence case, "${toSentenceCase(name)}", keeping proper nouns capitalized.`);
  }
}

export function checkText(errors: string[], label: string, text: unknown, limit: number, purpose: string): void {
  if (typeof text !== 'string' || !text.trim()) {
    errors.push(`${label} is missing. Fix: ${purpose}, in ${limit} characters or fewer.`);
    return;
  }
  if (text.length > limit) {
    errors.push(`${label} is ${text.length} characters. Fix: shorten it to ${limit} or fewer.`);
  }
}

export function checkEntries(errors: string[], label: string, value: unknown, limit: number): void {
  if (!isStringList(value)) {
    errors.push(`${label} must be a list of strings. Fix: write it as [] or ["…"].`);
    return;
  }
  value.forEach((entry, index) => {
    if (entry.length > limit) {
      errors.push(`${label}[${index}] is ${entry.length} characters. Fix: shorten it to ${limit} or fewer, or split it into two entries.`);
    }
  });
}

/** Prose errors are blocking; advisories are collected separately because each needs a judgment call. */
export function checkProse(errors: string[], label: string, text: unknown): void {
  if (typeof text !== 'string') return;
  for (const issue of lintProse(text)) {
    if (issue.level === 'error') errors.push(`${label} ${issue.message}`);
  }
}

export function quoteList(values: readonly string[]): string {
  return values.map(value => `"${value}"`).join(', ');
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

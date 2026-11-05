import { checkClosedObject, checkEntries, checkId, checkName, checkProse, checkText, isRecord, isStringList, quoteList } from './contract-checks';
import { isCssColorTokenValue, isCssLengthValue, isCssMotionValue, isCssShadowValue, isCssSizeValue, readFontValue } from './css';
import type { ProseField } from './screen-contract';
import type { DesignToken, TokenFile, TokenGroup } from './types';

export const TOKEN_FILE_FIELDS = ['schemaVersion', 'projectId', 'tokenGroups'] as const;
export const TOKEN_GROUP_FIELDS = ['id', 'name', 'description', 'styleRefs', 'notes', 'tokens'] as const satisfies ReadonlyArray<keyof TokenGroup>;
export const TOKEN_FIELDS = ['id', 'name', 'type', 'value', 'description', 'styleRef'] as const satisfies ReadonlyArray<keyof DesignToken>;
export const TOKEN_TYPES = ['color', 'space', 'size', 'radius', 'typography', 'shadow', 'motion'] as const;

export const TOKEN_LIMITS = {
  groupName: 24,
  groupDescription: 120,
  name: 32,
  description: 120,
  note: 200
} as const;

/** Prose a token group carries, with the description of each of its tokens. */
export function tokenGroupProseFields(group: TokenGroup): ProseField[] {
  const fields: ProseField[] = [];
  const add = (path: string, text: unknown): void => {
    if (typeof text === 'string' && text.trim()) fields.push({ path, text });
  };
  add('description', group.description);
  (Array.isArray(group.notes) ? group.notes : []).forEach((note, index) => add(`notes[${index}]`, note));
  for (const token of Array.isArray(group.tokens) ? group.tokens : []) {
    if (isRecord(token)) add(`token.${String(token.id)}.description`, token.description);
  }
  return fields;
}

/** Checks tokens.json against its fixed shape and the prose rules; duplicate ids stay in validateProject. */
export function validateTokenContract(errors: string[], tokens: TokenFile): void {
  checkClosedObject(errors, 'tokens.json', tokens, TOKEN_FILE_FIELDS);
  if (!Array.isArray(tokens.tokenGroups)) return;
  tokens.tokenGroups.forEach((group, index) => {
    const label = isRecord(group) && typeof group.id === 'string' && group.id ? `tokenGroup.${group.id}` : `tokens.tokenGroups[${index}]`;
    if (!isRecord(group)) {
      errors.push(`${label} must be an object. Fix: write it as { ${quoteList(TOKEN_GROUP_FIELDS)} }.`);
      return;
    }
    checkClosedObject(errors, label, group, TOKEN_GROUP_FIELDS);
    checkId(errors, label, group.id);
    checkName(errors, `${label}.name`, group.name, TOKEN_LIMITS.groupName);
    checkText(errors, `${label}.description`, group.description, TOKEN_LIMITS.groupDescription, 'say what the tokens in the group decide');
    if ('styleRefs' in group && !isStringList(group.styleRefs)) {
      errors.push(`${label}.styleRefs must be a list of strings. Fix: write it as [] or ["…"].`);
    }
    if ('notes' in group) checkEntries(errors, `${label}.notes`, group.notes, TOKEN_LIMITS.note);
    (Array.isArray(group.tokens) ? group.tokens : []).forEach((token, tokenIndex) => validateToken(errors, label, token, tokenIndex));
    for (const field of tokenGroupProseFields(group)) checkProse(errors, `${label}.${field.path}`, field.text);
  });
}

const TOKEN_VALUE_FORMS: Record<DesignToken['type'], { parses: (value: string) => boolean; form: string; example: string }> = {
  color: { parses: isCssColorTokenValue, form: 'a CSS color or a gradient', example: '"#ffffff"' },
  space: { parses: isCssLengthValue, form: 'a length, a percentage, 0, or a math function', example: '"8px"' },
  size: { parses: isCssSizeValue, form: 'a length, a percentage, a number, or a grid track list', example: '"44px"' },
  radius: { parses: isCssLengthValue, form: 'a length, a percentage, 0, or a math function', example: '"8px"' },
  typography: {
    parses: value => readFontValue(value).form !== 'other',
    form: 'a font shorthand, a font family list, or a length',
    example: '"400 14px/1.5 var(--app-font-sans)"'
  },
  shadow: { parses: isCssShadowValue, form: 'a shadow', example: '"0 1px 2px rgba(0, 0, 0, 0.2)"' },
  motion: { parses: isCssMotionValue, form: 'a duration or an easing', example: '"160ms ease"' }
};

function validateTokenValue(errors: string[], label: string, type: unknown, value: string): void {
  const form = TOKEN_VALUE_FORMS[type as DesignToken['type']];
  if (!form || form.parses(value)) return;
  errors.push(`${label}.value "${value}" is not ${form.form}, so it does not fit type "${String(type)}". Fix: set value to ${form.form}, such as ${form.example}, or set type to the type that this value has.`);
}

function validateToken(errors: string[], groupLabel: string, token: unknown, index: number): void {
  const label = isRecord(token) && typeof token.id === 'string' && token.id ? `${groupLabel}.token.${token.id}` : `${groupLabel}.tokens[${index}]`;
  if (!isRecord(token)) {
    errors.push(`${label} must be an object. Fix: write it as { ${quoteList(TOKEN_FIELDS)} }.`);
    return;
  }
  checkClosedObject(errors, label, token, TOKEN_FIELDS);
  checkId(errors, label, token.id);
  checkName(errors, `${label}.name`, token.name, TOKEN_LIMITS.name);
  if (!TOKEN_TYPES.includes(token.type as DesignToken['type'])) {
    errors.push(`${label}.type ${typeof token.type === 'string' ? `"${token.type}"` : 'is missing and'} is not a token type. Fix: set it to one of ${quoteList(TOKEN_TYPES)}.`);
  }
  if (typeof token.value !== 'string' || !token.value.trim()) {
    errors.push(`${label}.value is missing. Fix: set it to the CSS value the token stands for, such as "#ffffff" or "8px".`);
  } else {
    validateTokenValue(errors, label, token.type, token.value);
  }
  checkText(errors, `${label}.description`, token.description, TOKEN_LIMITS.description, 'say where the token applies');
  if (typeof token.styleRef !== 'string' || !/^--[\w-]+$/.test(token.styleRef)) {
    errors.push(`${label}.styleRef ${typeof token.styleRef === 'string' ? `"${token.styleRef}"` : 'is missing and'} is not a CSS custom property. Fix: set it to the property prototypes read, such as "--app-color-surface".`);
  }
}

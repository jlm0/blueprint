type Shape = 'array' | 'object' | 'string';

const SHAPE_WORDS: Record<Shape, string> = {
  array: 'a JSON array',
  object: 'a JSON object',
  string: 'a JSON string'
};

function hasShape(value: unknown, shape: Shape): boolean {
  if (shape === 'array') return Array.isArray(value);
  if (shape === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return typeof value === 'string';
}

function requireShape(errors: string[], file: string, field: string, value: unknown, shape: Shape): boolean {
  if (hasShape(value, shape)) return true;
  errors.push(`${file}: ${field} must be ${SHAPE_WORDS[shape]}. Fix: write ${field} as ${SHAPE_WORDS[shape]}.`);
  return false;
}

function requireOptionalShape(errors: string[], file: string, field: string, value: unknown, shape: Shape): void {
  if (value !== undefined) requireShape(errors, file, field, value, shape);
}

function requirePrototype(errors: string[], file: string, field: string, prototype: unknown): void {
  if (prototype === undefined || prototype === null) return;
  if (requireShape(errors, file, field, prototype, 'object')) {
    requireShape(errors, file, `${field}.styles`, (prototype as { styles?: unknown }).styles, 'array');
  }
}

function records(value: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(value) ? value : []).filter(item => typeof item === 'object' && item !== null);
}

/** Refuses a structured file whose containers have the wrong JSON type, because later readers iterate them. */
export function assertStructuredShapes(files: {
  manifest: unknown;
  tokens: unknown;
  primitives: unknown;
  components: unknown;
  screens: unknown;
  brand: unknown;
}): void {
  const errors: string[] = [];
  const field = (file: unknown, name: string): unknown => (file as Record<string, unknown> | null | undefined)?.[name];

  requireShape(errors, 'manifest.json', 'project', field(files.manifest, 'project'), 'object');
  for (const name of ['boards', 'framePresets']) {
    requireOptionalShape(errors, 'manifest.json', name, field(files.manifest, name), 'array');
  }

  const tokenGroups = field(files.tokens, 'tokenGroups');
  if (requireShape(errors, 'tokens.json', 'tokenGroups', tokenGroups, 'array')) {
    records(tokenGroups).forEach((group, index) => {
      requireOptionalShape(errors, 'tokens.json', `tokenGroups[${index}].tokens`, group.tokens, 'array');
    });
  }

  for (const [file, name, value] of [
    ['primitives.json', 'primitives', files.primitives],
    ['components.json', 'components', files.components]
  ] as const) {
    const items = field(value, name);
    if (requireShape(errors, file, name, items, 'array')) {
      records(items).forEach((item, index) => requirePrototype(errors, file, `${name}[${index}].prototype`, item.prototype));
    }
  }

  const screens = field(files.screens, 'screens');
  if (requireShape(errors, 'screens.json', 'screens', screens, 'array')) {
    records(screens).forEach((screen, index) => {
      requireShape(errors, 'screens.json', `screens[${index}].name`, screen.name, 'string');
      requireOptionalShape(errors, 'screens.json', `screens[${index}].sections`, screen.sections, 'array');
      requirePrototype(errors, 'screens.json', `screens[${index}].prototype`, screen.prototype);
    });
  }

  if (files.brand !== undefined) {
    requireOptionalShape(errors, 'brand.json', 'personality', field(files.brand, 'personality'), 'array');
    const marks = field(files.brand, 'marks');
    requireOptionalShape(errors, 'brand.json', 'marks', marks, 'array');
    records(marks).forEach((mark, index) => {
      requireOptionalShape(errors, 'brand.json', `marks[${index}].variants`, mark.variants, 'array');
    });
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

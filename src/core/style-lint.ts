import { collapseCssWhitespace, isCssLengthLiteral, listCssDeclarations, type CssDeclaration } from './css';
import type { BlueprintProjectBundle, DesignToken, LocalValueException, PrototypeAsset } from './types';

export type LocalStyleRule = 'literal-color' | 'named-color' | 'restated-token' | 'raw-font-family' | 'raw-font-size';

export interface LocalStyleValueIssue {
  rule: LocalStyleRule;
  boundary: string;
  styleRef: string;
  property: string;
  value: string;
  category: 'color' | 'spacing' | 'radius' | 'typography' | 'shadow';
  tokenStyleRef?: string;
  /** The named color that `named-color` found. */
  namedColor?: string;
  /** The length in `value` that equals the token that `restated-token` found. */
  restatedLength?: string;
}

const spacingEdges = ['top', 'right', 'bottom', 'left', 'inline', 'block'];
const spacingProperties = new Set([
  'gap',
  'row-gap',
  'column-gap',
  ...['margin', 'padding'].flatMap(base => [
    base,
    ...spacingEdges.flatMap(edge => [`${base}-${edge}`, `${base}-${edge}-start`, `${base}-${edge}-end`])
  ])
]);
const radiusProperties = new Set([
  'border-radius',
  ...['top', 'bottom', 'start', 'end'].flatMap(block => ['left', 'right', 'start', 'end'].map(inline => `border-${block}-${inline}-radius`))
]);
const typographyLengthProperties = new Set(['font-size', 'letter-spacing']);
const shadowProperties = new Set(['box-shadow', 'text-shadow']);
export const maskProperties: ReadonlySet<string> = new Set(['mask', 'mask-image', '-webkit-mask', '-webkit-mask-image']);
export const tokenLengthCategory: Partial<Record<DesignToken['type'], LocalStyleValueIssue['category']>> = {
  space: 'spacing',
  radius: 'radius',
  typography: 'typography',
  shadow: 'shadow'
};

/**
 * Primitive, component, and screen CSS must take colors and type from token custom properties, and must not
 * restate a token's length as a literal. `localValueExceptions` can excuse a literal color or a restated length,
 * but not raw type. Unique composition lengths stay valid.
 */
export function lintLocalStyleValues(bundle: BlueprintProjectBundle<PrototypeAsset>): LocalStyleValueIssue[] {
  const lengthTokens = readLengthTokens(bundle);
  const boundaries = [
    ...bundle.primitives.primitives.map(primitive => ({ label: `primitive.${primitive.id}`, prototype: primitive.prototype })),
    ...bundle.components.components.map(component => ({ label: `component.${component.id}`, prototype: component.prototype })),
    ...bundle.screens.screens.map(screen => ({ label: `screen.${screen.id}`, prototype: screen.prototype }))
  ];
  return boundaries.flatMap(({ label, prototype }) => (prototype.styles ?? []).flatMap(styleRef => {
    const css = bundle.prototypeSourceContents[styleRef];
    return css === undefined ? [] : lintStylesheetValues(label, styleRef, css, prototype.localValueExceptions, lengthTokens);
  }));
}

export function readLengthTokens(bundle: BlueprintProjectBundle<PrototypeAsset>): ReadonlyMap<string, string> {
  const lengthTokens = new Map<string, string>();
  for (const group of bundle.tokens.tokenGroups) {
    for (const token of group.tokens) {
      const value = token.value.trim().toLowerCase();
      const category = tokenLengthCategory[token.type];
      const key = `${category}:${value}`;
      if (category && isCssLengthLiteral(value) && Number.parseFloat(value) !== 0 && !lengthTokens.has(key)) {
        lengthTokens.set(key, token.styleRef);
      }
    }
  }
  return lengthTokens;
}

export function lintStylesheetValues(
  label: string,
  styleRef: string,
  css: string,
  exceptions: LocalValueException[] | undefined,
  lengthTokens: ReadonlyMap<string, string>
): LocalStyleValueIssue[] {
  const issues: LocalStyleValueIssue[] = [];
  for (const declaration of listCssDeclarations(css)) {
    if (declaration.inFontFace) continue;
    const rawType = rawFontFamilyFinding(declaration) ?? rawFontSizeFinding(declaration);
    const literal = rawType ?? (isExcepted(exceptions, declaration.property, declaration.value)
      ? undefined
      : namedColorFinding(declaration) ?? literalFinding(declaration, lengthTokens));
    if (literal) {
      issues.push({ boundary: label, styleRef, property: declaration.property, value: declaration.value, ...literal });
    }
  }
  return issues;
}

type LocalStyleFinding = Pick<LocalStyleValueIssue, 'rule' | 'category' | 'tokenStyleRef' | 'namedColor' | 'restatedLength'>;

function namedColorFinding(declaration: CssDeclaration): LocalStyleFinding | undefined {
  const namedColor = declaration.namedColors[0];
  return namedColor === undefined ? undefined : { rule: 'named-color', category: 'color', namedColor };
}

function literalFinding(declaration: CssDeclaration, lengthTokens: ReadonlyMap<string, string>): LocalStyleFinding | undefined {
  if (declaration.hasColorLiteral && !maskProperties.has(declaration.property)) return { rule: 'literal-color', category: 'color' };
  const category = lengthCategory(declaration.property);
  if (!category) return undefined;
  for (const length of declaration.lengths) {
    const tokenStyleRef = lengthTokens.get(`${category}:${length.toLowerCase()}`);
    if (tokenStyleRef) return { rule: 'restated-token', category, tokenStyleRef, restatedLength: length };
  }
  return undefined;
}

function rawFontFamilyFinding(declaration: CssDeclaration): LocalStyleFinding | undefined {
  if (declaration.property !== 'font-family' || isInheritOrOneVariable(declaration)) return undefined;
  return { rule: 'raw-font-family', category: 'typography' };
}

/** A `font` shorthand sets the size too, so it is raw for the same reason. */
function rawFontSizeFinding(declaration: CssDeclaration): LocalStyleFinding | undefined {
  if (declaration.property === 'font' && !isInheritOrOneVariable(declaration)) return { rule: 'raw-font-size', category: 'typography' };
  if (declaration.property !== 'font-size') return undefined;
  if (isInheritOrOneVariable(declaration) || (declaration.variables.length > 0 && declaration.lengths.length === 0)) return undefined;
  return { rule: 'raw-font-size', category: 'typography' };
}

function isInheritOrOneVariable(declaration: CssDeclaration): boolean {
  const value = declaration.value.toLowerCase();
  return value === 'inherit' || (declaration.variables.length === 1 && value === `var(${declaration.variables[0].toLowerCase()})`);
}

export function lengthCategory(property: string): LocalStyleValueIssue['category'] | undefined {
  if (spacingProperties.has(property)) return 'spacing';
  if (radiusProperties.has(property)) return 'radius';
  if (typographyLengthProperties.has(property)) return 'typography';
  if (shadowProperties.has(property)) return 'shadow';
  return undefined;
}

export function isExcepted(exceptions: LocalValueException[] | undefined, property: string, value: string): boolean {
  return (exceptions ?? []).some(exception => (
    exception.property.toLowerCase() === property &&
    value.toLowerCase() === collapseCssWhitespace(exception.value.trim()).toLowerCase()
  ));
}

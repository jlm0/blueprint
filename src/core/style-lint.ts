import { collapseCssWhitespace, isCssLengthLiteral, listCssDeclarations, type CssDeclaration } from './css';
import type { BlueprintProjectBundle, DesignToken, LocalValueException, PrototypeAsset } from './types';

export interface LocalStyleValueIssue {
  boundary: string;
  styleRef: string;
  property: string;
  value: string;
  category: 'color' | 'spacing' | 'radius' | 'typography' | 'shadow';
  tokenStyleRef?: string;
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
const maskProperties = new Set(['mask', 'mask-image', '-webkit-mask', '-webkit-mask-image']);
const tokenLengthCategory: Partial<Record<DesignToken['type'], LocalStyleValueIssue['category']>> = {
  space: 'spacing',
  radius: 'radius',
  typography: 'typography',
  shadow: 'shadow'
};

/**
 * Primitive, component, and screen CSS must take colors from token custom properties, and must not
 * restate a token's length as a literal, unless the literal is declared in `localValueExceptions`.
 * Unique composition lengths stay valid.
 */
export function lintLocalStyleValues(bundle: BlueprintProjectBundle<PrototypeAsset>): LocalStyleValueIssue[] {
  const issues: LocalStyleValueIssue[] = [];
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
  const boundaries = [
    ...bundle.primitives.primitives.map(primitive => ({ label: `primitive.${primitive.id}`, prototype: primitive.prototype })),
    ...bundle.components.components.map(component => ({ label: `component.${component.id}`, prototype: component.prototype })),
    ...bundle.screens.screens.map(screen => ({ label: `screen.${screen.id}`, prototype: screen.prototype }))
  ];
  for (const { label, prototype } of boundaries) {
    for (const styleRef of prototype.styles ?? []) {
      const css = bundle.prototypeSourceContents[styleRef];
      if (css === undefined) continue;
      for (const declaration of listCssDeclarations(css)) {
        const literal = literalFinding(declaration, lengthTokens);
        if (literal && !isExcepted(prototype.localValueExceptions, declaration.property, declaration.value)) {
          issues.push({ boundary: label, styleRef, property: declaration.property, value: declaration.value, ...literal });
        }
      }
    }
  }
  return issues;
}

function literalFinding(
  declaration: CssDeclaration,
  lengthTokens: Map<string, string>
): Pick<LocalStyleValueIssue, 'category' | 'tokenStyleRef'> | undefined {
  if (declaration.hasColorLiteral && !maskProperties.has(declaration.property)) return { category: 'color' };
  const category = lengthCategory(declaration.property);
  if (!category) return undefined;
  for (const length of declaration.lengths) {
    const tokenStyleRef = lengthTokens.get(`${category}:${length.toLowerCase()}`);
    if (tokenStyleRef) return { category, tokenStyleRef };
  }
  return undefined;
}

function lengthCategory(property: string): LocalStyleValueIssue['category'] | undefined {
  if (spacingProperties.has(property)) return 'spacing';
  if (radiusProperties.has(property)) return 'radius';
  if (typographyLengthProperties.has(property)) return 'typography';
  if (shadowProperties.has(property)) return 'shadow';
  return undefined;
}

function isExcepted(exceptions: LocalValueException[] | undefined, property: string, value: string): boolean {
  return (exceptions ?? []).some(exception => (
    exception.property.toLowerCase() === property &&
    value.toLowerCase().includes(collapseCssWhitespace(exception.value).toLowerCase())
  ));
}

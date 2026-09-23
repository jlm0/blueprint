import type { BlueprintProjectBundle, DesignToken, LocalValueException } from './types';

export interface LocalStyleValueIssue {
  boundary: string;
  styleRef: string;
  property: string;
  value: string;
  category: 'color' | 'spacing' | 'radius' | 'typography' | 'shadow';
  tokenStyleRef?: string;
}

const spacingProperty = /^(?:margin|padding)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$|^(?:row-|column-)?gap$/;
const radiusProperty = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/;
const typographyLengthProperty = /^(?:font-size|letter-spacing)$/;
const shadowProperty = /^(?:box-shadow|text-shadow)$/;
const maskProperty = /^(?:-webkit-)?mask(?:-image)?$/;
const tokenLengthCategory: Partial<Record<DesignToken['type'], LocalStyleValueIssue['category']>> = {
  space: 'spacing',
  radius: 'radius',
  typography: 'typography',
  shadow: 'shadow'
};
const colorLiteral = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const lengthLiteral = /(?<![\w.#-])-?(?:\d*\.)?\d+(?:px|rem|em)\b/gi;

/**
 * Primitive, component, and screen CSS must take colors from token custom properties, and must not
 * restate a token's length as a literal, unless the literal is declared in `localValueExceptions`.
 * Unique composition lengths stay valid.
 */
export function lintLocalStyleValues(bundle: BlueprintProjectBundle): LocalStyleValueIssue[] {
  const issues: LocalStyleValueIssue[] = [];
  const lengthTokens = new Map<string, string>();
  for (const group of bundle.tokens.tokenGroups) {
    for (const token of group.tokens) {
      const value = token.value.trim().toLowerCase();
      const category = tokenLengthCategory[token.type];
      const key = `${category}:${value}`;
      if (category && /^-?(?:\d*\.)?\d+(?:px|rem|em)$/.test(value) && Number.parseFloat(value) !== 0 && !lengthTokens.has(key)) {
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
      for (const declaration of cssDeclarations(css)) {
        const literal = literalFinding(declaration.property, declaration.value, lengthTokens);
        if (literal && !isExcepted(prototype.localValueExceptions, declaration.property, declaration.value)) {
          issues.push({ boundary: label, styleRef, property: declaration.property, value: declaration.value, ...literal });
        }
      }
    }
  }
  return issues;
}

function cssDeclarations(css: string): Array<{ property: string; value: string }> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([-\w]+)\s*:\s*([^;{}]+?)\s*(?=;|})/g)].map(match => ({
    property: match[1].toLowerCase(),
    value: match[2].replace(/\s+/g, ' ')
  }));
}

function literalFinding(
  property: string,
  value: string,
  lengthTokens: Map<string, string>
): Pick<LocalStyleValueIssue, 'category' | 'tokenStyleRef'> | undefined {
  const literal = stripTokenReferences(value);
  if (colorLiteral.test(literal) && !maskProperty.test(property)) return { category: 'color' };
  const category = lengthCategory(property);
  if (!category) return undefined;
  for (const [length] of literal.matchAll(lengthLiteral)) {
    const tokenStyleRef = lengthTokens.get(`${category}:${length.toLowerCase()}`);
    if (tokenStyleRef) return { category, tokenStyleRef };
  }
  return undefined;
}

function lengthCategory(property: string): LocalStyleValueIssue['category'] | undefined {
  if (spacingProperty.test(property)) return 'spacing';
  if (radiusProperty.test(property)) return 'radius';
  if (typographyLengthProperty.test(property)) return 'typography';
  if (shadowProperty.test(property)) return 'shadow';
  return undefined;
}

function stripTokenReferences(value: string): string {
  let stripped = value.replace(/url\([^)]*\)/gi, '');
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(/var\([^()]*\)/gi, '');
  } while (stripped !== previous);
  return stripped;
}

function isExcepted(exceptions: LocalValueException[] | undefined, property: string, value: string): boolean {
  return (exceptions ?? []).some(exception => (
    exception.property.toLowerCase() === property &&
    value.toLowerCase().includes(exception.value.replace(/\s+/g, ' ').toLowerCase())
  ));
}

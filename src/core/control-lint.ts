import type { BlueprintProjectBundle } from './types';

export interface HandBuiltControlIssue {
  boundary: string;
  sourceRef: string;
  line: number;
  element: string;
  primitiveId: string;
}

const buttonInputTypes = new Set(['button', 'submit', 'reset']);
const ignoredInputTypes = new Set(['hidden', 'file', 'color', 'image']);

/**
 * Screen and component sources must instantiate the app's canonical control primitive
 * instead of hand-building the native element, unless the element opts out with
 * `data-blueprint-native="<reason>"`.
 */
export function lintHandBuiltControls(bundle: BlueprintProjectBundle): HandBuiltControlIssue[] {
  const canonicalPrimitives = new Set(
    bundle.primitives.primitives.filter(primitive => primitive.prototype).map(primitive => primitive.id)
  );
  const boundaries = [
    ...bundle.components.components.map(component => ({ label: `component.${component.id}`, sourceRef: component.prototype.source })),
    ...bundle.screens.screens.flatMap(screen => screen.prototype ? [{ label: `screen.${screen.id}`, sourceRef: screen.prototype.source }] : [])
  ];
  const issues: HandBuiltControlIssue[] = [];
  for (const { label, sourceRef } of boundaries) {
    const source = bundle.prototypeSourceContents[sourceRef];
    if (source === undefined) continue;
    for (const match of source.matchAll(/<(button|input|select|textarea)\b([^>]*)>/gi)) {
      const element = match[1].toLowerCase();
      const attributes = match[2];
      if (/\bdata-blueprint-native\s*=/i.test(attributes)) continue;
      const primitiveId = matchingPrimitiveId(element, attributes);
      if (primitiveId && canonicalPrimitives.has(primitiveId)) {
        issues.push({
          boundary: label,
          sourceRef,
          line: source.slice(0, match.index).split('\n').length,
          element,
          primitiveId
        });
      }
    }
  }
  return issues;
}

function matchingPrimitiveId(element: string, attributes: string): string | undefined {
  if (element === 'button') return 'button';
  if (element === 'select') return 'select';
  if (element === 'textarea') return 'input';
  const type = (/\btype\s*=\s*(['"]?)([\w-]+)\1/i.exec(attributes)?.[2] ?? 'text').toLowerCase();
  if (ignoredInputTypes.has(type)) return undefined;
  if (buttonInputTypes.has(type)) return 'button';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (type === 'range') return 'slider';
  return 'input';
}

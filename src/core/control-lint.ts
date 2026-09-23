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
  const primitiveIds = new Set(
    bundle.primitives.primitives.map(primitive => primitive.id)
  );
  const boundaries = [
    ...bundle.components.components.map(component => ({ label: `component.${component.id}`, sourceRef: component.prototype.source })),
    ...bundle.screens.screens.map(screen => ({ label: `screen.${screen.id}`, sourceRef: screen.prototype.source }))
  ];
  const issues: HandBuiltControlIssue[] = [];
  for (const { label, sourceRef } of boundaries) {
    const source = bundle.prototypeSourceContents[sourceRef];
    if (source === undefined) continue;
    for (const match of source.matchAll(/<(button|input|select|textarea)\b([^>]*)>/gi)) {
      const element = match[1].toLowerCase();
      const attributes = match[2];
      if (/\bdata-blueprint-native\s*=/i.test(attributes)) continue;
      const primitiveId = matchingPrimitiveIds(element, attributes).find(candidate => primitiveIds.has(candidate));
      if (primitiveId) {
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

function matchingPrimitiveIds(element: string, attributes: string): string[] {
  if (element === 'button') return ['button'];
  if (element === 'select') return ['select'];
  if (element === 'textarea') return ['textarea', 'input'];
  const type = (/\btype\s*=\s*(['"]?)([\w-]+)\1/i.exec(attributes)?.[2] ?? 'text').toLowerCase();
  if (ignoredInputTypes.has(type)) return [];
  if (buttonInputTypes.has(type)) return ['button'];
  if (type === 'checkbox') return ['checkbox'];
  if (type === 'radio') return ['radio'];
  if (type === 'range') return ['slider'];
  return ['input'];
}

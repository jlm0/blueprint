import { attributeWithValue, listOpenTags, type OpenTag } from './markup';
import type { BlueprintProjectBundle, PrototypeAsset } from './types';

export interface HandBuiltControlIssue {
  boundary: string;
  sourceRef: string;
  line: number;
  element: string;
  primitiveId: string;
}

const nativeControls = new Set(['button', 'input', 'select', 'textarea']);
const buttonInputTypes = new Set(['button', 'submit', 'reset']);
const ignoredInputTypes = new Set(['hidden', 'file', 'color', 'image']);

/**
 * Screen and component sources must instantiate the app's canonical control primitive
 * instead of hand-building the native element, unless the element opts out with
 * `data-blueprint-native="<reason>"`.
 */
export function lintHandBuiltControls(bundle: BlueprintProjectBundle<PrototypeAsset>): HandBuiltControlIssue[] {
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
    for (const tag of listOpenTags(source)) {
      if (!nativeControls.has(tag.name) || attributeWithValue(tag, 'data-blueprint-native')) continue;
      const primitiveId = matchingPrimitiveIds(tag).find(candidate => primitiveIds.has(candidate));
      if (primitiveId) {
        issues.push({
          boundary: label,
          sourceRef,
          line: source.slice(0, tag.start).split('\n').length,
          element: tag.name,
          primitiveId
        });
      }
    }
  }
  return issues;
}

function matchingPrimitiveIds(tag: OpenTag): string[] {
  if (tag.name === 'button') return ['button'];
  if (tag.name === 'select') return ['select'];
  if (tag.name === 'textarea') return ['textarea', 'input'];
  const type = (attributeWithValue(tag, 'type')?.value || 'text').toLowerCase();
  if (ignoredInputTypes.has(type)) return [];
  if (buttonInputTypes.has(type)) return ['button'];
  if (type === 'checkbox') return ['checkbox'];
  if (type === 'radio') return ['radio'];
  if (type === 'range') return ['slider'];
  return ['input'];
}

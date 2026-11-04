import { rewriteCssAttributeSelectors } from './css';
import { applyMarkupEdits, listOpenTags, type MarkupEdit } from './markup';
import { asArray, asObject, isObject, type RawObject } from './raw-json';

export type PlacementAttribute = 'variant' | 'size' | 'state';

/** Where each placement attribute value of one reusable goes; `null` drops the attribute. */
export interface PlacementRemap {
  state: Map<string, PlacementAttribute>;
  variant: Map<string, PlacementAttribute | null>;
}

/** Placement attributes of moved values; a conflicting attribute is left for the agent and reported. */
export function rewritePlacements(
  html: string,
  remaps: Map<string, PlacementRemap>,
  file: string
): { html: string; rewritten: number; conflicts: string[] } {
  let rewritten = 0;
  const conflicts: string[] = [];
  const edits: MarkupEdit[] = [];
  for (const tag of listOpenTags(html)) {
    if (tag.name !== 'blueprint-use') continue;
    const attributes = tag.attributes
      .filter(attribute => attribute.quote)
      .map(attribute => ({ name: html.slice(attribute.nameStart, attribute.nameEnd), quote: attribute.quote, value: attribute.value }));
    const kind = attributes.find(attribute => attribute.name.toLowerCase() === 'kind')?.value;
    const ref = attributes.find(attribute => attribute.name.toLowerCase() === 'ref')?.value;
    const remap = kind && ref ? remaps.get(`${kind}:${ref}`) : undefined;
    if (!remap) continue;
    const next: typeof attributes = [];
    let changed = false;
    for (const attribute of attributes) {
      const name = attribute.name.toLowerCase();
      const target = name === 'state' ? remap.state.get(attribute.value) : name === 'variant' ? remap.variant.get(attribute.value) : undefined;
      if (target === undefined || target === name) {
        next.push(attribute);
        continue;
      }
      changed = true;
      if (target === null) continue;
      next.push({ ...attribute, name: target });
    }
    const names = next.map(attribute => attribute.name.toLowerCase());
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate) {
      conflicts.push(`${file}: a ${ref} placement would set "${duplicate}" twice after the move, so it was left as it was; set its variant, size, and state by hand.`);
      continue;
    }
    if (!changed) continue;
    rewritten += 1;
    const serialized = next.map(attribute => ` ${attribute.name}=${attribute.quote}${attribute.value}${attribute.quote}`).join('');
    edits.push({ start: tag.start, end: tag.end, text: `<blueprint-use${serialized}${tag.selfClosing ? ' /' : ''}>` });
  }
  return { html: applyMarkupEdits(html, edits), rewritten, conflicts };
}

const AXIS_BY_SELECTOR_ATTRIBUTE = new Map([['data-blueprint-state', 'state'], ['data-blueprint-variant', 'variant'], ['data-blueprint-size', 'size']]);

/** In the reusable's own stylesheet every axis selector moves; elsewhere only selectors compounded with that reusable do. */
export function rewriteAxisSelectors(css: string, remap: PlacementRemap, kind: 'primitive' | 'component', reusableId: string, ownsFile: boolean): string {
  return rewriteCssAttributeSelectors(css, selector => {
    const axis = AXIS_BY_SELECTOR_ATTRIBUTE.get(selector.name);
    const target = axis === 'state' ? remap.state.get(selector.value) : axis === 'variant' ? remap.variant.get(selector.value) : undefined;
    if (!target || target === axis) return undefined;
    return `[data-blueprint-${target}=${selector.quote || '"'}${selector.value}${selector.quote || '"'}]`;
  }, ownsFile ? undefined : { name: `data-blueprint-${kind}`, value: reusableId });
}

/** Moves section binding values of reclassified reusables in screens.json, exploration baselines, and history entries. */
export function rewriteScreenRecordBindings(record: RawObject, remaps: Map<string, PlacementRemap>): number {
  const screens: RawObject[] = [
    ...asArray(record.screens).map(asObject),
    ...(isObject(record.exploration) ? [asObject(asObject(asObject(asObject(record.exploration).target).baseline).screen)] : []),
    ...(isObject(record.entry) ? [asObject(asObject(record.entry).screen)] : [])
  ];
  let count = 0;
  for (const screen of screens) {
    for (const section of asArray(screen.sections).map(asObject)) {
      for (const use of asArray(section.uses).map(asObject)) {
        if (use.kind === 'state-set') {
          use.kind = 'primitive';
          use.id = String(use.id).split('/')[0];
          count += 1;
        }
        const remap = remaps.get(`${String(use.kind)}:${String(use.id)}`);
        if (!remap || !isObject(use.binding)) continue;
        const binding = use.binding as Record<string, string>;
        const moves: Array<[string, PlacementAttribute | null]> = [];
        if (binding.state && remap.state.has(binding.state)) moves.push(['state', remap.state.get(binding.state)!]);
        if (binding.variant && remap.variant.has(binding.variant)) moves.push(['variant', remap.variant.get(binding.variant)!]);
        const values = Object.fromEntries(moves.map(([from]) => [from, binding[from]]));
        for (const [from] of moves) delete binding[from];
        for (const [from, to] of moves) {
          if (to && binding[to] === undefined) binding[to] = values[from];
        }
        count += moves.length;
      }
    }
  }
  return count;
}

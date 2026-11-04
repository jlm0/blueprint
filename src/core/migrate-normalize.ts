import { basePrimitiveText } from './base-primitive-text';
import { BASE_PRIMITIVE_CONTRACT, basePrimitive, type BasePrimitiveText } from './base-primitives';
import { normalizeScreenShapes, normalizeTokenShapes, reportNames, sentenceCaseName } from './migrate-shapes';
import { rewriteAxisSelectors, rewritePlacements, rewriteScreenRecordBindings, type PlacementRemap } from './placement-remap';
import { asArray, asObject, parseJsonFile, serializeJson, unique, type RawObject } from './raw-json';
import { SINGLE_VALUE_DESCRIPTIONS, SIZE_VALUE_IDS, stripRootAxisAttributes } from './reusable-contract';
import { isSavedRecordFile } from './storage-records';
import type { ComponentFile, PrimitiveFile, ReusableAxisName, ReusableDefinition } from './types';

export interface NormalizeInput {
  files: ReadonlyMap<string, string>;
  starterFiles: ReadonlyMap<string, string>;
}

const AXIS_NAMES: Record<'variants' | 'states', ReusableAxisName> = { variants: 'variant', states: 'state' };

export function normalizeCurrentFiles(input: NormalizeInput, writes: Map<string, string>, changes: string[]): void {
  normalizeReusables(input, writes, changes);
  normalizeScreenShapes(input.files, writes, changes);
  normalizeTokenShapes(input.files, writes, changes);
}

function normalizeReusables(input: NormalizeInput, writes: Map<string, string>, changes: string[]): void {
  const currentText = (file: string): string | undefined => writes.get(file) ?? input.files.get(file);
  const primitiveFile = parseJsonFile(input.files, 'primitives.json') as PrimitiveFile;
  const componentFile = parseJsonFile(input.files, 'components.json') as ComponentFile;

  restoreMissingBasePrimitives(primitiveFile, input.starterFiles, currentText, writes, changes);

  const reusables = [
    ...primitiveFile.primitives.map(reusable => ({ kind: 'primitive' as const, reusable })),
    ...componentFile.components.map(reusable => ({ kind: 'component' as const, reusable }))
  ];

  let rootRewrites = 0;
  for (const { reusable } of reusables) {
    const file = reusable.prototype?.source;
    const before = file ? currentText(file) : undefined;
    if (!file || before === undefined) continue;
    const html = stripRootAxisAttributes(before);
    if (html !== before) {
      writes.set(file, html);
      rootRewrites += 1;
    }
  }
  if (rootRewrites > 0) {
    changes.push(`Removed hardcoded variant, size, and state attributes from ${rootRewrites} reusable root elements; the compiler stamps them.`);
  }

  const remaps = new Map<string, PlacementRemap>();
  for (const { kind, reusable } of reusables) {
    const remap = moveSizeValues(kind, reusable, changes);
    if (remap) remaps.set(`${kind}:${reusable.id}`, remap);
  }
  if (remaps.size > 0) {
    applyRemaps(input, remaps, reusables.map(({ kind, reusable }) => ({ kind, id: reusable.id, styles: reusable.prototype?.styles ?? [] })), writes, changes);
  }

  let restored = 0;
  let movedNotes = 0;
  for (const primitive of primitiveFile.primitives) {
    const text = basePrimitiveText(primitive.id);
    if (!text) continue;
    const result = restoreBlueprintText(primitive, text);
    if (result.changed) restored += 1;
    movedNotes += result.movedNotes;
  }
  if (restored > 0) {
    changes.push(`primitives.json: ${restored} primitive${restored > 1 ? 's' : ''} now carry Blueprint's description, accessibility, notes, and value and slot text, and hints from earlier starters use the current wording.`);
  }
  if (movedNotes > 0) {
    changes.push(`primitives.json: moved ${movedNotes} app note${movedNotes > 1 ? 's' : ''} on Blueprint primitives to implementationHints.`);
  }

  const renamed = { renamed: [] as string[] };
  for (const item of [...componentFile.groups, ...componentFile.components]) sentenceCaseName(item, renamed);
  reportNames(changes, 'components.json', renamed);

  const starterAgents = input.starterFiles.get('AGENTS.md');
  if (input.files.has('AGENTS.md') && starterAgents !== undefined && currentText('AGENTS.md') !== starterAgents) {
    writes.set('AGENTS.md', starterAgents);
    changes.push('AGENTS.md: replaced with the current starter copy.');
  }

  for (const [file, value] of [['primitives.json', primitiveFile], ['components.json', componentFile]] as const) {
    if (JSON.stringify(JSON.parse(input.files.get(file)!)) !== JSON.stringify(value)) writes.set(file, serializeJson(value));
  }
}

/** Which token takes a role is the app's choice, so a primitive that names a token the project lacks stays out. */
function restoreMissingBasePrimitives(
  primitiveFile: PrimitiveFile,
  starterFiles: ReadonlyMap<string, string>,
  currentText: (file: string) => string | undefined,
  writes: Map<string, string>,
  changes: string[]
): void {
  const declared = new Set(primitiveFile.primitives.map(primitive => primitive.id));
  const missing = BASE_PRIMITIVE_CONTRACT.filter(entry => !declared.has(entry.id));
  if (missing.length === 0) return;
  const starter = parseJsonFile(starterFiles, 'primitives.json') as PrimitiveFile;
  const tokenRefs = declaredTokenRefs(currentText('tokens.json'));
  const restored: string[] = [];
  for (const { id } of missing) {
    const primitive = starter.primitives.find(candidate => candidate.id === id);
    if (!primitive) continue;
    const absent = [...primitive.tokenGroupIds, ...Object.keys(primitive.tokenRoles)].filter(ref => !tokenRefs.has(ref));
    if (absent.length > 0) {
      changes.push(`primitives.json: left out the missing Blueprint primitive "${id}", because tokens.json does not declare ${absent.map(ref => `"${ref}"`).join(', ')}. Fix: add them, then run migrate again.`);
      continue;
    }
    primitiveFile.primitives.push(primitive);
    restored.push(`"${id}"`);
    for (const file of [primitive.prototype.source, ...primitive.prototype.styles]) {
      const text = starterFiles.get(file);
      if (text !== undefined && currentText(file) === undefined) writes.set(file, text);
    }
  }
  if (restored.length > 0) {
    changes.push(`primitives.json: restored ${restored.length} missing Blueprint primitive${restored.length > 1 ? 's' : ''} from the starter, with the prototype files: ${restored.join(', ')}.`);
  }
}

function declaredTokenRefs(tokensText: string | undefined): Set<string> {
  const refs = new Set<string>();
  for (const group of asArray(asObject(JSON.parse(tokensText ?? '{}')).tokenGroups).map(asObject)) {
    refs.add(String(group.id));
    for (const token of asArray(group.tokens).map(asObject)) refs.add(`${String(group.id)}.${String(token.id)}`);
  }
  return refs;
}

/** Notes earlier starters wrote on Blueprint primitives; Blueprint's own notes replace them. */
const RETIRED_STARTER_NOTES: ReadonlySet<string> = new Set([
  'Apps should replace token values and variant naming only when their design system requires it; do not recreate one-off buttons per screen.',
  'Input states are a core app behavior and should not be inferred from a single rendered form.',
  'Roots marked data-blueprint-surface take the level after their nearest marked ancestor; a surface state sets an explicit level for its subtree.',
  'This generalizes the reference mark into a replaceable app-owned loader.',
  'Use the ramp roles instead of one-off font styles; screens may still set screen-local display treatments.'
]);

/** Hints earlier starters wrote on Blueprint primitives, with the wording that replaces each. */
const REWRITTEN_STARTER_HINTS: ReadonlyMap<string, string> = new Map([
  ['Hover: Apply on pointer hover only; touch platforms skip it.', 'Hover: Apply it on pointer hover only. Touch platforms skip it.'],
  ['Replace geometry with the app mark if one exists; keep tone states.', "Replace the geometry with the app's mark when it has one. Keep the tone variants."],
  ["Keep the listbox in the primitive; map options from the target app's data.", "Keep the listbox in the primitive. Map its options from the target app's data."],
  ['Keep one tablist per section set; expose the selected tab to assistive technology.', 'Keep one tablist per set of sections. Expose the selected tab to assistive technology.'],
  ['Map to the target avatar component; replace initials with a controlled image asset when one exists.', 'Map it to the target avatar component. Replace the initials with a controlled image asset when one exists.'],
  ['Show on hover and keyboard focus; never put required information only in a tooltip.', 'Show it on hover and on keyboard focus. Never put required information only in a tooltip.'],
  ['Map to the target segmented control; use tabs instead when options switch whole panels.', 'Map it to the target segmented control. Use tabs instead when the options switch whole panels.']
]);

/** Puts Blueprint's text on one of its primitives; app notes move to implementationHints so nothing is lost. */
function restoreBlueprintText(primitive: ReusableDefinition, text: BasePrimitiveText): { changed: boolean; movedNotes: number } {
  const before = JSON.stringify(primitive);
  const appNotes = (primitive.notes ?? []).filter(note => !text.notes.includes(note) && !RETIRED_STARTER_NOTES.has(note));
  const hints = (primitive.implementationHints ?? []).map(hint => REWRITTEN_STARTER_HINTS.get(hint) ?? hint);
  primitive.implementationHints = unique([...hints, ...appNotes]);
  primitive.notes = [...text.notes];
  primitive.description = text.description;
  primitive.accessibility = text.accessibility;
  for (const key of ['variants', 'sizes', 'states'] as const) {
    for (const value of primitive[key].values) {
      if (Object.hasOwn(text[key], value.id)) Object.assign(value, text[key][value.id]);
    }
  }
  for (const slot of primitive.slots) {
    if (Object.hasOwn(text.slots, slot.id)) Object.assign(slot, text.slots[slot.id]);
  }
  return { changed: JSON.stringify(primitive) !== before, movedNotes: appNotes.length };
}

/** Moves variants and states named like sizes, such as "compact", into sizes; @returns where placements of the moved values go. */
function moveSizeValues(kind: 'primitive' | 'component', reusable: ReusableDefinition, changes: string[]): PlacementRemap | undefined {
  const contract = kind === 'primitive' ? basePrimitive(reusable.id) : undefined;
  const remap: PlacementRemap = { state: new Map(), variant: new Map() };
  const sizeIds = new Set(reusable.sizes.values.map(value => value.id));
  for (const key of ['variants', 'states'] as const) {
    const locked = new Set(contract?.[key].values ?? []);
    const moved = reusable[key].values.filter(value => SIZE_VALUE_IDS.has(value.id) && !locked.has(value.id) && !sizeIds.has(value.id));
    if (moved.length === 0) continue;
    if (reusable.sizes.values.length === 1 && reusable.sizes.values[0].id === 'default' && reusable.sizes.values[0].description === SINGLE_VALUE_DESCRIPTIONS.size) {
      reusable.sizes.values[0] = { ...reusable.sizes.values[0], description: 'The standard size.' };
    }
    reusable.sizes.values.push(...moved);
    for (const value of moved) sizeIds.add(value.id);
    const remaining = reusable[key].values.filter(value => !moved.includes(value));
    reusable[key] = {
      default: moved.some(value => value.id === reusable[key].default) ? remaining[0]?.id ?? 'default' : reusable[key].default,
      values: remaining.length > 0 ? remaining : [{ id: 'default', name: 'Default', description: SINGLE_VALUE_DESCRIPTIONS[AXIS_NAMES[key]] }]
    };
    const axis = AXIS_NAMES[key];
    const before = reusable.unsupported.length;
    reusable.unsupported = reusable.unsupported.filter(combination => !moved.some(value => (
      axis === 'state' ? combination.state === value.id : combination.axis === 'variant' && combination.value === value.id
    )));
    for (const value of moved) remap[axis === 'state' ? 'state' : 'variant'].set(value.id, 'size');
    changes.push(`${kind} ${reusable.id}: ${axis}${moved.length > 1 ? 's' : ''} ${moved.map(value => value.id).join(', ')} ${moved.length > 1 ? 'are' : 'is'} now ${moved.length > 1 ? 'sizes' : 'a size'}.`);
    if (reusable.unsupported.length !== before) {
      changes.push(`${kind} ${reusable.id}: dropped unsupported combinations that named the moved ${axis}s; list them again against sizes if they still apply.`);
    }
  }
  return remap.state.size > 0 || remap.variant.size > 0 ? remap : undefined;
}

/** Rewrites placements, axis selectors, and screen section bindings for every remapped reusable. */
function applyRemaps(
  input: NormalizeInput,
  remaps: Map<string, PlacementRemap>,
  owners: Array<{ kind: 'primitive' | 'component'; id: string; styles: string[] }>,
  writes: Map<string, string>,
  changes: string[]
): void {
  const currentText = (file: string): string => writes.get(file) ?? input.files.get(file) ?? '';
  const fileNames = [...new Set([...input.files.keys(), ...writes.keys()])].sort();
  let placements = 0;
  for (const file of fileNames.filter(name => name.endsWith('.html'))) {
    const before = currentText(file);
    const { html, rewritten, conflicts } = rewritePlacements(before, remaps, file);
    if (html !== before) writes.set(file, html);
    placements += rewritten;
    changes.push(...conflicts);
  }
  const styleCounts = new Map<string, number>();
  for (const owner of owners) for (const style of new Set(owner.styles)) styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
  let cssFiles = 0;
  for (const file of fileNames.filter(name => name.endsWith('.css'))) {
    const before = currentText(file);
    let css = before;
    for (const owner of owners) {
      const remap = remaps.get(`${owner.kind}:${owner.id}`);
      if (remap) css = rewriteAxisSelectors(css, remap, owner.kind, owner.id, owner.styles.includes(file) && styleCounts.get(file) === 1);
    }
    if (css !== before) {
      writes.set(file, css);
      cssFiles += 1;
    }
  }
  let bindings = 0;
  for (const file of fileNames.filter(name => name === 'screens.json' || isSavedRecordFile(name))) {
    const record = JSON.parse(currentText(file)) as RawObject;
    const count = rewriteScreenRecordBindings(record, remaps);
    if (count > 0) {
      writes.set(file, serializeJson(record));
      bindings += count;
    }
  }
  if (placements > 0) changes.push(`Rewrote ${placements} <blueprint-use> placements to the moved sizes.`);
  if (cssFiles > 0) changes.push(`Rewrote size selectors in ${cssFiles} CSS files to match.`);
  if (bindings > 0) changes.push(`Moved ${bindings} screen section binding values to sizes.`);
}

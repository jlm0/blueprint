import { listUsePlacements, slotContentAccepts, sourceSlotContents } from '../prototype/compiler';
import { basePrimitiveText } from './base-primitive-text';
import { basePrimitive, type BasePrimitiveContractEntry, type BasePrimitiveText, type PrimitiveGroupId } from './base-primitives';
import {
  humanizeId,
  PLATFORMS,
  REUSABLE_FIELDS,
  REUSABLE_SCHEMA_VERSION,
  rootAxisValues,
  SINGLE_VALUE_DESCRIPTIONS,
  SIZE_VALUE_IDS,
  stripRootAxisAttributes,
  toSentenceCase
} from './reusable-contract';
import type {
  ComponentFile,
  DeclaredGroup,
  Platform,
  PrimitiveFile,
  ReusableAxis,
  ReusableAxisName,
  ReusableDefinition,
  ReusableDependency,
  ReusableSlot
} from './types';

/** Inputs to {@linkcode migrateProjectFiles}: every JSON, HTML, CSS, and Markdown file in the project. */
export interface MigrationInput {
  /** Text contents keyed by project-relative path with forward slashes. */
  files: Map<string, string>;
  /** The current starter `primitives.json`, the source of Blueprint names, descriptions, and slot accepts. */
  starterPrimitives: PrimitiveFile;
  /** The current starter `AGENTS.md`, already rewritten for this project. */
  starterAgents: string;
}

export interface MigrationOutput {
  fromVersion: string;
  toVersion: string;
  upToDate: boolean;
  /** New contents keyed by project-relative path, only for files that change. */
  writes: Map<string, string>;
  /** One line per kind of mechanical change applied. */
  changes: string[];
}

type RawObject = Record<string, unknown>;
type AxisKey = 'variants' | 'sizes' | 'states';
type PlacementAttribute = 'variant' | 'size' | 'state';

/** v1 primitives whose values Blueprint now files under a different axis. */
const AXIS_MOVES: Record<string, { variants?: 'sizes'; states?: 'variants' | 'sizes'; everyState?: boolean }> = {
  text: { variants: 'sizes', states: 'variants', everyState: true },
  slider: { states: 'variants' },
  'back-button': { states: 'sizes' },
  surface: { states: 'variants' },
  'nav-bar': { states: 'variants' },
  list: { states: 'variants' },
  'pressable-row': { states: 'variants' },
  'row-layout': { states: 'variants' },
  'loading-mark': { states: 'variants' },
  skeleton: { states: 'variants' },
  'alert-dialog': { states: 'variants' },
  'bottom-sheet': { states: 'variants' },
  tooltip: { states: 'variants' }
};

/** Runtime conditions that stay states when a primitive's other v1 states become variants or sizes. */
const RUNTIME_STATE_IDS = new Set([
  'normal', 'default', 'hover', 'focus', 'focused', 'focus-visible', 'pressed', 'active', 'disabled', 'disabled-on',
  'loading', 'busy', 'selected', 'checked', 'on', 'off', 'open', 'invalid', 'error', 'empty', 'value', 'filled', 'dragging'
]);

/** Resting values a migration may add when Blueprint now requires them and the base CSS already draws them. */
const RESTING_VALUE_IDS = new Set(['default', 'normal']);

const AXIS_NAMES: Record<AxisKey, ReusableAxisName> = { variants: 'variant', sizes: 'size', states: 'state' };
const AXIS_ATTRIBUTES: Record<AxisKey, PlacementAttribute> = { variants: 'variant', sizes: 'size', states: 'state' };

/** Where each v1 placement attribute value of one primitive goes; `null` drops the attribute. */
interface PlacementRemap {
  state: Map<string, PlacementAttribute>;
  variant: Map<string, PlacementAttribute | null>;
}

/**
 * Upgrades a v1 project to the reusable contract without touching the disk.
 * Applies every mechanical change; judgment calls are left for validation to report.
 *
 * @throws {Error} When primitives.json or components.json is missing or on an unknown schema version.
 */
export function migrateProjectFiles(input: MigrationInput): MigrationOutput {
  const primitivesFile = parseJsonFile(input.files, 'primitives.json');
  const componentsFile = parseJsonFile(input.files, 'components.json');
  const fromVersion = String(primitivesFile.schemaVersion ?? '');
  const componentsVersion = String(componentsFile.schemaVersion ?? '');
  for (const [file, version] of [['primitives.json', fromVersion], ['components.json', componentsVersion]]) {
    if (version !== '1.0.0' && version !== REUSABLE_SCHEMA_VERSION) {
      throw new Error(`${file} is on schema "${version}", which migrate does not know how to upgrade.`);
    }
  }

  const writes = new Map<string, string>();
  const changes: string[] = [];
  const current = fromVersion === REUSABLE_SCHEMA_VERSION && componentsVersion === REUSABLE_SCHEMA_VERSION
    ? { primitiveFile: primitivesFile as unknown as PrimitiveFile, componentFile: componentsFile as unknown as ComponentFile }
    : upgradeFromV1(input, primitivesFile, componentsFile, writes, changes);
  normalizeProject(input, current.primitiveFile, current.componentFile, writes, changes);
  for (const [file, value] of [['primitives.json', current.primitiveFile], ['components.json', current.componentFile]] as const) {
    const before = input.files.get(file);
    if (before === undefined || JSON.stringify(JSON.parse(before)) !== JSON.stringify(value)) writes.set(file, serializeJson(value));
    else writes.delete(file);
  }
  return { fromVersion, toVersion: REUSABLE_SCHEMA_VERSION, upToDate: writes.size === 0, writes, changes };
}

function upgradeFromV1(
  input: MigrationInput,
  primitivesFile: RawObject,
  componentsFile: RawObject,
  writes: Map<string, string>,
  changes: string[]
): { primitiveFile: PrimitiveFile; componentFile: ComponentFile } {
  const rawPrimitives = asArray(primitivesFile.primitives).map(asObject);
  const rawComponents = asArray(componentsFile.components).map(asObject);
  const htmlFiles = [...input.files.keys()].filter(file => file.endsWith('.html')).sort();
  const cssFiles = [...input.files.keys()].filter(file => file.endsWith('.css')).sort();

  const remaps = new Map<string, PlacementRemap>();
  const primitiveAxes = new Map<string, Record<AxisKey, string[]>>();
  const axisMoveNotes: string[] = [];
  for (const raw of rawPrimitives) {
    const id = String(raw.id);
    const { axes, remap, notes } = reclassifyPrimitiveAxes(raw, basePrimitive(id));
    primitiveAxes.set(id, axes);
    if (remap) remaps.set(`primitive:${id}`, remap);
    axisMoveNotes.push(...notes);
  }
  changes.push(...axisMoveNotes);

  const placementTotals = { rewritten: 0, files: 0, conflicts: [] as string[] };
  for (const file of htmlFiles) {
    const before = input.files.get(file)!;
    const { html, rewritten, conflicts } = rewritePlacements(before, remaps, file);
    if (html !== before) {
      writes.set(file, html);
      placementTotals.rewritten += rewritten;
      placementTotals.files += 1;
    }
    placementTotals.conflicts.push(...conflicts);
  }
  if (placementTotals.rewritten > 0) {
    changes.push(`Rewrote ${placementTotals.rewritten} <blueprint-use> placements in ${placementTotals.files} HTML files to the new axes.`);
  }
  changes.push(...placementTotals.conflicts);

  const styleOwners = countStyleOwners([...rawPrimitives, ...rawComponents], asArray(parseJsonFile(input.files, 'screens.json').screens).map(asObject));
  let cssRewrites = 0;
  for (const file of cssFiles) {
    const before = writes.get(file) ?? input.files.get(file)!;
    let css = before;
    for (const raw of rawPrimitives) {
      const remap = remaps.get(`primitive:${String(raw.id)}`);
      if (!remap) continue;
      const owns = asArray(asObject(raw.prototype).styles).includes(file) && styleOwners.get(file) === 1;
      css = rewriteAxisSelectors(css, remap, 'primitive', String(raw.id), owns);
    }
    if (css !== before) {
      writes.set(file, css);
      cssRewrites += 1;
    }
  }
  if (cssRewrites > 0) {
    changes.push(`Rewrote axis selectors in ${cssRewrites} CSS files to match.`);
  }

  const currentHtml = (file: string): string => writes.get(file) ?? input.files.get(file) ?? '';
  const placements = htmlFiles.flatMap(file => listUsePlacements(currentHtml(file)));
  const starterById = new Map(input.starterPrimitives.primitives.map(primitive => [primitive.id, primitive]));

  const primitives = rawPrimitives.map(raw => migratePrimitive(raw, primitiveAxes.get(String(raw.id))!, {
    contract: basePrimitive(String(raw.id)),
    starter: starterById.get(String(raw.id)),
    source: currentHtml(String(asObject(raw.prototype).source ?? '')),
    placements,
    changes
  }));
  const components = rawComponents.map(raw => migrateComponent(raw, {
    source: currentHtml(String(asObject(raw.prototype).source ?? '')),
    placements,
    changes
  }));
  changes.push(
    `primitives.json: ${primitives.length} primitives now carry name, group, platforms, variants, sizes, states, slots, and accessibility in the shared reusable shape; state sets were folded in.`,
    `components.json: ${components.length} components now carry the shared reusable shape, with a default variant and size; "sections" is now "groups" and "section" is "group".`
  );

  const primitiveFile: PrimitiveFile = {
    schemaVersion: REUSABLE_SCHEMA_VERSION,
    projectId: String(primitivesFile.projectId ?? ''),
    primitives
  };
  const componentFile: ComponentFile = {
    schemaVersion: REUSABLE_SCHEMA_VERSION,
    projectId: String(componentsFile.projectId ?? ''),
    groups: asArray(componentsFile.groups ?? componentsFile.sections).map(asObject).map(migrateDeclaredGroup),
    components
  };

  let bindingRewrites = 0;
  for (const file of [...input.files.keys()].filter(isScreenRecordFile).sort()) {
    const before = input.files.get(file)!;
    const record = JSON.parse(before) as RawObject;
    const count = rewriteScreenRecordBindings(record, remaps);
    if (count > 0) {
      writes.set(file, serializeJson(record));
      bindingRewrites += count;
    }
  }
  if (bindingRewrites > 0) {
    changes.push(`Moved ${bindingRewrites} screen section binding values to the new axes.`);
  }

  return { primitiveFile, componentFile };
}

/** Mechanical fixes every project gets on each run, whatever schema it started on. */
function normalizeProject(
  input: MigrationInput,
  primitiveFile: PrimitiveFile,
  componentFile: ComponentFile,
  writes: Map<string, string>,
  changes: string[]
): void {
  const currentText = (file: string): string | undefined => writes.get(file) ?? input.files.get(file);
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

  if (input.files.has('AGENTS.md') && currentText('AGENTS.md') !== input.starterAgents) {
    writes.set('AGENTS.md', input.starterAgents);
    changes.push('AGENTS.md: replaced with the current starter copy.');
  }
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
  input: MigrationInput,
  remaps: Map<string, PlacementRemap>,
  owners: Array<{ kind: 'primitive' | 'component'; id: string; styles: string[] }>,
  writes: Map<string, string>,
  changes: string[]
): void {
  const currentText = (file: string): string => writes.get(file) ?? input.files.get(file) ?? '';
  let placements = 0;
  for (const file of [...input.files.keys()].filter(name => name.endsWith('.html')).sort()) {
    const before = currentText(file);
    const { html, rewritten, conflicts } = rewritePlacements(before, remaps, file);
    if (html !== before) writes.set(file, html);
    placements += rewritten;
    changes.push(...conflicts);
  }
  const styleCounts = new Map<string, number>();
  for (const owner of owners) for (const style of new Set(owner.styles)) styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
  let cssFiles = 0;
  for (const file of [...input.files.keys()].filter(name => name.endsWith('.css')).sort()) {
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
  for (const file of [...input.files.keys()].filter(isScreenRecordFile).sort()) {
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

function reclassifyPrimitiveAxes(
  raw: RawObject,
  contract: BasePrimitiveContractEntry | undefined
): { axes: Record<AxisKey, string[]>; remap?: PlacementRemap; notes: string[] } {
  const id = String(raw.id);
  const prototype = asObject(raw.prototype);
  if (isObject(raw.states)) {
    return { axes: { variants: axisValueIds(raw.variants), sizes: axisValueIds(raw.sizes), states: axisValueIds(raw.states) }, notes: [] };
  }
  const oldVariants = stringList(prototype.variants);
  let variants = oldVariants.length > 0 ? [...oldVariants] : ['default'];
  let sizes = stringList(prototype.sizes);
  let states = stringList(prototype.states);
  const move = AXIS_MOVES[id];
  const remap: PlacementRemap = { state: new Map(), variant: new Map() };
  const notes: string[] = [];

  if (move?.variants === 'sizes') {
    sizes = unique([...sizes, ...variants]);
    for (const value of variants) remap.variant.set(value, 'size');
    notes.push(`primitive ${id}: variants ${variants.join(', ')} are now sizes.`);
    variants = [];
  }
  if (move?.states) {
    const moved = states.filter(state => move.everyState || !RUNTIME_STATE_IDS.has(state));
    states = states.filter(state => !moved.includes(state));
    const target = move.states;
    if (moved.length > 0) {
      if (target === 'variants') {
        if (oldVariants.length <= 1 && (oldVariants[0] ?? 'default') === 'default' && move.variants !== 'sizes') {
          variants = [];
          remap.variant.set('default', null);
        }
        variants = unique([...variants, ...moved]);
      } else {
        sizes = unique([...sizes, ...moved]);
      }
      for (const value of moved) remap.state.set(value, AXIS_ATTRIBUTES[target]);
      notes.push(`primitive ${id}: states ${moved.join(', ')} are now ${target}.`);
    }
  }

  const axes: Record<AxisKey, string[]> = {
    variants: variants.length > 0 ? variants : ['default'],
    sizes: sizes.length > 0 ? sizes : ['default'],
    states: states.length > 0 ? states : ['default']
  };
  for (const key of ['variants', 'sizes', 'states'] as const) {
    const required = contract?.[key].default;
    if (required && RESTING_VALUE_IDS.has(required) && !axes[key].includes(required)) {
      axes[key] = axes[key].length === 1 && axes[key][0] === 'default' && key !== 'variants' ? [required] : [required, ...axes[key]];
      notes.push(`primitive ${id}: added the resting ${AXIS_NAMES[key]} "${required}" Blueprint now requires.`);
    }
  }
  const changed = remap.state.size > 0 || remap.variant.size > 0;
  return { axes, ...(changed ? { remap } : {}), notes };
}

interface PrimitiveMigrationContext {
  contract: BasePrimitiveContractEntry | undefined;
  starter: ReusableDefinition | undefined;
  source: string;
  placements: ReturnType<typeof listUsePlacements>;
  changes: string[];
}

function migratePrimitive(raw: RawObject, axes: Record<AxisKey, string[]>, context: PrimitiveMigrationContext): ReusableDefinition {
  if (isObject(raw.states)) {
    return raw as unknown as ReusableDefinition;
  }
  const id = String(raw.id);
  const prototype = asObject(raw.prototype);
  const { contract, starter } = context;
  const stateSetNames = new Map<string, string>();
  const stateSetNotes: string[] = [];
  const stateSetHints: string[] = [];
  for (const stateSet of asArray(raw.stateSets).map(asObject)) {
    for (const state of asArray(stateSet.states).map(asObject)) {
      const stateName = String(state.name ?? state.id);
      if (!stateSetNames.has(String(state.id))) stateSetNames.set(String(state.id), stateName);
      stateSetNotes.push(...stringList(state.notes).map(note => `${toSentenceCase(stateName)}: ${note}`));
      stateSetHints.push(...stringList(state.implementationHints).map(hint => `${toSentenceCase(stateName)}: ${hint}`));
    }
  }

  const axis = (key: AxisKey): ReusableAxis => {
    const values = axes[key].map(valueId => {
      const known = starter?.[key]?.values?.find(value => value.id === valueId);
      const fallbackName = stateSetNames.get(valueId);
      return {
        id: valueId,
        name: known?.name ?? (fallbackName ? toSentenceCase(fallbackName) : humanizeId(valueId)),
        description: known?.description ?? (axes[key].length === 1 && valueId === 'default' ? SINGLE_VALUE_DESCRIPTIONS[AXIS_NAMES[key]] : '')
      };
    });
    return { default: axisDefault(key, axes[key], contract, rootDefault(context.source, AXIS_NAMES[key], axes[key])), values };
  };

  const name = contract?.name ?? String(raw.name ?? '');
  if (contract && raw.name !== contract.name) {
    context.changes.push(`primitive ${id}: renamed "${String(raw.name)}" to its Blueprint name "${contract.name}".`);
  }
  const { uses, tokenGroupIds } = migrateUses(raw.uses, stringList(raw.tokenGroupIds), `primitive ${id}`, context.changes);
  const slotIds = unique([...stringList(prototype.slots), ...defaultSlotIfPlaced(context.source)]);
  return orderReusable({
    id,
    name,
    description: String(raw.description ?? ''),
    group: contract?.group ?? inferPrimitiveGroup(id),
    platforms: contract?.platforms ?? migratedPrimitivePlatforms(raw.platforms),
    uses,
    variants: axis('variants'),
    sizes: axis('sizes'),
    states: axis('states'),
    unsupported: [],
    slots: slotIds.map(slotId => migrateSlot(slotId, 'primitive', id, context.source, context.placements, starter?.slots?.find(slot => slot.id === slotId))),
    prototype: migratePrototype(prototype),
    tokenGroupIds,
    tokenRoles: isObject(prototype.tokenRoles) ? prototype.tokenRoles as Record<string, string> : {},
    accessibility: String(prototype.accessibilityIntent ?? ''),
    notes: unique([...stringList(raw.notes), ...stateSetNotes]),
    implementationHints: unique([...stringList(raw.implementationHints), ...stateSetHints]),
    implementationTargets: asArray(raw.implementationTargets) as ReusableDefinition['implementationTargets'],
    styleRefs: stringList(raw.styleRefs),
    styleEvidence: asArray(raw.styleEvidence) as ReusableDefinition['styleEvidence'],
    prototypeOnly: raw.prototypeOnly === true
  });
}

function axisDefault(key: AxisKey, values: string[], contract: BasePrimitiveContractEntry | undefined, rootValue: string | undefined): string {
  const required = contract?.[key].default;
  if (required && values.includes(required)) return required;
  if (rootValue) return rootValue;
  if (key === 'sizes') {
    return values.find(value => value === 'md') ?? values.find(value => value === 'default') ?? values[0];
  }
  return values[0];
}

function rootDefault(source: string, axis: ReusableAxisName, values: string[]): string | undefined {
  const root = rootAxisValues(source);
  return [root[axis], ...Object.values(root)].find(value => value !== undefined && values.includes(value));
}

interface ComponentMigrationContext {
  source: string;
  placements: ReturnType<typeof listUsePlacements>;
  changes: string[];
}

function migrateComponent(raw: RawObject, context: ComponentMigrationContext): ReusableDefinition {
  if (isObject(raw.states)) {
    return raw as unknown as ReusableDefinition;
  }
  const id = String(raw.id);
  const prototype = asObject(raw.prototype);
  const stateIds = stringList(prototype.states);
  const states = stateIds.length > 0 ? stateIds : ['default'];
  const { uses, tokenGroupIds } = migrateUses(raw.uses, stringList(raw.tokenGroupIds), `component ${id}`, context.changes);
  const slotIds = unique([...stringList(prototype.slots), ...defaultSlotIfPlaced(context.source)]);
  return orderReusable({
    id,
    name: String(raw.name ?? ''),
    description: String(raw.description ?? ''),
    group: String(raw.group ?? raw.section ?? ''),
    platforms: [],
    uses,
    variants: singleValueAxis('variant'),
    sizes: singleValueAxis('size'),
    states: {
      default: rootDefault(context.source, 'state', states) ?? states[0],
      values: states.map(stateId => ({
        id: stateId,
        name: humanizeId(stateId),
        description: states.length === 1 && stateId === 'default' ? SINGLE_VALUE_DESCRIPTIONS.state : ''
      }))
    },
    unsupported: [],
    slots: slotIds.map(slotId => migrateSlot(slotId, 'component', id, context.source, context.placements, undefined)),
    prototype: migratePrototype(prototype),
    tokenGroupIds,
    tokenRoles: {},
    accessibility: '',
    notes: stringList(raw.notes),
    implementationHints: stringList(raw.implementationHints),
    implementationTargets: asArray(raw.implementationTargets) as ReusableDefinition['implementationTargets'],
    styleRefs: stringList(raw.styleRefs),
    styleEvidence: asArray(raw.styleEvidence) as ReusableDefinition['styleEvidence'],
    prototypeOnly: raw.prototypeOnly === true
  });
}

function singleValueAxis(axis: ReusableAxisName): ReusableAxis {
  return { default: 'default', values: [{ id: 'default', name: 'Default', description: SINGLE_VALUE_DESCRIPTIONS[axis] }] };
}

function migrateUses(
  rawUses: unknown,
  tokenGroupIds: string[],
  label: string,
  changes: string[]
): { uses: ReusableDependency[]; tokenGroupIds: string[] } {
  const byKey = new Map<string, ReusableDependency>();
  const groups = [...tokenGroupIds];
  for (const use of asArray(rawUses).map(asObject)) {
    const kind = String(use.kind);
    const reason = String(use.reason ?? '').trim();
    if (kind === 'token-group') {
      groups.push(String(use.id));
      continue;
    }
    const resolved: { kind: ReusableDependency['kind']; id: string } | undefined = kind === 'state-set'
      ? { kind: 'primitive', id: String(use.id).split('/')[0] }
      : kind === 'primitive' || kind === 'component'
        ? { kind, id: String(use.id) }
        : undefined;
    if (!resolved) {
      changes.push(`${label}: dropped its ${kind} dependency "${String(use.id)}"; a reusable lists only the primitives and components it renders.`);
      continue;
    }
    const key = `${resolved.kind}:${resolved.id}`;
    const existing = byKey.get(key);
    if (existing) {
      if (reason && !existing.reason.split('; ').includes(reason)) {
        existing.reason = existing.reason ? `${existing.reason}; ${reason}` : reason;
      }
      continue;
    }
    byKey.set(key, { kind: resolved.kind, id: resolved.id, reason });
  }
  return { uses: [...byKey.values()], tokenGroupIds: unique(groups) };
}

function migrateSlot(
  slotId: string,
  kind: 'primitive' | 'component',
  ownerId: string,
  source: string,
  placements: ReturnType<typeof listUsePlacements>,
  starterSlot: ReusableSlot | undefined
): ReusableSlot {
  const accepts = new Set(starterSlot?.accepts ?? []);
  const defaults = sourceSlotContents(source).get(slotId);
  if (defaults !== undefined) {
    for (const accept of slotContentAccepts(defaults)) accepts.add(accept);
  }
  for (const placement of placements) {
    if (placement.kind !== kind || placement.ref !== ownerId) continue;
    const content = placement.slots.get(slotId);
    if (content !== undefined) {
      for (const accept of slotContentAccepts(content)) accepts.add(accept);
    }
  }
  return {
    id: slotId,
    name: starterSlot?.name ?? (slotId === 'default' ? 'Content' : humanizeId(slotId)),
    description: starterSlot?.description ?? '',
    accepts: [...accepts].sort(sortAccepts)
  };
}

function defaultSlotIfPlaced(source: string): string[] {
  return /<slot(?![^>]*\bname\s*=)[^>]*>/i.test(source) ? ['default'] : [];
}

function sortAccepts(left: string, right: string): number {
  const rank = (accept: string): number => ['text', 'graphic', 'brand-mark'].indexOf(accept) + 1 || 4;
  return rank(left) - rank(right) || left.localeCompare(right);
}

function migratePrototype(prototype: RawObject): ReusableDefinition['prototype'] {
  return {
    source: String(prototype.source ?? ''),
    styles: stringList(prototype.styles),
    localValueExceptions: asArray(prototype.localValueExceptions) as ReusableDefinition['prototype']['localValueExceptions']
  };
}

function migrateDeclaredGroup(raw: RawObject): DeclaredGroup {
  return { id: String(raw.id ?? ''), name: String(raw.name ?? ''), description: String(raw.description ?? '') };
}

function migratedPrimitivePlatforms(value: unknown): Platform[] {
  const platforms = stringList(value);
  if (platforms.length === 0) return [...PLATFORMS];
  return unique(platforms.flatMap(platform => (platform === 'desktop' ? ['web', 'desktop'] : platform === 'mobile' ? ['mobile'] : []))) as Platform[];
}

function inferPrimitiveGroup(id: string): PrimitiveGroupId {
  const words = new Set(id.split('-'));
  const has = (...candidates: string[]): boolean => candidates.some(candidate => words.has(candidate));
  if (has('button', 'action')) return 'actions';
  if (has('input', 'field', 'select', 'checkbox', 'radio', 'switch', 'slider', 'toggle')) return 'inputs';
  if (has('text', 'heading', 'label')) return 'text';
  if (has('surface', 'card', 'panel', 'media')) return 'surfaces';
  if (has('nav', 'tab', 'tabs', 'back', 'link')) return 'navigation';
  if (has('dialog', 'menu', 'sheet', 'modal', 'popover')) return 'overlays';
  if (has('badge', 'icon', 'toast', 'alert', 'loading', 'progress', 'skeleton', 'avatar', 'tooltip')) return 'feedback';
  return 'structure';
}

function orderReusable(reusable: ReusableDefinition): ReusableDefinition {
  return Object.fromEntries(REUSABLE_FIELDS.map(field => [field, reusable[field]])) as unknown as ReusableDefinition;
}

/** Placement attributes of moved primitive values; a conflicting attribute is left for the agent and reported. */
function rewritePlacements(
  html: string,
  remaps: Map<string, PlacementRemap>,
  file: string
): { html: string; rewritten: number; conflicts: string[] } {
  let rewritten = 0;
  const conflicts: string[] = [];
  const result = html.replace(/<blueprint-use\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (tag, body: string) => {
    const attributes = [...body.matchAll(/([^\s=/>]+)\s*=\s*(['"])(.*?)\2/g)].map(match => ({ name: match[1], quote: match[2], value: match[3] }));
    const kind = attributes.find(attribute => attribute.name.toLowerCase() === 'kind')?.value;
    const ref = attributes.find(attribute => attribute.name.toLowerCase() === 'ref')?.value;
    const remap = kind && ref ? remaps.get(`${kind}:${ref}`) : undefined;
    if (!remap) return tag;
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
      return tag;
    }
    if (!changed) return tag;
    rewritten += 1;
    const selfClosing = /\/\s*$/.test(body);
    return `<blueprint-use${next.map(attribute => ` ${attribute.name}=${attribute.quote}${attribute.value}${attribute.quote}`).join('')}${selfClosing ? ' /' : ''}>`;
  });
  return { html: result, rewritten, conflicts };
}

const AXIS_SELECTOR_PATTERN = /\[\s*data-blueprint-(state|variant|size)\s*=\s*(['"]?)([^'"\]\s]+)\2\s*\]/g;

/** In the primitive's own stylesheet every axis selector moves; elsewhere only selectors compounded with that primitive do. */
function rewriteAxisSelectors(css: string, remap: PlacementRemap, kind: 'primitive' | 'component', reusableId: string, ownsFile: boolean): string {
  const replaceIn = (text: string): string => text.replace(AXIS_SELECTOR_PATTERN, (selector, axis: string, quote: string, value: string) => {
    const target = axis === 'state' ? remap.state.get(value) : axis === 'variant' ? remap.variant.get(value) : undefined;
    if (!target || target === axis) return selector;
    return `[data-blueprint-${target}=${quote || '"'}${value}${quote || '"'}]`;
  });
  if (ownsFile) return replaceIn(css);

  const anchor = new RegExp(`\\[\\s*data-blueprint-${kind}\\s*=\\s*(['"]?)${escapeRegExp(reusableId)}\\1\\s*\\]`, 'g');
  const ranges = [...css.matchAll(anchor)].map(match => compoundRange(css, match.index!, match.index! + match[0].length));
  let result = css;
  for (const [start, end] of ranges.reverse()) {
    result = `${result.slice(0, start)}${replaceIn(result.slice(start, end))}${result.slice(end)}`;
  }
  return result;
}

function compoundRange(css: string, anchorStart: number, anchorEnd: number): [number, number] {
  const isBoundary = (character: string): boolean => /[\s,>+~{};]/.test(character);
  let start = anchorStart;
  let depth = 0;
  while (start > 0) {
    const character = css[start - 1];
    if (character === ')' || character === ']') depth += 1;
    else if (character === '(' || character === '[') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && isBoundary(character)) break;
    start -= 1;
  }
  let end = anchorEnd;
  depth = 0;
  while (end < css.length) {
    const character = css[end];
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && isBoundary(character)) break;
    end += 1;
  }
  return [start, end];
}

function countStyleOwners(reusables: RawObject[], screens: RawObject[]): Map<string, number> {
  const owners = new Map<string, number>();
  for (const owner of [...reusables, ...screens]) {
    for (const style of new Set(stringList(asObject(owner.prototype).styles))) {
      owners.set(style, (owners.get(style) ?? 0) + 1);
    }
  }
  return owners;
}

function isScreenRecordFile(file: string): boolean {
  return file === 'screens.json' || /^(explorations|history)\/[^/]+\.json$/.test(file);
}

/** Moves section binding values of reclassified primitives in screens.json, exploration baselines, and history entries. */
function rewriteScreenRecordBindings(record: RawObject, remaps: Map<string, PlacementRemap>): number {
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

function axisValueIds(axis: unknown): string[] {
  return asArray(asObject(axis).values).map(value => String(asObject(value).id));
}

function parseJsonFile(files: Map<string, string>, file: string): RawObject {
  const text = files.get(file);
  if (text === undefined) {
    throw new Error(`${file} is missing, so migrate cannot read the project.`);
  }
  return asObject(JSON.parse(text));
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function asObject(value: unknown): RawObject {
  return isObject(value) ? value as RawObject : {};
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringList(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

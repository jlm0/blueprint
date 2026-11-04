import { hasDefaultSlot, listUsePlacements, slotContentAccepts, sourceSlotContents } from '../markup';
import { rewriteAxisSelectors, rewritePlacements, rewriteScreenRecordBindings, type PlacementAttribute, type PlacementRemap } from '../placement-remap';
import { asArray, asObject, isObject, parseJsonFile, serializeJson, stringList, unique, type RawObject } from '../raw-json';
import { humanizeId, rootAxisValues, toSentenceCase } from '../reusable-contract';
import { isSavedRecordFile } from '../storage-records';
import primitivesAtTo from './1.0.0-to-2.0.0.primitives.json';
import { stampSchemaVersions, type MigrationStep, type MigrationStepResult } from './step';

const FROM = '1.0.0';
const TO = '2.0.0';

type AxisKey = 'variants' | 'sizes' | 'states';
type AxisName = 'variant' | 'size' | 'state';

interface NamedValue {
  id: string;
  name: string;
  description: string;
}

interface Axis {
  default: string;
  values: NamedValue[];
}

interface Slot extends NamedValue {
  accepts: string[];
}

interface Use {
  kind: 'primitive' | 'component';
  id: string;
  reason: string;
}

interface PrimitiveAtTo {
  id: string;
  name: string;
  group: string;
  platforms: string[];
  required: Partial<Record<AxisKey, string>>;
  variants: { values: NamedValue[] };
  sizes: { values: NamedValue[] };
  states: { values: NamedValue[] };
  slots: Slot[];
}

const PRIMITIVES_AT_TO = new Map((primitivesAtTo as PrimitiveAtTo[]).map(primitive => [primitive.id, primitive]));

const PLATFORMS = ['web', 'mobile', 'desktop'];

const SINGLE_VALUE_DESCRIPTIONS: Record<AxisName, string> = {
  variant: 'The only variant.',
  size: 'The only size.',
  state: 'The only state.'
};

const REUSABLE_FIELDS = [
  'id', 'name', 'description', 'group', 'platforms', 'uses', 'variants', 'sizes', 'states', 'unsupported', 'slots', 'prototype',
  'tokenGroupIds', 'tokenRoles', 'accessibility', 'notes', 'implementationHints', 'implementationTargets', 'styleRefs', 'styleEvidence', 'prototypeOnly'
];

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

const AXIS_NAMES: Record<AxisKey, AxisName> = { variants: 'variant', sizes: 'size', states: 'state' };
const AXIS_ATTRIBUTES: Record<AxisKey, PlacementAttribute> = { variants: 'variant', sizes: 'size', states: 'state' };

export const step: MigrationStep = { from: FROM, to: TO, run };

function run(input: ReadonlyMap<string, string>): MigrationStepResult {
  const files = new Map(input);
  const changes: string[] = [];
  if (parseJsonFile(files, 'primitives.json').schemaVersion === FROM || parseJsonFile(files, 'components.json').schemaVersion === FROM) {
    upgradeReusables(files, changes);
  }
  return { files, changes, stamped: stampSchemaVersions(files, FROM, TO) };
}

function upgradeReusables(files: Map<string, string>, changes: string[]): void {
  const primitivesFile = parseJsonFile(files, 'primitives.json');
  const componentsFile = parseJsonFile(files, 'components.json');
  const rawPrimitives = asArray(primitivesFile.primitives).map(asObject);
  const rawComponents = asArray(componentsFile.components).map(asObject);
  const htmlFiles = [...files.keys()].filter(file => file.endsWith('.html')).sort();
  const cssFiles = [...files.keys()].filter(file => file.endsWith('.css')).sort();

  const remaps = new Map<string, PlacementRemap>();
  const primitiveAxes = new Map<string, Record<AxisKey, string[]>>();
  const axisMoveNotes: string[] = [];
  for (const raw of rawPrimitives) {
    const id = String(raw.id);
    const { axes, remap, notes } = reclassifyPrimitiveAxes(raw, PRIMITIVES_AT_TO.get(id));
    primitiveAxes.set(id, axes);
    if (remap) remaps.set(`primitive:${id}`, remap);
    axisMoveNotes.push(...notes);
  }
  changes.push(...axisMoveNotes);

  const placementTotals = { rewritten: 0, files: 0, conflicts: [] as string[] };
  for (const file of htmlFiles) {
    const before = files.get(file)!;
    const { html, rewritten, conflicts } = rewritePlacements(before, remaps, file);
    if (html !== before) {
      files.set(file, html);
      placementTotals.rewritten += rewritten;
      placementTotals.files += 1;
    }
    placementTotals.conflicts.push(...conflicts);
  }
  if (placementTotals.rewritten > 0) {
    changes.push(`Rewrote ${placementTotals.rewritten} <blueprint-use> placements in ${placementTotals.files} HTML files to the new axes.`);
  }
  changes.push(...placementTotals.conflicts);

  const styleOwners = countStyleOwners([...rawPrimitives, ...rawComponents], asArray(parseJsonFile(files, 'screens.json').screens).map(asObject));
  let cssRewrites = 0;
  for (const file of cssFiles) {
    const before = files.get(file)!;
    let css = before;
    for (const raw of rawPrimitives) {
      const remap = remaps.get(`primitive:${String(raw.id)}`);
      if (!remap) continue;
      const owns = asArray(asObject(raw.prototype).styles).includes(file) && styleOwners.get(file) === 1;
      css = rewriteAxisSelectors(css, remap, 'primitive', String(raw.id), owns);
    }
    if (css !== before) {
      files.set(file, css);
      cssRewrites += 1;
    }
  }
  if (cssRewrites > 0) {
    changes.push(`Rewrote axis selectors in ${cssRewrites} CSS files to match.`);
  }

  const currentHtml = (file: string): string => files.get(file) ?? '';
  const placements = htmlFiles.flatMap(file => listUsePlacements(currentHtml(file)));

  const primitives = rawPrimitives.map(raw => migratePrimitive(raw, primitiveAxes.get(String(raw.id))!, {
    atTo: PRIMITIVES_AT_TO.get(String(raw.id)),
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

  writeIfChanged(files, 'primitives.json', {
    schemaVersion: nextVersion(primitivesFile),
    projectId: String(primitivesFile.projectId ?? ''),
    primitives
  });
  writeIfChanged(files, 'components.json', {
    schemaVersion: nextVersion(componentsFile),
    projectId: String(componentsFile.projectId ?? ''),
    groups: asArray(componentsFile.groups ?? componentsFile.sections).map(asObject).map(migrateDeclaredGroup),
    components
  });

  let bindingRewrites = 0;
  for (const file of [...files.keys()].filter(isScreenRecordFile).sort()) {
    const record = JSON.parse(files.get(file)!) as RawObject;
    const count = rewriteScreenRecordBindings(record, remaps);
    if (count > 0) {
      files.set(file, serializeJson(record));
      bindingRewrites += count;
    }
  }
  if (bindingRewrites > 0) {
    changes.push(`Moved ${bindingRewrites} screen section binding values to the new axes.`);
  }
}

function nextVersion(file: RawObject): unknown {
  return file.schemaVersion === FROM ? TO : file.schemaVersion;
}

function writeIfChanged(files: Map<string, string>, file: string, value: unknown): void {
  if (JSON.stringify(JSON.parse(files.get(file)!)) !== JSON.stringify(value)) files.set(file, serializeJson(value));
}

function reclassifyPrimitiveAxes(
  raw: RawObject,
  atTo: PrimitiveAtTo | undefined
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
    const required = atTo?.required[key];
    if (required && RESTING_VALUE_IDS.has(required) && !axes[key].includes(required)) {
      axes[key] = axes[key].length === 1 && axes[key][0] === 'default' && key !== 'variants' ? [required] : [required, ...axes[key]];
      notes.push(`primitive ${id}: added the resting ${AXIS_NAMES[key]} "${required}" Blueprint now requires.`);
    }
  }
  const changed = remap.state.size > 0 || remap.variant.size > 0;
  return { axes, ...(changed ? { remap } : {}), notes };
}

interface PrimitiveMigrationContext {
  atTo: PrimitiveAtTo | undefined;
  source: string;
  placements: ReturnType<typeof listUsePlacements>;
  changes: string[];
}

function migratePrimitive(raw: RawObject, axes: Record<AxisKey, string[]>, context: PrimitiveMigrationContext): RawObject {
  if (isObject(raw.states)) {
    return raw;
  }
  const id = String(raw.id);
  const prototype = asObject(raw.prototype);
  const { atTo } = context;
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

  const axis = (key: AxisKey): Axis => {
    const values = axes[key].map(valueId => {
      const known = atTo?.[key].values.find(value => value.id === valueId);
      const fallbackName = stateSetNames.get(valueId);
      return {
        id: valueId,
        name: known?.name ?? (fallbackName ? toSentenceCase(fallbackName) : humanizeId(valueId)),
        description: known?.description ?? (axes[key].length === 1 && valueId === 'default' ? SINGLE_VALUE_DESCRIPTIONS[AXIS_NAMES[key]] : '')
      };
    });
    return { default: axisDefault(key, axes[key], atTo, rootDefault(context.source, AXIS_NAMES[key], axes[key])), values };
  };

  const name = atTo?.name ?? String(raw.name ?? '');
  if (atTo && raw.name !== atTo.name) {
    context.changes.push(`primitive ${id}: renamed "${String(raw.name)}" to its Blueprint name "${atTo.name}".`);
  }
  const { uses, tokenGroupIds } = migrateUses(raw.uses, stringList(raw.tokenGroupIds), `primitive ${id}`, context.changes);
  const slotIds = unique([...stringList(prototype.slots), ...defaultSlotIfPlaced(context.source)]);
  return orderReusable({
    id,
    name,
    description: String(raw.description ?? ''),
    group: atTo?.group ?? inferPrimitiveGroup(id),
    platforms: atTo?.platforms ?? migratedPrimitivePlatforms(raw.platforms),
    uses,
    variants: axis('variants'),
    sizes: axis('sizes'),
    states: axis('states'),
    unsupported: [],
    slots: slotIds.map(slotId => migrateSlot(slotId, 'primitive', id, context.source, context.placements, atTo?.slots.find(slot => slot.id === slotId))),
    prototype: migratePrototype(prototype),
    tokenGroupIds,
    tokenRoles: isObject(prototype.tokenRoles) ? prototype.tokenRoles : {},
    accessibility: String(prototype.accessibilityIntent ?? ''),
    notes: unique([...stringList(raw.notes), ...stateSetNotes]),
    implementationHints: unique([...stringList(raw.implementationHints), ...stateSetHints]),
    implementationTargets: asArray(raw.implementationTargets),
    styleRefs: stringList(raw.styleRefs),
    styleEvidence: asArray(raw.styleEvidence),
    prototypeOnly: raw.prototypeOnly === true
  });
}

function axisDefault(key: AxisKey, values: string[], atTo: PrimitiveAtTo | undefined, rootValue: string | undefined): string {
  const required = atTo?.required[key];
  if (required && values.includes(required)) return required;
  if (rootValue) return rootValue;
  if (key === 'sizes') {
    return values.find(value => value === 'md') ?? values.find(value => value === 'default') ?? values[0];
  }
  return values[0];
}

function rootDefault(source: string, axis: AxisName, values: string[]): string | undefined {
  const root = rootAxisValues(source);
  return [root[axis], ...Object.values(root)].find(value => value !== undefined && values.includes(value));
}

interface ComponentMigrationContext {
  source: string;
  placements: ReturnType<typeof listUsePlacements>;
  changes: string[];
}

function migrateComponent(raw: RawObject, context: ComponentMigrationContext): RawObject {
  if (isObject(raw.states)) {
    return raw;
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
    implementationTargets: asArray(raw.implementationTargets),
    styleRefs: stringList(raw.styleRefs),
    styleEvidence: asArray(raw.styleEvidence),
    prototypeOnly: raw.prototypeOnly === true
  });
}

function singleValueAxis(axis: AxisName): Axis {
  return { default: 'default', values: [{ id: 'default', name: 'Default', description: SINGLE_VALUE_DESCRIPTIONS[axis] }] };
}

function migrateUses(
  rawUses: unknown,
  tokenGroupIds: string[],
  label: string,
  changes: string[]
): { uses: Use[]; tokenGroupIds: string[] } {
  const byKey = new Map<string, Use>();
  const groups = [...tokenGroupIds];
  for (const use of asArray(rawUses).map(asObject)) {
    const kind = String(use.kind);
    const reason = String(use.reason ?? '').trim();
    if (kind === 'token-group') {
      groups.push(String(use.id));
      continue;
    }
    const resolved: Pick<Use, 'kind' | 'id'> | undefined = kind === 'state-set'
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
  slotAtTo: Slot | undefined
): Slot {
  const accepts = new Set(slotAtTo?.accepts ?? []);
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
    name: slotAtTo?.name ?? (slotId === 'default' ? 'Content' : humanizeId(slotId)),
    description: slotAtTo?.description ?? '',
    accepts: [...accepts].sort(sortAccepts)
  };
}

function defaultSlotIfPlaced(source: string): string[] {
  return hasDefaultSlot(source) ? ['default'] : [];
}

function sortAccepts(left: string, right: string): number {
  const rank = (accept: string): number => ['text', 'graphic', 'brand-mark'].indexOf(accept) + 1 || 4;
  return rank(left) - rank(right) || left.localeCompare(right);
}

function migratePrototype(prototype: RawObject): RawObject {
  return {
    source: String(prototype.source ?? ''),
    styles: stringList(prototype.styles),
    localValueExceptions: asArray(prototype.localValueExceptions)
  };
}

function migrateDeclaredGroup(raw: RawObject): RawObject {
  return { id: String(raw.id ?? ''), name: String(raw.name ?? ''), description: String(raw.description ?? '') };
}

function migratedPrimitivePlatforms(value: unknown): string[] {
  const platforms = stringList(value);
  if (platforms.length === 0) return [...PLATFORMS];
  return unique(platforms.flatMap(platform => (platform === 'desktop' ? ['web', 'desktop'] : platform === 'mobile' ? ['mobile'] : [])));
}

function inferPrimitiveGroup(id: string): string {
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

function orderReusable(reusable: RawObject): RawObject {
  return Object.fromEntries(REUSABLE_FIELDS.map(field => [field, reusable[field]]));
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
  return file === 'screens.json' || isSavedRecordFile(file);
}

function axisValueIds(axis: unknown): string[] {
  return asArray(asObject(axis).values).map(value => String(asObject(value).id));
}

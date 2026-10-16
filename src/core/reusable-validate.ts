import { slotContentAccepts, sourceSlotContents } from '../prototype/compiler';
import { basePrimitiveText } from './base-primitive-text';
import {
  BASE_PRIMITIVE_LOCK_REASON,
  BASE_PRIMITIVE_TEXT_REASON,
  basePrimitive,
  PRIMITIVE_GROUPS,
  type BasePrimitiveAxisFloor,
  type BasePrimitiveText
} from './base-primitives';
import { boundaryId } from './address';
import { lintProse, lintSynonymRotation, type ProseAdvisoryRule } from './prose-lint';
import {
  axisIds,
  COMPONENT_FILE_FIELDS,
  DECLARED_GROUP_FIELDS,
  isSlotReuseAccept,
  isTitleCase,
  KEBAB_ID_PATTERN,
  PLATFORMS,
  PRIMITIVE_FILE_FIELDS,
  REUSABLE_AXES,
  REUSABLE_AXIS_FIELDS,
  REUSABLE_AXIS_VALUE_FIELDS,
  REUSABLE_FIELDS,
  REUSABLE_LIMITS,
  REUSABLE_PROTOTYPE_FIELDS,
  REUSABLE_SCHEMA_VERSION,
  REUSABLE_SLOT_FIELDS,
  REUSABLE_UNSUPPORTED_FIELDS,
  REUSABLE_USE_FIELDS,
  reusableProseFields,
  rootAxisAttributes,
  SINGLE_VALUE_DESCRIPTIONS,
  SIZE_VALUE_IDS,
  SLOT_CONTENT_ACCEPTS,
  toSentenceCase
} from './reusable-contract';
import type { BlueprintProjectBundle, Platform, ReusableDefinition, ReusableKind } from './types';

/** Message when a project's reusable files predate the current schema; every other tool refuses it until it is migrated. */
export function reusableSchemaVersionErrors(bundle: Pick<BlueprintProjectBundle, 'primitives' | 'components'>): string[] {
  return ([['primitives.json', bundle.primitives?.schemaVersion], ['components.json', bundle.components?.schemaVersion]] as const)
    .filter(([, version]) => version !== REUSABLE_SCHEMA_VERSION)
    .map(([file, version]) => (
      `${file} is on schema "${String(version)}", and Blueprint now reads "${REUSABLE_SCHEMA_VERSION}". ` +
      'Fix: run the migrate tool on this project, then fix what validate reports.'
    ));
}

/** @throws {Error} When the project still needs `migrate`. */
export function assertCurrentReusableSchema(bundle: Pick<BlueprintProjectBundle, 'primitives' | 'components'>): void {
  const errors = reusableSchemaVersionErrors(bundle);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

interface ReusableContext {
  errors: string[];
  bundle: BlueprintProjectBundle;
  tokenGroupIds: Set<string>;
  tokenIds: Set<string>;
  groupIds: Set<string>;
  reusables: Map<string, ReusableDefinition>;
}

/** Checks every primitive and component against the shared reusable contract. */
export function validateReusables(
  errors: string[],
  bundle: BlueprintProjectBundle,
  tokenGroupIds: Set<string>,
  tokenIds: Set<string>
): void {
  checkClosedObject(errors, 'primitives.json', bundle.primitives, PRIMITIVE_FILE_FIELDS);
  checkClosedObject(errors, 'components.json', bundle.components, COMPONENT_FILE_FIELDS);
  const groupIds = validateComponentGroups(errors, bundle.components.groups);
  const reusables = new Map<string, ReusableDefinition>();
  for (const [kind, items] of [['primitive', bundle.primitives.primitives], ['component', bundle.components.components]] as const) {
    for (const item of Array.isArray(items) ? items : []) {
      if (isRecord(item) && typeof item.id === 'string') reusables.set(`${kind}:${item.id}`, item);
    }
  }
  const context: ReusableContext = { errors, bundle, tokenGroupIds, tokenIds, groupIds, reusables };
  for (const [kind, items] of [['primitive', bundle.primitives.primitives], ['component', bundle.components.components]] as const) {
    (Array.isArray(items) ? items : []).forEach((item, index) => validateReusable(context, kind, item, index));
  }
}

function validateComponentGroups(errors: string[], groups: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(groups)) {
    errors.push('components.groups must be an array. Fix: declare each component group as { "id", "name", "description" }.');
    return ids;
  }
  groups.forEach((group, index) => {
    const label = isRecord(group) && typeof group.id === 'string' && group.id ? `components.group.${group.id}` : `components.groups[${index}]`;
    if (!isRecord(group)) {
      errors.push(`${label} must be an object. Fix: declare it as { "id", "name", "description" }.`);
      return;
    }
    checkClosedObject(errors, label, group, DECLARED_GROUP_FIELDS);
    checkId(errors, label, group.id);
    checkName(errors, `${label}.name`, group.name, REUSABLE_LIMITS.groupName);
    checkText(errors, `${label}.description`, group.description, REUSABLE_LIMITS.groupDescription, 'say in one line what belongs in the group');
    checkProse(errors, `${label}.description`, group.description);
    if (typeof group.id === 'string') {
      if (ids.has(group.id)) errors.push(`${label} is declared twice. Fix: keep one entry per group id.`);
      ids.add(group.id);
    }
  });
  return ids;
}

function validateReusable(context: ReusableContext, kind: ReusableKind, item: unknown, index: number): void {
  const { errors } = context;
  const label = isRecord(item) && typeof item.id === 'string' && item.id ? `${kind}.${item.id}` : `${kind}s[${index}]`;
  if (!isRecord(item)) {
    errors.push(`${label} must be an object. Fix: write it in the reusable shape that AGENTS.md describes.`);
    return;
  }
  const reusable = item as unknown as ReusableDefinition;
  checkClosedObject(errors, label, item, REUSABLE_FIELDS);
  const contract = kind === 'primitive' ? basePrimitive(reusable.id) : undefined;

  checkId(errors, label, reusable.id);
  checkName(errors, `${label}.name`, reusable.name, REUSABLE_LIMITS.name);
  if (contract && typeof reusable.name === 'string' && reusable.name !== contract.name) {
    errors.push(`${label}.name is "${reusable.name}". Fix: set it to the Blueprint name "${contract.name}". ${BASE_PRIMITIVE_LOCK_REASON}`);
  }
  checkText(errors, `${label}.description`, reusable.description, REUSABLE_LIMITS.description, 'say what it is and when to use it');
  validateGroup(context, kind, label, reusable, contract?.group);
  validateUses(context, kind, label, reusable);
  validatePlatforms(context, kind, label, reusable, contract?.platforms);
  for (const axis of REUSABLE_AXES) {
    validateAxis(errors, label, axis.key, axis.label, reusable[axis.key], contract?.[axis.key]);
  }
  validateUnsupported(errors, label, reusable);
  validateSlots(context, kind, label, reusable, contract?.slots ?? []);
  validatePrototype(context, label, reusable.prototype);
  validateTokens(context, label, reusable);
  checkText(errors, `${label}.accessibility`, reusable.accessibility, REUSABLE_LIMITS.accessibility, 'say what role it has and how assistive technology announces it');
  for (const field of ['notes', 'implementationHints', 'styleRefs'] as const) {
    if (field in item && !isStringList(reusable[field])) {
      errors.push(`${label}.${field} must be a list of strings. Fix: write it as [] or ["…"].`);
    }
  }
  for (const field of ['implementationTargets', 'styleEvidence'] as const) {
    if (field in item && !Array.isArray(reusable[field])) {
      errors.push(`${label}.${field} must be a list. Fix: write it as [] when there is nothing to record.`);
    }
  }
  if ('prototypeOnly' in item && typeof reusable.prototypeOnly !== 'boolean') {
    errors.push(`${label}.prototypeOnly must be true or false. Fix: write false unless it never ships.`);
  }
  for (const field of ['notes', 'implementationHints'] as const) {
    if (!isStringList(reusable[field])) continue;
    reusable[field].forEach((entry, entryIndex) => {
      if (entry.length > REUSABLE_LIMITS.note) {
        errors.push(`${label}.${field}[${entryIndex}] is ${entry.length} characters. Fix: shorten it to ${REUSABLE_LIMITS.note} or fewer, or split it into two entries.`);
      }
    });
  }
  const blueprintText = kind === 'primitive' ? basePrimitiveText(reusable.id) : undefined;
  if (blueprintText) validateBlueprintText(errors, label, reusable, blueprintText);
  for (const field of reusableProseFields(reusable, blueprintText)) {
    if (field.owner === 'app') checkProse(errors, `${label}.${field.path}`, field.text);
  }
}

/** A Blueprint primitive carries the text Blueprint writes for it, word for word. */
function validateBlueprintText(errors: string[], label: string, reusable: ReusableDefinition, text: BasePrimitiveText): void {
  const restore = `or run the migrate tool, which restores it. ${BASE_PRIMITIVE_TEXT_REASON}`;
  for (const field of ['description', 'accessibility'] as const) {
    if (typeof reusable[field] === 'string' && reusable[field] !== text[field]) {
      errors.push(`${label}.${field} is not Blueprint's text. Fix: set it to "${text[field]}", ${restore}`);
    }
  }
  if (isStringList(reusable.notes) && !sameList(reusable.notes, text.notes)) {
    errors.push(
      `${label}.notes are not Blueprint's notes. Fix: set them to ${text.notes.length > 0 ? `[${quoteList(text.notes)}]` : '[]'} and move app guidance to implementationHints, ${restore}`
    );
  }
  const entries: Array<[string, unknown, Record<string, { name: string; description: string }>]> = [
    ...REUSABLE_AXES.map(axis => [axis.key, isRecord(reusable[axis.key]) ? reusable[axis.key].values : undefined, text[axis.key]] as [string, unknown, BasePrimitiveText['slots']]),
    ['slots', reusable.slots, text.slots]
  ];
  for (const [key, values, owned] of entries) {
    for (const value of Array.isArray(values) ? values : []) {
      if (!isRecord(value) || typeof value.id !== 'string' || !Object.hasOwn(owned, value.id)) continue;
      const expected = owned[value.id];
      for (const field of ['name', 'description'] as const) {
        if (typeof value[field] === 'string' && value[field] !== expected[field]) {
          errors.push(`${label}.${key}.${value.id}.${field} is not Blueprint's text. Fix: set it to "${expected[field]}", ${restore}`);
        }
      }
    }
  }
}

function checkProse(errors: string[], label: string, text: unknown): void {
  if (typeof text !== 'string') return;
  for (const issue of lintProse(text)) {
    if (issue.level === 'error') errors.push(`${label} ${issue.message}`);
  }
}

export interface ProseAdvisory {
  boundaryId: string;
  kind: ReusableKind;
  localId: string;
  field: string;
  rule: ProseAdvisoryRule;
  match: string;
  message: string;
}

/** Wording heuristics on the prose an app writes for its reusables; they need a judgment call, so they never fail validation. */
export function collectProseAdvisories(bundle: BlueprintProjectBundle): ProseAdvisory[] {
  const projectId = bundle.manifest.project.id;
  const advisories: ProseAdvisory[] = [];
  for (const [kind, items] of [['primitive', bundle.primitives.primitives], ['component', bundle.components.components]] as const) {
    for (const reusable of Array.isArray(items) ? items : []) {
      if (!isRecord(reusable) || typeof reusable.id !== 'string') continue;
      const fields = reusableProseFields(reusable, kind === 'primitive' ? basePrimitiveText(reusable.id) : undefined)
        .filter(field => field.owner === 'app');
      const advise = (field: string, issue: { rule: string; match: string; message: string }): void => {
        advisories.push({
          boundaryId: boundaryId(projectId, kind, reusable.id),
          kind,
          localId: reusable.id,
          field,
          rule: issue.rule as ProseAdvisoryRule,
          match: issue.match,
          message: `${kind}.${reusable.id}.${field} ${issue.message}`
        });
      };
      for (const field of fields) {
        for (const issue of lintProse(field.text)) {
          if (issue.level === 'advisory') advise(field.path, issue);
        }
      }
      for (const issue of lintSynonymRotation(fields.map(field => field.text))) {
        advise(fields[issue.textIndex].path, issue);
      }
    }
  }
  return advisories;
}

function validateGroup(context: ReusableContext, kind: ReusableKind, label: string, reusable: ReusableDefinition, required: string | undefined): void {
  if (typeof reusable.group !== 'string' || !reusable.group) {
    context.errors.push(kind === 'primitive'
      ? `${label}.group is missing. Fix: set it to ${required ? `"${required}"` : `one of ${quoteList(PRIMITIVE_GROUPS.map(group => group.id))}`}.`
      : `${label}.group is missing. Fix: set it to a group declared in components.json "groups"${context.groupIds.size ? `: ${quoteList([...context.groupIds])}` : ''}.`);
    return;
  }
  if (kind === 'primitive') {
    if (required && reusable.group !== required) {
      context.errors.push(`${label}.group is "${reusable.group}". Fix: set it to the Blueprint group "${required}". ${BASE_PRIMITIVE_LOCK_REASON}`);
    } else if (!required && !PRIMITIVE_GROUPS.some(group => group.id === reusable.group)) {
      context.errors.push(`${label}.group "${reusable.group}" is not a primitive group. Fix: use one of ${quoteList(PRIMITIVE_GROUPS.map(group => group.id))}.`);
    }
    return;
  }
  if (!context.groupIds.has(reusable.group)) {
    context.errors.push(`${label}.group "${reusable.group}" is not declared. Fix: add { "id": "${reusable.group}", "name", "description" } to components.json "groups", or use a declared group.`);
  }
}

function validateUses(context: ReusableContext, kind: ReusableKind, label: string, reusable: ReusableDefinition): void {
  const { errors } = context;
  if (!Array.isArray(reusable.uses)) {
    errors.push(`${label}.uses must be a list. Fix: list each primitive and component the source renders as { "kind", "id", "reason" }.`);
    return;
  }
  if (kind === 'component' && reusable.uses.length === 0) {
    errors.push(
      `${label}.uses is empty. Fix: build it from primitives and components, list each one its source renders, ` +
      'and replace hand-written markup with <blueprint-use>, such as "text" for headings and copy.'
    );
  }
  const seen = new Set<string>();
  reusable.uses.forEach((use, index) => {
    const useLabel = `${label}.uses[${index}]`;
    if (!isRecord(use)) {
      errors.push(`${useLabel} must be an object. Fix: write it as { "kind", "id", "reason" }.`);
      return;
    }
    checkClosedObject(errors, useLabel, use, REUSABLE_USE_FIELDS);
    const allowedKinds = kind === 'primitive' ? ['primitive'] : ['primitive', 'component'];
    if (!allowedKinds.includes(String(use.kind))) {
      errors.push(`${useLabel}.kind is "${String(use.kind)}". Fix: use ${quoteList(allowedKinds)}${kind === 'primitive' ? '; a primitive is built only from primitives and tokens' : ''}.`);
      return;
    }
    const key = `${String(use.kind)}:${String(use.id)}`;
    if (!context.reusables.has(key)) {
      errors.push(`${useLabel} names ${String(use.kind)} "${String(use.id)}", which does not exist. Fix: use a declared ${String(use.kind)} id or remove the entry.`);
    }
    if (key === `${kind}:${reusable.id}`) {
      errors.push(`${useLabel} names the ${kind} itself. Fix: remove it; a reusable cannot be built from itself.`);
    }
    if (seen.has(key)) {
      errors.push(`${useLabel} repeats ${key}. Fix: keep one entry per reusable and put every reason in it.`);
    }
    seen.add(key);
    checkText(errors, `${useLabel}.reason`, use.reason, REUSABLE_LIMITS.reason, 'say what the piece does in this reusable');
  });
}

function validatePlatforms(
  context: ReusableContext,
  kind: ReusableKind,
  label: string,
  reusable: ReusableDefinition,
  required: Platform[] | undefined
): void {
  const { errors } = context;
  const restrictions = (Array.isArray(reusable.uses) ? reusable.uses : []).flatMap(use => {
    const target = isRecord(use) ? context.reusables.get(`${String(use.kind)}:${String(use.id)}`) : undefined;
    return target && Array.isArray(target.platforms) ? [{ use: `${String(use.kind)} "${String(use.id)}"`, platforms: target.platforms }] : [];
  });
  const allowed = PLATFORMS.filter(platform => restrictions.every(restriction => restriction.platforms.includes(platform)));
  const allowedNote = allowed.length === PLATFORMS.length ? '' : `; what it is built from allows ${quoteList(allowed)}`;
  if (!Array.isArray(reusable.platforms) || reusable.platforms.length === 0) {
    errors.push(`${label}.platforms is empty. Fix: list where it runs: one or more of ${quoteList(required ?? PLATFORMS)}${required ? '' : allowedNote}.`);
    return;
  }
  const unknown = reusable.platforms.filter(platform => !PLATFORMS.includes(platform));
  if (unknown.length > 0) {
    errors.push(`${label}.platforms has ${quoteList(unknown)}. Fix: use only ${quoteList(PLATFORMS)}.`);
  }
  if (new Set(reusable.platforms).size !== reusable.platforms.length) {
    errors.push(`${label}.platforms repeats a platform. Fix: list each platform once.`);
  }
  if (required && !sameSet(reusable.platforms, required)) {
    errors.push(`${label}.platforms is ${quoteList(reusable.platforms)}. Fix: set it to the Blueprint platforms ${quoteList(required)}. ${BASE_PRIMITIVE_LOCK_REASON}`);
    return;
  }
  for (const platform of reusable.platforms.filter(platform => PLATFORMS.includes(platform))) {
    const blocking = restrictions.filter(restriction => !restriction.platforms.includes(platform));
    if (blocking.length > 0) {
      errors.push(
        `${label}.platforms includes "${platform}", but it uses ${blocking.map(restriction => `${restriction.use} (${quoteList(restriction.platforms)})`).join(', ')}. ` +
        `Fix: remove "${platform}", or build it from ${kind === 'primitive' ? 'primitives' : 'pieces'} that support "${platform}".`
      );
    }
  }
}

function validateAxis(
  errors: string[],
  label: string,
  key: 'variants' | 'sizes' | 'states',
  noun: string,
  axis: unknown,
  floor: BasePrimitiveAxisFloor | undefined
): void {
  const axisLabel = `${label}.${key}`;
  if (!isRecord(axis)) {
    errors.push(`${axisLabel} must be { "default", "values" }. Fix: list every ${noun} in "values" and name the one an omitted attribute takes in "default"; a single ${noun} uses the id "default".`);
    return;
  }
  checkClosedObject(errors, axisLabel, axis, REUSABLE_AXIS_FIELDS);
  const values = Array.isArray(axis.values) ? axis.values : undefined;
  if (!values || values.length === 0) {
    errors.push(`${axisLabel}.values is empty. Fix: list at least one ${noun}; with only one, use { "id": "default", "name": "Default", "description": "The only ${noun}." }.`);
    return;
  }
  const ids = new Set<string>();
  const undescribed: string[] = [];
  values.forEach((value, index) => {
    const valueLabel = isRecord(value) && typeof value.id === 'string' && value.id ? `${axisLabel}.${value.id}` : `${axisLabel}.values[${index}]`;
    if (!isRecord(value)) {
      errors.push(`${valueLabel} must be { "id", "name", "description" }. Fix: write it in that shape.`);
      return;
    }
    checkClosedObject(errors, valueLabel, value, REUSABLE_AXIS_VALUE_FIELDS);
    checkId(errors, valueLabel, value.id);
    checkName(errors, `${valueLabel}.name`, value.name, REUSABLE_LIMITS.valueName);
    if (typeof value.description !== 'string' || value.description.trim() === '') {
      undescribed.push(String(value.id));
    } else if (value.description.length > REUSABLE_LIMITS.valueDescription) {
      errors.push(`${valueLabel}.description is ${value.description.length} characters. Fix: shorten it to ${REUSABLE_LIMITS.valueDescription} or fewer.`);
    } else if (values.length > 1 && Object.values(SINGLE_VALUE_DESCRIPTIONS).includes(value.description)) {
      errors.push(`${valueLabel}.description says "${value.description}", but ${axisLabel} has ${values.length} values. Fix: say what sets this ${noun} apart from the others.`);
    }
    if (typeof value.id === 'string') {
      if (ids.has(value.id)) errors.push(`${axisLabel} lists "${value.id}" twice. Fix: keep one entry per ${noun}.`);
      ids.add(value.id);
    }
  });
  if (undescribed.length > 0) {
    errors.push(`${axisLabel} has no description for ${quoteList(undescribed)}. Fix: describe each ${noun} in one sentence of ${REUSABLE_LIMITS.valueDescription} characters or fewer.`);
  }
  if (key !== 'sizes') {
    const locked = new Set(floor?.values ?? []);
    for (const id of [...ids].filter(id => !locked.has(id))) {
      const segments = id.split('-');
      if (SIZE_VALUE_IDS.has(id)) {
        errors.push(`${axisLabel}.${id} is a size, not a ${noun}. Fix: run the migrate tool, which moves it to "sizes" and rewrites its placements and selectors.`);
      } else if (segments.length > 1 && segments.some(segment => SIZE_VALUE_IDS.has(segment))) {
        const size = segments.find(segment => SIZE_VALUE_IDS.has(segment))!;
        errors.push(`${axisLabel}.${id} combines size "${size}" with a ${noun}. Fix: add "${size}" to "sizes", keep "${segments.filter(segment => segment !== size).join('-')}" as the ${noun}, and place it with size="${size}".`);
      }
    }
  }
  if (typeof axis.default !== 'string' || !ids.has(axis.default)) {
    errors.push(`${axisLabel}.default is ${axis.default === undefined ? 'missing' : `"${String(axis.default)}"`}. Fix: set it to one of ${quoteList([...ids])}.`);
  }
  if (!floor) return;
  const missing = floor.values.filter(id => !ids.has(id));
  if (missing.length > 0) {
    errors.push(`${axisLabel} is missing the Blueprint ${noun}${missing.length > 1 ? 's' : ''} ${quoteList(missing)}. Fix: add ${missing.length > 1 ? 'them' : 'it'} and style ${missing.length > 1 ? 'each' : 'it'} in the primitive's CSS. ${BASE_PRIMITIVE_LOCK_REASON}`);
  }
  if (floor.default && axis.default !== floor.default && ids.has(floor.default)) {
    errors.push(`${axisLabel}.default is "${String(axis.default)}". Fix: set it to the Blueprint default "${floor.default}". ${BASE_PRIMITIVE_LOCK_REASON}`);
  }
}

function validateUnsupported(errors: string[], label: string, reusable: ReusableDefinition): void {
  if (!Array.isArray(reusable.unsupported)) {
    errors.push(`${label}.unsupported must be a list. Fix: write [] when every variant and size supports every state.`);
    return;
  }
  const seen = new Set<string>();
  reusable.unsupported.forEach((combination, index) => {
    const itemLabel = `${label}.unsupported[${index}]`;
    if (!isRecord(combination)) {
      errors.push(`${itemLabel} must be { "axis", "value", "state", "reason" }. Fix: write it in that shape.`);
      return;
    }
    checkClosedObject(errors, itemLabel, combination, REUSABLE_UNSUPPORTED_FIELDS);
    if (combination.axis !== 'variant' && combination.axis !== 'size') {
      errors.push(`${itemLabel}.axis is "${String(combination.axis)}". Fix: use "variant" or "size".`);
      return;
    }
    const axis = combination.axis === 'variant' ? reusable.variants : reusable.sizes;
    const values = axisIds(axis);
    if (!values.includes(String(combination.value))) {
      errors.push(`${itemLabel}.value "${String(combination.value)}" is not a declared ${combination.axis}. Fix: use one of ${quoteList(values)}.`);
    }
    if (!axisIds(reusable.states).includes(String(combination.state))) {
      errors.push(`${itemLabel}.state "${String(combination.state)}" is not a declared state. Fix: use one of ${quoteList(axisIds(reusable.states))}.`);
    }
    if (combination.value === axis?.default && combination.state === reusable.states?.default) {
      errors.push(`${itemLabel} removes the default ${combination.axis} in the default state. Fix: remove the entry; the defaults always render together.`);
    }
    checkText(errors, `${itemLabel}.reason`, combination.reason, REUSABLE_LIMITS.unsupportedReason, 'say why the combination does not exist');
    const key = `${String(combination.axis)}:${String(combination.value)}:${String(combination.state)}`;
    if (seen.has(key)) errors.push(`${itemLabel} repeats an earlier entry. Fix: remove the duplicate.`);
    seen.add(key);
  });
}

function validateSlots(context: ReusableContext, kind: ReusableKind, label: string, reusable: ReusableDefinition, floor: string[]): void {
  const { errors } = context;
  if (!Array.isArray(reusable.slots)) {
    errors.push(`${label}.slots must be a list. Fix: list each slot as { "id", "name", "description", "accepts" }, or write [] when nothing can be customized.`);
    return;
  }
  const ids = new Set<string>();
  const undescribed: string[] = [];
  reusable.slots.forEach((slot, index) => {
    const slotLabel = isRecord(slot) && typeof slot.id === 'string' && slot.id ? `${label}.slots.${slot.id}` : `${label}.slots[${index}]`;
    if (!isRecord(slot)) {
      errors.push(`${slotLabel} must be { "id", "name", "description", "accepts" }. Fix: write it in that shape.`);
      return;
    }
    checkClosedObject(errors, slotLabel, slot, REUSABLE_SLOT_FIELDS);
    checkId(errors, slotLabel, slot.id);
    checkName(errors, `${slotLabel}.name`, slot.name, REUSABLE_LIMITS.valueName);
    if (typeof slot.description !== 'string' || slot.description.trim() === '') {
      undescribed.push(String(slot.id));
    } else if (slot.description.length > REUSABLE_LIMITS.valueDescription) {
      errors.push(`${slotLabel}.description is ${slot.description.length} characters. Fix: shorten it to ${REUSABLE_LIMITS.valueDescription} or fewer.`);
    }
    if (typeof slot.id === 'string') {
      if (ids.has(slot.id)) errors.push(`${label}.slots lists "${slot.id}" twice. Fix: keep one entry per slot.`);
      ids.add(slot.id);
    }
    const accepts = slot.accepts;
    if (!isStringList(accepts) || accepts.length === 0) {
      errors.push(`${slotLabel}.accepts is empty. Fix: list what it takes: ${quoteList(SLOT_CONTENT_ACCEPTS)}, "primitive:<id>", or "component:<id>".`);
      return;
    }
    for (const accept of accepts) {
      if ((SLOT_CONTENT_ACCEPTS as readonly string[]).includes(accept)) continue;
      if (!isSlotReuseAccept(accept)) {
        errors.push(`${slotLabel}.accepts has "${accept}". Fix: use ${quoteList(SLOT_CONTENT_ACCEPTS)}, "primitive:<id>", or "component:<id>".`);
      } else if (!context.reusables.has(accept)) {
        errors.push(`${slotLabel}.accepts names "${accept}", which does not exist. Fix: name a declared primitive or component.`);
      } else if (accept === `${kind}:${reusable.id}`) {
        errors.push(`${slotLabel}.accepts names the ${kind} itself. Fix: remove it.`);
      }
    }
    if (new Set(accepts).size !== accepts.length) {
      errors.push(`${slotLabel}.accepts repeats an entry. Fix: list each once.`);
    }
  });
  if (undescribed.length > 0) {
    errors.push(`${label}.slots has no description for ${quoteList(undescribed)}. Fix: say in one sentence of ${REUSABLE_LIMITS.valueDescription} characters or fewer what each slot holds.`);
  }
  const missing = floor.filter(id => !ids.has(id));
  if (missing.length > 0) {
    errors.push(`${label}.slots is missing the Blueprint slot${missing.length > 1 ? 's' : ''} ${quoteList(missing)}. Fix: declare ${missing.length > 1 ? 'them' : 'it'} and keep ${missing.length > 1 ? 'their markers' : 'its marker'} in the source. ${BASE_PRIMITIVE_LOCK_REASON}`);
  }

  const source = typeof reusable.prototype?.source === 'string' ? context.bundle.prototypeSourceContents[reusable.prototype.source] : undefined;
  if (source === undefined) return;
  const marked = sourceSlotContents(source);
  const marker = (id: string): string => (id === 'default' ? 'a bare <slot>' : `data-blueprint-slot="${id}"`);
  for (const id of ids) {
    if (!marked.has(id)) {
      errors.push(`${label}.slots.${id} is not marked in ${reusable.prototype.source}. Fix: mark the element it fills with ${marker(id)}, or remove the slot.`);
    }
  }
  for (const [id, content] of marked) {
    if (!ids.has(id)) {
      errors.push(`${reusable.prototype.source} marks slot "${id}", which ${label}.slots does not declare. Fix: declare it in slots or remove ${marker(id)}.`);
      continue;
    }
    const slot = reusable.slots.find(candidate => isRecord(candidate) && candidate.id === id);
    const accepts = isStringList(slot?.accepts) ? slot.accepts : [];
    if (accepts.length === 0) continue;
    const refused = safeAccepts(content).filter(accept => !accepts.includes(accept));
    if (refused.length > 0) {
      errors.push(`${label}.slots.${id} default content in ${reusable.prototype.source} is ${quoteList(refused)}, which it does not accept. Fix: add ${quoteList(refused)} to accepts, or change the default content.`);
    }
  }
}

function validatePrototype(context: ReusableContext, label: string, prototype: unknown): void {
  const { errors } = context;
  if (!isRecord(prototype)) {
    errors.push(`${label}.prototype must be { "source", "styles", "localValueExceptions" }. Fix: point "source" at its HTML and "styles" at its CSS.`);
    return;
  }
  checkClosedObject(errors, `${label}.prototype`, prototype, REUSABLE_PROTOTYPE_FIELDS);
  if (!Array.isArray(prototype.localValueExceptions)) {
    errors.push(`${label}.prototype.localValueExceptions must be a list. Fix: write [] when every value comes from tokens.`);
  }
  const source = typeof prototype.source === 'string' ? context.bundle.prototypeSourceContents[prototype.source] : undefined;
  const stamped = source ? rootAxisAttributes(source) : [];
  if (stamped.length > 0) {
    errors.push(`${label} root element in ${String(prototype.source)} sets ${quoteList(stamped)}. Fix: remove ${stamped.length > 1 ? 'them' : 'it'}; the compiler stamps each placement's variant, size, and state.`);
  }
}

function validateTokens(context: ReusableContext, label: string, reusable: ReusableDefinition): void {
  const { errors } = context;
  if (!isStringList(reusable.tokenGroupIds) || reusable.tokenGroupIds.length === 0) {
    errors.push(`${label}.tokenGroupIds is empty. Fix: list the token groups its CSS reads, such as ${quoteList([...context.tokenGroupIds].slice(0, 3))}.`);
  } else {
    for (const groupId of reusable.tokenGroupIds.filter(id => !context.tokenGroupIds.has(id))) {
      errors.push(`${label}.tokenGroupIds names "${groupId}", which tokens.json does not declare. Fix: use one of ${quoteList([...context.tokenGroupIds])}.`);
    }
  }
  if (!isRecord(reusable.tokenRoles)) {
    errors.push(`${label}.tokenRoles must be an object of token reference to role. Fix: write {} when no token plays a named role.`);
    return;
  }
  for (const [tokenRef, role] of Object.entries(reusable.tokenRoles)) {
    if (!context.tokenIds.has(tokenRef)) {
      errors.push(`${label}.tokenRoles names "${tokenRef}", which tokens.json does not declare. Fix: use a "<group>.<token>" reference that exists.`);
    }
    if (typeof role !== 'string' || !role.trim()) {
      errors.push(`${label}.tokenRoles.${tokenRef} has no role. Fix: name what the token does here, such as "fill" or "label".`);
    }
  }
}

function checkClosedObject(errors: string[], label: string, value: unknown, fields: readonly string[]): void {
  if (!isRecord(value)) return;
  const unknown = Object.keys(value).filter(key => !fields.includes(key));
  const missing = fields.filter(field => !(field in value));
  if (unknown.length > 0) {
    errors.push(`${label} has unknown field${unknown.length > 1 ? 's' : ''} ${quoteList(unknown)}. Fix: remove ${unknown.length > 1 ? 'them' : 'it'}; it carries only ${quoteList(fields)}.`);
  }
  if (missing.length > 0) {
    errors.push(`${label} is missing ${quoteList(missing)}. Fix: add ${missing.length > 1 ? 'them' : 'it'}; every field is required.`);
  }
}

function checkId(errors: string[], label: string, id: unknown): void {
  if (typeof id !== 'string' || !KEBAB_ID_PATTERN.test(id)) {
    errors.push(`${label}.id ${typeof id === 'string' ? `"${id}"` : 'is missing and'} is not kebab-case. Fix: use lowercase letters, digits, and single hyphens, such as "empty-state".`);
  }
}

function checkName(errors: string[], label: string, name: unknown, limit: number): void {
  if (typeof name !== 'string' || !name.trim()) {
    errors.push(`${label} is missing. Fix: give it a short sentence-case name.`);
    return;
  }
  if (name.length > limit) {
    errors.push(`${label} "${name}" is ${name.length} characters. Fix: shorten it to ${limit} or fewer.`);
  }
  if (isTitleCase(name)) {
    errors.push(`${label} "${name}" is in title case. Fix: write it in sentence case, "${toSentenceCase(name)}", keeping proper nouns capitalized.`);
  }
}

function checkText(errors: string[], label: string, text: unknown, limit: number, purpose: string): void {
  if (typeof text !== 'string' || !text.trim()) {
    errors.push(`${label} is missing. Fix: ${purpose}, in ${limit} characters or fewer.`);
    return;
  }
  if (text.length > limit) {
    errors.push(`${label} is ${text.length} characters. Fix: shorten it to ${limit} or fewer.`);
  }
}

function safeAccepts(content: string): string[] {
  try {
    return slotContentAccepts(content);
  } catch {
    return [];
  }
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value));
}

function quoteList(values: readonly string[]): string {
  return values.map(value => `"${value}"`).join(', ');
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

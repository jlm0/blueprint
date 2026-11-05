import { listOpenTags } from './markup';
import { KEBAB_ID_PATTERN } from './reusable-contract';
import type { BlueprintProjectBundle, ReusableDefinition } from './types';

export const ID_LENGTH_CAP = 36;

const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set(['copy', 'dummy', 'foo', 'misc', 'new', 'placeholder', 'stuff', 'temp', 'test', 'thing', 'tmp', 'untitled', 'wip']);
const VERSION_WORDS: ReadonlySet<string> = new Set(['alt', 'backup', 'final', 'latest', 'old', 'revised', 'updated']);
const VERSION_WORD = /^v\d+$/;
const GENERATED_PART = /^(?=[0-9a-f]*\d)[0-9a-f]{6,}$/;
const SCREEN_VERSION_SUFFIX = /-v(\d+)$/;
const NAME_VERSION_WORD = /\b(?:v\d+|version \d+)\b/i;

interface NamedId {
  label: string;
  id: string;
}

function idParts(id: string): string[] {
  return id.split('-');
}

function checkLength(errors: string[], { label, id }: NamedId): void {
  if (typeof id === 'string' && id.length > ID_LENGTH_CAP) {
    errors.push(`${label} id is ${id.length} characters, over the limit of ${ID_LENGTH_CAP}. Fix: rename it to ${ID_LENGTH_CAP} characters or fewer.`);
  }
}

function checkWords(errors: string[], { label, id }: NamedId, withoutVersionSuffix = id): void {
  if (typeof withoutVersionSuffix !== 'string') return;
  const parts = idParts(withoutVersionSuffix);
  const placeholder = parts.find(part => PLACEHOLDER_WORDS.has(part));
  if (placeholder) {
    errors.push(`${label} id holds the placeholder word "${placeholder}". Fix: rename it with a word that says what it is.`);
  }
  const version = parts.find(part => VERSION_WORDS.has(part) || VERSION_WORD.test(part));
  if (version) {
    errors.push(`${label} id holds the version word "${version}". Fix: remove the word. A numbered screen version ends in -v<version>, with the same number, 2 or greater, in its version field.`);
  }
  if (/\d$/.test(withoutVersionSuffix) && !version) {
    errors.push(`${label} id ends in a number. Fix: rename it with a word that says how it differs.`);
  }
}

function checkScreenId(errors: string[], screen: { id: string; version?: number }): void {
  if (typeof screen.id !== 'string') return;
  const named = { label: `screen.${screen.id}`, id: screen.id };
  const suffix = SCREEN_VERSION_SUFFIX.exec(screen.id);
  if (suffix && Number(suffix[1]) >= 2 && Number(suffix[1]) === screen.version) {
    checkWords(errors, named, screen.id.slice(0, suffix.index));
  } else {
    checkWords(errors, named);
  }
}

function checkKebab(errors: string[], { label, id }: NamedId): void {
  if (typeof id === 'string' && !KEBAB_ID_PATTERN.test(id)) {
    const kebab = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    errors.push(`${label} id "${id}" is not kebab-case. Fix: rename it to "${kebab || 'a-word'}", in its declaration and in each place that names it.`);
  }
}

function normalizedName(name: unknown): string {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

function checkUniqueNames(errors: string[], kind: string, items: ReadonlyArray<{ id: string; name?: unknown }>): void {
  const first = new Map<string, string>();
  for (const item of items) {
    const key = normalizedName(item.name);
    if (!key) continue;
    const owner = first.get(key);
    if (owner === undefined) first.set(key, item.id);
    else errors.push(`${kind}.${item.id} has the name "${String(item.name)}", which ${kind}.${owner} has too. Fix: give ${kind}.${item.id} another name.`);
  }
}

function checkScreenNameVersions(errors: string[], screens: ReadonlyArray<{ id: string; name?: unknown; version?: number }>): void {
  const first = new Map<string, string>();
  for (const screen of screens) {
    const name = normalizedName(screen.name);
    if (!name) continue;
    const key = `${name}\u0000${screen.version ?? 1}`;
    const owner = first.get(key);
    if (owner === undefined) {
      first.set(key, screen.id);
    } else {
      errors.push(`screen.${screen.id} has the name "${String(screen.name)}", and version ${screen.version ?? 1}, which screen.${owner} has too. Fix: give screen.${screen.id} another name. Only numbered versions of one route keep a shared name, each with its own version.`);
    }
  }
}

function checkScreenNameWords(errors: string[], screens: ReadonlyArray<{ id: string; name?: unknown }>): void {
  for (const screen of screens) {
    const word = typeof screen.name === 'string' ? NAME_VERSION_WORD.exec(screen.name)?.[0] : undefined;
    if (word) {
      errors.push(`screen.${screen.id} has the name "${String(screen.name)}", which holds the version word "${word}". Fix: remove the word from the name, and write the number in the version field of screen.${screen.id}.`);
    }
  }
}

function checkReusableFiles(errors: string[], bundle: BlueprintProjectBundle, kind: 'primitive' | 'component', reusable: ReusableDefinition): void {
  const source = reusable.prototype?.source;
  if (typeof source !== 'string') return;
  const expected = `prototype/${kind}s/${reusable.id}.html`;
  if (source !== expected) {
    errors.push(`${kind}.${reusable.id}.prototype.source is "${source}". Fix: move the file to "${expected}", and set source to that path.`);
  }
  const html = bundle.prototypeSourceContents[source];
  const root = html === undefined ? undefined : listOpenTags(html)[0];
  if (root === undefined) return;
  const attribute = `data-blueprint-${kind}`;
  const value = root.attributes.find(item => item.name === attribute)?.value;
  if (value !== reusable.id) {
    errors.push(`${kind}.${reusable.id} root element in ${source} has ${attribute}=${JSON.stringify(value ?? '')}. Fix: set ${attribute}="${reusable.id}" on the root element.`);
  }
}

function checkSingleValueAxes(errors: string[], kind: 'primitive' | 'component', reusable: ReusableDefinition): void {
  for (const axis of ['variants', 'sizes', 'states'] as const) {
    const values = reusable[axis]?.values;
    if (!Array.isArray(values) || values.length !== 1 || values[0].id === 'default') continue;
    errors.push(
      `${kind}.${reusable.id}.${axis} has one value, "${values[0].id}". Fix: run the migrate tool, which renames the value to "default" and rewrites its placements and selectors. ` +
      `If the value stays, rename it to "default" by hand in the declaration, in each placement, and in each selector.`
    );
  }
}

function listOf<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

function reusableAxisIds(kind: string, reusable: ReusableDefinition): NamedId[] {
  const label = `${kind}.${reusable.id}`;
  return [
    ...(['variants', 'sizes', 'states'] as const).flatMap(axis => listOf(reusable[axis]?.values).map(value => ({ label: `${label}.${axis}.${value.id}`, id: value.id }))),
    ...listOf(reusable.slots).map(slot => ({ label: `${label}.slots.${slot.id}`, id: slot.id }))
  ];
}

function checkGeneratedPart(errors: string[], kind: string, reusable: ReusableDefinition): void {
  if (typeof reusable.id !== 'string') return;
  const part = idParts(reusable.id).find(item => GENERATED_PART.test(item));
  if (part) {
    errors.push(`${kind}.${reusable.id} id holds the generated part "${part}". Fix: rename it with words that say what it is.`);
  }
}

/**
 * An axis value, a slot, a token, and a state keep a number or a word such as "new" or "copy", because there each one names a level, a position, a badge, or an icon, and the starter uses them.
 * A saved exploration that is not active keeps its id, because the id names its stored files.
 */
export function collectNamingErrors(bundle: BlueprintProjectBundle): string[] {
  const errors: string[] = [];
  const primitives = bundle.primitives.primitives;
  const components = bundle.components.components;
  const screens = bundle.screens.screens;
  const pages = listOf(bundle.screens.pages);
  const activeExplorations = bundle.explorations.explorations.filter(exploration => exploration.lifecycle === 'active');

  const reusables = [
    ...primitives.map(reusable => ({ kind: 'primitive' as const, reusable })),
    ...components.map(reusable => ({ kind: 'component' as const, reusable }))
  ];
  const boundaryIds: NamedId[] = [
    ...reusables.map(({ kind, reusable }) => ({ label: `${kind}.${reusable.id}`, id: reusable.id })),
    ...pages.map(page => ({ label: `page.${page.id}`, id: page.id })),
    ...screens.flatMap(screen => listOf(screen.sections).map(section => ({ label: `screen.${screen.id}.section.${section.id}`, id: section.id }))),
    ...activeExplorations.map(exploration => ({ label: `exploration.${exploration.id}`, id: exploration.id })),
    ...activeExplorations.flatMap(exploration => listOf(exploration.candidates).map(candidate => ({ label: `exploration.${exploration.id}.candidate.${candidate.id}`, id: candidate.id })))
  ];
  const screenStates = screens.flatMap(screen => listOf(screen.prototype?.states).map(state => ({ label: `screen.${screen.id}.state.${state}`, id: state })));
  const conditions = screens.flatMap(screen => listOf(screen.prototype?.reviewConditions).map(condition => ({ label: `screen.${screen.id}.reviewCondition.${condition.id}`, id: condition.id })));
  const presets = listOf(bundle.manifest.framePresets).map(preset => ({ label: `framePreset.${preset.id}`, id: preset.id }));
  const marks = listOf(bundle.brand?.marks).map(mark => ({ label: `brand.mark.${mark.id}`, id: mark.id }));

  for (const named of boundaryIds) {
    checkLength(errors, named);
    checkWords(errors, named);
  }
  for (const screen of screens) {
    checkLength(errors, { label: `screen.${screen.id}`, id: screen.id });
    checkScreenId(errors, screen);
  }
  for (const named of [...screenStates, ...conditions, ...presets, ...marks]) {
    checkLength(errors, named);
    checkKebab(errors, named);
  }
  for (const { kind, reusable } of reusables) {
    reusableAxisIds(kind, reusable).forEach(named => checkLength(errors, named));
    checkGeneratedPart(errors, kind, reusable);
    checkReusableFiles(errors, bundle, kind, reusable);
    checkSingleValueAxes(errors, kind, reusable);
  }
  checkScreenNameVersions(errors, screens);
  checkScreenNameWords(errors, screens);
  checkUniqueNames(errors, 'primitive', primitives);
  checkUniqueNames(errors, 'component', components);
  checkUniqueNames(errors, 'page', pages);
  const primitiveIds = new Set(primitives.map(primitive => primitive.id));
  for (const component of components) {
    if (primitiveIds.has(component.id)) {
      errors.push(`component.${component.id} has the id of a primitive. Fix: rename the component with a word that says how it differs from primitive.${component.id}.`);
    }
  }
  return errors;
}

import { hasUnownedAttributeSelector, renameBoundaryAttributeValue } from './css';
import { applyMarkupEdits, listOpenTags, type MarkupEdit } from './markup';
import type { NormalizeInput } from './migrate-normalize';
import { asArray, asObject, isObject, serializeJson, type RawObject } from './raw-json';
import { isSavedRecordFile } from './storage-records';
import type { ReusableAxisName, ReusableDefinition } from './types';

const AXES: ReadonlyArray<{ key: 'variants' | 'sizes' | 'states'; axis: ReusableAxisName }> = [
  { key: 'variants', axis: 'variant' },
  { key: 'sizes', axis: 'size' },
  { key: 'states', axis: 'state' }
];

const DEFAULT_VALUE = 'default';

interface AxisRename {
  kind: 'primitive' | 'component';
  reusable: ReusableDefinition;
  key: 'variants' | 'sizes' | 'states';
  axis: ReusableAxisName;
  from: string;
}

function owner(rename: AxisRename): { name: string; value: string } {
  return { name: `data-blueprint-${rename.kind}`, value: rename.reusable.id };
}

/** A selector with no boundary in its compound can mean this reusable, and only the sheet of one owner tells which boundary it means. */
function isSafe(rename: AxisRename, cssFiles: ReadonlyMap<string, string>, ownerCounts: ReadonlyMap<string, number>): boolean {
  const owned = new Set(rename.reusable.prototype?.styles ?? []);
  for (const [file, css] of cssFiles) {
    if (owned.has(file) && ownerCounts.get(file) === 1) continue;
    if (hasUnownedAttributeSelector(css, `data-blueprint-${rename.axis}`, rename.from)) return false;
  }
  return true;
}

function renamePlacements(html: string, renames: readonly AxisRename[]): { html: string; count: number } {
  const edits: MarkupEdit[] = [];
  for (const tag of listOpenTags(html)) {
    if (tag.name !== 'blueprint-use') continue;
    const kind = tag.attributes.find(attribute => attribute.name === 'kind')?.value;
    const ref = tag.attributes.find(attribute => attribute.name === 'ref')?.value;
    for (const attribute of tag.attributes) {
      const renamed = renames.some(rename => rename.kind === kind && rename.reusable.id === ref && rename.axis === attribute.name && rename.from === attribute.value);
      if (renamed) edits.push({ start: attribute.valueStart, end: attribute.valueEnd, text: DEFAULT_VALUE });
    }
  }
  return { html: applyMarkupEdits(html, edits), count: edits.length };
}

function savedScreens(record: RawObject): RawObject[] {
  const screens = asArray(record.screens).filter(isObject);
  if (isObject(record.exploration)) screens.push(asObject(asObject(asObject(record.exploration.target).baseline).screen));
  if (isObject(record.entry)) screens.push(asObject(record.entry.screen));
  return screens;
}

function renameBindings(record: RawObject, renames: readonly AxisRename[]): number {
  let count = 0;
  for (const screen of savedScreens(record)) {
    for (const section of asArray(screen.sections).filter(isObject)) {
      for (const use of asArray(section.uses).filter(isObject)) {
        if (!isObject(use.binding)) continue;
        for (const rename of renames) {
          if (use.kind === rename.kind && use.id === rename.reusable.id && use.binding[rename.axis] === rename.from) {
            use.binding[rename.axis] = DEFAULT_VALUE;
            count += 1;
          }
        }
      }
    }
  }
  return count;
}

function renameDeclaration({ reusable, key, axis, from }: AxisRename): void {
  const declared = reusable[key].values[0];
  reusable[key] = {
    default: DEFAULT_VALUE,
    values: [{ ...declared, id: DEFAULT_VALUE, name: 'Default' }]
  };
  for (const combination of reusable.unsupported ?? []) {
    if (axis === 'state' && combination.state === from) combination.state = DEFAULT_VALUE;
    if (axis !== 'state' && combination.axis === axis && combination.value === from) combination.value = DEFAULT_VALUE;
  }
}

/** An axis with one value uses the id "default". A rename that is not safe stays for the agent, and validate reports it with its Fix. */
export function renameSingleAxisValues(
  input: NormalizeInput,
  reusables: ReadonlyArray<{ kind: 'primitive' | 'component'; reusable: ReusableDefinition }>,
  writes: Map<string, string>,
  changes: string[]
): void {
  const currentText = (file: string): string => writes.get(file) ?? input.files.get(file) ?? '';
  const fileNames = [...new Set([...input.files.keys(), ...writes.keys()])].sort();
  const cssFiles = new Map(fileNames.filter(file => file.endsWith('.css')).map(file => [file, currentText(file)]));
  const ownerCounts = new Map<string, number>();
  for (const { reusable } of reusables) {
    for (const style of new Set(reusable.prototype?.styles ?? [])) ownerCounts.set(style, (ownerCounts.get(style) ?? 0) + 1);
  }
  const renames: AxisRename[] = [];
  for (const { kind, reusable } of reusables) {
    for (const { key, axis } of AXES) {
      const values = reusable[key]?.values;
      if (!Array.isArray(values) || values.length !== 1 || values[0].id === DEFAULT_VALUE) continue;
      const rename: AxisRename = { kind, reusable, key, axis, from: values[0].id };
      if (isSafe(rename, cssFiles, ownerCounts)) renames.push(rename);
    }
  }
  if (renames.length === 0) return;

  let placements = 0;
  for (const file of fileNames.filter(name => name.endsWith('.html'))) {
    const { html, count } = renamePlacements(currentText(file), renames);
    if (count > 0) writes.set(file, html);
    placements += count;
  }
  for (const [file, before] of cssFiles) {
    let css = before;
    for (const rename of renames) {
      const ownsFile = (rename.reusable.prototype?.styles ?? []).includes(file) && ownerCounts.get(file) === 1;
      css = renameBoundaryAttributeValue(css, { attribute: `data-blueprint-${rename.axis}`, from: rename.from, to: DEFAULT_VALUE }, owner(rename), ownsFile);
    }
    if (css !== before) writes.set(file, css);
  }
  for (const file of fileNames.filter(name => name === 'screens.json' || isSavedRecordFile(name))) {
    const record = asObject(JSON.parse(currentText(file)));
    if (renameBindings(record, renames) > 0) writes.set(file, serializeJson(record));
  }
  renames.forEach(renameDeclaration);
  changes.push(`Renamed the only value of ${renames.length === 1 ? '1 axis' : `${renames.length} axes`} to "default", and rewrote ${placements} placement${placements === 1 ? '' : 's'}: ${renames.map(rename => `${rename.kind} ${rename.reusable.id} ${rename.axis} ${rename.from}`).join(', ')}.`);
}

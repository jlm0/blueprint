import type { BlueprintProjectBundle, PrototypeAsset } from './types';

type SourceFiles = BlueprintProjectBundle['sourceFiles'];
type SourceFileKey = keyof SourceFiles;
type SourceFileRecord = Record<SourceFileKey, SourceFiles[SourceFileKey]>;

export type ProjectBundleField = Exclude<keyof BlueprintProjectBundle, 'sourceFiles' | 'prototypeSourceContents' | 'prototypeAssetContents'>;

export type OptionalProjectBundleField = {
  [Field in ProjectBundleField]-?: undefined extends BlueprintProjectBundle[Field] ? Field : never;
}[ProjectBundleField];

export interface EntryDelta<TValue, TKey extends string = string> {
  set: Partial<Record<TKey, TValue>>;
  remove: TKey[];
  /** The full key order, sent only when setting and removing entries cannot reproduce it. */
  order?: TKey[];
}

export interface ProjectBundleDelta<TAsset extends PrototypeAsset = PrototypeAsset> {
  fields: Partial<Pick<BlueprintProjectBundle<TAsset>, ProjectBundleField>>;
  removedFields: OptionalProjectBundleField[];
  sourceFiles: EntryDelta<SourceFiles[SourceFileKey], SourceFileKey>;
  prototypeSourceContents: EntryDelta<string>;
  prototypeAssetContents: EntryDelta<TAsset>;
}

const PROJECT_BUNDLE_FIELDS: Record<ProjectBundleField, true> = {
  manifest: true,
  tokens: true,
  primitives: true,
  components: true,
  screens: true,
  brand: true,
  inspo: true,
  explorations: true,
  history: true,
  recordSchemaVersions: true,
  sourceRoot: true
};

const OPTIONAL_PROJECT_BUNDLE_FIELDS: Record<OptionalProjectBundleField, true> = {
  brand: true,
  inspo: true,
  recordSchemaVersions: true
};

export function diffProjectBundles<TAsset extends PrototypeAsset>(
  previous: BlueprintProjectBundle<TAsset>,
  next: BlueprintProjectBundle<TAsset>
): ProjectBundleDelta<TAsset> {
  const fields: Partial<Pick<BlueprintProjectBundle<TAsset>, ProjectBundleField>> = {};
  for (const field of keys(PROJECT_BUNDLE_FIELDS)) {
    if (next[field] !== undefined && !sameJson(previous[field], next[field])) Object.assign(fields, { [field]: next[field] });
  }
  return {
    fields,
    removedFields: keys(OPTIONAL_PROJECT_BUNDLE_FIELDS).filter(field => previous[field] !== undefined && next[field] === undefined),
    sourceFiles: diffEntries(previous.sourceFiles as SourceFileRecord, next.sourceFiles as SourceFileRecord, sameJson),
    prototypeSourceContents: diffEntries(previous.prototypeSourceContents, next.prototypeSourceContents, (left, right) => left === right),
    prototypeAssetContents: diffEntries<TAsset>(previous.prototypeAssetContents, next.prototypeAssetContents, sameJson)
  };
}

export function applyProjectBundleDelta<TAsset extends PrototypeAsset>(
  base: BlueprintProjectBundle<TAsset>,
  delta: ProjectBundleDelta<TAsset>
): BlueprintProjectBundle<TAsset> {
  const next: BlueprintProjectBundle<TAsset> = {
    ...base,
    ...delta.fields,
    sourceFiles: applyEntries(base.sourceFiles as SourceFileRecord, delta.sourceFiles) as SourceFiles,
    prototypeSourceContents: applyEntries(base.prototypeSourceContents, delta.prototypeSourceContents),
    prototypeAssetContents: applyEntries(base.prototypeAssetContents, delta.prototypeAssetContents)
  };
  for (const field of delta.removedFields) delete next[field];
  return next;
}

function diffEntries<TValue, TKey extends string = string>(
  previous: Record<TKey, TValue>,
  next: Record<TKey, TValue>,
  same: (left: TValue, right: TValue) => boolean
): EntryDelta<TValue, TKey> {
  const set: Partial<Record<TKey, TValue>> = {};
  for (const key of keys(next)) {
    if (!Object.hasOwn(previous, key) || !same(previous[key], next[key])) set[key] = next[key];
  }
  const delta: EntryDelta<TValue, TKey> = { set, remove: keys(previous).filter(key => !Object.hasOwn(next, key)) };
  const order = keys(next);
  if (keys(applyEntries(previous, delta)).some((key, index) => key !== order[index])) delta.order = order;
  return delta;
}

function applyEntries<TValue, TKey extends string>(base: Record<TKey, TValue>, delta: EntryDelta<TValue, TKey>): Record<TKey, TValue> {
  const removed = new Set(delta.remove);
  const order = delta.order ?? [
    ...keys(base).filter(key => !removed.has(key)),
    ...keys(delta.set).filter(key => !Object.hasOwn(base, key))
  ];
  return Object.fromEntries(order.map(key => [key, Object.hasOwn(delta.set, key) ? delta.set[key] : base[key]])) as Record<TKey, TValue>;
}

function keys<TKey extends string>(record: Partial<Record<TKey, unknown>>): TKey[] {
  return Object.keys(record) as TKey[];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

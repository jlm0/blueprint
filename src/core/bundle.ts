import type {
  BlueprintManifest,
  BlueprintProjectBundle,
  ComponentFile,
  ExplorationFile,
  PrimitiveFile,
  PrototypeSource,
  PrototypeAssetContent,
  ScreenFile,
  ScreenHistoryFile,
  TokenFile
} from './types';

/** Preserves one caller-supplied app-owned project without introducing project-manager state. */
export function createConfiguredProjectBundle(bundle: BlueprintProjectBundle): BlueprintProjectBundle {
  return bundle;
}

export interface RawProjectFiles {
  manifest: BlueprintManifest;
  tokens: TokenFile;
  primitives: PrimitiveFile;
  components?: ComponentFile;
  screens: ScreenFile;
  explorations?: ExplorationFile;
  history?: ScreenHistoryFile;
  legacyExplorationsFile?: boolean;
  explorationRecordRefs?: string[];
  historyRecordRefs?: string[];
  prototypeSourceContents?: Record<string, string>;
  prototypeAssetContents?: Record<string, PrototypeAssetContent>;
}

export function createProjectBundle(sourceRoot: string, raw: RawProjectFiles): BlueprintProjectBundle {
  const components = raw.components ?? emptyComponentFile(raw.manifest.project.id);
  const explorations = raw.explorations ?? emptyExplorationFile(raw.manifest.project.id);
  const history = raw.history ?? emptyScreenHistoryFile(raw.manifest.project.id);
  const prototypeSourceRefs = collectPrototypeSourceRefs(raw.primitives, components, raw.screens);
  const explorationSourceRefs = collectExplorationSourceRefs(explorations);
  const historySourceRefs = collectHistorySourceRefs(history);
  return {
    manifest: raw.manifest,
    tokens: raw.tokens,
    primitives: raw.primitives,
    components,
    screens: raw.screens,
    explorations,
    history,
    sourceRoot,
    sourceFiles: {
      manifest: `${sourceRoot}/manifest.json`,
      tokens: `${sourceRoot}/tokens.json`,
      primitives: `${sourceRoot}/primitives.json`,
      ...(raw.components ? { components: `${sourceRoot}/components.json` } : {}),
      screens: `${sourceRoot}/screens.json`,
      ...(raw.legacyExplorationsFile ? { explorations: `${sourceRoot}/explorations.json` } : {}),
      explorationRecords: (raw.explorationRecordRefs ?? []).map(ref => `${sourceRoot}/${ref}`),
      historyRecords: (raw.historyRecordRefs ?? []).map(ref => `${sourceRoot}/${ref}`),
      prototypeSources: prototypeSourceRefs.map(sourceRef => `${sourceRoot}/${sourceRef}`),
      explorationSources: explorationSourceRefs.map(sourceRef => `${sourceRoot}/${sourceRef}`),
      historySources: historySourceRefs.map(sourceRef => `${sourceRoot}/${sourceRef}`)
    },
    prototypeSourceContents: raw.prototypeSourceContents ?? {},
    prototypeAssetContents: raw.prototypeAssetContents ?? {}
  };
}

/** Lists safe sidecar-relative prototype inputs without exposing their source content. */
export function collectPrototypeSourceRefs(
  primitives: PrimitiveFile,
  components: ComponentFile,
  screens: ScreenFile
): string[] {
  const refs = [
    ...primitives.primitives.flatMap(primitive => sourceRefs(primitive.prototype)),
    ...components.components.flatMap(component => sourceRefs(component.prototype)),
    ...screens.screens.flatMap(screen => [
      ...sourceRefs(screen.prototype),
      ...(screen.prototype?.assetRefs ?? [])
    ])
  ];
  return [...new Set(refs.flatMap(ref => safePrototypeRef(ref)))];
}

/** Lists safe sidecar-relative HTML and CSS inputs that must be decoded as UTF-8. */
export function collectPrototypeTextSourceRefs(
  primitives: PrimitiveFile,
  components: ComponentFile,
  screens: ScreenFile
): string[] {
  const refs = [
    ...primitives.primitives.flatMap(primitive => sourceRefs(primitive.prototype)),
    ...components.components.flatMap(component => sourceRefs(component.prototype)),
    ...screens.screens.flatMap(screen => sourceRefs(screen.prototype))
  ];
  return [...new Set(refs.flatMap(ref => safePrototypeRef(ref)))];
}

/** Lists safe controlled asset refs that must retain their original bytes. */
export function collectPrototypeAssetRefs(screens: ScreenFile): string[] {
  return [...new Set(
    screens.screens.flatMap(screen => (screen.prototype?.assetRefs ?? []).flatMap(ref => safePrototypeRef(ref)))
  )];
}

/** Lists safe HTML, CSS, and asset refs belonging only to saved explorations. */
export function collectExplorationSourceRefs(explorations: ExplorationFile): string[] {
  const refs = explorations.explorations.flatMap(exploration => [
    exploration.target.baseline.prototype.source,
    ...exploration.target.baseline.prototype.styles,
    ...exploration.target.baseline.prototype.assetRefs,
    ...exploration.candidates.flatMap(candidate => [
      candidate.prototype.source,
      ...candidate.prototype.styles,
      ...candidate.prototype.assetRefs
    ])
  ]);
  return [...new Set(refs.flatMap(ref => safePrototypeRef(ref)))];
}

/** Lists safe exploration HTML and CSS refs that must be decoded as UTF-8. */
export function collectExplorationTextSourceRefs(explorations: ExplorationFile): string[] {
  const refs = explorations.explorations.flatMap(exploration => [
    exploration.target.baseline.prototype.source,
    ...exploration.target.baseline.prototype.styles,
    ...exploration.candidates.flatMap(candidate => [candidate.prototype.source, ...candidate.prototype.styles])
  ]);
  return [...new Set(refs.flatMap(ref => safePrototypeRef(ref)))];
}

/** Lists safe exploration assets that must retain their original bytes. */
export function collectExplorationAssetRefs(explorations: ExplorationFile): string[] {
  const refs = explorations.explorations.flatMap(exploration => [
    ...exploration.target.baseline.prototype.assetRefs,
    ...exploration.candidates.flatMap(candidate => candidate.prototype.assetRefs)
  ]);
  return [...new Set(refs.flatMap(ref => safePrototypeRef(ref)))];
}

/** Lists safe HTML, CSS, and asset refs belonging only to prior canonical versions. */
export function collectHistorySourceRefs(history: ScreenHistoryFile): string[] {
  const refs = history.entries.flatMap(entry => [
    ...sourceRefs(entry.screen.prototype),
    ...(entry.screen.prototype?.assetRefs ?? [])
  ]);
  return [...new Set(refs.flatMap(ref => safePrototypeRef(ref)))];
}

/** Lists safe historical HTML and CSS refs that must be decoded as UTF-8. */
export function collectHistoryTextSourceRefs(history: ScreenHistoryFile): string[] {
  const refs = history.entries.flatMap(entry => sourceRefs(entry.screen.prototype));
  return [...new Set(refs.flatMap(ref => safePrototypeRef(ref)))];
}

/** Lists safe historical assets that must retain their original bytes. */
export function collectHistoryAssetRefs(history: ScreenHistoryFile): string[] {
  const refs = history.entries.flatMap(entry => entry.screen.prototype?.assetRefs ?? []);
  return [...new Set(refs.flatMap(ref => safePrototypeRef(ref)))];
}

function sourceRefs(prototype: PrototypeSource | undefined): string[] {
  return prototype ? [prototype.source, ...prototype.styles] : [];
}

function safePrototypeRef(sourceRef: string): string[] {
  const normalized = sourceRef.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.includes('://') ||
    normalized.split('/').some(segment => segment === '..')
  ) {
    return [];
  }
  return [normalized];
}

function emptyComponentFile(projectId: string): ComponentFile {
  return {
    schemaVersion: '1.0.0',
    projectId,
    components: []
  };
}

function emptyExplorationFile(projectId: string): ExplorationFile {
  return {
    schemaVersion: '1.0.0',
    projectId,
    explorations: []
  };
}

function emptyScreenHistoryFile(projectId: string): ScreenHistoryFile {
  return {
    schemaVersion: '1.0.0',
    projectId,
    entries: []
  };
}

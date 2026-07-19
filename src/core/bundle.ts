import type {
  BlueprintManifest,
  BlueprintProjectBundle,
  ComponentFile,
  PrimitiveFile,
  PrototypeSource,
  PrototypeAssetContent,
  ScreenFile,
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
  prototypeSourceContents?: Record<string, string>;
  prototypeAssetContents?: Record<string, PrototypeAssetContent>;
}

export function createProjectBundle(sourceRoot: string, raw: RawProjectFiles): BlueprintProjectBundle {
  const components = raw.components ?? emptyComponentFile(raw.manifest.project.id);
  const prototypeSourceRefs = collectPrototypeSourceRefs(raw.primitives, components, raw.screens);
  return {
    manifest: raw.manifest,
    tokens: raw.tokens,
    primitives: raw.primitives,
    components,
    screens: raw.screens,
    sourceRoot,
    sourceFiles: {
      manifest: `${sourceRoot}/manifest.json`,
      tokens: `${sourceRoot}/tokens.json`,
      primitives: `${sourceRoot}/primitives.json`,
      ...(raw.components ? { components: `${sourceRoot}/components.json` } : {}),
      screens: `${sourceRoot}/screens.json`,
      prototypeSources: prototypeSourceRefs.map(sourceRef => `${sourceRoot}/${sourceRef}`)
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

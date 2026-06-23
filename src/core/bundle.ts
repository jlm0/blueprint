import type { BlueprintManifest, BlueprintProjectBundle, PrimitiveFile, ScreenFile, TokenFile } from './types';

export interface RawProjectFiles {
  manifest: BlueprintManifest;
  tokens: TokenFile;
  primitives: PrimitiveFile;
  screens: ScreenFile;
}

export function createProjectBundle(sourceRoot: string, raw: RawProjectFiles): BlueprintProjectBundle {
  return {
    manifest: raw.manifest,
    tokens: raw.tokens,
    primitives: raw.primitives,
    screens: raw.screens,
    sourceRoot,
    sourceFiles: {
      manifest: `${sourceRoot}/manifest.json`,
      tokens: `${sourceRoot}/tokens.json`,
      primitives: `${sourceRoot}/primitives.json`,
      screens: `${sourceRoot}/screens.json`
    }
  };
}

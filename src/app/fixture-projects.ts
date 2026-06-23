import { createProjectBundle } from '../core/bundle';
import type { BlueprintManifest, BlueprintProjectBundle, PrimitiveFile, ScreenFile, TokenFile } from '../core/types';
import starterManifest from '../../starter/design/blueprint/manifest.json';
import starterPrimitives from '../../starter/design/blueprint/primitives.json';
import starterScreens from '../../starter/design/blueprint/screens.json';
import starterTokens from '../../starter/design/blueprint/tokens.json';

export function loadStarterProject(): BlueprintProjectBundle {
  const sourceRoot = 'starter/design/blueprint';
  return createProjectBundle(sourceRoot, {
    manifest: starterManifest as BlueprintManifest,
    tokens: starterTokens as TokenFile,
    primitives: starterPrimitives as PrimitiveFile,
    screens: starterScreens as ScreenFile
  });
}

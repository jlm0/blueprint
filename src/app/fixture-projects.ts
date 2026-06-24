import { createProjectBundle } from '../core/bundle';
import type { CanvasStyleEvidenceArtifact, ReviewManifest, VisibleBoundarySyncResult } from '../core/review';
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

export interface CanvasReviewRuntimeState {
  projectId: string;
  boundarySync: VisibleBoundarySyncResult;
  manifest: ReviewManifest;
  styleEvidence: CanvasStyleEvidenceArtifact;
}

declare global {
  interface Window {
    __BLUEPRINT_PROJECT_BUNDLE__?: BlueprintProjectBundle;
    __BLUEPRINT_REVIEW__?: CanvasReviewRuntimeState;
  }
}

export function createConfiguredProjectBundle(bundle: BlueprintProjectBundle): BlueprintProjectBundle {
  return bundle;
}

export function loadConfiguredProject(): BlueprintProjectBundle {
  if (typeof window !== 'undefined' && window.__BLUEPRINT_PROJECT_BUNDLE__) {
    return createConfiguredProjectBundle(window.__BLUEPRINT_PROJECT_BUNDLE__);
  }

  return loadStarterProject();
}

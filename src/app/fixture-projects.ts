import { createConfiguredProjectBundle, createProjectBundle } from '../core/bundle';
import type { BlueprintAgentActivityEvent, BlueprintProjectLoadError } from '../core/activity';
import type { CanvasStyleEvidenceArtifact, ReviewManifest, VisibleBoundarySyncResult } from '../core/review';
import type {
  BlueprintManifest,
  BlueprintProjectBundle,
  CanvasProjectBundle,
  BrandFile,
  ComponentFile,
  PrimitiveFile,
  ScreenFile,
  TokenFile
} from '../core/types';
import starterBrand from '../../starter/design/blueprint/brand.json';
import starterComponents from '../../starter/design/blueprint/components.json';
import starterManifest from '../../starter/design/blueprint/manifest.json';
import starterPrimitives from '../../starter/design/blueprint/primitives.json';
import starterScreens from '../../starter/design/blueprint/screens.json';
import starterTokens from '../../starter/design/blueprint/tokens.json';

const starterSourceFiles = import.meta.glob<string>(
  ['../../starter/design/blueprint/brand/*.svg', '../../starter/design/blueprint/prototype/**/*.{css,html}'],
  { eager: true, import: 'default', query: '?raw' }
);

function starterSourceContents(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(starterSourceFiles).map(([file, content]) => [file.replace('../../starter/design/blueprint/', ''), content])
  );
}

export function loadStarterProject(): BlueprintProjectBundle {
  const sourceRoot = 'starter/design/blueprint';
  return createProjectBundle(sourceRoot, {
    manifest: starterManifest as BlueprintManifest,
    tokens: starterTokens as TokenFile,
    primitives: starterPrimitives as unknown as PrimitiveFile,
    components: starterComponents as ComponentFile,
    screens: starterScreens as ScreenFile,
    brand: starterBrand as BrandFile,
    prototypeSourceContents: starterSourceContents()
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
    __BLUEPRINT_PROJECT_BUNDLE__?: CanvasProjectBundle;
    __BLUEPRINT_REVIEW__?: CanvasReviewRuntimeState;
    __BLUEPRINT_LIVE_RUNTIME__?: { eventsPath: string; snapshotPath: string; selectionPath?: string; canvasToken?: string; revision?: string };
    __BLUEPRINT_AGENT_ACTIVITY__?: BlueprintAgentActivityEvent;
    __BLUEPRINT_PROJECT_LOAD_ERROR__?: BlueprintProjectLoadError;
  }
}

export function loadConfiguredProject(): CanvasProjectBundle {
  if (typeof window !== 'undefined' && window.__BLUEPRINT_PROJECT_BUNDLE__) {
    return createConfiguredProjectBundle(window.__BLUEPRINT_PROJECT_BUNDLE__);
  }

  return loadStarterProject();
}

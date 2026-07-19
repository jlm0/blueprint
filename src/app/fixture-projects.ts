import { createConfiguredProjectBundle, createProjectBundle } from '../core/bundle';
import type { CanvasStyleEvidenceArtifact, ReviewManifest, VisibleBoundarySyncResult } from '../core/review';
import type {
  BlueprintManifest,
  BlueprintProjectBundle,
  ComponentFile,
  PrimitiveFile,
  ScreenFile,
  TokenFile
} from '../core/types';
import starterComponents from '../../starter/design/blueprint/components.json';
import starterManifest from '../../starter/design/blueprint/manifest.json';
import starterPrimitives from '../../starter/design/blueprint/primitives.json';
import starterScreens from '../../starter/design/blueprint/screens.json';
import starterTokens from '../../starter/design/blueprint/tokens.json';
import starterActionClusterCss from '../../starter/design/blueprint/prototype/components/action-cluster.css?raw';
import starterActionClusterHtml from '../../starter/design/blueprint/prototype/components/action-cluster.html?raw';
import starterAlertDialogCss from '../../starter/design/blueprint/prototype/primitives/alert-dialog.css?raw';
import starterAlertDialogHtml from '../../starter/design/blueprint/prototype/primitives/alert-dialog.html?raw';
import starterBackButtonCss from '../../starter/design/blueprint/prototype/primitives/back-button.css?raw';
import starterBackButtonHtml from '../../starter/design/blueprint/prototype/primitives/back-button.html?raw';
import starterBadgeCss from '../../starter/design/blueprint/prototype/primitives/badge.css?raw';
import starterBadgeHtml from '../../starter/design/blueprint/prototype/primitives/badge.html?raw';
import starterBottomSheetCss from '../../starter/design/blueprint/prototype/primitives/bottom-sheet.css?raw';
import starterBottomSheetHtml from '../../starter/design/blueprint/prototype/primitives/bottom-sheet.html?raw';
import starterButtonCss from '../../starter/design/blueprint/prototype/primitives/button.css?raw';
import starterButtonHtml from '../../starter/design/blueprint/prototype/primitives/button.html?raw';
import starterCardCss from '../../starter/design/blueprint/prototype/primitives/card.css?raw';
import starterCardHtml from '../../starter/design/blueprint/prototype/primitives/card.html?raw';
import starterCheckboxCss from '../../starter/design/blueprint/prototype/primitives/checkbox.css?raw';
import starterCheckboxHtml from '../../starter/design/blueprint/prototype/primitives/checkbox.html?raw';
import starterContextMenuCss from '../../starter/design/blueprint/prototype/primitives/context-menu.css?raw';
import starterContextMenuHtml from '../../starter/design/blueprint/prototype/primitives/context-menu.html?raw';
import starterIconCss from '../../starter/design/blueprint/prototype/primitives/icon.css?raw';
import starterIconHtml from '../../starter/design/blueprint/prototype/primitives/icon.html?raw';
import starterInputCss from '../../starter/design/blueprint/prototype/primitives/input.css?raw';
import starterInputHtml from '../../starter/design/blueprint/prototype/primitives/input.html?raw';
import starterListCss from '../../starter/design/blueprint/prototype/primitives/list.css?raw';
import starterListHtml from '../../starter/design/blueprint/prototype/primitives/list.html?raw';
import starterLoadingMarkCss from '../../starter/design/blueprint/prototype/primitives/loading-mark.css?raw';
import starterLoadingMarkHtml from '../../starter/design/blueprint/prototype/primitives/loading-mark.html?raw';
import starterMediaCardCss from '../../starter/design/blueprint/prototype/primitives/media-card.css?raw';
import starterMediaCardHtml from '../../starter/design/blueprint/prototype/primitives/media-card.html?raw';
import starterNavBarCss from '../../starter/design/blueprint/prototype/primitives/nav-bar.css?raw';
import starterNavBarHtml from '../../starter/design/blueprint/prototype/primitives/nav-bar.html?raw';
import starterOtpInputCss from '../../starter/design/blueprint/prototype/primitives/otp-input.css?raw';
import starterOtpInputHtml from '../../starter/design/blueprint/prototype/primitives/otp-input.html?raw';
import starterPressableRowCss from '../../starter/design/blueprint/prototype/primitives/pressable-row.css?raw';
import starterPressableRowHtml from '../../starter/design/blueprint/prototype/primitives/pressable-row.html?raw';
import starterRadioCss from '../../starter/design/blueprint/prototype/primitives/radio.css?raw';
import starterRadioHtml from '../../starter/design/blueprint/prototype/primitives/radio.html?raw';
import starterRowLayoutCss from '../../starter/design/blueprint/prototype/primitives/row-layout.css?raw';
import starterRowLayoutHtml from '../../starter/design/blueprint/prototype/primitives/row-layout.html?raw';
import starterSelectCss from '../../starter/design/blueprint/prototype/primitives/select.css?raw';
import starterSelectHtml from '../../starter/design/blueprint/prototype/primitives/select.html?raw';
import starterSeparatorCss from '../../starter/design/blueprint/prototype/primitives/separator.css?raw';
import starterSeparatorHtml from '../../starter/design/blueprint/prototype/primitives/separator.html?raw';
import starterSkeletonCss from '../../starter/design/blueprint/prototype/primitives/skeleton.css?raw';
import starterSkeletonHtml from '../../starter/design/blueprint/prototype/primitives/skeleton.html?raw';
import starterSliderCss from '../../starter/design/blueprint/prototype/primitives/slider.css?raw';
import starterSliderHtml from '../../starter/design/blueprint/prototype/primitives/slider.html?raw';
import starterSurfaceCss from '../../starter/design/blueprint/prototype/primitives/surface.css?raw';
import starterSurfaceHtml from '../../starter/design/blueprint/prototype/primitives/surface.html?raw';
import starterSwitchCss from '../../starter/design/blueprint/prototype/primitives/switch.css?raw';
import starterSwitchHtml from '../../starter/design/blueprint/prototype/primitives/switch.html?raw';
import starterTabsCss from '../../starter/design/blueprint/prototype/primitives/tabs.css?raw';
import starterTabsHtml from '../../starter/design/blueprint/prototype/primitives/tabs.html?raw';
import starterTextCss from '../../starter/design/blueprint/prototype/primitives/text.css?raw';
import starterTextHtml from '../../starter/design/blueprint/prototype/primitives/text.html?raw';
import starterToastCss from '../../starter/design/blueprint/prototype/primitives/toast.css?raw';
import starterToastHtml from '../../starter/design/blueprint/prototype/primitives/toast.html?raw';

export function loadStarterProject(): BlueprintProjectBundle {
  const sourceRoot = 'starter/design/blueprint';
  return createProjectBundle(sourceRoot, {
    manifest: starterManifest as BlueprintManifest,
    tokens: starterTokens as TokenFile,
    primitives: starterPrimitives as unknown as PrimitiveFile,
    components: starterComponents as ComponentFile,
    screens: starterScreens as ScreenFile,
    prototypeSourceContents: {
      'prototype/components/action-cluster.css': starterActionClusterCss,
      'prototype/components/action-cluster.html': starterActionClusterHtml,
      'prototype/primitives/alert-dialog.css': starterAlertDialogCss,
      'prototype/primitives/alert-dialog.html': starterAlertDialogHtml,
      'prototype/primitives/back-button.css': starterBackButtonCss,
      'prototype/primitives/back-button.html': starterBackButtonHtml,
      'prototype/primitives/badge.css': starterBadgeCss,
      'prototype/primitives/badge.html': starterBadgeHtml,
      'prototype/primitives/bottom-sheet.css': starterBottomSheetCss,
      'prototype/primitives/bottom-sheet.html': starterBottomSheetHtml,
      'prototype/primitives/button.css': starterButtonCss,
      'prototype/primitives/button.html': starterButtonHtml,
      'prototype/primitives/card.css': starterCardCss,
      'prototype/primitives/card.html': starterCardHtml,
      'prototype/primitives/checkbox.css': starterCheckboxCss,
      'prototype/primitives/checkbox.html': starterCheckboxHtml,
      'prototype/primitives/context-menu.css': starterContextMenuCss,
      'prototype/primitives/context-menu.html': starterContextMenuHtml,
      'prototype/primitives/icon.css': starterIconCss,
      'prototype/primitives/icon.html': starterIconHtml,
      'prototype/primitives/input.css': starterInputCss,
      'prototype/primitives/input.html': starterInputHtml,
      'prototype/primitives/list.css': starterListCss,
      'prototype/primitives/list.html': starterListHtml,
      'prototype/primitives/loading-mark.css': starterLoadingMarkCss,
      'prototype/primitives/loading-mark.html': starterLoadingMarkHtml,
      'prototype/primitives/media-card.css': starterMediaCardCss,
      'prototype/primitives/media-card.html': starterMediaCardHtml,
      'prototype/primitives/nav-bar.css': starterNavBarCss,
      'prototype/primitives/nav-bar.html': starterNavBarHtml,
      'prototype/primitives/otp-input.css': starterOtpInputCss,
      'prototype/primitives/otp-input.html': starterOtpInputHtml,
      'prototype/primitives/pressable-row.css': starterPressableRowCss,
      'prototype/primitives/pressable-row.html': starterPressableRowHtml,
      'prototype/primitives/radio.css': starterRadioCss,
      'prototype/primitives/radio.html': starterRadioHtml,
      'prototype/primitives/row-layout.css': starterRowLayoutCss,
      'prototype/primitives/row-layout.html': starterRowLayoutHtml,
      'prototype/primitives/select.css': starterSelectCss,
      'prototype/primitives/select.html': starterSelectHtml,
      'prototype/primitives/separator.css': starterSeparatorCss,
      'prototype/primitives/separator.html': starterSeparatorHtml,
      'prototype/primitives/skeleton.css': starterSkeletonCss,
      'prototype/primitives/skeleton.html': starterSkeletonHtml,
      'prototype/primitives/slider.css': starterSliderCss,
      'prototype/primitives/slider.html': starterSliderHtml,
      'prototype/primitives/surface.css': starterSurfaceCss,
      'prototype/primitives/surface.html': starterSurfaceHtml,
      'prototype/primitives/switch.css': starterSwitchCss,
      'prototype/primitives/switch.html': starterSwitchHtml,
      'prototype/primitives/tabs.css': starterTabsCss,
      'prototype/primitives/tabs.html': starterTabsHtml,
      'prototype/primitives/text.css': starterTextCss,
      'prototype/primitives/text.html': starterTextHtml,
      'prototype/primitives/toast.css': starterToastCss,
      'prototype/primitives/toast.html': starterToastHtml
    }
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

export function loadConfiguredProject(): BlueprintProjectBundle {
  if (typeof window !== 'undefined' && window.__BLUEPRINT_PROJECT_BUNDLE__) {
    return createConfiguredProjectBundle(window.__BLUEPRINT_PROJECT_BUNDLE__);
  }

  return loadStarterProject();
}

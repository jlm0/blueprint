import type {
  BlueprintProjectBundle,
  BoardDefinition,
  BoundaryDependency,
  ComponentDefinition,
  ExplorationDefinition,
  ExplorationPrototypeSource,
  FramePreset,
  ImplementationTarget,
  PrimitiveDefinition,
  PrototypeSource,
  PrimitiveStateSet,
  ReadinessItem,
  ReadinessReport,
  ProductionRelationship,
  ScreenDefinition,
  ScreenHistoryEntry,
  ScreenSection,
  StyleEvidence,
  ValidationOptions,
  TokenGroup,
  ValidationResult
} from './types';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { inspectPrototypeSourceGraph } from '../prototype/compiler';
import { BASE_PRIMITIVE_CONTRACT, BASE_PRIMITIVE_LOCK_REASON } from './base-primitives';
import { lintHandBuiltControls } from './control-lint';
import { handBuiltControlMessage, localStyleValueMessage, unmarkedSectionIds } from './findings';
import { lintLocalStyleValues } from './style-lint';
import { contrastMessage, lintColorContrast } from './contrast-lint';
import { screenRoutePath, screenVersionGroupKey } from './screen-naming';
import { computeExplorationBaselineDigest } from './exploration';
import { storageRecordSegment } from './storage-records';

const supportedHandoffContractVersion = '1.0.0';

export function validateProject(bundle: BlueprintProjectBundle, options: ValidationOptions = {}): ValidationResult {
  const errors: string[] = [];
  const projectId = bundle.manifest.project?.id;

  requireString(errors, 'manifest.project.id', projectId);
  requireString(errors, 'manifest.project.name', bundle.manifest.project?.name);
  requireString(errors, 'manifest.project.sourceRoot', bundle.manifest.project?.sourceRoot);
  requireString(errors, 'manifest.defaultBoardId', bundle.manifest.defaultBoardId);

  if (bundle.tokens.projectId !== projectId) {
    errors.push(`tokens.projectId "${bundle.tokens.projectId}" must match manifest project id "${projectId}".`);
  }

  if (bundle.primitives.projectId !== projectId) {
    errors.push(`primitives.projectId "${bundle.primitives.projectId}" must match manifest project id "${projectId}".`);
  }

  if (bundle.components.projectId !== projectId) {
    errors.push(`components.projectId "${bundle.components.projectId}" must match manifest project id "${projectId}".`);
  }

  if (bundle.screens.projectId !== projectId) {
    errors.push(`screens.projectId "${bundle.screens.projectId}" must match manifest project id "${projectId}".`);
  }

  if (bundle.explorations.projectId !== projectId) {
    errors.push(`explorations.projectId "${bundle.explorations.projectId}" must match manifest project id "${projectId}".`);
  }

  if (bundle.history.projectId !== projectId) {
    errors.push(`history.projectId "${bundle.history.projectId}" must match manifest project id "${projectId}".`);
  }

  const boardIds = collectIds(errors, 'manifest.boards', bundle.manifest.boards, board => validateBoard(errors, board));
  if (!boardIds.has(bundle.manifest.defaultBoardId)) {
    errors.push(`manifest.defaultBoardId "${bundle.manifest.defaultBoardId}" does not match a board id.`);
  }

  const framePresetIds = collectIds(errors, 'manifest.framePresets', bundle.manifest.framePresets, framePreset => validateFramePreset(errors, framePreset));
  const tokenGroupIds = collectIds(errors, 'tokens.tokenGroups', bundle.tokens.tokenGroups, group => validateTokenGroup(errors, group));
  const primitiveIds = collectIds(errors, 'primitives.primitives', bundle.primitives.primitives, primitive => {
    validatePrimitive(errors, primitive, tokenGroupIds);
  });
  const tokenIds = collectTokenIds(bundle.tokens.tokenGroups);
  const componentIds = collectIds(errors, 'components.components', bundle.components.components, component => {
    validateComponent(errors, component, tokenGroupIds);
  });

  const stateSetIds = new Set<string>();
  for (const primitive of bundle.primitives.primitives) {
    for (const stateSet of primitive.stateSets ?? []) {
      const localId = `${primitive.id}/${stateSet.id}`;
      if (stateSetIds.has(localId)) {
        errors.push(`Duplicate state-set id "${localId}".`);
      }
      stateSetIds.add(localId);
      validateStateTokenReferences(errors, primitive, stateSet, tokenIds);
    }
  }

  const screenIds = collectIds(errors, 'screens.screens', bundle.screens.screens, screen => {
    validateScreen(errors, screen, framePresetIds, primitiveIds, componentIds, stateSetIds);
  });
  validateScreenVersions(errors, bundle.screens.screens);
  validateExplorations(errors, bundle, screenIds, framePresetIds);
  validateScreenHistory(errors, bundle, screenIds, framePresetIds, primitiveIds, componentIds, stateSetIds);
  const sectionIds = new Set(
    bundle.screens.screens.flatMap(screen => (screen.sections ?? []).map(section => `${screen.id}/${section.id}`))
  );

  for (const primitive of bundle.primitives.primitives) {
    for (const dependency of primitive.uses ?? []) {
      validateDependency(errors, `primitive.${primitive.id}.uses`, dependency, {
        tokenGroupIds,
        primitiveIds,
        stateSetIds,
        componentIds,
        screenIds,
        sectionIds
      });
    }
  }

  for (const component of bundle.components.components) {
    for (const dependency of component.uses ?? []) {
      validateDependency(errors, `component.${component.id}.uses`, dependency, {
        tokenGroupIds,
        primitiveIds,
        stateSetIds,
        componentIds,
        screenIds,
        sectionIds
      });
    }
  }

  for (const screen of bundle.screens.screens) {
    for (const section of screen.sections ?? []) {
      for (const dependency of section.uses ?? []) {
        validateDependency(errors, `screens.${screen.id}.sections.${section.id}.uses`, dependency, {
          tokenGroupIds,
          primitiveIds,
          stateSetIds,
          componentIds,
          screenIds,
          sectionIds
        });
      }
    }
  }

  validatePrototypeHost(errors, bundle.manifest.prototypeHost);
  validateBasePrimitiveContract(errors, bundle);
  validatePrototypeContracts(errors, bundle, tokenIds, framePresetIds);
  recordPrototypeSourceGraphValidation(errors, bundle);

  if ((options.mode ?? 'baseline') === 'strict') {
    validateStrictHandoffReadiness(errors, bundle);
  }

  return { ok: errors.length === 0, errors };
}

export function createReadinessReport(bundle: BlueprintProjectBundle): ReadinessReport {
  const items: ReadinessItem[] = [];
  const prototypeSources = relativePrototypeSources(bundle);

  for (const sourceRef of prototypeSources) {
    if (!(sourceRef in bundle.prototypeSourceContents) && !(sourceRef in bundle.prototypeAssetContents)) {
      items.push({
        path: `prototypeSources.${sourceRef}`,
        severity: 'blocker',
        source: 'synthesized-missing',
        message: `Declared prototype source "${sourceRef}" does not exist or could not be loaded.`
      });
    }
  }
  recordPrototypeSourceGraphReadiness(items, bundle);

  for (const primitive of bundle.primitives.primitives ?? []) {
    if (primitive.prototypeOnly) {
      continue;
    }

    recordImplementationTargetReadiness(items, `primitive.${primitive.id}.implementationTargets`, primitive.implementationTargets);
    recordStyleEvidenceReadiness(
      items,
      bundle,
      `primitive.${primitive.id}.styleEvidence`,
      primitive.styleRefs,
      primitive.styleEvidence
    );

    for (const stateSet of primitive.stateSets ?? []) {
      if ((stateSet.states ?? []).every(state => state.prototypeOnly)) {
        continue;
      }
      recordStyleEvidenceReadiness(
        items,
        bundle,
        `primitive.${primitive.id}.stateSet.${stateSet.id}.styleEvidence`,
        stateSet.styleRefs,
        stateSet.styleEvidence
      );
    }
  }

  for (const screen of bundle.screens.screens ?? []) {
    if (screen.prototypeOnly) {
      continue;
    }

    recordImplementationTargetReadiness(items, `screen.${screen.id}.implementationTargets`, screen.implementationTargets);
    recordStyleEvidenceReadiness(items, bundle, `screen.${screen.id}.styleEvidence`, screen.styleRefs, screen.styleEvidence);

    for (const section of screen.sections ?? []) {
      if (section.prototypeOnly) {
        continue;
      }

      recordImplementationTargetReadiness(
        items,
        `screen.${screen.id}.section.${section.id}.implementationTargets`,
        section.implementationTargets
      );
      recordStyleEvidenceReadiness(
        items,
        bundle,
        `screen.${screen.id}.section.${section.id}.styleEvidence`,
        section.styleRefs,
        section.styleEvidence
      );
    }
    for (const sectionId of unmarkedSectionIds(bundle, screen)) {
      items.push({
        path: `screen.${screen.id}.section.${sectionId}.marker`,
        severity: 'blocker',
        source: 'synthesized-missing',
        message: `Prototype source has no data-blueprint-section="${sectionId}" marker, so the section cannot be addressed on the canvas.`
      });
    }
  }

  for (const component of bundle.components.components ?? []) {
    if (component.prototypeOnly) {
      continue;
    }
    if (component.implementationTargets) {
      recordImplementationTargetReadiness(items, `component.${component.id}.implementationTargets`, component.implementationTargets);
    }
    recordStyleEvidenceReadiness(
      items,
      bundle,
      `component.${component.id}.styleEvidence`,
      component.styleRefs ?? [],
      component.styleEvidence
    );
  }

  for (const issue of lintLocalStyleValues(bundle)) {
    items.push({
      path: `${issue.boundary}.localValues.${issue.styleRef}.${issue.property}`,
      severity: 'blocker',
      source: 'declared',
      message: localStyleValueMessage(issue)
    });
  }

  for (const issue of lintHandBuiltControls(bundle)) {
    items.push({
      path: `${issue.boundary}.controls.${issue.sourceRef}:${issue.line}`,
      severity: 'blocker',
      source: 'declared',
      message: handBuiltControlMessage(issue)
    });
  }

  for (const issue of lintColorContrast(bundle)) {
    items.push({
      path: `tokenGroup.${issue.groupId}.contrast.${issue.foreground.styleRef}.${issue.background.styleRef}`,
      severity: 'blocker',
      source: 'declared',
      message: contrastMessage(issue)
    });
  }

  const blockers = items.filter(item => item.severity === 'blocker');
  let tier: ReadinessReport['tier'] = 'ready';
  if (blockers.length > 0) {
    tier = 'blocked';
  } else if (items.some(item => item.severity === 'unresolved')) {
    tier = 'unresolved';
  } else if (items.some(item => item.severity === 'pending')) {
    tier = 'pending';
  }

  return {
    projectId: bundle.manifest.project.id,
    prototypeSources,
    tier,
    items,
    blockers
  };
}

function recordPrototypeSourceGraphValidation(errors: string[], bundle: BlueprintProjectBundle): void {
  for (const issue of inspectPrototypeSourceGraph(bundle)) {
    errors.push(`Prototype source graph ${issue.boundaryId} state "${issue.state}" cannot compile: ${issue.message}`);
  }
}

function recordPrototypeSourceGraphReadiness(items: ReadinessItem[], bundle: BlueprintProjectBundle): void {
  for (const issue of inspectPrototypeSourceGraph(bundle)) {
    items.push({
      path: `prototypeSourceGraph.${issue.boundaryId}.${issue.state}`,
      severity: 'blocker',
      source: 'declared',
      message: `Prototype source graph ${issue.boundaryId} state "${issue.state}" cannot compile: ${issue.message}`
    });
  }
}

function recordImplementationTargetReadiness(
  items: ReadinessItem[],
  label: string,
  targets: ImplementationTarget[] | undefined
): void {
  if (!Array.isArray(targets) || targets.length === 0) {
    items.push({
      path: label,
      severity: 'blocker',
      source: 'synthesized-missing',
      message: 'Production handoff is missing implementation target metadata.'
    });
    return;
  }

  targets.forEach((target, index) => {
    const unresolved = target.unresolvedDecisions ?? [];
    if (unresolved.length === 0) {
      return;
    }
    items.push({
      path: `${label}.${index}.unresolvedDecisions`,
      severity: 'unresolved',
      source: 'declared',
      message: unresolved.join(' ')
    });
  });
}

function recordStyleEvidenceReadiness(
  items: ReadinessItem[],
  bundle: BlueprintProjectBundle,
  label: string,
  styleRefs: string[] | undefined,
  evidence: StyleEvidence[] | undefined
): void {
  const refs = styleRefs ?? [];
  if (refs.length === 0) {
    return;
  }

  if (!Array.isArray(evidence)) {
    for (const styleRef of refs) {
      items.push({
        path: label,
        severity: 'blocker',
        source: 'synthesized-missing',
        message: `No explicit style evidence has been recorded for "${styleRef}".`
      });
    }
    return;
  }

  const byRef = new Map(evidence.map(item => [item.styleRef, item]));
  for (const styleRef of refs) {
    const item = byRef.get(styleRef);
    if (!item) {
      items.push({
        path: label,
        severity: 'blocker',
        source: 'synthesized-missing',
        message: `Style evidence is missing for "${styleRef}".`
      });
      continue;
    }

    const status = String(item.status);
    if (status === 'source') {
      items.push({
        path: label,
        severity: 'ready',
        source: 'resolved',
        message: `Style evidence for "${styleRef}" is linked to source.`
      });
      continue;
    }

    if (status === 'unresolved') {
      items.push({
        path: label,
        severity: 'unresolved',
        source: 'declared',
        message: evidenceMessage(item, `Style evidence for "${styleRef}" is unresolved.`)
      });
      continue;
    }

    if (status === 'linked-artifact-pending') {
      const artifactRef = item.artifactRef;
      const artifactExists = artifactRef ? existsSync(resolveArtifactRef(bundle, artifactRef)) : false;
      if (artifactExists) {
        items.push({
          path: label,
          severity: 'pending',
          source: 'declared',
          message: `Style evidence for "${styleRef}" is linked to a pending review artifact.`,
          artifactRef,
          artifactExists
        });
        continue;
      }

      items.push({
        path: label,
        severity: 'blocker',
        source: 'declared-missing-artifact',
        message: artifactRef
          ? `Style evidence artifact for "${styleRef}" does not exist.`
          : `Style evidence artifact for "${styleRef}" is not declared.`,
        artifactRef,
        artifactExists
      });
      continue;
    }

    items.push({
      path: label,
      severity: 'blocker',
      source: 'declared',
      message: `Style evidence for "${styleRef}" has unsupported status "${status}".`
    });
  }
}

function resolveArtifactRef(bundle: BlueprintProjectBundle, artifactRef: string): string {
  if (path.isAbsolute(artifactRef)) {
    return artifactRef;
  }
  return path.resolve(bundle.sourceRoot, artifactRef);
}

function evidenceMessage(item: StyleEvidence, fallback: string): string {
  const message = item.notes?.join(' ').trim();
  return message && message.length > 0 ? message : fallback;
}

function validateBoard(errors: string[], board: BoardDefinition): void {
  requireString(errors, 'board.id', board.id);
  requireString(errors, `board.${board.id}.kind`, board.kind);
  requireString(errors, `board.${board.id}.name`, board.name);
}

function validateFramePreset(errors: string[], framePreset: FramePreset): void {
  requireString(errors, 'framePreset.id', framePreset.id);
  requireString(errors, `framePreset.${framePreset.id}.name`, framePreset.name);
  if (framePreset.type !== 'mobile' && framePreset.type !== 'desktop') {
    errors.push(`framePreset.${framePreset.id}.type must be "mobile" or "desktop".`);
  }
  requireNumber(errors, `framePreset.${framePreset.id}.width`, framePreset.width);
  requireNumber(errors, `framePreset.${framePreset.id}.height`, framePreset.height);
  requirePositiveNumber(errors, `framePreset.${framePreset.id}.width`, framePreset.width);
  requirePositiveNumber(errors, `framePreset.${framePreset.id}.height`, framePreset.height);
  requireObject(errors, `framePreset.${framePreset.id}.safeArea`, framePreset.safeArea);
  requireNumber(errors, `framePreset.${framePreset.id}.safeArea.top`, framePreset.safeArea?.top);
  requireNumber(errors, `framePreset.${framePreset.id}.safeArea.right`, framePreset.safeArea?.right);
  requireNumber(errors, `framePreset.${framePreset.id}.safeArea.bottom`, framePreset.safeArea?.bottom);
  requireNumber(errors, `framePreset.${framePreset.id}.safeArea.left`, framePreset.safeArea?.left);
}

function validateTokenGroup(errors: string[], group: TokenGroup): void {
  requireString(errors, 'tokenGroup.id', group.id);
  requireString(errors, `tokenGroup.${group.id}.name`, group.name);
  requireArray(errors, `tokenGroup.${group.id}.tokens`, group.tokens);

  const tokenIds = new Set<string>();
  for (const token of group.tokens ?? []) {
    requireString(errors, `tokenGroup.${group.id}.token.id`, token.id);
    requireString(errors, `tokenGroup.${group.id}.token.${token.id}.type`, token.type);
    requireString(errors, `tokenGroup.${group.id}.token.${token.id}.value`, token.value);
    requireString(errors, `tokenGroup.${group.id}.token.${token.id}.styleRef`, token.styleRef);
    if (tokenIds.has(token.id)) {
      errors.push(`Duplicate token id "${group.id}.${token.id}".`);
    }
    tokenIds.add(token.id);
  }
}

function validatePrimitive(errors: string[], primitive: PrimitiveDefinition, tokenGroupIds: Set<string>): void {
  requireString(errors, 'primitive.id', primitive.id);
  requireString(errors, `primitive.${primitive.id}.name`, primitive.name);
  requireArray(errors, `primitive.${primitive.id}.tokenGroupIds`, primitive.tokenGroupIds);
  requireArray(errors, `primitive.${primitive.id}.styleRefs`, primitive.styleRefs);
  requireArray(errors, `primitive.${primitive.id}.notes`, primitive.notes);
  requireBoolean(errors, `primitive.${primitive.id}.prototypeOnly`, primitive.prototypeOnly);
  requireArray(errors, `primitive.${primitive.id}.implementationHints`, primitive.implementationHints);
  requireArray(errors, `primitive.${primitive.id}.stateSets`, primitive.stateSets);
  if (primitive.platforms !== undefined) {
    const platforms = Array.isArray(primitive.platforms) ? primitive.platforms : [];
    if (platforms.length === 0 || new Set(platforms).size !== platforms.length || platforms.some(platform => platform !== 'mobile' && platform !== 'desktop')) {
      errors.push(`primitive.${primitive.id}.platforms must list "mobile" and/or "desktop" once each, or be omitted for shared primitives.`);
    }
  }

  for (const tokenGroupId of primitive.tokenGroupIds ?? []) {
    if (!tokenGroupIds.has(tokenGroupId)) {
      errors.push(`primitive.${primitive.id}.tokenGroupIds references missing token group "${tokenGroupId}".`);
    }
  }

  collectIds(errors, `primitive.${primitive.id}.stateSets`, primitive.stateSets, stateSet => validateStateSet(errors, primitive, stateSet));
}

function validateComponent(errors: string[], component: ComponentDefinition, tokenGroupIds: Set<string>): void {
  requireString(errors, 'component.id', component.id);
  requireString(errors, `component.${component.id}.name`, component.name);
  requireString(errors, `component.${component.id}.description`, component.description);
  requireArray(errors, `component.${component.id}.uses`, component.uses);
  requireArray(errors, `component.${component.id}.tokenGroupIds`, component.tokenGroupIds);
  requireObject(errors, `component.${component.id}.prototype`, component.prototype);
  for (const tokenGroupId of component.tokenGroupIds ?? []) {
    if (!tokenGroupIds.has(tokenGroupId)) {
      errors.push(`component.${component.id}.tokenGroupIds references missing token group "${tokenGroupId}".`);
    }
  }
}

function validateStateSet(errors: string[], primitive: PrimitiveDefinition, stateSet: PrimitiveStateSet): void {
  requireString(errors, `primitive.${primitive.id}.stateSet.id`, stateSet.id);
  requireString(errors, `primitive.${primitive.id}.stateSet.${stateSet.id}.name`, stateSet.name);
  requireArray(errors, `primitive.${primitive.id}.stateSet.${stateSet.id}.styleRefs`, stateSet.styleRefs);
  requireArray(errors, `primitive.${primitive.id}.stateSet.${stateSet.id}.states`, stateSet.states);

  collectIds(errors, `primitive.${primitive.id}.stateSet.${stateSet.id}.states`, stateSet.states, state => {
    requireString(errors, `stateSet.${stateSet.id}.state.id`, state.id);
    requireString(errors, `stateSet.${stateSet.id}.state.${state.id}.name`, state.name);
    requireArray(errors, `stateSet.${stateSet.id}.state.${state.id}.tokens`, state.tokens);
    requireBoolean(errors, `stateSet.${stateSet.id}.state.${state.id}.prototypeOnly`, state.prototypeOnly);
    requireArray(errors, `stateSet.${stateSet.id}.state.${state.id}.notes`, state.notes);
    requireArray(errors, `stateSet.${stateSet.id}.state.${state.id}.implementationHints`, state.implementationHints);
  });
}

function validateScreen(
  errors: string[],
  screen: ScreenDefinition,
  framePresetIds: Set<string>,
  primitiveIds: Set<string>,
  componentIds: Set<string>,
  stateSetIds: Set<string>
): void {
  requireString(errors, 'screen.id', screen.id);
  requireString(errors, `screen.${screen.id}.name`, screen.name);
  if (screen.version !== undefined && (!Number.isSafeInteger(screen.version) || screen.version < 1)) {
    errors.push(`screen.${screen.id}.version must be a positive integer.`);
  }
  requireString(errors, `screen.${screen.id}.framePresetId`, screen.framePresetId);
  requireArray(errors, `screen.${screen.id}.sections`, screen.sections);

  if (!framePresetIds.has(screen.framePresetId)) {
    errors.push(`screen.${screen.id}.framePresetId references missing frame preset "${screen.framePresetId}".`);
  }

  collectIds(errors, `screen.${screen.id}.sections`, screen.sections, section => {
    requireString(errors, `screen.${screen.id}.section.id`, section.id);
    requireString(errors, `screen.${screen.id}.section.${section.id}.name`, section.name);
    requireArray(errors, `screen.${screen.id}.section.${section.id}.uses`, section.uses);

    for (const dependency of section.uses ?? []) {
      if (dependency.kind === 'primitive' && !primitiveIds.has(dependency.id)) {
        errors.push(`screen.${screen.id}.section.${section.id}.uses references missing primitive "${dependency.id}".`);
      }
      if (dependency.kind === 'state-set' && !stateSetIds.has(dependency.id)) {
        errors.push(`screen.${screen.id}.section.${section.id}.uses references missing state-set "${dependency.id}".`);
      }
      if (dependency.kind === 'component' && !componentIds.has(dependency.id)) {
        errors.push(`screen.${screen.id}.section.${section.id}.uses references missing component "${dependency.id}".`);
      }
    }
  });
}

function validateScreenVersions(errors: string[], screens: ScreenDefinition[]): void {
  const groups = new Map<string, ScreenDefinition[]>();
  for (const screen of screens ?? []) {
    const key = screenVersionGroupKey(screen);
    groups.set(key, [...(groups.get(key) ?? []), screen]);
  }

  for (const group of groups.values()) {
    const first = group[0];
    if (!first) {
      continue;
    }
    const route = screenRoutePath(first);
    const identity = `route "${route}" and frame name "${first.name.trim()}"`;

    if (group.length === 1) {
      if (first.version !== undefined) {
        errors.push(`screen.${first.id}.version must be omitted because ${identity} has only one screen.`);
      }
      continue;
    }

    const unversioned = group.filter(screen => screen.version === undefined);
    if (unversioned.length > 0) {
      errors.push(
        `Screens sharing ${identity} must each declare a unique consecutive version starting at 1; missing on ${unversioned.map(screen => `"${screen.id}"`).join(', ')}.`
      );
      continue;
    }

    const versions = group
      .map(screen => screen.version)
      .filter((version): version is number => typeof version === 'number' && Number.isSafeInteger(version) && version >= 1)
      .sort((a, b) => a - b);
    if (versions.length !== group.length) {
      continue;
    }
    const expected = Array.from({ length: group.length }, (_, index) => index + 1);
    if (versions.some((version, index) => version !== expected[index])) {
      errors.push(
        `Screens sharing ${identity} must use unique consecutive versions ${expected.join(', ')}; received ${versions.join(', ')}.`
      );
    }
  }
}

function validateScreenHistory(
  errors: string[],
  bundle: BlueprintProjectBundle,
  screenIds: Set<string>,
  framePresetIds: Set<string>,
  primitiveIds: Set<string>,
  componentIds: Set<string>,
  stateSetIds: Set<string>
): void {
  requireArray(errors, 'history.entries', bundle.history.entries);
  const versionsByScreen = new Map<string, number[]>();
  const keys = new Set<string>();
  for (const entry of bundle.history.entries ?? []) {
    validateScreenHistoryEntry(
      errors,
      bundle,
      entry,
      screenIds,
      framePresetIds,
      primitiveIds,
      componentIds,
      stateSetIds
    );
    const key = `${entry.screenId}\u0000${entry.version}`;
    if (keys.has(key)) {
      errors.push(`History for screen "${entry.screenId}" contains duplicate V${entry.version}.`);
    }
    keys.add(key);
    versionsByScreen.set(entry.screenId, [...(versionsByScreen.get(entry.screenId) ?? []), entry.version]);
  }
  for (const [screenId, versions] of versionsByScreen) {
    const ordered = [...versions].sort((left, right) => left - right);
    const expected = Array.from({ length: ordered.length }, (_, index) => index + 1);
    if (ordered.some((version, index) => version !== expected[index])) {
      errors.push(
        `History for screen "${screenId}" must use consecutive immutable versions ${expected.join(', ')}; received ${ordered.join(', ')}.`
      );
    }
  }
}

function validateScreenHistoryEntry(
  errors: string[],
  bundle: BlueprintProjectBundle,
  entry: ScreenHistoryEntry,
  screenIds: Set<string>,
  framePresetIds: Set<string>,
  primitiveIds: Set<string>,
  componentIds: Set<string>,
  stateSetIds: Set<string>
): void {
  const label = `history.${entry.screenId}.v${entry.version}`;
  requireString(errors, `${label}.screenId`, entry.screenId);
  if (!Number.isSafeInteger(entry.version) || entry.version < 1) {
    errors.push(`${label}.version must be a positive integer.`);
  }
  requireString(errors, `${label}.state`, entry.state);
  requireString(errors, `${label}.framePresetId`, entry.framePresetId);
  if (!screenIds.has(entry.screenId)) {
    errors.push(`${label} references missing canonical screen "${entry.screenId}".`);
  }
  if (!framePresetIds.has(entry.framePresetId)) {
    errors.push(`${label} references missing frame preset "${entry.framePresetId}".`);
  }
  requireObject(errors, `${label}.screen`, entry.screen);
  if (entry.screen?.id !== entry.screenId) {
    errors.push(`${label}.screen.id must match canonical screen "${entry.screenId}".`);
  }
  if (entry.screen) {
    validateScreen(errors, entry.screen, framePresetIds, primitiveIds, componentIds, stateSetIds);
  }
  const prototype = entry.screen?.prototype;
  if (!prototype) {
    errors.push(`${label}.screen must retain a governed prototype source.`);
    return;
  }
  const hasReviewPair = prototype.reviewConditions?.some(condition => (
    condition.state === entry.state && condition.framePresetId === entry.framePresetId
  ));
  if (!hasReviewPair) {
    errors.push(`${label} state and frame preset must remain a declared historical review condition.`);
  }
  const ownedMarker = `.history-${storageRecordSegment(entry.screenId)}-v${entry.version}`;
  for (const sourceRef of [prototype.source, ...(prototype.styles ?? [])]) {
    const extension = path.posix.extname(sourceRef.replace(/\\/g, '/'));
    const withoutExtension = extension ? sourceRef.slice(0, -extension.length) : sourceRef;
    if (!isSafeRelativeRef(sourceRef) || !withoutExtension.endsWith(ownedMarker)) {
      errors.push(`${label} source "${sourceRef}" must carry immutable marker "${ownedMarker}".`);
      continue;
    }
    const content = bundle.prototypeSourceContents[sourceRef];
    if (typeof content !== 'string' || content.length === 0) {
      errors.push(`${label} source "${sourceRef}" is missing or empty.`);
    }
  }
  for (const assetRef of prototype.assetRefs ?? []) {
    if (!isSafeRelativeRef(assetRef) || !isControlledAssetRef(bundle, assetRef)) {
      errors.push(`${label} asset "${assetRef}" must stay inside a declared prototypeHost.assetRoots directory.`);
    } else if (!(assetRef in bundle.prototypeAssetContents)) {
      errors.push(`${label} asset "${assetRef}" is missing.`);
    }
  }
  if (entry.replacedBy?.type === 'exploration-candidate') {
    const replacement = entry.replacedBy;
    const exploration = bundle.explorations.explorations.find(candidate => candidate.id === replacement.explorationId);
    if (!exploration?.candidates.some(candidate => candidate.id === replacement.candidateId)) {
      errors.push(`${label}.replacedBy must reference a saved exploration candidate.`);
    }
  } else if (entry.replacedBy?.type === 'history-restore') {
    if (!Number.isSafeInteger(entry.replacedBy.version) || entry.replacedBy.version < 1) {
      errors.push(`${label}.replacedBy.version must be a positive integer.`);
    }
  } else {
    errors.push(`${label}.replacedBy must describe an exploration candidate or history restoration.`);
  }
}

function validateExplorations(
  errors: string[],
  bundle: BlueprintProjectBundle,
  screenIds: Set<string>,
  framePresetIds: Set<string>
): void {
  collectIds(errors, 'explorations.explorations', bundle.explorations.explorations, exploration => {
    validateExploration(errors, bundle, exploration, screenIds, framePresetIds);
  });
  const activeTargets = new Map<string, string>();
  for (const exploration of bundle.explorations.explorations ?? []) {
    if (exploration.lifecycle !== 'active') {
      continue;
    }
    const targetKey = [
      exploration.target?.screenId,
      exploration.target?.state,
      exploration.target?.framePresetId
    ].join('\u0000');
    const existing = activeTargets.get(targetKey);
    if (existing) {
      errors.push(
        `Active explorations "${existing}" and "${exploration.id}" target the same canonical screen, state, and frame preset.`
      );
    } else {
      activeTargets.set(targetKey, exploration.id);
    }
  }
}

function validateExploration(
  errors: string[],
  bundle: BlueprintProjectBundle,
  exploration: ExplorationDefinition,
  screenIds: Set<string>,
  framePresetIds: Set<string>
): void {
  const label = `exploration.${exploration.id}`;
  requireString(errors, 'exploration.id', exploration.id);
  if (!isSafeExplorationId(exploration.id)) {
    errors.push(`${label}.id must use 1-64 lowercase letters, numbers, or internal hyphens.`);
  }
  requireSafeHumanLabel(errors, `${label}.title`, exploration.title);
  requireSafeHumanLabel(errors, `${label}.intent`, exploration.intent);
  if (!['active', 'archived', 'promoted'].includes(String(exploration.lifecycle))) {
    errors.push(`${label}.lifecycle must be "active", "archived", or "promoted".`);
  }
  requireObject(errors, `${label}.target`, exploration.target);
  requireString(errors, `${label}.target.screenId`, exploration.target?.screenId);
  requireString(errors, `${label}.target.state`, exploration.target?.state);
  requireString(errors, `${label}.target.framePresetId`, exploration.target?.framePresetId);
  requireString(errors, `${label}.target.baseDigest`, exploration.target?.baseDigest);
  if (!/^[a-f0-9]{64}$/.test(exploration.target?.baseDigest ?? '')) {
    errors.push(`${label}.target.baseDigest must be a lowercase SHA-256 digest.`);
  }
  if (!screenIds.has(exploration.target?.screenId)) {
    errors.push(`${label}.target references missing canonical screen "${exploration.target?.screenId}".`);
  }
  if (!framePresetIds.has(exploration.target?.framePresetId)) {
    errors.push(`${label}.target references missing frame preset "${exploration.target?.framePresetId}".`);
  }

  const baseline = exploration.target?.baseline;
  requireObject(errors, `${label}.target.baseline`, baseline);
  requireObject(errors, `${label}.target.baseline.screen`, baseline?.screen);
  requireObject(errors, `${label}.target.baseline.prototype`, baseline?.prototype);
  if (baseline?.screen?.id !== exploration.target?.screenId) {
    errors.push(`${label}.target.baseline.screen.id must match target screen "${exploration.target?.screenId}".`);
  }
  const baselineScreenPrototype = baseline?.screen?.prototype;
  const hasReviewPair = baselineScreenPrototype?.reviewConditions?.some(condition => (
    condition.state === exploration.target?.state &&
    condition.framePresetId === exploration.target?.framePresetId
  ));
  if (!hasReviewPair) {
    errors.push(
      `${label}.target state "${exploration.target?.state}" and frame preset "${exploration.target?.framePresetId}" are not a declared baseline review condition.`
    );
  }
  if (baselineScreenPrototype && !(baselineScreenPrototype.states ?? []).includes(exploration.target?.state)) {
    errors.push(`${label}.target state "${exploration.target?.state}" is not declared by the baseline prototype.`);
  }
  if (baseline?.prototype) {
    validateExplorationPrototype(errors, bundle, exploration, 'baseline', baseline.prototype);
  }
  try {
    const digest = computeExplorationBaselineDigest(bundle, exploration.id);
    if (digest !== exploration.target?.baseDigest) {
      errors.push(`${label}.target.baseDigest is stale for the persisted baseline sources.`);
    }
  } catch (error) {
    errors.push(`${label}.target baseline cannot be digested: ${error instanceof Error ? error.message : String(error)}`);
  }

  requireArray(errors, `${label}.candidates`, exploration.candidates);
  if (!Array.isArray(exploration.candidates) || exploration.candidates.length < 2 || exploration.candidates.length > 5) {
    errors.push(`${label}.candidates must contain between 2 and 5 candidates.`);
  }
  const candidateIds = new Set<string>();
  const candidateLabels = new Set<string>();
  for (const candidate of exploration.candidates ?? []) {
    requireString(errors, `${label}.candidate.id`, candidate.id);
    if (!isSafeExplorationId(candidate.id)) {
      errors.push(`${label}.candidate id "${candidate.id}" must use 1-64 lowercase letters, numbers, or internal hyphens.`);
    }
    if (candidateIds.has(candidate.id)) {
      errors.push(`${label} has duplicate candidate id "${candidate.id}".`);
    }
    candidateIds.add(candidate.id);
    requireSafeHumanLabel(errors, `${label}.candidate.${candidate.id}.label`, candidate.label);
    const normalizedLabel = candidate.label?.trim().toLocaleLowerCase();
    if (candidateLabels.has(normalizedLabel)) {
      errors.push(`${label} has duplicate candidate label "${candidate.label}".`);
    }
    candidateLabels.add(normalizedLabel);
    requireObject(errors, `${label}.candidate.${candidate.id}.prototype`, candidate.prototype);
    if (candidate.prototype) {
      validateExplorationPrototype(errors, bundle, exploration, candidate.id, candidate.prototype);
    }
  }

  const selected = exploration.selectedCandidateId;
  const promotedScreen = exploration.promotedScreenId;
  if (exploration.lifecycle === 'promoted') {
    if (!selected || !candidateIds.has(selected)) {
      errors.push(`${label}.selectedCandidateId must reference a candidate when lifecycle is "promoted".`);
    }
    if (!promotedScreen || !screenIds.has(promotedScreen)) {
      errors.push(`${label}.promotedScreenId must reference a canonical screen when lifecycle is "promoted".`);
    }
  } else if (selected !== undefined || promotedScreen !== undefined) {
    errors.push(`${label} may declare selectedCandidateId and promotedScreenId only when lifecycle is "promoted".`);
  }
}

function validateExplorationPrototype(
  errors: string[],
  bundle: BlueprintProjectBundle,
  exploration: ExplorationDefinition,
  ownerId: string,
  prototype: ExplorationPrototypeSource
): void {
  const label = `exploration.${exploration.id}.${ownerId}.prototype`;
  requireString(errors, `${label}.source`, prototype.source);
  requireArray(errors, `${label}.styles`, prototype.styles);
  requireArray(errors, `${label}.assetRefs`, prototype.assetRefs);
  const textRefs = [prototype.source, ...(prototype.styles ?? [])];
  for (const sourceRef of textRefs) {
    if (!isSafeRelativeRef(sourceRef)) {
      errors.push(`${label} source "${sourceRef}" escapes or points outside the Blueprint source root.`);
      continue;
    }
    if (!hasExplorationSourceMarker(sourceRef, exploration.id, ownerId)) {
      errors.push(`${label} source "${sourceRef}" is not owned by this screen-local exploration entry.`);
    }
    const content = bundle.prototypeSourceContents[sourceRef];
    if (typeof content !== 'string' || content.length === 0) {
      errors.push(`${label} source "${sourceRef}" is missing or empty.`);
    }
  }
  for (const assetRef of prototype.assetRefs ?? []) {
    if (!isSafeRelativeRef(assetRef)) {
      errors.push(`${label} asset "${assetRef}" escapes or points outside the Blueprint source root.`);
      continue;
    }
    if (!isControlledAssetRef(bundle, assetRef)) {
      errors.push(`${label} asset "${assetRef}" must stay inside a declared prototypeHost.assetRoots directory.`);
    }
    if (!(assetRef in bundle.prototypeAssetContents)) {
      errors.push(`${label} asset "${assetRef}" is missing.`);
    }
  }
}

function hasExplorationSourceMarker(sourceRef: string, explorationId: string, ownerId: string): boolean {
  const normalized = sourceRef.replace(/\\/g, '/');
  const recordRoot = ownerId === 'baseline'
    ? `prototype/explorations/${explorationId}/baseline/`
    : `prototype/explorations/${explorationId}/candidates/${ownerId}/`;
  if (normalized.startsWith(recordRoot)) {
    return true;
  }
  const extension = path.posix.extname(normalized);
  const withoutExtension = extension ? sourceRef.slice(0, -extension.length) : sourceRef;
  return withoutExtension.endsWith(`.exploration-${explorationId}-${ownerId}`);
}

function isSafeExplorationId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

function requireSafeHumanLabel(errors: string[], label: string, value: unknown): void {
  requireString(errors, label, value);
  if (typeof value === 'string' && (value.length > 160 || /[\u0000-\u001f\u007f]/.test(value))) {
    errors.push(`${label} must be at most 160 characters and contain no control characters.`);
  }
}

function validateDependency(
  errors: string[],
  path: string,
  dependency: BoundaryDependency,
  known: {
    tokenGroupIds: Set<string>;
    primitiveIds: Set<string>;
    stateSetIds: Set<string>;
    componentIds: Set<string>;
    screenIds: Set<string>;
    sectionIds: Set<string>;
  }
): void {
  requireString(errors, `${path}.kind`, dependency.kind);
  requireString(errors, `${path}.id`, dependency.id);
  requireString(errors, `${path}.reason`, dependency.reason);

  const map = {
    'token-group': known.tokenGroupIds,
    primitive: known.primitiveIds,
    'state-set': known.stateSetIds,
    component: known.componentIds,
    screen: known.screenIds,
    section: known.sectionIds
  } as const;

  if (!(dependency.kind in map)) {
    errors.push(`${path} has unsupported dependency kind "${String(dependency.kind)}".`);
    return;
  }
  if (!map[dependency.kind].has(dependency.id)) {
    errors.push(`${path} references missing ${dependency.kind} "${dependency.id}".`);
  }
}

function validateBasePrimitiveContract(errors: string[], bundle: BlueprintProjectBundle): void {
  const primitivesById = new Map(bundle.primitives.primitives.map(primitive => [primitive.id, primitive]));
  for (const base of BASE_PRIMITIVE_CONTRACT) {
    const primitive = primitivesById.get(base.id);
    if (!primitive) {
      errors.push(`primitives is missing locked base primitive "${base.id}". ${BASE_PRIMITIVE_LOCK_REASON}`);
      continue;
    }

    // Supersets stay valid: apps may add state sets and states, never reduce the base floor.
    const stateSetsById = new Map((primitive.stateSets ?? []).map(stateSet => [stateSet.id, stateSet]));
    for (const requiredSet of base.stateSets) {
      const stateSet = stateSetsById.get(requiredSet.id);
      if (!stateSet) {
        errors.push(`primitive.${base.id}.stateSets is missing locked base state-set "${requiredSet.id}". ${BASE_PRIMITIVE_LOCK_REASON}`);
        continue;
      }

      const stateIds = new Set((stateSet.states ?? []).map(state => state.id));
      for (const stateId of requiredSet.states) {
        if (!stateIds.has(stateId)) {
          errors.push(`primitive.${base.id}.stateSet.${requiredSet.id} is missing locked base state "${stateId}". ${BASE_PRIMITIVE_LOCK_REASON}`);
        }
      }
    }
  }
}

function validatePrototypeContracts(
  errors: string[],
  bundle: BlueprintProjectBundle,
  tokenIds: Set<string>,
  framePresetIds: Set<string>
): void {
  for (const primitive of bundle.primitives.primitives) {
    if (!primitive.prototype) {
      errors.push(`primitive.${primitive.id}.prototype must declare a canonical HTML/CSS source.`);
      continue;
    }
    validatePrototypeSource(errors, bundle, `primitive.${primitive.id}.prototype`, primitive.prototype);
    requireArray(errors, `primitive.${primitive.id}.prototype.slots`, primitive.prototype.slots);
    requireArray(errors, `primitive.${primitive.id}.prototype.variants`, primitive.prototype.variants);
    if (primitive.prototype.sizes !== undefined) {
      requireArray(errors, `primitive.${primitive.id}.prototype.sizes`, primitive.prototype.sizes);
    }
    requireString(errors, `primitive.${primitive.id}.prototype.accessibilityIntent`, primitive.prototype.accessibilityIntent);
    requireObject(errors, `primitive.${primitive.id}.prototype.tokenRoles`, primitive.prototype.tokenRoles);
    for (const [tokenRef, role] of Object.entries(primitive.prototype.tokenRoles ?? {})) {
      if (!tokenIds.has(tokenRef)) {
        errors.push(`primitive.${primitive.id}.prototype.tokenRoles references missing token "${tokenRef}".`);
      }
      requireString(errors, `primitive.${primitive.id}.prototype.tokenRoles.${tokenRef}`, role);
    }
    validateRenderedUses(errors, `primitive.${primitive.id}.prototype.renderedUses`, primitive.uses ?? [], primitive.prototype.renderedUses);
  }

  for (const component of bundle.components.components) {
    validatePrototypeSource(errors, bundle, `component.${component.id}.prototype`, component.prototype);
    requireArray(errors, `component.${component.id}.prototype.slots`, component.prototype.slots);
    validateRenderedUses(errors, `component.${component.id}.prototype.renderedUses`, component.uses, component.prototype.renderedUses);
  }

  for (const screen of bundle.screens.screens) {
    if (!screen.prototype) {
      errors.push(`screen.${screen.id}.prototype must declare a browser-native HTML/CSS source.`);
      continue;
    }
    validatePrototypeSource(errors, bundle, `screen.${screen.id}.prototype`, screen.prototype);
    requireArray(errors, `screen.${screen.id}.prototype.assetRefs`, screen.prototype.assetRefs);
    requireArray(errors, `screen.${screen.id}.prototype.reviewConditions`, screen.prototype.reviewConditions);
    for (const assetRef of screen.prototype.assetRefs ?? []) {
      validatePrototypeFileRef(errors, bundle, `screen.${screen.id}.prototype.assetRef`, assetRef);
      if (!isControlledAssetRef(bundle, assetRef)) {
        errors.push(`screen.${screen.id}.prototype asset "${assetRef}" must stay inside a declared prototypeHost.assetRoots directory.`);
      }
    }
    collectIds(errors, `screen.${screen.id}.prototype.reviewConditions`, screen.prototype.reviewConditions, condition => {
      requireString(errors, `screen.${screen.id}.prototype.reviewCondition.id`, condition.id);
      requireString(errors, `screen.${screen.id}.prototype.reviewCondition.${condition.id}.framePresetId`, condition.framePresetId);
      requireString(errors, `screen.${screen.id}.prototype.reviewCondition.${condition.id}.state`, condition.state);
      if (!framePresetIds.has(condition.framePresetId)) {
        errors.push(`screen.${screen.id}.prototype.reviewCondition.${condition.id} references missing frame preset "${condition.framePresetId}".`);
      }
      if (!screen.prototype?.states.includes(condition.state)) {
        errors.push(`screen.${screen.id}.prototype.reviewCondition.${condition.id} references undeclared state "${condition.state}".`);
      }
    });
    const declaredUses = screen.sections.flatMap(section => section.uses);
    validateRenderedUses(errors, `screen.${screen.id}.prototype.renderedUses`, declaredUses, screen.prototype.renderedUses);
  }
}

function validatePrototypeSource(
  errors: string[],
  bundle: BlueprintProjectBundle,
  label: string,
  prototype: PrototypeSource
): void {
  requireString(errors, `${label}.source`, prototype.source);
  requireArray(errors, `${label}.styles`, prototype.styles);
  requireArray(errors, `${label}.states`, prototype.states);
  validatePrototypeFileRef(errors, bundle, `${label}.source`, prototype.source);
  for (const styleRef of prototype.styles ?? []) {
    validatePrototypeFileRef(errors, bundle, `${label}.style`, styleRef);
  }
  if (prototype.localValueExceptions) {
    requireArray(errors, `${label}.localValueExceptions`, prototype.localValueExceptions);
    for (const exception of prototype.localValueExceptions) {
      requireString(errors, `${label}.localValueException.property`, exception.property);
      requireString(errors, `${label}.localValueException.value`, exception.value);
      requireString(errors, `${label}.localValueException.reason`, exception.reason);
    }
  }
}

function validatePrototypeFileRef(
  errors: string[],
  bundle: BlueprintProjectBundle,
  label: string,
  sourceRef: string
): void {
  if (!isSafeRelativeRef(sourceRef)) {
    errors.push(`${label} "${sourceRef}" escapes or points outside the Blueprint source root.`);
    return;
  }
  if (!existsSync(path.resolve(bundle.sourceRoot, sourceRef))) {
    errors.push(`${label} "${sourceRef}" does not exist.`);
  }
}

function isSafeRelativeRef(sourceRef: string): boolean {
  if (path.isAbsolute(sourceRef) || sourceRef.includes('://')) {
    return false;
  }
  const segments = sourceRef.replace(/\\/g, '/').split('/');
  return sourceRef.length > 0 && !segments.includes('..');
}

function isControlledAssetRef(bundle: BlueprintProjectBundle, assetRef: string): boolean {
  const normalized = assetRef.replace(/\\/g, '/').replace(/^\.\//, '');
  return (bundle.manifest.prototypeHost?.assetRoots ?? []).some(assetRoot => {
    const root = assetRoot.replace(/\\/g, '/').replace(/\/$/, '');
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}

function validateRenderedUses(
  errors: string[],
  label: string,
  declaredUses: BoundaryDependency[],
  renderedUses: PrototypeSource['renderedUses']
): void {
  if (!renderedUses) {
    return;
  }
  const declared = declaredUses
    .filter(dependency => dependency.kind === 'primitive' || dependency.kind === 'component')
    .map(dependency => `${dependency.kind}:${dependency.id}`)
    .sort();
  const rendered = renderedUses.map(dependency => `${dependency.kind}:${dependency.id}`).sort();
  if (JSON.stringify(declared) !== JSON.stringify(rendered)) {
    errors.push(`${label} must exactly match declared reusable dependencies. Declared ${JSON.stringify(declared)}; rendered ${JSON.stringify(rendered)}.`);
  }
}

function validatePrototypeHost(errors: string[], prototypeHost: BlueprintProjectBundle['manifest']['prototypeHost'] | undefined): void {
  if (typeof prototypeHost !== 'object' || prototypeHost === null) {
    errors.push('manifest.prototypeHost must declare assetRoots, network "deny", and scripts "none".');
    return;
  }
  requireArray(errors, 'manifest.prototypeHost.assetRoots', prototypeHost.assetRoots);
  if (prototypeHost.network !== 'deny') {
    errors.push('manifest.prototypeHost.network must be "deny".');
  }
  if (prototypeHost.scripts !== 'none') {
    errors.push('manifest.prototypeHost.scripts must be "none".');
  }
}

function relativePrototypeSources(bundle: BlueprintProjectBundle): string[] {
  const prefix = `${bundle.sourceRoot.replace(/\/$/, '')}/`;
  return bundle.sourceFiles.prototypeSources.map(sourcePath => sourcePath.startsWith(prefix) ? sourcePath.slice(prefix.length) : sourcePath);
}

function collectTokenIds(groups: TokenGroup[]): Set<string> {
  const tokenIds = new Set<string>();
  for (const group of groups ?? []) {
    for (const token of group.tokens ?? []) {
      if (group.id && token.id) {
        tokenIds.add(`${group.id}.${token.id}`);
      }
    }
  }
  return tokenIds;
}

function validateStateTokenReferences(
  errors: string[],
  primitive: PrimitiveDefinition,
  stateSet: PrimitiveStateSet,
  tokenIds: Set<string>
): void {
  for (const state of stateSet.states ?? []) {
    for (const tokenRef of state.tokens ?? []) {
      if (!tokenIds.has(tokenRef)) {
        errors.push(`primitive.${primitive.id}.stateSet.${stateSet.id}.state.${state.id}.tokens references missing token "${tokenRef}".`);
      }
    }
    if (state.tokenRoles) {
      requireObject(errors, `primitive.${primitive.id}.stateSet.${stateSet.id}.state.${state.id}.tokenRoles`, state.tokenRoles);
      for (const [tokenRef, role] of Object.entries(state.tokenRoles)) {
        if (!tokenIds.has(tokenRef)) {
          errors.push(`primitive.${primitive.id}.stateSet.${stateSet.id}.state.${state.id}.tokenRoles references missing token "${tokenRef}".`);
        }
        if (!(state.tokens ?? []).includes(tokenRef)) {
          errors.push(
            `primitive.${primitive.id}.stateSet.${stateSet.id}.state.${state.id}.tokenRoles references token "${tokenRef}" that is not listed in state tokens.`
          );
        }
        requireString(errors, `primitive.${primitive.id}.stateSet.${stateSet.id}.state.${state.id}.tokenRoles.${tokenRef}`, role);
      }
    }
  }
}

function validateStrictHandoffReadiness(errors: string[], bundle: BlueprintProjectBundle): void {
  for (const issue of lintLocalStyleValues(bundle)) {
    errors.push(`${issue.boundary} ${issue.styleRef} ${localStyleValueMessage(issue)}`);
  }
  for (const issue of lintHandBuiltControls(bundle)) {
    errors.push(`${issue.boundary} ${issue.sourceRef}:${issue.line} ${handBuiltControlMessage(issue)}`);
  }
  for (const issue of lintColorContrast(bundle)) {
    errors.push(`token-group.${issue.groupId} ${contrastMessage(issue)}`);
  }

  if (bundle.manifest.handoffContractVersion !== supportedHandoffContractVersion) {
    if (!bundle.manifest.handoffContractVersion) {
      errors.push(`manifest.handoffContractVersion must be "${supportedHandoffContractVersion}" for strict handoff readiness.`);
    } else {
      errors.push(`Unsupported handoff contract version "${bundle.manifest.handoffContractVersion}". Expected "${supportedHandoffContractVersion}".`);
    }
  }

  for (const primitive of bundle.primitives.primitives ?? []) {
    if (primitive.prototypeOnly) {
      continue;
    }

    validateImplementationTargets(errors, `primitive.${primitive.id}.implementationTargets`, primitive.implementationTargets);
    validateStyleEvidence(errors, `primitive.${primitive.id}.styleEvidence`, primitive.styleRefs, primitive.styleEvidence);

    for (const stateSet of primitive.stateSets ?? []) {
      if ((stateSet.states ?? []).every(state => state.prototypeOnly)) {
        continue;
      }
      validateStyleEvidence(errors, `primitive.${primitive.id}.stateSet.${stateSet.id}.styleEvidence`, stateSet.styleRefs, stateSet.styleEvidence);
    }
  }

  for (const screen of bundle.screens.screens ?? []) {
    if (screen.prototypeOnly) {
      continue;
    }

    validateProductionRelationship(errors, `screen.${screen.id}.productionRelationship`, screen.productionRelationship);
    validateImplementationTargets(errors, `screen.${screen.id}.implementationTargets`, screen.implementationTargets);
    validateStyleEvidence(errors, `screen.${screen.id}.styleEvidence`, screen.styleRefs, screen.styleEvidence);

    for (const section of screen.sections ?? []) {
      if (section.prototypeOnly) {
        continue;
      }

      validateImplementationTargets(errors, `screen.${screen.id}.section.${section.id}.implementationTargets`, section.implementationTargets);
      validateStyleEvidence(errors, `screen.${screen.id}.section.${section.id}.styleEvidence`, section.styleRefs, section.styleEvidence);
      validateCompositionBindings(errors, screen, section);
    }
    for (const sectionId of unmarkedSectionIds(bundle, screen)) {
      errors.push(`screen.${screen.id}.section.${sectionId} needs a data-blueprint-section="${sectionId}" marker in its prototype source for strict handoff readiness.`);
    }
  }
}

function validateProductionRelationship(errors: string[], label: string, relationship: ProductionRelationship | undefined): void {
  if (!relationship) {
    errors.push(`${label} is required for strict handoff readiness.`);
    return;
  }

  requireString(errors, `${label}.kind`, relationship.kind);
  if (relationship.kind === 'new-route' || relationship.kind === 'existing-route') {
    requireString(errors, `${label}.routePath`, relationship.routePath);
  }
  if (
    (relationship.kind === 'state-of-existing-screen' || relationship.kind === 'variant-of-existing-screen') &&
    !relationship.targetScreenId
  ) {
    errors.push(`${label}.targetScreenId is required for ${relationship.kind}.`);
  }
}

function validateImplementationTargets(
  errors: string[],
  label: string,
  targets: ImplementationTarget[] | undefined
): void {
  if (!Array.isArray(targets) || targets.length === 0) {
    errors.push(`${label} must include at least one target for strict handoff readiness.`);
    return;
  }

  targets.forEach((target, index) => {
    const item = `${label}.${index}`;
    requireString(errors, `${item}.platform`, target.platform);
    requireString(errors, `${item}.framework`, target.framework);
    requireString(errors, `${item}.candidatePath`, target.candidatePath);
    requireString(errors, `${item}.symbolName`, target.symbolName);
    requireString(errors, `${item}.operationIntent`, target.operationIntent);
    requireObject(errors, `${item}.propMapping`, target.propMapping);
    requireObject(errors, `${item}.stateMapping`, target.stateMapping);
    requireString(errors, `${item}.tokenAdapter`, target.tokenAdapter);
    requireArray(errors, `${item}.testPaths`, target.testPaths);
    requireArray(errors, `${item}.storyPaths`, target.storyPaths);
    requireArray(errors, `${item}.unresolvedDecisions`, target.unresolvedDecisions);
    if ((target.unresolvedDecisions ?? []).length > 0) {
      errors.push(`${item}.unresolvedDecisions must be empty for strict handoff readiness.`);
    }
  });
}

function validateStyleEvidence(
  errors: string[],
  label: string,
  styleRefs: string[] | undefined,
  evidence: StyleEvidence[] | undefined
): void {
  const refs = styleRefs ?? [];
  if (refs.length === 0) {
    return;
  }

  if (!Array.isArray(evidence)) {
    errors.push(`${label} must include explicit evidence for ${refs.length} style refs.`);
    return;
  }

  const byRef = new Map(evidence.map(item => [item.styleRef, item]));
  for (const styleRef of refs) {
    const item = byRef.get(styleRef);
    if (!item) {
      errors.push(`${label} is missing evidence for style ref "${styleRef}".`);
      continue;
    }
    if (item.status !== 'source' && item.status !== 'linked-artifact-pending' && item.status !== 'unresolved') {
      errors.push(`${label}.${styleRef}.status "${String(item.status)}" is not supported.`);
    }
    if (item.status === 'source') {
      requireString(errors, `${label}.${styleRef}.sourceAnchor`, item.sourceAnchor);
    }
    if (item.status === 'linked-artifact-pending') {
      requireString(errors, `${label}.${styleRef}.artifactRef`, item.artifactRef);
    }
    if (item.status === 'unresolved') {
      errors.push(`${label}.${styleRef} style evidence is unresolved.`);
    }
  }
}

function validateCompositionBindings(errors: string[], screen: ScreenDefinition, section: ScreenSection): void {
  for (const dependency of section.uses ?? []) {
    const label = `screen.${screen.id}.section.${section.id}.uses.${dependency.kind}.${dependency.id}.binding`;
    if (!dependency.binding) {
      errors.push(`${label} is required for strict handoff readiness.`);
      continue;
    }

    requireString(errors, `${label}.slot`, dependency.binding.slot);
    const hasBindingDetail = [
      dependency.binding.state,
      dependency.binding.variant,
      dependency.binding.prop,
      dependency.binding.copy,
      dependency.binding.data,
      dependency.binding.layout,
      dependency.binding.accessibility
    ].some(value => typeof value === 'string' && value.length > 0);

    if (!hasBindingDetail) {
      errors.push(`${label} must describe at least one state, variant, prop, copy, data, layout, or accessibility binding.`);
    }
  }
}

function collectIds<T extends { id: string }>(
  errors: string[],
  label: string,
  items: T[] | undefined,
  validate: (item: T) => void
): Set<string> {
  const ids = new Set<string>();
  requireArray(errors, label, items);

  for (const item of items ?? []) {
    validate(item);
    if (!item.id) {
      continue;
    }
    if (ids.has(item.id)) {
      errors.push(`Duplicate id "${item.id}" in ${label}.`);
    }
    ids.add(item.id);
  }

  return ids;
}

function requireString(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${label} must be a non-empty string.`);
  }
}

function requireNumber(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label} must be a finite number.`);
  }
}

function requirePositiveNumber(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`${label} must be a positive number.`);
  }
}

function requireBoolean(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'boolean') {
    errors.push(`${label} must be a boolean.`);
  }
}

function requireArray(errors: string[], label: string, value: unknown): void {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
  }
}

function requireObject(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
  }
}

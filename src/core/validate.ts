import type {
  BlueprintProjectBundle,
  BoardDefinition,
  BoundaryDependency,
  BrandMark,
  ExplorationDefinition,
  ExplorationPrototypeSource,
  FramePreset,
  ImplementationTarget,
  PrototypeSource,
  ReadinessItem,
  ReadinessReport,
  ProductionRelationship,
  SavedScreen,
  ScreenDefinition,
  ScreenHistoryEntry,
  ScreenSection,
  StyleEvidence,
  ValidationMode,
  PrototypeSourceGraphIssue,
  ValidationOptions,
  TokenGroup,
  ValidationResult
} from './types';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BASE_PRIMITIVE_CONTRACT, BASE_PRIMITIVE_LOCK_REASON, primitiveOutsideSetMessage, primitivesOutsideSet } from './base-primitives';
import { validateReusables } from './reusable-validate';
import { validateScreenContract } from './screen-contract';
import { schemaVersionErrors } from './schema-version';
import { validateTokenContract } from './token-contract';
import { hasApprovedInspoDirection, validateInspoContract } from './inspo-contract';
import { lintHandBuiltControls } from './control-lint';
import { handBuiltControlError, handBuiltControlMessage, localStyleValueError, localStyleValueMessage, unmarkedSectionIds } from './findings';
import { lintLocalStyleValues, type LocalStyleValueIssue } from './style-lint';
import { collectStyleRuleIssues, styleRuleMessage } from './style-rules';
import { validateBrandFonts, validateFontFaces, validateFontFamilyTokens } from './font-rules';
import { contrastMessage, contrastRatio, lintColorContrast } from './contrast-lint';
import { BRAND_MARK_ROLES, brandMarkHandoffIssues, brandMarkSourceIssues } from './brand-lint';
import { parseOpaqueColor } from './color';
import { collectNamingErrors } from './naming-rules';
import { screenRoutePath, screenVersionGroupKey } from './screen-naming';
import { collectCandidateRuleErrors } from './candidate-rules';
import { computeExplorationBaselineDigest } from './exploration';
import { storageRecordSegment } from './storage-records';

const supportedHandoffContractVersion = '1.0.0';

export type SourceGraphIssues = () => PrototypeSourceGraphIssue[];

export function validationResult(contractErrors: string[], styleErrors: string[]): ValidationResult {
  const errors = [...contractErrors, ...styleErrors];
  return { ok: errors.length === 0, errors, contractErrors, styleErrors };
}

export function validateProjectWithSourceGraph(
  bundle: BlueprintProjectBundle,
  options: ValidationOptions,
  sourceGraphIssues: SourceGraphIssues
): ValidationResult {
  const schemaErrors = schemaVersionErrors(bundle);
  if (schemaErrors.length > 0) {
    return validationResult(schemaErrors, []);
  }
  const errors: string[] = [];
  const projectId = bundle.manifest.project?.id;

  requireString(errors, 'manifest.project.id', projectId);
  requireString(errors, 'manifest.project.name', bundle.manifest.project?.name);
  requireString(errors, 'manifest.project.sourceRoot', bundle.manifest.project?.sourceRoot);
  requireString(errors, 'manifest.defaultBoardId', bundle.manifest.defaultBoardId);

  if (bundle.tokens.projectId !== projectId) {
    errors.push(`tokens.projectId "${bundle.tokens.projectId}" must match manifest project id "${projectId}". Fix: set projectId in tokens.json to "${projectId}".`);
  }

  if (bundle.primitives.projectId !== projectId) {
    errors.push(`primitives.projectId "${bundle.primitives.projectId}" must match manifest project id "${projectId}". Fix: set projectId in primitives.json to "${projectId}".`);
  }

  if (bundle.components.projectId !== projectId) {
    errors.push(`components.projectId "${bundle.components.projectId}" must match manifest project id "${projectId}". Fix: set projectId in components.json to "${projectId}".`);
  }

  if (bundle.screens.projectId !== projectId) {
    errors.push(`screens.projectId "${bundle.screens.projectId}" must match manifest project id "${projectId}". Fix: set projectId in screens.json to "${projectId}".`);
  }

  if (bundle.explorations.projectId !== projectId) {
    errors.push(`explorations.projectId "${bundle.explorations.projectId}" must match manifest project id "${projectId}". Fix: set projectId in each file under explorations/ to "${projectId}".`);
  }

  if (bundle.history.projectId !== projectId) {
    errors.push(`history.projectId "${bundle.history.projectId}" must match manifest project id "${projectId}". Fix: set projectId in each file under history/ to "${projectId}".`);
  }

  const boardIds = collectIds(errors, 'manifest.boards', bundle.manifest.boards, board => validateBoard(errors, board));
  if (!boardIds.has(bundle.manifest.defaultBoardId)) {
    errors.push(`manifest.defaultBoardId "${bundle.manifest.defaultBoardId}" does not match a board id. Fix: set defaultBoardId in manifest.json to one of these board ids: ${[...boardIds].join(', ') || 'none, so add a board first'}.`);
  }

  const framePresetIds = collectIds(errors, 'manifest.framePresets', bundle.manifest.framePresets, framePreset => validateFramePreset(errors, framePreset));
  validateTokenContract(errors, bundle.tokens);
  const tokenGroupIds = collectIds(errors, 'tokens.tokenGroups', bundle.tokens.tokenGroups, group => validateTokenGroup(errors, group));
  const primitiveIds = collectIds(errors, 'primitives.primitives', bundle.primitives.primitives, () => {});
  const tokenIds = collectTokenIds(bundle.tokens.tokenGroups);
  const componentIds = collectIds(errors, 'components.components', bundle.components.components, () => {});
  validateReusables(errors, bundle, tokenGroupIds, tokenIds);

  validateScreenContract(errors, bundle.screens);
  const pageIds = collectIds(errors, 'screens.pages', Array.isArray(bundle.screens.pages) ? bundle.screens.pages : [], () => {});
  const screenIds = collectIds(errors, 'screens.screens', bundle.screens.screens, screen => {
    validateScreen(errors, screen, framePresetIds, primitiveIds, componentIds);
    if (screen.page && !pageIds.has(screen.page)) {
      errors.push(`screen.${screen.id}.page "${screen.page}" is not declared. Fix: add it to screens.pages, or set page to a declared id${pageIds.size ? `: ${[...pageIds].map(id => `"${id}"`).join(', ')}` : ''}.`);
    }
  });
  validateScreenVersions(errors, bundle.screens.screens);
  validateExplorations(errors, bundle, screenIds, framePresetIds);
  validateScreenHistory(errors, bundle, screenIds, framePresetIds, primitiveIds, componentIds);
  const sectionIds = new Set(
    bundle.screens.screens.flatMap(screen => (screen.sections ?? []).map(section => `${screen.id}/${section.id}`))
  );

  for (const screen of bundle.screens.screens) {
    for (const section of screen.sections ?? []) {
      for (const dependency of section.uses ?? []) {
        validateDependency(errors, `screens.${screen.id}.sections.${section.id}.uses`, dependency, {
          tokenGroupIds,
          primitiveIds,
          componentIds,
          screenIds,
          sectionIds
        });
      }
    }
  }

  validatePrototypeHost(errors, bundle.manifest.prototypeHost);
  validateInspo(errors, bundle);
  validateBrand(errors, bundle, options.mode ?? 'baseline', options.fileExists ?? existsSync);
  validateBasePrimitiveContract(errors, bundle, options.mode ?? 'baseline');
  validatePrototypeContracts(errors, bundle, tokenIds, framePresetIds, options.fileExists ?? existsSync);
  if (designRulesCanRead(bundle)) validateFontFaces(errors, bundle);
  const styleErrors = collectDesignRuleErrors(bundle);
  if (designRulesCanRead(bundle)) styleErrors.push(...collectCandidateRuleErrors(bundle, new Set([...errors, ...styleErrors]), options.onCandidateFileLint));
  recordPrototypeSourceGraphValidation(errors, sourceGraphIssues());

  if ((options.mode ?? 'baseline') === 'strict') {
    validateStrictHandoffReadiness(errors, bundle);
  }

  return validationResult(errors, styleErrors);
}

function designRulesCanRead(bundle: BlueprintProjectBundle): boolean {
  const boundaries = [...bundle.primitives.primitives, ...bundle.components.components, ...bundle.screens.screens];
  return boundaries.every(boundary => typeof boundary.prototype === 'object' && boundary.prototype !== null);
}

/** The findings that the canvas marks, with the rules that keep each stylesheet in its boundary. */
function collectDesignRuleErrors(bundle: BlueprintProjectBundle): string[] {
  const errors: string[] = [];
  for (const id of primitivesOutsideSet(bundle.primitives.primitives.map(primitive => primitive.id))) {
    errors.push(primitiveOutsideSetMessage(id, BASE_PRIMITIVE_LOCK_REASON));
  }
  if (!designRulesCanRead(bundle)) return errors;
  const reported = new Set<string>();
  const reportOnce = (issue: LocalStyleValueIssue): void => {
    const key = `${issue.styleRef}\n${issue.property}\n${issue.value}`;
    if (reported.has(key)) return;
    reported.add(key);
    errors.push(localStyleValueError(issue));
  };
  lintLocalStyleValues(bundle).forEach(reportOnce);
  for (const issue of lintHandBuiltControls(bundle)) {
    errors.push(handBuiltControlError(issue));
  }
  for (const issue of lintColorContrast(bundle)) {
    errors.push(`token-group.${issue.groupId} ${contrastMessage(issue)}`);
  }
  for (const issue of collectStyleRuleIssues(bundle)) errors.push(styleRuleMessage(issue));
  validateFontFamilyTokens(errors, bundle);
  errors.push(...collectNamingErrors(bundle));
  return errors;
}

function validateInspo(errors: string[], bundle: BlueprintProjectBundle): void {
  if (!bundle.inspo) return;
  validateInspoContract(errors, bundle.inspo, bundle.manifest.project?.id);
  if (bundle.brand && !hasApprovedInspoDirection(bundle.inspo)) {
    errors.push('brand.json exists, but inspo.json has no approved direction. Fix: propose directions from the inspo notes and set status "approved" after the person agrees.');
  }
}

function recordInspoReadiness(items: ReadinessItem[], bundle: BlueprintProjectBundle): void {
  if (!bundle.inspo) return;
  const entries = Array.isArray(bundle.inspo.entries) ? bundle.inspo.entries : [];
  if (entries.length === 0) {
    items.push({
      path: 'inspo.entries',
      severity: 'pending',
      source: 'synthesized-missing',
      message: 'Inspo has no entries. Fix: ask the person for image links and what they like in each, then add them with the inspo tool.'
    });
  }
  const hasText = (text: unknown): boolean => typeof text === 'string' && text.trim().length > 0;
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    if (typeof entry.image === 'string' && !existsSync(path.resolve(bundle.sourceRoot, entry.image))) {
      items.push({
        path: `inspo.entry.${entry.id}.image`,
        severity: 'pending',
        source: 'declared-missing-artifact',
        message: `The cached image of inspo entry "${entry.id}" is missing. Fix: run the inspo tool with operation sync.`,
        artifactRef: entry.image,
        artifactExists: false
      });
    }
    if (!hasText(entry.note)) {
      items.push({
        path: `inspo.entry.${entry.id}.note`,
        severity: 'pending',
        source: 'synthesized-missing',
        message: `Inspo entry "${entry.id}" has no note. Fix: ask the person what they like or avoid in it, and save their words with the inspo tool.`
      });
    } else if (!hasText(entry.reading)) {
      items.push({
        path: `inspo.entry.${entry.id}.reading`,
        severity: 'pending',
        source: 'synthesized-missing',
        message: `Inspo entry "${entry.id}" has no reading. Fix: look at the image, then save what you take from it for its aspects.`
      });
    }
  }
  if (entries.some(entry => hasText(entry?.note)) && !hasApprovedInspoDirection(bundle.inspo)) {
    items.push({
      path: 'inspo.directions',
      severity: 'pending',
      source: 'synthesized-missing',
      message: 'Inspo has no approved direction. Fix: propose one direction for each aspect the notes name, and approve each after the person agrees.'
    });
  }
}

export function createReadinessReportWithSourceGraph(
  bundle: BlueprintProjectBundle,
  sourceGraphIssues: SourceGraphIssues
): ReadinessReport {
  const items: ReadinessItem[] = [];
  const prototypeSources = relativePrototypeSources(bundle);

  for (const sourceRef of prototypeSources) {
    if (!(sourceRef in bundle.prototypeSourceContents) && !(sourceRef in bundle.prototypeAssetContents)) {
      items.push({
        path: `prototypeSources.${sourceRef}`,
        severity: 'blocker',
        source: 'synthesized-missing',
        message: `Declared prototype source "${sourceRef}" does not exist or could not be loaded. Fix: add the file "${sourceRef}" to the project, or remove the ref that names it.`
      });
    }
  }
  recordPrototypeSourceGraphReadiness(items, sourceGraphIssues());
  recordInspoReadiness(items, bundle);
  if (!bundle.brand) {
    items.push({
      path: 'brand',
      severity: 'pending',
      source: 'synthesized-missing',
      message: 'No brand.json yet: declare the brand name, marks, voice, and usage so every layer has a brand to express.'
    });
  }

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
        message: `Prototype source has no data-blueprint-section="${sectionId}" marker, so the section cannot be addressed on the canvas. Fix: add data-blueprint-section="${sectionId}" to the root element of this section in ${screen.prototype.source}.`
      });
    }
  }

  for (const component of bundle.components.components ?? []) {
    if (component.prototypeOnly) {
      continue;
    }
    recordImplementationTargetReadiness(items, `component.${component.id}.implementationTargets`, component.implementationTargets);
    recordStyleEvidenceReadiness(
      items,
      bundle,
      `component.${component.id}.styleEvidence`,
      component.styleRefs,
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

function recordPrototypeSourceGraphValidation(errors: string[], issues: PrototypeSourceGraphIssue[]): void {
  for (const issue of issues) {
    errors.push(`Prototype source graph ${issue.boundaryId} state "${issue.state}" cannot compile: ${issue.message}`);
  }
}

function recordPrototypeSourceGraphReadiness(items: ReadinessItem[], issues: PrototypeSourceGraphIssue[]): void {
  for (const issue of issues) {
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
      message: `Production handoff is missing implementation target metadata. Fix: ${implementationTargetFix(label)}`
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
        message: `No explicit style evidence has been recorded for "${styleRef}". Fix: ${styleEvidenceFix(label, styleRef)}`
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
        message: `Style evidence is missing for "${styleRef}". Fix: ${styleEvidenceFix(label, styleRef)}`
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
          ? `Style evidence artifact for "${styleRef}" does not exist. Fix: add the artifact at "${artifactRef}", or set artifactRef of this style evidence to a file that exists.`
          : `Style evidence artifact for "${styleRef}" is not declared. Fix: set artifactRef of this style evidence in ${label} to the artifact path.`,
        artifactRef,
        artifactExists
      });
      continue;
    }

    items.push({
      path: label,
      severity: 'blocker',
      source: 'declared',
      message: `Style evidence for "${styleRef}" has unsupported status "${status}". Fix: set status of this style evidence in ${label} to "source", "linked-artifact-pending", or "unresolved".`
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
    errors.push(`framePreset.${framePreset.id}.type must be "mobile" or "desktop". Fix: set framePreset.${framePreset.id}.type to "mobile" or "desktop" in manifest.json.`);
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
  if (!Array.isArray(group.tokens)) {
    errors.push(`tokenGroup.${group.id}.tokens must be a list. Fix: write each token as { "id", "name", "type", "value", "description", "styleRef" }.`);
    return;
  }
  const tokenIds = new Set<string>();
  for (const token of group.tokens) {
    if (tokenIds.has(token?.id)) {
      errors.push(`tokenGroup.${group.id}.token.${token.id} is declared twice. Fix: keep one token per id in the group.`);
    }
    tokenIds.add(token?.id);
  }
}

function validateBrand(errors: string[], bundle: BlueprintProjectBundle, mode: ValidationMode, fileExists: (filePath: string) => boolean): void {
  const brand = bundle.brand;
  if (!brand) {
    if (mode === 'strict') {
      errors.push('brand.json is required for a strict handoff: declare the brand name, marks, and usage. Fix: add brand.json with schemaVersion, projectId, name, marks, and fonts.');
    }
    return;
  }
  if (brand.projectId !== bundle.manifest.project.id) {
    errors.push(`brand.projectId "${brand.projectId}" must match manifest project id "${bundle.manifest.project.id}". Fix: set projectId in brand.json to "${bundle.manifest.project.id}".`);
  }
  requireString(errors, 'brand.name', brand.name);
  if (brand.tagline !== undefined) {
    requireString(errors, 'brand.tagline', brand.tagline);
  }
  for (const [index, trait] of (brand.personality ?? []).entries()) {
    requireString(errors, `brand.personality.${index}.name`, trait.name);
    requireString(errors, `brand.personality.${index}.description`, trait.description);
  }
  if (brand.voice) {
    requireString(errors, 'brand.voice.summary', brand.voice.summary);
    requireStringList(errors, 'brand.voice.do', brand.voice.do);
    requireStringList(errors, 'brand.voice.dont', brand.voice.dont);
  }
  if (brand.usage) {
    requireStringList(errors, 'brand.usage.do', brand.usage.do);
    requireStringList(errors, 'brand.usage.dont', brand.usage.dont);
  }
  const colors = new Map(bundle.tokens.tokenGroups.flatMap(group => (group.tokens ?? [])
    .filter(token => token.type === 'color')
    .map(token => [`${group.id}.${token.id}`, token.value] as const)));
  collectIds(errors, 'brand.marks', brand.marks, mark => validateBrandMark(errors, bundle, mark, colors, mode));
  if (mode === 'strict' && (brand.marks ?? []).length === 0) {
    errors.push('brand.marks must declare at least one mark for a strict handoff. Fix: add one mark to marks in brand.json.');
  }
  validateBrandFonts(errors, brand, bundle.manifest.prototypeHost?.assetRoots ?? [], ref => fileExists(path.resolve(bundle.sourceRoot, ref)));
}

function validateBrandMark(
  errors: string[],
  bundle: BlueprintProjectBundle,
  mark: BrandMark,
  colors: Map<string, string>,
  mode: ValidationMode
): void {
  const label = `brand.mark.${mark.id}`;
  requireString(errors, 'brand.mark.id', mark.id);
  requireString(errors, `${label}.name`, mark.name);
  requireString(errors, `${label}.description`, mark.description);
  if (!BRAND_MARK_ROLES.includes(mark.role)) {
    errors.push(`${label}.role must be one of ${BRAND_MARK_ROLES.map(role => `"${role}"`).join(', ')}. Fix: set ${label}.role to one of those values.`);
  }
  requireString(errors, `${label}.source`, mark.source);
  if (typeof mark.source === 'string' && mark.source.length > 0) {
    const svg = bundle.prototypeSourceContents[mark.source];
    if (!mark.source.endsWith('.svg')) {
      errors.push(`${label}.source must be an .svg file. Fix: set ${label}.source to the path of an .svg file in the project.`);
    } else if (svg === undefined) {
      errors.push(`${label}.source "${mark.source}" does not exist or could not be loaded. Fix: add the file "${mark.source}" to the project, or set ${label}.source to a file that exists.`);
    } else {
      const issues = [...brandMarkSourceIssues(svg), ...(mode === 'strict' ? brandMarkHandoffIssues(svg) : [])];
      errors.push(...issues.map(issue => `${label}.source ${issue}`));
    }
  }

  collectIds(errors, `${label}.variants`, mark.variants, variant => {
    requireString(errors, `${label}.variant.id`, variant.id);
    requireString(errors, `${label}.variant.${variant.id}.name`, variant.name);
    for (const role of ['background', 'foreground', 'accent'] as const) {
      const ref = variant[role];
      if (role === 'accent' && ref === undefined) continue;
      if (typeof ref !== 'string' || !colors.has(ref)) {
        errors.push(`${label}.variant.${variant.id}.${role} "${ref}" must reference a declared color token, such as "color.background". Fix: set ${role} of this variant in brand.json to a color token in tokens.json, written as group.token.`);
      }
    }
    if (mode !== 'strict') return;
    const background = parseOpaqueColor(colors.get(variant.background) ?? '');
    for (const role of ['foreground', 'accent'] as const) {
      const ref = variant[role];
      const ink = ref ? parseOpaqueColor(colors.get(ref) ?? '') : undefined;
      const ratio = ink && background ? contrastRatio(ink, background) : undefined;
      if (ratio !== undefined && ratio < 3) {
        errors.push(`${label}.variant.${variant.id}.${role} ${ref} on ${variant.background} has contrast ${Math.floor(ratio * 100) / 100}:1; a mark needs at least 3:1. Fix: in brand.json, set ${role} or background of variant "${variant.id}" of ${label} to color tokens whose contrast reaches 3:1.`);
      }
    }
  });
  if (Array.isArray(mark.variants) && mark.variants.length === 0) {
    errors.push(`${label}.variants must declare at least one approved treatment. Fix: add one variant with id, name, background, and foreground to ${label}.variants.`);
  }

  requireObject(errors, `${label}.clearSpace`, mark.clearSpace);
  if (mark.clearSpace) {
    requirePositiveNumber(errors, `${label}.clearSpace.ratio`, mark.clearSpace.ratio);
    requireAxis(errors, `${label}.clearSpace.basis`, mark.clearSpace.basis);
  }
  requireObject(errors, `${label}.minimumSize`, mark.minimumSize);
  if (mark.minimumSize) {
    requirePositiveNumber(errors, `${label}.minimumSize.px`, mark.minimumSize.px);
    requireAxis(errors, `${label}.minimumSize.axis`, mark.minimumSize.axis);
  }
}

function requireStringList(errors: string[], label: string, value: unknown): void {
  requireArray(errors, label, value);
  for (const [index, item] of (Array.isArray(value) ? value : []).entries()) {
    requireString(errors, `${label}.${index}`, item);
  }
}

function requireAxis(errors: string[], label: string, value: unknown): void {
  if (value !== 'height' && value !== 'width') {
    errors.push(`${label} must be "height" or "width". Fix: set ${label} to "height" or "width".`);
  }
}

function validateScreen(
  errors: string[],
  screen: SavedScreen,
  framePresetIds: Set<string>,
  primitiveIds: Set<string>,
  componentIds: Set<string>,
  historySnapshot = false
): void {
  if (historySnapshot) {
    requireString(errors, 'screen.id', screen.id);
    requireString(errors, `screen.${screen.id}.name`, screen.name);
    requireArray(errors, `screen.${screen.id}.sections`, screen.sections);
  }
  if (screen.version !== undefined && (!Number.isSafeInteger(screen.version) || screen.version < 1)) {
    errors.push(`screen.${screen.id}.version must be a positive integer. Fix: set it to 1 or higher, or remove it when the route and name are unique.`);
  }
  if (!historySnapshot) {
    if (typeof screen.page !== 'string' || !screen.page) {
      errors.push(`screen.${screen.id}.page is missing. Fix: set it to the id of a page in screens.pages.`);
    }
    if ('flow' in screen) {
      errors.push(`screen.${screen.id}.flow was replaced by page. Fix: run the migrate tool, which declares a page for each flow, or declare the page in screens.pages and set page to its id.`);
    }
  }

  if (!framePresetIds.has(screen.framePresetId)) {
    errors.push(`screen.${screen.id}.framePresetId references missing frame preset "${String(screen.framePresetId)}". Fix: set it to a frame preset id in manifest.framePresets: ${[...framePresetIds].map(id => `"${id}"`).join(', ')}.`);
  }

  collectIds(errors, `screen.${screen.id}.sections`, Array.isArray(screen.sections) ? screen.sections : [], section => {
    if (historySnapshot) {
      requireString(errors, `screen.${screen.id}.section.id`, section.id);
      requireString(errors, `screen.${screen.id}.section.${section.id}.name`, section.name);
      requireArray(errors, `screen.${screen.id}.section.${section.id}.uses`, section.uses);
    }

    for (const dependency of historySnapshot && Array.isArray(section.uses) ? section.uses : []) {
      if (dependency.kind === 'primitive' && !primitiveIds.has(dependency.id)) {
        errors.push(`screen.${screen.id}.section.${section.id}.uses references missing primitive "${dependency.id}". Fix: use a primitive id from primitives.json, or remove the use.`);
      }
      if (dependency.kind === 'component' && !componentIds.has(dependency.id)) {
        errors.push(`screen.${screen.id}.section.${section.id}.uses references missing component "${dependency.id}". Fix: use a component id from components.json, or remove the use.`);
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
        errors.push(`screen.${first.id}.version must be omitted because ${identity} has only one screen. Fix: remove version from screen "${first.id}" in screens.json.`);
      }
      continue;
    }

    const unversioned = group.filter(screen => screen.version === undefined);
    if (unversioned.length > 0) {
      errors.push(
        `Screens sharing ${identity} must each declare a unique consecutive version starting at 1; missing on ${unversioned.map(screen => `"${screen.id}"`).join(', ')}. Fix: set version on each of these screens in screens.json, counting from 1.`
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
        `Screens sharing ${identity} must use unique consecutive versions ${expected.join(', ')}; received ${versions.join(', ')}. Fix: set the versions of these screens in screens.json to ${expected.join(', ')}.`
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
  componentIds: Set<string>
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
      componentIds
    );
    const key = `${entry.screenId}\u0000${entry.version}`;
    if (keys.has(key)) {
      errors.push(`History for screen "${entry.screenId}" contains duplicate V${entry.version}. Fix: keep one record of this version, and delete the other from history/.`);
    }
    keys.add(key);
    versionsByScreen.set(entry.screenId, [...(versionsByScreen.get(entry.screenId) ?? []), entry.version]);
  }
  for (const [screenId, versions] of versionsByScreen) {
    const ordered = [...versions].sort((left, right) => left - right);
    const expected = Array.from({ length: ordered.length }, (_, index) => index + 1);
    if (ordered.some((version, index) => version !== expected[index])) {
      errors.push(
        `History for screen "${screenId}" must use consecutive immutable versions ${expected.join(', ')}; received ${ordered.join(', ')}. Fix: restore the missing records under history/ from git, so that the versions run ${expected.join(', ')}.`
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
  componentIds: Set<string>
): void {
  const label = `history.${entry.screenId}.v${entry.version}`;
  requireString(errors, `${label}.screenId`, entry.screenId);
  if (!Number.isSafeInteger(entry.version) || entry.version < 1) {
    errors.push(`${label}.version must be a positive integer. Fix: set version in this history record to a whole number of 1 or more.`);
  }
  requireString(errors, `${label}.state`, entry.state);
  requireString(errors, `${label}.framePresetId`, entry.framePresetId);
  if (!screenIds.has(entry.screenId)) {
    errors.push(`${label} references missing canonical screen "${entry.screenId}". Fix: restore screen "${entry.screenId}" in screens.json, or delete this history record.`);
  }
  if (!framePresetIds.has(entry.framePresetId)) {
    errors.push(`${label} references missing frame preset "${entry.framePresetId}". Fix: add "${entry.framePresetId}" to framePresets in manifest.json, or set framePresetId in this record to a declared preset.`);
  }
  requireObject(errors, `${label}.screen`, entry.screen);
  if (entry.screen?.id !== entry.screenId) {
    errors.push(`${label}.screen.id must match canonical screen "${entry.screenId}". Fix: set screen.id in this history record to "${entry.screenId}".`);
  }
  if (entry.screen) {
    validateScreen(errors, entry.screen, framePresetIds, primitiveIds, componentIds, true);
  }
  const prototype = entry.screen?.prototype;
  if (!prototype) {
    errors.push(`${label}.screen must retain a governed prototype source. Fix: restore this history record from git.`);
    return;
  }
  const hasReviewPair = prototype.reviewConditions?.some(condition => (
    condition.state === entry.state && condition.framePresetId === entry.framePresetId
  ));
  if (!hasReviewPair) {
    errors.push(`${label} state and frame preset must remain a declared historical review condition. Fix: add this state and frame preset to screen.prototype.reviewConditions in this record, or restore the record from git.`);
  }
  const ownedMarker = `.history-${storageRecordSegment(entry.screenId)}-v${entry.version}`;
  for (const sourceRef of [prototype.source, ...(prototype.styles ?? [])]) {
    const extension = path.posix.extname(sourceRef.replace(/\\/g, '/'));
    const withoutExtension = extension ? sourceRef.slice(0, -extension.length) : sourceRef;
    if (!isSafeRelativeRef(sourceRef) || !withoutExtension.endsWith(ownedMarker)) {
      errors.push(`${label} source "${sourceRef}" must carry immutable marker "${ownedMarker}". Fix: rename the file so that its name ends with "${ownedMarker}" before the extension, and update this ref.`);
      continue;
    }
    const content = bundle.prototypeSourceContents[sourceRef];
    if (typeof content !== 'string' || content.length === 0) {
      errors.push(`${label} source "${sourceRef}" is missing or empty. Fix: restore "${sourceRef}" from git.`);
    }
  }
  for (const assetRef of prototype.assetRefs ?? []) {
    if (!isSafeRelativeRef(assetRef) || !isControlledAssetRef(bundle, assetRef)) {
      errors.push(`${label} asset "${assetRef}" must stay inside a declared prototypeHost.assetRoots directory. ${assetRootsFix(bundle, assetRef)}`);
    } else if (!(assetRef in bundle.prototypeAssetContents)) {
      errors.push(`${label} asset "${assetRef}" is missing. Fix: restore "${assetRef}" from git, or remove it from assetRefs in this record.`);
    }
  }
  if (entry.replacedBy?.type === 'exploration-candidate') {
    const replacement = entry.replacedBy;
    const exploration = bundle.explorations.explorations.find(candidate => candidate.id === replacement.explorationId);
    if (!exploration?.candidates.some(candidate => candidate.id === replacement.candidateId)) {
      errors.push(`${label}.replacedBy must reference a saved exploration candidate. Fix: set replacedBy.explorationId and replacedBy.candidateId in this record to a saved candidate, or restore the record from git.`);
    }
  } else if (entry.replacedBy?.type === 'history-restore') {
    if (!Number.isSafeInteger(entry.replacedBy.version) || entry.replacedBy.version < 1) {
      errors.push(`${label}.replacedBy.version must be a positive integer. Fix: set replacedBy.version in this record to a whole number of 1 or more.`);
    }
  } else {
    errors.push(`${label}.replacedBy must describe an exploration candidate or history restoration. Fix: set replacedBy.type in this record to "exploration-candidate" or "history-restore", with the fields of that type.`);
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
        `Active explorations "${existing}" and "${exploration.id}" target the same canonical screen, state, and frame preset. Fix: archive or promote one of these explorations.`
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
    errors.push(`${label}.id must use 1-64 lowercase letters, numbers, or internal hyphens. Fix: rename this exploration in that form, such as "option-a", and rename its record file to match.`);
  }
  requireSafeHumanLabel(errors, `${label}.title`, exploration.title);
  requireSafeHumanLabel(errors, `${label}.intent`, exploration.intent);
  if (!['active', 'archived', 'promoted'].includes(String(exploration.lifecycle))) {
    errors.push(`${label}.lifecycle must be "active", "archived", or "promoted". Fix: set ${label}.lifecycle to "active", "archived", or "promoted".`);
  }
  requireObject(errors, `${label}.target`, exploration.target);
  requireString(errors, `${label}.target.screenId`, exploration.target?.screenId);
  requireString(errors, `${label}.target.state`, exploration.target?.state);
  requireString(errors, `${label}.target.framePresetId`, exploration.target?.framePresetId);
  requireString(errors, `${label}.target.baseDigest`, exploration.target?.baseDigest);
  if (!/^[a-f0-9]{64}$/.test(exploration.target?.baseDigest ?? '')) {
    errors.push(`${label}.target.baseDigest must be a lowercase SHA-256 digest. Fix: restore this exploration record from git, because Blueprint writes this digest.`);
  }
  if (!screenIds.has(exploration.target?.screenId)) {
    errors.push(`${label}.target references missing canonical screen "${exploration.target?.screenId}". Fix: restore screen "${exploration.target?.screenId}" in screens.json, or delete this exploration record and its prototype files.`);
  }
  if (!framePresetIds.has(exploration.target?.framePresetId)) {
    errors.push(`${label}.target references missing frame preset "${exploration.target?.framePresetId}". Fix: add "${exploration.target?.framePresetId}" to framePresets in manifest.json, or delete this exploration record and its prototype files.`);
  }

  const baseline = exploration.target?.baseline;
  requireObject(errors, `${label}.target.baseline`, baseline);
  requireObject(errors, `${label}.target.baseline.screen`, baseline?.screen);
  requireObject(errors, `${label}.target.baseline.prototype`, baseline?.prototype);
  if (baseline?.screen?.id !== exploration.target?.screenId) {
    errors.push(`${label}.target.baseline.screen.id must match target screen "${exploration.target?.screenId}". Fix: set target.baseline.screen.id in this record to "${exploration.target?.screenId}".`);
  }
  const baselineScreenPrototype = baseline?.screen?.prototype;
  const hasReviewPair = baselineScreenPrototype?.reviewConditions?.some(condition => (
    condition.state === exploration.target?.state &&
    condition.framePresetId === exploration.target?.framePresetId
  ));
  if (!hasReviewPair) {
    errors.push(
      `${label}.target state "${exploration.target?.state}" and frame preset "${exploration.target?.framePresetId}" are not a declared baseline review condition. Fix: restore this exploration record from git, or delete it and create a new exploration.`
    );
  }
  if (baselineScreenPrototype && !(baselineScreenPrototype.states ?? []).includes(exploration.target?.state)) {
    errors.push(`${label}.target state "${exploration.target?.state}" is not declared by the baseline prototype. Fix: restore this exploration record from git, or delete it and create a new exploration.`);
  }
  if (baseline?.prototype) {
    validateExplorationPrototype(errors, bundle, exploration, 'baseline', baseline.prototype);
  }
  try {
    const digest = computeExplorationBaselineDigest(bundle, exploration.id);
    if (digest !== exploration.target?.baseDigest) {
      errors.push(`${label}.target.baseDigest is stale for the persisted baseline sources. Fix: restore the baseline files of this exploration from git, or delete it and create a new exploration.`);
    }
  } catch (error) {
    errors.push(`${label}.target baseline cannot be digested: ${error instanceof Error ? error.message : String(error)}`);
  }

  requireArray(errors, `${label}.candidates`, exploration.candidates);
  if (!Array.isArray(exploration.candidates) || exploration.candidates.length < 2 || exploration.candidates.length > 5) {
    errors.push(`${label}.candidates must contain between 2 and 5 candidates. Fix: change the candidates list in this record so that it holds 2 to 5 candidates.`);
  }
  const candidateIds = new Set<string>();
  const candidateLabels = new Set<string>();
  for (const candidate of exploration.candidates ?? []) {
    requireString(errors, `${label}.candidate.id`, candidate.id);
    if (!isSafeExplorationId(candidate.id)) {
      errors.push(`${label}.candidate id "${candidate.id}" must use 1-64 lowercase letters, numbers, or internal hyphens. Fix: rename this candidate in that form, such as "option-a".`);
    }
    if (candidateIds.has(candidate.id)) {
      errors.push(`${label} has duplicate candidate id "${candidate.id}". Fix: give each candidate in this exploration its own id.`);
    }
    candidateIds.add(candidate.id);
    requireSafeHumanLabel(errors, `${label}.candidate.${candidate.id}.label`, candidate.label);
    const normalizedLabel = candidate.label?.trim().toLocaleLowerCase();
    if (candidateLabels.has(normalizedLabel)) {
      errors.push(`${label} has duplicate candidate label "${candidate.label}". Fix: give each candidate in this exploration its own label.`);
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
      errors.push(`${label}.selectedCandidateId must reference a candidate when lifecycle is "promoted". Fix: set selectedCandidateId in this record to one of these ids: ${[...candidateIds].join(', ')}.`);
    }
    if (!promotedScreen || !screenIds.has(promotedScreen)) {
      errors.push(`${label}.promotedScreenId must reference a canonical screen when lifecycle is "promoted". Fix: set promotedScreenId in this record to the id of the screen that this exploration became.`);
    }
  } else if (selected !== undefined || promotedScreen !== undefined) {
    errors.push(`${label} may declare selectedCandidateId and promotedScreenId only when lifecycle is "promoted". Fix: remove both fields from this record, or set lifecycle to "promoted".`);
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
      errors.push(`${label} source "${sourceRef}" escapes or points outside the Blueprint source root. Fix: set it to a relative path inside the project, with no ".." segment.`);
      continue;
    }
    if (!hasExplorationSourceMarker(sourceRef, exploration.id, ownerId)) {
      errors.push(`${label} source "${sourceRef}" is not owned by this screen-local exploration entry. Fix: move the file under ${explorationSourceRoot(exploration.id, ownerId)}, and update this ref.`);
    }
    const content = bundle.prototypeSourceContents[sourceRef];
    if (typeof content !== 'string' || content.length === 0) {
      errors.push(`${label} source "${sourceRef}" is missing or empty. Fix: restore "${sourceRef}" from git, or write its content.`);
    }
  }
  for (const assetRef of prototype.assetRefs ?? []) {
    if (!isSafeRelativeRef(assetRef)) {
      errors.push(`${label} asset "${assetRef}" escapes or points outside the Blueprint source root. Fix: set it to a relative path inside the project, with no ".." segment.`);
      continue;
    }
    if (!isControlledAssetRef(bundle, assetRef)) {
      errors.push(`${label} asset "${assetRef}" must stay inside a declared prototypeHost.assetRoots directory. ${assetRootsFix(bundle, assetRef)}`);
    }
    if (!(assetRef in bundle.prototypeAssetContents)) {
      errors.push(`${label} asset "${assetRef}" is missing. Fix: restore "${assetRef}" from git, or remove it from assetRefs in this record.`);
    }
  }
}

function explorationSourceRoot(explorationId: string, ownerId: string): string {
  return ownerId === 'baseline'
    ? `prototype/explorations/${explorationId}/baseline/`
    : `prototype/explorations/${explorationId}/candidates/${ownerId}/`;
}

function hasExplorationSourceMarker(sourceRef: string, explorationId: string, ownerId: string): boolean {
  const normalized = sourceRef.replace(/\\/g, '/');
  if (normalized.startsWith(explorationSourceRoot(explorationId, ownerId))) {
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
    errors.push(`${label} must be at most 160 characters and contain no control characters. Fix: rewrite ${label} as one line of 160 characters or fewer.`);
  }
}

function validateDependency(
  errors: string[],
  path: string,
  dependency: BoundaryDependency,
  known: {
    tokenGroupIds: Set<string>;
    primitiveIds: Set<string>;
    componentIds: Set<string>;
    screenIds: Set<string>;
    sectionIds: Set<string>;
  }
): void {
  const map = {
    'token-group': known.tokenGroupIds,
    primitive: known.primitiveIds,
    component: known.componentIds,
    screen: known.screenIds,
    section: known.sectionIds
  } as const;

  if (!(dependency.kind in map)) {
    errors.push(`${path} has unsupported dependency kind "${String(dependency.kind)}". Fix: set kind to one of ${Object.keys(map).map(kind => `"${kind}"`).join(', ')}.`);
    return;
  }
  if (!map[dependency.kind].has(dependency.id)) {
    errors.push(`${path} references missing ${dependency.kind} "${String(dependency.id)}". Fix: use the id of a ${dependency.kind} the project declares, or remove the use.`);
  }
}

function validateBasePrimitiveContract(errors: string[], bundle: BlueprintProjectBundle, mode: ValidationMode): void {
  const primitivesById = new Map(bundle.primitives.primitives.map(primitive => [primitive.id, primitive]));
  for (const base of BASE_PRIMITIVE_CONTRACT) {
    const primitive = primitivesById.get(base.id);
    if (!primitive && (base.enforcement !== 'strict' || mode === 'strict')) {
      errors.push(`primitives is missing locked base primitive "${base.id}". Fix: restore it from the Blueprint starter's primitives.json and its prototype files. ${BASE_PRIMITIVE_LOCK_REASON}`);
    }
  }
}

function validatePrototypeContracts(
  errors: string[],
  bundle: BlueprintProjectBundle,
  tokenIds: Set<string>,
  framePresetIds: Set<string>,
  fileExists: (filePath: string) => boolean
): void {
  for (const [kind, reusables] of [['primitive', bundle.primitives.primitives], ['component', bundle.components.components]] as const) {
    for (const reusable of reusables) {
      if (!reusable.prototype || typeof reusable.prototype !== 'object') {
        continue;
      }
      validatePrototypeSource(errors, bundle, fileExists, `${kind}.${reusable.id}.prototype`, reusable.prototype);
    }
  }

  for (const screen of bundle.screens.screens) {
    if (!screen.prototype) {
      errors.push(`screen.${screen.id}.prototype must declare a browser-native HTML/CSS source. Fix: add prototype with source, styles, states, assetRefs, and reviewConditions to this screen in screens.json.`);
      continue;
    }
    validatePrototypeSource(errors, bundle, fileExists, `screen.${screen.id}.prototype`, screen.prototype);
    requireArray(errors, `screen.${screen.id}.prototype.assetRefs`, screen.prototype.assetRefs);
    requireArray(errors, `screen.${screen.id}.prototype.reviewConditions`, screen.prototype.reviewConditions);
    for (const assetRef of screen.prototype.assetRefs ?? []) {
      validatePrototypeFileRef(errors, bundle, fileExists, `screen.${screen.id}.prototype.assetRef`, assetRef);
      if (!isControlledAssetRef(bundle, assetRef)) {
        errors.push(`screen.${screen.id}.prototype asset "${assetRef}" must stay inside a declared prototypeHost.assetRoots directory. ${assetRootsFix(bundle, assetRef)}`);
      }
    }
    collectIds(errors, `screen.${screen.id}.prototype.reviewConditions`, screen.prototype.reviewConditions, condition => {
      requireString(errors, `screen.${screen.id}.prototype.reviewCondition.id`, condition.id);
      requireString(errors, `screen.${screen.id}.prototype.reviewCondition.${condition.id}.framePresetId`, condition.framePresetId);
      requireString(errors, `screen.${screen.id}.prototype.reviewCondition.${condition.id}.state`, condition.state);
      if (!framePresetIds.has(condition.framePresetId)) {
        errors.push(`screen.${screen.id}.prototype.reviewCondition.${condition.id} references missing frame preset "${condition.framePresetId}". Fix: set framePresetId of this review condition to one of these presets: ${[...framePresetIds].join(', ')}.`);
      }
      if (!screen.prototype?.states.includes(condition.state)) {
        errors.push(`screen.${screen.id}.prototype.reviewCondition.${condition.id} references undeclared state "${condition.state}". Fix: add "${condition.state}" to prototype.states of this screen, or set state of this review condition to one of ${screen.prototype?.states.join(', ')}.`);
      }
    });
    const declaredUses = screen.sections.flatMap(section => section.uses);
    validateRenderedUses(errors, `screen.${screen.id}.prototype.renderedUses`, declaredUses, screen.prototype.renderedUses);
  }
}

function validatePrototypeSource(
  errors: string[],
  bundle: BlueprintProjectBundle,
  fileExists: (filePath: string) => boolean,
  label: string,
  prototype: Pick<PrototypeSource, 'source' | 'styles' | 'localValueExceptions'> & { states?: string[] }
): void {
  requireString(errors, `${label}.source`, prototype.source);
  requireArray(errors, `${label}.styles`, prototype.styles);
  if (label.startsWith('screen.')) {
    requireArray(errors, `${label}.states`, prototype.states);
  }
  validatePrototypeFileRef(errors, bundle, fileExists, `${label}.source`, prototype.source);
  for (const styleRef of prototype.styles ?? []) {
    validatePrototypeFileRef(errors, bundle, fileExists, `${label}.style`, styleRef);
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
  fileExists: (filePath: string) => boolean,
  label: string,
  sourceRef: string
): void {
  if (!isSafeRelativeRef(sourceRef)) {
    errors.push(`${label} "${sourceRef}" escapes or points outside the Blueprint source root. Fix: set it to a relative path inside the project, with no ".." segment.`);
    return;
  }
  if (!fileExists(path.resolve(bundle.sourceRoot, sourceRef))) {
    errors.push(`${label} "${sourceRef}" does not exist. Fix: add the file "${sourceRef}" to the project, or change this ref to a file that exists.`);
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
    errors.push(`${label} must exactly match declared reusable dependencies. Declared ${JSON.stringify(declared)}; rendered ${JSON.stringify(rendered)}. Fix: change renderedUses or the declared uses so that both lists hold the same entries.`);
  }
}

function validatePrototypeHost(errors: string[], prototypeHost: BlueprintProjectBundle['manifest']['prototypeHost'] | undefined): void {
  if (typeof prototypeHost !== 'object' || prototypeHost === null) {
    errors.push('manifest.prototypeHost must declare assetRoots, network "deny", and scripts "none". Fix: set prototypeHost in manifest.json to { "assetRoots": ["prototype/assets"], "network": "deny", "scripts": "none" }.');
    return;
  }
  requireArray(errors, 'manifest.prototypeHost.assetRoots', prototypeHost.assetRoots);
  if (prototypeHost.network !== 'deny') {
    errors.push('manifest.prototypeHost.network must be "deny". Fix: set prototypeHost.network in manifest.json to "deny".');
  }
  if (prototypeHost.scripts !== 'none') {
    errors.push('manifest.prototypeHost.scripts must be "none". Fix: set prototypeHost.scripts in manifest.json to "none".');
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

function validateStrictHandoffReadiness(errors: string[], bundle: BlueprintProjectBundle): void {
  if (bundle.manifest.handoffContractVersion !== supportedHandoffContractVersion) {
    if (!bundle.manifest.handoffContractVersion) {
      errors.push(`manifest.handoffContractVersion must be "${supportedHandoffContractVersion}" for strict handoff readiness. Fix: set handoffContractVersion in manifest.json to "${supportedHandoffContractVersion}".`);
    } else {
      errors.push(`Unsupported handoff contract version "${bundle.manifest.handoffContractVersion}". Expected "${supportedHandoffContractVersion}". Fix: set handoffContractVersion in manifest.json to "${supportedHandoffContractVersion}".`);
    }
  }

  for (const primitive of bundle.primitives.primitives ?? []) {
    if (primitive.prototypeOnly) {
      continue;
    }

    validateImplementationTargets(errors, `primitive.${primitive.id}.implementationTargets`, primitive.implementationTargets);
    validateStyleEvidence(errors, `primitive.${primitive.id}.styleEvidence`, primitive.styleRefs, primitive.styleEvidence);
  }

  for (const component of bundle.components.components ?? []) {
    if (component.prototypeOnly) {
      continue;
    }

    validateImplementationTargets(errors, `component.${component.id}.implementationTargets`, component.implementationTargets);
    validateStyleEvidence(errors, `component.${component.id}.styleEvidence`, component.styleRefs, component.styleEvidence);
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
      errors.push(`screen.${screen.id}.section.${sectionId} needs a data-blueprint-section="${sectionId}" marker in its prototype source for strict handoff readiness. Fix: add data-blueprint-section="${sectionId}" to the root element of this section in ${screen.prototype.source}.`);
    }
  }
}

function validateProductionRelationship(errors: string[], label: string, relationship: ProductionRelationship | undefined): void {
  if (!relationship) {
    errors.push(`${label} is required for strict handoff readiness. Fix: add ${label} with kind and notes, or set prototypeOnly to true on this screen.`);
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
    errors.push(`${label}.targetScreenId is required for ${relationship.kind}. Fix: set ${label}.targetScreenId to the id of the existing screen.`);
  }
}

function validateImplementationTargets(
  errors: string[],
  label: string,
  targets: ImplementationTarget[] | undefined
): void {
  if (!Array.isArray(targets) || targets.length === 0) {
    errors.push(`${label} must include at least one target for strict handoff readiness. Fix: ${implementationTargetFix(label)}`);
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
      errors.push(`${item}.unresolvedDecisions must be empty for strict handoff readiness. Fix: settle each decision with the person, record the result in this target, and set ${item}.unresolvedDecisions to [].`);
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
    errors.push(`${label} must include explicit evidence for ${refs.length} style refs. Fix: write ${label} as a list with one entry for each of these style refs: ${refs.join(', ')}.`);
    return;
  }

  const byRef = new Map(evidence.map(item => [item.styleRef, item]));
  for (const styleRef of refs) {
    const item = byRef.get(styleRef);
    if (!item) {
      errors.push(`${label} is missing evidence for style ref "${styleRef}". Fix: ${styleEvidenceFix(label, styleRef)}`);
      continue;
    }
    if (item.status !== 'source' && item.status !== 'linked-artifact-pending' && item.status !== 'unresolved') {
      errors.push(`${label}.${styleRef}.status "${String(item.status)}" is not supported. Fix: set this status to "source", "linked-artifact-pending", or "unresolved".`);
    }
    if (item.status === 'source') {
      requireString(errors, `${label}.${styleRef}.sourceAnchor`, item.sourceAnchor);
    }
    if (item.status === 'linked-artifact-pending') {
      requireString(errors, `${label}.${styleRef}.artifactRef`, item.artifactRef);
    }
    if (item.status === 'unresolved') {
      errors.push(`${label}.${styleRef} style evidence is unresolved. Fix: set this status to "source" with sourceAnchor, or to "linked-artifact-pending" with artifactRef.`);
    }
  }
}

function validateCompositionBindings(errors: string[], screen: ScreenDefinition, section: ScreenSection): void {
  for (const dependency of section.uses ?? []) {
    const label = `screen.${screen.id}.section.${section.id}.uses.${dependency.kind}.${dependency.id}.binding`;
    if (!dependency.binding) {
      errors.push(`${label} is required for strict handoff readiness. Fix: add "binding" to the ${dependency.kind} "${dependency.id}" use in section "${section.id}" of screen "${screen.id}" in screens.json. Set "slot" and one of state, variant, size, prop, copy, data, layout, or accessibility in it.`);
      continue;
    }

    requireString(errors, `${label}.slot`, dependency.binding.slot);
    const hasBindingDetail = [
      dependency.binding.state,
      dependency.binding.variant,
      dependency.binding.size,
      dependency.binding.prop,
      dependency.binding.copy,
      dependency.binding.data,
      dependency.binding.layout,
      dependency.binding.accessibility
    ].some(value => typeof value === 'string' && value.length > 0);

    if (!hasBindingDetail) {
      errors.push(`${label} must describe at least one state, variant, size, prop, copy, data, layout, or accessibility binding. Fix: set one of those fields on ${label}.`);
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
      errors.push(`Duplicate id "${item.id}" in ${label}. Fix: give each entry its own id.`);
    }
    ids.add(item.id);
  }

  return ids;
}

function assetRootsFix(bundle: BlueprintProjectBundle, assetRef: string): string {
  const roots = bundle.manifest.prototypeHost?.assetRoots;
  const destination = Array.isArray(roots) && roots.length > 0 ? roots.map(root => `"${root}"`).join(' or ') : 'a prototypeHost.assetRoots directory';
  return `Fix: move "${assetRef}" into ${destination}, or add its directory to prototypeHost.assetRoots in manifest.json.`;
}

function boundaryFile(label: string): string {
  if (label.startsWith('primitive.')) return 'primitives.json';
  return label.startsWith('component.') ? 'components.json' : 'screens.json';
}

function implementationTargetFix(label: string): string {
  return `add one target to ${label} in ${boundaryFile(label)} with platform, framework, candidatePath, symbolName, operationIntent, propMapping, stateMapping, tokenAdapter, testPaths, storyPaths, and unresolvedDecisions. Or set prototypeOnly to true on ${label.replace(/\.implementationTargets$/, '')}.`;
}

function styleEvidenceFix(label: string, styleRef: string): string {
  return `add { "styleRef": "${styleRef}", "status": "source", "sourceAnchor": "<stylesheet path>" } to ${label} in ${boundaryFile(label)}.`;
}

function requireString(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${label} must be a non-empty string. Fix: set ${label} to a non-empty string.`);
  }
}

function requireNumber(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label} must be a finite number. Fix: set ${label} to a number.`);
  }
}

function requirePositiveNumber(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`${label} must be a positive number. Fix: set ${label} to a number above 0.`);
  }
}

function requireArray(errors: string[], label: string, value: unknown): void {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array. Fix: write ${label} as a JSON array.`);
  }
}

function requireObject(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${label} must be an object. Fix: write ${label} as a JSON object.`);
  }
}

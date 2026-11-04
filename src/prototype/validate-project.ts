import {
  createReadinessReportWithSourceGraph,
  validateProjectWithSourceGraph
} from '../core/validate';
import type {
  BlueprintProjectBundle,
  PrototypeSourceGraphIssue,
  ReadinessReport,
  ValidationOptions,
  ValidationResult
} from '../core/types';
import { inspectPrototypeSourceGraph } from './compiler';

type SourceGraphCheck = (bundle: BlueprintProjectBundle) => PrototypeSourceGraphIssue[];

export function validateProject(
  bundle: BlueprintProjectBundle,
  options: ValidationOptions = {},
  inspect: SourceGraphCheck = inspectPrototypeSourceGraph
): ValidationResult {
  return validateProjectWithSourceGraph(bundle, options, () => inspect(bundle));
}

export function createReadinessReport(bundle: BlueprintProjectBundle): ReadinessReport {
  return createReadinessReportWithSourceGraph(bundle, () => inspectPrototypeSourceGraph(bundle));
}

export function validateProjectReadiness(
  bundle: BlueprintProjectBundle,
  inspect: SourceGraphCheck = inspectPrototypeSourceGraph,
  knownBaseline?: ValidationResult
): { baseline: ValidationResult; readiness: ReadinessReport } {
  let issues: PrototypeSourceGraphIssue[] | undefined;
  const sourceGraphIssues = (): PrototypeSourceGraphIssue[] => issues ??= inspect(bundle);
  return {
    baseline: knownBaseline ?? validateProjectWithSourceGraph(bundle, {}, sourceGraphIssues),
    readiness: createReadinessReportWithSourceGraph(bundle, sourceGraphIssues)
  };
}

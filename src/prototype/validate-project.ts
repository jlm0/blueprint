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

export function validateProject(bundle: BlueprintProjectBundle, options: ValidationOptions = {}): ValidationResult {
  return validateProjectWithSourceGraph(bundle, options, () => inspectPrototypeSourceGraph(bundle));
}

export function createReadinessReport(bundle: BlueprintProjectBundle): ReadinessReport {
  return createReadinessReportWithSourceGraph(bundle, () => inspectPrototypeSourceGraph(bundle));
}

export function validateProjectReadiness(
  bundle: BlueprintProjectBundle,
  inspect: (bundle: BlueprintProjectBundle) => PrototypeSourceGraphIssue[] = inspectPrototypeSourceGraph
): { baseline: ValidationResult; readiness: ReadinessReport } {
  let issues: PrototypeSourceGraphIssue[] | undefined;
  const sourceGraphIssues = (): PrototypeSourceGraphIssue[] => issues ??= inspect(bundle);
  return {
    baseline: validateProjectWithSourceGraph(bundle, {}, sourceGraphIssues),
    readiness: createReadinessReportWithSourceGraph(bundle, sourceGraphIssues)
  };
}

import { lintSourceControls } from './control-lint';
import { handBuiltControlError, localStyleValueError } from './findings';
import { prototypeFileCopies } from './exploration';
import { validateStylesheetFontFaces } from './font-rules';
import { lintStylesheetValues, readLengthTokens } from './style-lint';
import {
  collectExceptionIssues,
  collectSourceIssues,
  collectStylesheetIssues,
  createStyleContext,
  ownersAfterCopy,
  placementKey,
  styleRuleMessage,
  withScreenFiles,
  type Boundary,
  type StyleContext
} from './style-rules';
import type { BlueprintProjectBundle, PrototypeAsset } from './types';

function sourceErrors(context: StyleContext, screen: Boundary, primitiveIds: ReadonlySet<string>): string[] {
  const source = context.bundle.prototypeSourceContents[screen.source];
  return [
    ...lintSourceControls(screen.label, screen.source, source ?? '', primitiveIds).map(handBuiltControlError),
    ...collectSourceIssues(context, screen).map(styleRuleMessage)
  ];
}

function stylesheetErrors(context: StyleContext, styleRef: string, owners: Boundary[], lengthTokens: ReadonlyMap<string, string>): string[] {
  const css = context.bundle.prototypeSourceContents[styleRef];
  if (css === undefined) return [];
  const values = new Map<string, string>();
  const exceptionLists = new Set<string>();
  for (const owner of owners) {
    const exceptionList = JSON.stringify(owner.exceptions);
    if (exceptionLists.has(exceptionList)) continue;
    exceptionLists.add(exceptionList);
    for (const issue of lintStylesheetValues(owner.label, styleRef, css, owner.exceptions, lengthTokens)) {
      const key = `${issue.property}\n${issue.value}`;
      if (!values.has(key)) values.set(key, localStyleValueError(issue));
    }
  }
  const errors = [...values.values()];
  if (context.bundle.brand) validateStylesheetFontFaces(errors, context.bundle.brand, styleRef, css);
  return [...errors, ...collectStylesheetIssues(context, styleRef, owners).map(styleRuleMessage)];
}

/**
 * Each error that a candidate of an active exploration gains, so that validate agrees with `promote`. Each file gets one rule pass
 * in one validation, and each candidate that names the file reads that result. A sheet gets a second pass only for a source that
 * gives the reach checks other input. A rule that reads no candidate file reports in the canonical pass, so it does not run here.
 */
export function collectCandidateRuleErrors(
  bundle: BlueprintProjectBundle<PrototypeAsset>,
  canonicalErrors: ReadonlySet<string>,
  onFileLint: (file: string) => void = () => {}
): string[] {
  const active = (bundle.explorations?.explorations ?? []).filter(exploration => exploration.lifecycle === 'active' && Array.isArray(exploration.candidates));
  if (!active.some(exploration => exploration.candidates.length > 0)) return [];
  const context = createStyleContext(bundle);
  const lengthTokens = readLengthTokens(bundle);
  const primitiveIds = new Set(bundle.primitives.primitives.map(primitive => primitive.id));
  const passes = new Map<string, readonly string[]>();
  const lintOnce = (key: string, file: string, lint: () => string[]): readonly string[] => {
    const known = passes.get(key);
    if (known) return known;
    onFileLint(file);
    const found = lint();
    passes.set(key, found);
    return found;
  };
  // The fix of a canonical error also shows what the candidate still holds, so a repeat of it stays out of the list until then.
  const gained = (found: string[], target: string, written: string): string[] => (
    found.filter(error => !canonicalErrors.has(written === '' ? error : error.replaceAll(written, target)))
  );
  const errors: string[] = [];
  for (const exploration of active) {
    const current = context.boundaries.find(boundary => boundary.kind === 'screen' && boundary.id === exploration.target?.screenId);
    if (!current) continue;
    for (const candidate of exploration.candidates) {
      const { source, styles } = candidate.prototype ?? {};
      if (typeof source !== 'string' || !Array.isArray(styles)) continue;
      const screen = withScreenFiles(current, source, styles, bundle.prototypeSourceContents[source]);
      const sheets = prototypeFileCopies(current, { source, styles }).slice(1);
      const placements = placementKey(screen, context);
      const sheetOwners = sheets.map(([target]) => ownersAfterCopy(context, target, current, screen));
      const projectedOwners = [...new Set([screen, ...sheetOwners.flat()])].map(owner => (
        owner === screen ? owner : { ...owner, styles: owner.styles.map(styleRef => sheets.find(([target]) => target === styleRef)?.[1] ?? styleRef) }
      ));
      const found = [
        ...lintOnce(`source\n${current.id}\n${source}`, source, () => gained(sourceErrors(context, screen, primitiveIds), current.source, source)),
        ...sheets.flatMap(([target, written], index) => lintOnce(`sheet\n${current.id}\n${target}\n${written}\n${placements}`, written, () => gained(stylesheetErrors(context, written, sheetOwners[index], lengthTokens), target, written))),
        ...gained(collectExceptionIssues(context, projectedOwners).map(styleRuleMessage), '', '')
      ];
      for (const error of new Set(found)) errors.push(`exploration.${exploration.id} candidate.${candidate.id}: ${error}`);
    }
  }
  return errors;
}

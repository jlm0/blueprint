import { findSectionMarkers } from '../prototype/compiler';
import { boundaryId } from './address';
import { lintHandBuiltControls, type HandBuiltControlIssue } from './control-lint';
import { lintLocalStyleValues, type LocalStyleValueIssue } from './style-lint';
import type { BlueprintProjectBundle, BoundaryKind, ScreenDefinition } from './types';

export interface DesignFinding {
  boundaryId: string;
  kind: BoundaryKind;
  localId: string;
  rule: 'local-value' | 'native-control' | 'section-marker';
  location: string;
  message: string;
}

/** Governance findings that point at a specific boundary and can be fixed in its own source. */
export function collectDesignFindings(bundle: BlueprintProjectBundle): DesignFinding[] {
  const projectId = bundle.manifest.project.id;
  const finding = (label: string, rule: DesignFinding['rule'], location: string, message: string): DesignFinding => {
    const divider = label.indexOf('.');
    const kind = label.slice(0, divider) as BoundaryKind;
    const localId = label.slice(divider + 1);
    return { boundaryId: boundaryId(projectId, kind, localId), kind, localId, rule, location, message };
  };
  return [
    ...lintLocalStyleValues(bundle).map(issue => finding(issue.boundary, 'local-value', issue.styleRef, localStyleValueMessage(issue))),
    ...lintHandBuiltControls(bundle).map(issue => (
      finding(issue.boundary, 'native-control', `${issue.sourceRef}:${issue.line}`, handBuiltControlMessage(issue))
    )),
    ...bundle.screens.screens.flatMap(screen => unmarkedSectionIds(bundle, screen).map(sectionId => finding(
      `screen.${screen.id}`,
      'section-marker',
      screen.prototype?.source ?? '',
      `section "${sectionId}" has no data-blueprint-section="${sectionId}" marker, so it cannot be addressed on the canvas.`
    )))
  ];
}

export function designFindingReference(finding: DesignFinding): string {
  return `${finding.kind}:${finding.localId} ${finding.location} ${finding.message}`;
}

export function localStyleValueMessage(issue: LocalStyleValueIssue): string {
  const value = issue.value.length > 80 ? `${issue.value.slice(0, 77)}...` : issue.value;
  const remedy = issue.tokenStyleRef
    ? `restates token ${issue.tokenStyleRef}; use var(${issue.tokenStyleRef})`
    : 'uses a literal color; use a token custom property';
  return `${issue.property}: "${value}" ${remedy} or declare the literal in prototype.localValueExceptions.`;
}

export function handBuiltControlMessage(issue: HandBuiltControlIssue): string {
  return `hand-builds a native <${issue.element}>; use <blueprint-use kind="primitive" ref="${issue.primitiveId}"> or mark a deliberate native control with data-blueprint-native="<reason>".`;
}

export function unmarkedSectionIds(bundle: BlueprintProjectBundle, screen: ScreenDefinition): string[] {
  const source = screen.prototype ? bundle.prototypeSourceContents[screen.prototype.source] : undefined;
  if (source === undefined) return [];
  const marked = new Set(findSectionMarkers(source));
  return (screen.sections ?? [])
    .filter(section => !section.prototypeOnly && !marked.has(section.id))
    .map(section => section.id);
}

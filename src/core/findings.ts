import { findSectionMarkers } from './markup';
import { boundaryId } from './address';
import { primitiveOutsideSetMessage, primitivesOutsideSet } from './base-primitives';
import { contrastMessage, lintColorContrast } from './contrast-lint';
import { lintHandBuiltControls, type HandBuiltControlIssue, type UnreadableSourceIssue } from './control-lint';
import { lintLocalStyleValues, type LocalStyleValueIssue } from './style-lint';
import type { BlueprintProjectBundle, BoundaryKind, PrototypeAsset, ScreenDefinition } from './types';

export interface DesignFinding {
  boundaryId: string;
  kind: BoundaryKind;
  localId: string;
  rule: 'local-value' | 'native-control' | 'section-marker' | 'contrast' | 'primitive-set';
  location: string;
  message: string;
}

/** Governance findings that point at a specific boundary and can be fixed in its own source. */
export function collectDesignFindings(bundle: BlueprintProjectBundle<PrototypeAsset>): DesignFinding[] {
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
      screen.prototype.source,
      `section "${sectionId}" has no data-blueprint-section="${sectionId}" marker, so it cannot be addressed on the canvas.`
    ))),
    ...lintColorContrast(bundle).map(issue => finding(`token-group.${issue.groupId}`, 'contrast', 'tokens.json', contrastMessage(issue))),
    ...primitivesOutsideSet(bundle.primitives.primitives.map(primitive => primitive.id))
      .map(id => finding(`primitive.${id}`, 'primitive-set', 'primitives.json', primitiveOutsideSetMessage(id)))
  ];
}

export function designFindingReference(finding: DesignFinding): string {
  return `${finding.kind}:${finding.localId} ${finding.location} ${finding.message}`;
}

export function localStyleValueError(issue: LocalStyleValueIssue): string {
  return `${issue.boundary} ${issue.styleRef} ${localStyleValueMessage(issue)}`;
}

export function handBuiltControlError(issue: HandBuiltControlIssue): string {
  return `${issue.boundary} ${issue.sourceRef}:${issue.line} ${handBuiltControlMessage(issue)}`;
}

export function localStyleValueMessage(issue: LocalStyleValueIssue): string {
  const value = issue.value.length > 80 ? `${issue.value.slice(0, 77)}...` : issue.value;
  if (issue.rule === 'raw-font-family') {
    return `${issue.property}: "${value}" names a font family directly. Fix: replace "${value}" with var() of a typography token, or with inherit, in ${issue.styleRef}. Add the token to tokens.json when none has this family.`;
  }
  if (issue.rule === 'raw-font-size') {
    return `${issue.property}: "${value}" sets a raw font size. Fix: replace "${value}" with var() of a typography token, or with inherit, in ${issue.styleRef}. Add the token to tokens.json when none has this value.`;
  }
  const exception = `Or add { "property": "${issue.property}", "value": ${JSON.stringify(issue.value)}, "reason": "<why>" } to prototype.localValueExceptions.`;
  if (issue.rule === 'named-color') {
    return `${issue.property}: "${value}" uses the named color "${issue.namedColor}". Fix: replace "${issue.namedColor}" with var() of a color token in ${issue.styleRef}. ${exception}`;
  }
  const remedy = issue.tokenStyleRef
    ? `restates token ${issue.tokenStyleRef}; use var(${issue.tokenStyleRef})`
    : 'uses a literal color; use a token custom property';
  const restated = issue.restatedLength !== undefined && issue.restatedLength !== issue.value ? `"${issue.restatedLength}" in "${value}"` : `"${value}"`;
  return `${issue.property}: "${value}" ${remedy} or declare the literal in prototype.localValueExceptions. Fix: ${issue.tokenStyleRef ? `replace ${restated} with var(${issue.tokenStyleRef})` : `replace "${value}" with var() of a color token`} in ${issue.styleRef}. ${exception}`;
}

const UNREADABLE_CONSTRUCTS: Readonly<Record<UnreadableSourceIssue['construct'], { problem: string; fix: string }>> = {
  'cdata-outside-foreign-content': {
    problem: 'holds "<![CDATA[" outside an inline <svg> or <math>, which a browser and Blueprint read in different ways',
    fix: 'delete the "<![CDATA[" and "]]>" markers'
  },
  'end-tag-attributes': {
    problem: 'holds an end tag with attributes, which a browser and Blueprint read in different ways',
    fix: 'delete each attribute from the end tag'
  }
};

export function handBuiltControlMessage(issue: HandBuiltControlIssue): string {
  if (issue.kind === 'unreadable-source') {
    const { problem, fix } = UNREADABLE_CONSTRUCTS[issue.construct];
    return `${problem}. A native control can hide there from this check. Fix: ${fix} at line ${issue.line} of ${issue.sourceRef}.`;
  }
  return `hand-builds a native <${issue.element}>; use <blueprint-use kind="primitive" ref="${issue.primitiveId}"> or mark a deliberate native control with data-blueprint-native="<reason>". Fix: replace this <${issue.element}> at line ${issue.line} of ${issue.sourceRef} with that primitive, or add data-blueprint-native="<reason>" to it.`;
}

export function unmarkedSectionIds(bundle: BlueprintProjectBundle<PrototypeAsset>, screen: ScreenDefinition): string[] {
  const source = bundle.prototypeSourceContents[screen.prototype.source];
  if (source === undefined) return [];
  const marked = new Set(findSectionMarkers(source));
  return (screen.sections ?? [])
    .filter(section => !section.prototypeOnly && !marked.has(section.id))
    .map(section => section.id);
}

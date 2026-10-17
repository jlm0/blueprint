import { boundaryId } from './address';
import { basePrimitiveText } from './base-primitive-text';
import { isRecord } from './contract-checks';
import { lintProse, lintSynonymRotation, type ProseAdvisoryRule } from './prose-lint';
import { reusableProseFields } from './reusable-contract';
import { pageProseFields, screenProseFields, sectionProseFields, type ProseField } from './screen-contract';
import { tokenGroupProseFields } from './token-contract';
import type { BlueprintProjectBundle, DeclaredGroup, ReusableDefinition, ScreenDefinition, ScreenSection, TokenGroup } from './types';

export type ProseAdvisoryKind = 'primitive' | 'component' | 'token-group' | 'page' | 'screen' | 'section';

export interface ProseAdvisory {
  boundaryId: string;
  kind: ProseAdvisoryKind;
  localId: string;
  field: string;
  rule: ProseAdvisoryRule;
  match: string;
  message: string;
}

interface ProseOwner {
  kind: ProseAdvisoryKind;
  localId: string;
  boundaryId: string;
  /** Validation label the field paths hang off, such as "screen.home.section.hero". */
  label: string;
  noun: string;
  fields: ProseField[];
}

/** Wording heuristics on the prose an app writes; they need a judgment call, so they never fail validation. */
export function collectProseAdvisories(bundle: BlueprintProjectBundle): ProseAdvisory[] {
  return proseOwners(bundle).flatMap(owner => {
    const advisories: ProseAdvisory[] = [];
    const advise = (field: string, issue: { rule: string; match: string; message: string }): void => {
      advisories.push({
        boundaryId: owner.boundaryId,
        kind: owner.kind,
        localId: owner.localId,
        field,
        rule: issue.rule as ProseAdvisoryRule,
        match: issue.match,
        message: `${owner.label}.${field} ${issue.message}`
      });
    };
    for (const field of owner.fields) {
      for (const issue of lintProse(field.text)) {
        if (issue.level === 'advisory') advise(field.path, issue);
      }
    }
    for (const issue of lintSynonymRotation(owner.fields.map(field => field.text), owner.noun)) {
      advise(owner.fields[issue.textIndex].path, issue);
    }
    return advisories;
  });
}

function proseOwners(bundle: BlueprintProjectBundle): ProseOwner[] {
  const projectId = bundle.manifest.project.id;
  const owners: ProseOwner[] = [];
  for (const [kind, items] of [['primitive', bundle.primitives.primitives], ['component', bundle.components.components]] as const) {
    for (const reusable of records<ReusableDefinition>(items)) {
      owners.push({
        kind,
        localId: reusable.id,
        boundaryId: boundaryId(projectId, kind, reusable.id),
        label: `${kind}.${reusable.id}`,
        noun: kind,
        fields: reusableProseFields(reusable, kind === 'primitive' ? basePrimitiveText(reusable.id) : undefined).filter(field => field.owner === 'app')
      });
    }
  }
  for (const group of records<TokenGroup>(bundle.tokens.tokenGroups)) {
    owners.push({
      kind: 'token-group',
      localId: group.id,
      boundaryId: boundaryId(projectId, 'token-group', group.id),
      label: `tokenGroup.${group.id}`,
      noun: 'token group',
      fields: tokenGroupProseFields(group)
    });
  }
  for (const page of records<DeclaredGroup>(bundle.screens.pages)) {
    owners.push({
      kind: 'page',
      localId: page.id,
      boundaryId: boundaryId(projectId, 'board', 'screens'),
      label: `screens.page.${page.id}`,
      noun: 'page',
      fields: pageProseFields(page)
    });
  }
  for (const screen of records<ScreenDefinition>(bundle.screens.screens)) {
    owners.push({
      kind: 'screen',
      localId: screen.id,
      boundaryId: boundaryId(projectId, 'screen', screen.id),
      label: `screen.${screen.id}`,
      noun: 'screen',
      fields: screenProseFields(screen)
    });
    for (const section of records<ScreenSection>(screen.sections)) {
      owners.push({
        kind: 'section',
        localId: `${screen.id}/${section.id}`,
        boundaryId: boundaryId(projectId, 'section', `${screen.id}/${section.id}`),
        label: `screen.${screen.id}.section.${section.id}`,
        noun: 'section',
        fields: sectionProseFields(section)
      });
    }
  }
  return owners;
}

function records<T extends { id: string }>(items: unknown): T[] {
  return (Array.isArray(items) ? items : []).filter((item): item is T => isRecord(item) && typeof item.id === 'string');
}

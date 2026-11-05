import { BRAND_FOCUS_ID, INSPO_FOCUS_ID } from '../core/activity';
import { isBasePrimitive } from '../core/base-primitives';
import type { BoundaryKind, CanvasProjectBundle, ComponentDefinition } from '../core/types';
import { groupPrimitivesForNavigation } from './primitive-families';

export type DocumentSectionId = 'foundations' | 'primitives' | 'components';

export type SectionId = DocumentSectionId | 'screens';

export interface SectionItem {
  id: string;
  label: string;
  group?: string;
  boundaryKind: BoundaryKind;
  notice?: string;
}

export const DOCUMENT_SECTIONS: DocumentSectionId[] = ['foundations', 'primitives', 'components'];

export const BRAND_ITEM_ID = BRAND_FOCUS_ID;

export const INSPO_ITEM_ID = INSPO_FOCUS_ID;

export const SECTION_LABELS: Record<SectionId, string> = {
  foundations: 'Foundations',
  primitives: 'Primitives',
  components: 'Components',
  screens: 'Screens'
};

export let activeSection: DocumentSectionId;

export function setActiveSection(next: DocumentSectionId): void {
  activeSection = next;
}

export function restoreRequestedSection(): void {
  activeSection = requestedDocumentSection() ?? 'foundations';
  const requestedItem = new URLSearchParams(location.search).get('item');
  if (requestedItem) activeItemBySection.set(activeSection, requestedItem);
}

export const activeItemBySection = new Map<DocumentSectionId, string>();

function requestedDocumentSection(): DocumentSectionId | undefined {
  const section = new URLSearchParams(location.search).get('section');
  return DOCUMENT_SECTIONS.find(candidate => candidate === section);
}

export function sectionItems(bundle: CanvasProjectBundle, section: DocumentSectionId): SectionItem[] {
  if (section === 'foundations') {
    return [
      ...(bundle.inspo ? [{ id: INSPO_ITEM_ID, label: 'Inspo', boundaryKind: 'project' as const }] : []),
      ...(bundle.brand ? [{ id: BRAND_ITEM_ID, label: 'Brand', boundaryKind: 'project' as const }] : []),
      ...bundle.tokens.tokenGroups.map(group => ({ id: group.id, label: group.name, boundaryKind: 'token-group' as const }))
    ];
  }
  if (section === 'primitives') {
    return groupPrimitivesForNavigation(bundle.primitives.primitives).flatMap(({ label, primitives }) =>
      primitives.map(primitive => ({
        id: primitive.id,
        label: primitive.name,
        group: label,
        boundaryKind: 'primitive' as const,
        ...(isBasePrimitive(primitive.id) ? {} : { notice: 'Not in the primitive set' })
      }))
    );
  }
  const groups = bundle.components.groups;
  const rank = (component: ComponentDefinition): number => {
    const index = groups.findIndex(group => group.id === component.group);
    return index === -1 ? groups.length : index;
  };
  return [...bundle.components.components].sort((a, b) => rank(a) - rank(b)).map(component => ({
    id: component.id,
    label: component.name,
    group: groups.find(group => group.id === component.group)?.name,
    boundaryKind: 'component' as const
  }));
}

export function activeItem(bundle: CanvasProjectBundle, section: DocumentSectionId): SectionItem | undefined {
  const items = sectionItems(bundle, section);
  const remembered = activeItemBySection.get(section);
  return items.find(item => item.id === remembered) ?? items[0];
}

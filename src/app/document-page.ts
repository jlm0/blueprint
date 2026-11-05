import { el } from './dom';
import { type DocumentSectionId, SECTION_LABELS } from './sections';

export function createDocumentPage(kicker: string, title: string, description: string, badges: HTMLElement[] = []): { page: HTMLElement; body: HTMLElement } {
  const page = el('article', 'bp-chrome-doc-page');
  const head = el('header', 'bp-chrome-doc-head');
  const titleRow = el('div', 'bp-chrome-doc-title-row');
  titleRow.append(el('h1', 'bp-chrome-doc-title', title));
  if (badges.length > 0) {
    const facts = el('div', 'bp-chrome-doc-facts');
    facts.append(...badges);
    titleRow.append(facts);
  }
  head.append(el('p', 'bp-chrome-doc-kicker', kicker), titleRow);
  if (description) head.append(el('p', 'bp-chrome-doc-lede', description));
  const body = el('div', 'bp-chrome-doc-body');
  page.append(head, body);
  return { page, body };
}

export function createDocumentSection(title: string, ...children: HTMLElement[]): HTMLElement {
  const section = el('section', 'bp-chrome-doc-section');
  section.append(el('h2', 'bp-chrome-doc-section-title', title), ...children);
  return section;
}

export function createEmptySectionPage(section: DocumentSectionId): HTMLElement {
  const copy: Record<DocumentSectionId, [string, string]> = {
    foundations: ['No tokens yet', 'Foundations show the color, type, space, shape and motion tokens every primitive reads from.'],
    primitives: ['No primitives yet', 'Primitives are the fixed building blocks every app shares, such as the button and the input.'],
    components: ['No components yet', 'Components are this app\'s own compositions built from primitives, such as a bento grid on a landing page. Primitives stay fixed; components are where an app adds its own pieces.']
  };
  const [title, description] = copy[section];
  const { page } = createDocumentPage(SECTION_LABELS[section], title, description);
  page.classList.add('bp-chrome-doc-empty');
  return page;
}

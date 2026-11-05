import type { InspoAspect, InspoDirection, InspoEntry, InspoFile } from '../core/types';
import { createDocumentPage, createDocumentSection } from './document-page';
import { el } from './dom';

const INSPO_ASPECT_LABELS: Record<InspoAspect, string> = {
  mark: 'Mark',
  wordmark: 'Wordmark',
  typography: 'Typography',
  color: 'Color',
  layout: 'Layout',
  imagery: 'Imagery',
  style: 'Style'
};

export function createInspoPage(inspo: InspoFile): HTMLElement {
  const entries = inspo.entries ?? [];
  const directions = inspo.directions ?? [];
  const approved = directions.filter(direction => direction.status === 'approved').length;
  const badges = [el('span', 'bp-chrome-doc-fact', `${entries.length} ${entries.length === 1 ? 'image' : 'images'}`)];
  if (directions.length > 0) badges.push(el('span', 'bp-chrome-doc-fact', `${approved} of ${directions.length} directions approved`));
  const { page, body } = createDocumentPage(
    'Foundations',
    'Inspo',
    'The references this brand starts from. Paste an image link in chat and say what you like about it. The agent saves it here with your note.',
    badges
  );
  page.dataset.inspo = 'true';

  if (entries.length === 0) {
    body.append(el('p', 'bp-chrome-doc-text', 'No images yet. Paste a link to an image from Dribbble or anywhere else, then say what draws you to it: the mark, the wordmark, the type, the colors, or the feel of the site. On Dribbble, right-click the shot and copy the image address.'));
    return page;
  }

  if (directions.length > 0) {
    const pending = directions.length > approved
      ? [el('p', 'bp-chrome-doc-text bp-chrome-inspo-hint', 'Proposed directions wait for your OK in chat. The brand is built from approved ones.')]
      : [];
    body.append(createDocumentSection('Directions', createInspoDirections(directions), ...pending));
  }

  const grid = el('div', 'bp-chrome-inspo-grid');
  grid.append(...entries.map(createInspoCard));
  body.append(createDocumentSection('Images', grid));
  return page;
}

export function createInspoDirections(directions: InspoDirection[]): HTMLElement {
  const list = el('ul', 'bp-chrome-inspo-directions');
  for (const direction of directions) {
    const item = el('li', 'bp-chrome-inspo-direction');
    item.dataset.status = direction.status;
    const head = el('div', 'bp-chrome-inspo-direction-head');
    head.append(
      el('span', 'bp-chrome-inspo-direction-aspect', INSPO_ASPECT_LABELS[direction.aspect] ?? direction.aspect),
      el('span', 'bp-chrome-doc-fact', direction.status === 'approved' ? 'Approved' : 'Proposed')
    );
    item.append(
      head,
      el('p', 'bp-chrome-doc-text', direction.statement),
      el('p', 'bp-chrome-inspo-from', `From ${direction.entryIds.join(', ')}`)
    );
    list.append(item);
  }
  return list;
}

function createInspoCard(entry: InspoEntry): HTMLElement {
  const card = el('article', 'bp-chrome-inspo-card');
  card.dataset.inspoEntry = entry.id;
  card.dataset.stance = entry.stance;
  const figure = el('figure', 'bp-chrome-inspo-figure');
  const file = entry.image.startsWith('inspo/') ? entry.image.slice('inspo/'.length) : '';
  const href = `/__blueprint/inspo/${encodeURIComponent(file)}`;
  const link = el('a', 'bp-chrome-inspo-image-link') as HTMLAnchorElement;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  const image = el('img', 'bp-chrome-inspo-image') as HTMLImageElement;
  image.src = href;
  image.alt = entry.reading || `Inspo image ${entry.id}`;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('error', () => {
    link.replaceWith(el('div', 'bp-chrome-inspo-missing', 'Image not downloaded yet. Ask the agent to sync inspo.'));
  }, { once: true });
  link.append(image);
  figure.append(link);

  const head = el('div', 'bp-chrome-inspo-card-head');
  head.append(el('h3', 'bp-chrome-specimen-title', entry.id), el('span', 'bp-chrome-inspo-stance', entry.stance === 'avoid' ? 'Avoid' : 'Like'));
  const meta = el('div', 'bp-chrome-inspo-card-body');
  meta.append(head);
  if (entry.aspects.length > 0) {
    const chips = el('div', 'bp-chrome-doc-chips');
    chips.append(...entry.aspects.map(aspect => el('span', 'bp-chrome-doc-chip', INSPO_ASPECT_LABELS[aspect] ?? aspect)));
    meta.append(chips);
  }
  meta.append(createInspoVoice('You', entry.note ? `\u201c${entry.note}\u201d` : 'No note yet.', !entry.note));
  if (entry.reading) meta.append(createInspoVoice('Agent', entry.reading, false));
  if (entry.sourceUrl.startsWith('https://')) {
    const source = el('a', 'bp-chrome-inspo-source', sourceHost(entry.sourceUrl)) as HTMLAnchorElement;
    source.href = entry.sourceUrl;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    meta.append(source);
  }
  card.append(figure, meta);
  return card;
}

function createInspoVoice(speaker: string, text: string, empty: boolean): HTMLElement {
  const voice = el('p', 'bp-chrome-inspo-voice');
  if (empty) voice.dataset.empty = 'true';
  voice.append(el('span', 'bp-chrome-inspo-speaker', speaker), document.createTextNode(text));
  return voice;
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

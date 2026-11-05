import { BASE_PRIMITIVE_CONTRACT, isBasePrimitive, primitiveGroupName } from '../core/base-primitives';
import { PLATFORMS, REUSABLE_AXES, type SLOT_CONTENT_ACCEPTS, platformsLabel } from '../core/reusable-contract';
import type { CanvasProjectBundle, Platform, ReusableAxisValue, ReusableDefinition, ReusableKind } from '../core/types';
import { compilePrototypeDocument } from '../prototype/compiler';
import { applyPrototypeIframeIsolation } from '../prototype/host-policy';
import { createDocumentPage, createDocumentSection } from './document-page';
import {
  componentPreviewWidth,
  createPreviewFit,
  fitPreviewFrame,
  measureCanonicalCellSize,
  measureComponentPreview
} from './document-preview';
import { createPrototypeCompileError, el } from './dom';
import { trackFrameLoad } from './frame-loads';
import { openDocumentItem } from './navigation';
import { inferPrimitiveFamily, primitiveCellWidth } from './primitive-families';
import { setBoundary } from './review-state';
import type { DocumentSectionId } from './sections';
import type { TokenIndex } from './tokens';

export function createReusablePage(bundle: CanvasProjectBundle, tokenIndex: TokenIndex, kind: ReusableKind, reusable: ReusableDefinition): HTMLElement {
  const groupName = kind === 'primitive'
    ? primitiveGroupName(reusable.group) ?? 'Other'
    : bundle.components.groups.find(group => group.id === reusable.group)?.name ?? reusable.group;
  const badges = [
    createPlatformBadge(reusable.platforms),
    ...REUSABLE_AXES.map(axis => el('span', 'bp-chrome-doc-fact', plural(reusable[axis.key].values.length, axis.label))),
    el('span', 'bp-chrome-doc-fact', plural(reusable.slots.length, 'slot'))
  ];
  const { page, body } = createDocumentPage(`${kind === 'primitive' ? 'Primitive' : 'Component'} · ${groupName}`, reusable.name, reusable.description, badges);
  setBoundary(page, kind, reusable.id, bundle.manifest.project.id, reusable.name);
  page.dataset.boundarySummary = reusable.description;

  const family = kind === 'primitive' ? inferPrimitiveFamily(reusable) : undefined;
  if (family) page.dataset.primitiveFamily = family;
  if (kind === 'primitive' && !isBasePrimitive(reusable.id)) {
    body.append(el('p', 'bp-chrome-doc-notice', `This is not one of the ${BASE_PRIMITIVE_CONTRACT.length} Blueprint primitives. App-specific pieces belong in components, built from primitives.`));
  }

  const context: SpecimenContext = {
    bundle,
    kind,
    reusable,
    width: family ? primitiveCellWidth(family, reusable.id) : componentPreviewWidth(bundle, reusable.id)
  };
  const specimens = el('div', 'bp-chrome-doc-specimen canonical-primitive-specimen');
  specimens.dataset.prototypeRenderMode = 'canonical-app-owned';
  specimens.style.setProperty('--cell-w', `${context.width}px`);
  specimens.append(
    createDocumentSection('Variants', ...reusable.variants.values.map(variant => createAxisGroup(
      variant,
      variant.id === reusable.variants.default,
      reusable.states.values.map(state => createReusableCell(context, variant.id, reusable.sizes.default, state))
    ))),
    reusable.sizes.values.length > 1
      ? createDocumentSection('Sizes', ...reusable.sizes.values.map(size => createAxisGroup(
          size,
          size.id === reusable.sizes.default,
          reusable.states.values.map(state => createReusableCell(context, reusable.variants.default, size.id, state))
        )))
      : createDocumentSection('Sizes', el('p', 'bp-chrome-doc-text', 'One size.'))
  );

  body.append(
    createBuiltFromSection(bundle, tokenIndex, reusable),
    specimens,
    createDocumentSection('States', createDefinitionList(reusable.states.values.map(state => ({
      name: state.name,
      description: state.description,
      isDefault: state.id === reusable.states.default
    })))),
    createDocumentSection('Slots', reusable.slots.length > 0
      ? createDefinitionList(reusable.slots.map(slot => ({
          name: slot.name,
          description: slot.description,
          detail: createSlotAccepts(bundle, slot.accepts)
        })))
      : el('p', 'bp-chrome-doc-text', 'No slots: a placement cannot customize its content.'))
  );
  return page;
}

function createPlatformBadge(platforms: readonly Platform[]): HTMLElement {
  const label = platformsLabel(platforms);
  const badge = el('span', 'bp-chrome-doc-fact bp-chrome-doc-platform');
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', label);
  badge.title = label;
  const icons: Record<Platform, string> = {
    web: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
    mobile: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
    desktop: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'
  };
  badge.innerHTML = PLATFORMS.filter(platform => platforms.includes(platform)).map(platform => (
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-platform="${platform}">${icons[platform]}</svg>`
  )).join('');
  return badge;
}

function createBuiltFromSection(bundle: CanvasProjectBundle, tokenIndex: TokenIndex, reusable: ReusableDefinition): HTMLElement {
  const rows: Array<[string, HTMLElement[]]> = [
    ['Primitives', reusable.uses.filter(use => use.kind === 'primitive').map(use => createDocumentLink(
      bundle.primitives.primitives.find(candidate => candidate.id === use.id)?.name ?? use.id, use.reason, 'primitives', use.id
    ))],
    ['Components', reusable.uses.filter(use => use.kind === 'component').map(use => createDocumentLink(
      bundle.components.components.find(candidate => candidate.id === use.id)?.name ?? use.id, use.reason, 'components', use.id
    ))],
    ['Foundations', reusable.tokenGroupIds.map(groupId => createDocumentLink(
      tokenIndex.byGroup.get(groupId)?.name ?? groupId, `${groupId} tokens`, 'foundations', groupId
    ))]
  ];
  const list = el('dl', 'bp-chrome-doc-defs');
  for (const [label, chips] of rows.filter(([, chips]) => chips.length > 0)) {
    const value = el('dd', 'bp-chrome-doc-chips');
    value.append(...chips);
    list.append(el('dt', 'bp-chrome-doc-def-name', label), value);
  }
  return createDocumentSection('Built from', list);
}

function createDocumentLink(label: string, title: string, section: DocumentSectionId, itemId: string): HTMLElement {
  const chip = el('button', 'bp-chrome-doc-chip bp-chrome-doc-link', label) as HTMLButtonElement;
  chip.type = 'button';
  chip.title = title;
  chip.addEventListener('click', () => openDocumentItem(section, itemId));
  return chip;
}

const SLOT_ACCEPT_LABELS: Record<(typeof SLOT_CONTENT_ACCEPTS)[number], string> = {
  text: 'Text',
  graphic: 'Graphic',
  'brand-mark': 'Brand mark'
};

function createSlotAccepts(bundle: CanvasProjectBundle, accepts: string[]): HTMLElement {
  const list = el('div', 'bp-chrome-doc-chips');
  for (const accept of accepts) {
    const [kind, id] = accept.split(':');
    if (kind === 'primitive' || kind === 'component') {
      const target = kind === 'primitive'
        ? bundle.primitives.primitives.find(candidate => candidate.id === id)
        : bundle.components.components.find(candidate => candidate.id === id);
      list.append(createDocumentLink(target?.name ?? id, accept, kind === 'primitive' ? 'primitives' : 'components', id));
    } else {
      list.append(el('span', 'bp-chrome-doc-chip', SLOT_ACCEPT_LABELS[accept as keyof typeof SLOT_ACCEPT_LABELS] ?? accept));
    }
  }
  return list;
}

function createDefinitionList(entries: Array<{ name: string; description: string; isDefault?: boolean; detail?: HTMLElement }>): HTMLElement {
  const list = el('dl', 'bp-chrome-doc-defs');
  for (const entry of entries) {
    const name = el('dt', 'bp-chrome-doc-def-name', entry.name);
    if (entry.isDefault) name.append(el('span', 'bp-chrome-doc-default', 'Default'));
    const value = el('dd', 'bp-chrome-doc-def-value');
    value.append(el('p', 'bp-chrome-doc-text', entry.description));
    if (entry.detail) value.append(entry.detail);
    list.append(name, value);
  }
  return list;
}

function createAxisGroup(value: ReusableAxisValue, isDefault: boolean, cells: HTMLElement[]): HTMLElement {
  const group = el('div', 'bp-chrome-specimen-group');
  const title = el('h3', 'bp-chrome-specimen-title', value.name);
  if (isDefault) title.append(el('span', 'bp-chrome-doc-default', 'Default'));
  const row = el('div', 'bp-chrome-specimen-row');
  row.append(...cells);
  group.append(title, el('p', 'bp-chrome-specimen-description', value.description), row);
  return group;
}

function createReusableCell(context: SpecimenContext, variant: string, size: string, state: ReusableAxisValue): HTMLElement {
  const { bundle, kind, reusable, width } = context;
  const item = el('figure', 'bp-chrome-specimen-cell');
  const unsupported = reusable.unsupported.find(combination => (
    combination.state === state.id && combination.value === (combination.axis === 'variant' ? variant : size)
  ));
  if (unsupported) {
    item.classList.add('bp-chrome-specimen-unsupported');
    const empty = el('div', 'bp-chrome-specimen-empty', 'Not offered');
    empty.title = unsupported.reason;
    empty.style.width = `${width}px`;
    item.append(empty, el('figcaption', 'bp-chrome-specimen-caption', state.name));
    return item;
  }
  try {
    const compiled = compilePrototypeDocument({ bundle, target: { kind, id: reusable.id }, state: state.id, variant, size, assetOrigin: location.origin });
    const iframe = document.createElement('iframe');
    iframe.className = kind === 'primitive' ? 'canonical-primitive-iframe' : 'canonical-primitive-iframe component-preview-iframe';
    applyPrototypeIframeIsolation(iframe);
    iframe.title = `${reusable.name} · ${variant} · ${size} · ${state.id}`;
    iframe.srcdoc = compiled.html;
    trackFrameLoad(iframe);
    iframe.dataset.prototypeTargetBoundary = compiled.targetBoundaryId;
    iframe.dataset.prototypeObservedUses = JSON.stringify(compiled.observedUses);
    item.append(createPreviewFit(iframe));
    if (kind === 'primitive') {
      // The visible frame keeps its empty-permission sandbox, so its content is
      // measured through an ephemeral offscreen twin instead; the twin renders
      // the same CSP-locked no-script document and is removed immediately.
      measureCanonicalCellSize(compiled.html, width, fitted => fitPreviewFrame(iframe, fitted));
    } else {
      fitPreviewFrame(iframe, { width, height: 160 });
      measureComponentPreview(compiled.html, width, fitted => fitPreviewFrame(iframe, fitted));
    }
  } catch (error) {
    item.append(createPrototypeCompileError(error));
  }
  item.append(el('figcaption', 'bp-chrome-specimen-caption', state.name));
  return item;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

interface SpecimenContext {
  bundle: CanvasProjectBundle;
  kind: ReusableKind;
  reusable: ReusableDefinition;
  width: number;
}

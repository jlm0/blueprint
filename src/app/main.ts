import './styles.css';
import { toBlob } from 'html-to-image';
import { boundaryId } from '../core/address';
import {
  createCanvasStyleEvidence,
  createReviewManifest,
  validateVisibleBoundaryRecords
} from '../core/review';
import type {
  BlueprintProjectBundle,
  BoardDefinition,
  BoundaryKind,
  DesignToken,
  PrimitiveDefinition,
  PrimitiveState,
  PrimitiveStateSet,
  ScreenDefinition,
  TokenGroup
} from '../core/types';
import type { VisibleBoundaryRecord } from '../core/review';
import { createCanvasController, type CanvasController, type CanvasView } from './canvas-controller';
import { createCanvasItemLayout } from './canvas-layout';
import { loadConfiguredProject } from './fixture-projects';

type BoardId = 'primitives' | 'screens';

interface MountedBoard {
  root: HTMLElement;
  mounted: BoardMount;
  view: CanvasView | null;
}

interface BoardMount {
  configure: () => CanvasController;
  fit: () => void;
}

interface BoardConfig {
  label: string;
  className: string;
  mount: (context: BoardContext) => BoardMount;
}

interface BoardContext {
  root: HTMLElement;
  canvas: CanvasController;
  project: BlueprintProjectBundle;
}

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Blueprint app root is missing.');
}

const project = loadConfiguredProject();
const shell = el('div');
shell.id = 'app-shell';

const switcher = el('nav', 'board-switcher');
switcher.setAttribute('aria-label', 'Blueprint boards');

const viewport = el('main');
viewport.id = 'viewport';
viewport.setAttribute('aria-label', 'Blueprint canvas');

const world = el('div');
world.id = 'world';
viewport.append(world);
shell.append(switcher, viewport);
app.append(shell);

const canvas = createCanvasController({
  viewport,
  world,
  minScale: 0.08,
  fallbackWidth: 320,
  fallbackHeight: 260
});

const boardConfigs: Record<BoardId, BoardConfig> = {
  primitives: {
    label: 'Primitives',
    className: 'board-root board-primitives',
    mount: mountPrimitives
  },
  screens: {
    label: 'Screens',
    className: 'board-root board-screens',
    mount: mountScreens
  }
};

const boardState = new Map<BoardId, MountedBoard>();
let activeBoardId: BoardId | null = null;

for (const board of project.manifest.boards.filter(isVisibleBoard)) {
  const button = el('button', '', board.name) as HTMLButtonElement;
  button.type = 'button';
  button.dataset.board = board.id;
  button.addEventListener('click', () => showBoard(board.id));
  switcher.append(button);
}

const requestedBoard = new URLSearchParams(location.search).get('board');
const defaultBoard = isBoardId(project.manifest.defaultBoardId) ? project.manifest.defaultBoardId : 'primitives';

function showBoard(id: BoardId): void {
  const config = boardConfigs[id];
  if (!config) {
    return;
  }

  if (activeBoardId) {
    const current = boardState.get(activeBoardId);
    if (current) {
      current.view = canvas.snapshot();
      current.root.hidden = true;
    }
  }

  const state = ensureBoard(id, config);
  state.root.hidden = false;
  state.mounted.configure();
  activeBoardId = id;

  switcher.querySelectorAll<HTMLButtonElement>('[data-board]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.board === id));
  });

  const url = new URL(window.location.href);
  url.searchParams.set('board', id);
  history.replaceState(null, '', url);

  if (state.view) {
    canvas.setView(state.view);
  } else {
    requestAnimationFrame(() => state.mounted.fit());
  }

  refreshCanvasReviewState(id);
}

function ensureBoard(id: BoardId, config: BoardConfig): MountedBoard {
  const existing = boardState.get(id);
  if (existing) {
    return existing;
  }

  const root = el('section', config.className);
  root.dataset.boardRoot = id;
  root.hidden = true;
  root.setAttribute('aria-label', config.label);
  world.append(root);

  const mounted = config.mount({ root, canvas, project });
  const state: MountedBoard = { root, mounted, view: null };
  boardState.set(id, state);
  return state;
}

function mountPrimitives({ root, canvas: boardCanvas, project: bundle }: BoardContext): BoardMount {
  const configure = (): CanvasController =>
    boardCanvas.configure({
      minScale: 0.08,
      fallbackWidth: 400,
      fallbackHeight: 240
    });
  const controller = configure();
  const layout = createCanvasItemLayout(root, {
    selector: '.group-head, .spec',
    chipClearance: 38,
    stackGap: 34,
    horizontalGap: 24,
    fallbackWidth: 400,
    fallbackHeight: 220
  });
  const projectId = bundle.manifest.project.id;
  const tokenIndex = createTokenIndex(bundle);

  addGroupHeading(root, controller, {
    title: 'Tokens',
    subtitle: `${bundle.tokens.tokenGroups.length} app-owned groups`,
    x: 70,
    y: 300,
    accent: 'var(--accent-token)'
  });
  bundle.tokens.tokenGroups.forEach((group, index) => {
    addTokenGroupCard(root, controller, bundle, tokenIndex, group, {
      x: 70,
      y: 380 + index * 250,
      width: 460
    });
  });

  const groupedPrimitives = groupPrimitivesByFamily(bundle.primitives.primitives);
  groupedPrimitives.forEach((group, index) => {
    const x = 650 + index * 520;
    addGroupHeading(root, controller, {
      title: familyLabel(group.family),
      subtitle: `${group.primitives.length} ${group.family} ${group.primitives.length === 1 ? 'primitive' : 'primitives'}`,
      x,
      y: 300,
      accent: familyAccent(group.family)
    });
    group.primitives.forEach((primitive, primitiveIndex) => {
      addPrimitiveDefinitionCard(root, controller, bundle, tokenIndex, primitive, group.family, {
        x,
        y: 380 + primitiveIndex * 280,
        width: familyWidth(group.family)
      });
    });
  });

  if (document.fonts?.ready) {
    void document.fonts.ready.then(() => {
      if (!root.hidden) {
        controller.fitTo(layout.reflow());
      }
    });
  }

  return {
    configure,
    fit: () => controller.fitTo(layout.reflow())
  };
}

interface TokenRecord {
  ref: string;
  group: TokenGroup;
  token: DesignToken;
}

interface TokenIndex {
  byRef: Map<string, TokenRecord>;
  byGroup: Map<string, TokenGroup>;
}

interface PositionedCard {
  x: number;
  y: number;
  width: number;
}

interface FamilyGroup {
  family: string;
  primitives: PrimitiveDefinition[];
}

const FAMILY_ORDER = [
  'button',
  'input',
  'checkbox',
  'switch',
  'slider',
  'surface',
  'card',
  'media',
  'navigation',
  'separator',
  'list',
  'row',
  'loading',
  'badge',
  'icon',
  'skeleton',
  'dialog',
  'menu',
  'sheet',
  'generic'
];

function createTokenIndex(bundle: BlueprintProjectBundle): TokenIndex {
  const byRef = new Map<string, TokenRecord>();
  const byGroup = new Map<string, TokenGroup>();
  for (const group of bundle.tokens.tokenGroups) {
    byGroup.set(group.id, group);
    for (const token of group.tokens) {
      byRef.set(`${group.id}.${token.id}`, {
        ref: `${group.id}.${token.id}`,
        group,
        token
      });
    }
  }
  return { byRef, byGroup };
}

function addTokenGroupCard(
  root: HTMLElement,
  controller: CanvasController,
  bundle: BlueprintProjectBundle,
  tokenIndex: TokenIndex,
  group: TokenGroup,
  position: PositionedCard
): HTMLElement {
  const card = createSpecCard({
    label: `TOKEN · ${group.name}`,
    x: position.x,
    y: position.y,
    width: position.width,
    accent: familyAccent('token'),
    boundary: ['token-group', group.id, bundle.manifest.project.id]
  });
  card.dataset.boundarySummary = group.description;
  card.dataset.tokenGroup = group.id;

  const body = appendSpecBody(card);
  const header = el('div', 'generated-card-head');
  header.append(el('strong', '', group.name), el('span', '', group.description));
  body.append(header);

  const grid = el('div', 'token-grid');
  for (const token of group.tokens) {
    grid.append(createTokenRow(tokenIndex, group, token));
  }
  body.append(grid);

  if (group.notes.length > 0) {
    body.append(el('p', 'spec-note', group.notes[0] ?? ''));
  }

  root.append(card);
  controller.makeDraggable(card, card.querySelector<HTMLElement>('.spec-chip') ?? card);
  return card;
}

function createTokenRow(tokenIndex: TokenIndex, group: TokenGroup, token: DesignToken): HTMLElement {
  const row = el('div', `token-row token-row-${token.type}`);
  row.dataset.tokenType = token.type;
  const tokenRef = `${group.id}.${token.id}`;
  setTokenHook(row, tokenIndex.byRef.get(tokenRef), `${token.type}-token-row`);

  const sample = el('span', 'token-sample');
  applyTokenPreview(sample, token);
  const meta = el('span', 'token-meta');
  meta.append(el('b', '', token.name), el('span', '', `${tokenRef} · ${token.value}`));
  row.append(sample, meta);
  return row;
}

function addPrimitiveDefinitionCard(
  root: HTMLElement,
  controller: CanvasController,
  bundle: BlueprintProjectBundle,
  tokenIndex: TokenIndex,
  primitive: PrimitiveDefinition,
  family: string,
  position: PositionedCard
): HTMLElement {
  const card = createSpecCard({
    label: primitive.name,
    x: position.x,
    y: position.y,
    width: position.width,
    accent: familyAccent(family),
    boundary: ['primitive', primitive.id, bundle.manifest.project.id]
  });
  card.dataset.boundarySummary = primitive.description;
  card.dataset.primitiveFamily = family;

  const body = appendSpecBody(card);
  const header = el('div', 'generated-card-head primitive-generated-head');
  const title = el('strong', '', primitive.name);
  const typography = firstTokenFromGroups(tokenIndex, primitive.tokenGroupIds, 'typography', 'body');
  if (typography) {
    setTokenHook(title, typography, 'primitive-title-type');
    title.style.font = typography.token.value;
  }
  header.append(title, el('span', '', primitive.description));
  body.append(header);

  const meta = el('div', 'primitive-meta-row');
  meta.append(el('span', 'family-pill', family), el('span', '', `${primitive.stateSets.length} state ${primitive.stateSets.length === 1 ? 'set' : 'sets'}`));
  body.append(meta);

  if (primitive.stateSets.length === 0) {
    body.append(createGenericPrimitiveSample(primitive, tokenIndex, family));
  } else {
    for (const stateSet of primitive.stateSets) {
      body.append(createStateSetSection(bundle, tokenIndex, primitive, stateSet, family));
    }
  }

  if (primitive.notes.length > 0) {
    body.append(el('p', 'spec-note', primitive.notes[0] ?? ''));
  }

  root.append(card);
  controller.makeDraggable(card, card.querySelector<HTMLElement>('.spec-chip') ?? card);
  return card;
}

function createStateSetSection(
  bundle: BlueprintProjectBundle,
  tokenIndex: TokenIndex,
  primitive: PrimitiveDefinition,
  stateSet: PrimitiveStateSet,
  family: string
): HTMLElement {
  const section = el('section', 'primitive-state-set');
  setBoundary(section, 'state-set', `${primitive.id}/${stateSet.id}`, bundle.manifest.project.id, stateSet.name);
  section.dataset.boundarySummary = stateSet.description;

  const heading = el('div', 'state-set-heading');
  heading.append(el('b', '', stateSet.name), el('span', '', stateSet.description));
  section.append(heading);

  const grid = el('div', 'state-sample-grid');
  for (const state of stateSet.states) {
    grid.append(createPrimitiveStateSample(tokenIndex, primitive, state, family));
  }
  section.append(grid);
  return section;
}

function createPrimitiveStateSample(
  tokenIndex: TokenIndex,
  primitive: PrimitiveDefinition,
  state: PrimitiveState,
  family: string
): HTMLElement {
  const sample = el('div', `primitive-sample primitive-sample-${family}`);
  sample.dataset.primitiveSample = family;
  sample.dataset.primitiveStateId = state.id;
  sample.dataset.prototypeOnly = String(state.prototypeOnly);

  const color = firstStateToken(tokenIndex, state, 'color') ?? firstTokenFromGroups(tokenIndex, primitive.tokenGroupIds, 'color');
  const space = firstStateToken(tokenIndex, state, 'space') ?? firstTokenFromGroups(tokenIndex, primitive.tokenGroupIds, 'space');
  const radius = firstStateToken(tokenIndex, state, 'radius') ?? firstTokenFromGroups(tokenIndex, primitive.tokenGroupIds, 'radius');
  const shadow = firstStateToken(tokenIndex, state, 'shadow') ?? firstTokenFromGroups(tokenIndex, primitive.tokenGroupIds, 'shadow');
  const motion = firstStateToken(tokenIndex, state, 'motion') ?? firstTokenFromGroups(tokenIndex, primitive.tokenGroupIds, 'motion');

  if (color) {
    setTokenHook(sample, color, 'sample-background');
    sample.style.backgroundColor = color.token.value;
  }
  if (shadow) {
    sample.style.boxShadow = shadow.token.value;
  }
  if (motion) {
    sample.style.transition = `transform ${motion.token.value}`;
  }

  const label = el('span', 'primitive-sample-label', state.name);
  sample.append(label);

  if (space) {
    const probe = el('span', 'token-probe token-probe-space', 'space');
    setTokenHook(probe, space, 'sample-padding-inline');
    probe.style.paddingLeft = space.token.value;
    probe.style.paddingRight = space.token.value;
    sample.append(probe);
  }

  if (radius) {
    const probe = el('span', 'token-probe token-probe-radius', 'radius');
    setTokenHook(probe, radius, 'sample-radius');
    probe.style.borderRadius = radius.token.value;
    sample.append(probe);
  }

  if (shadow) {
    const probe = el('span', 'token-probe token-probe-shadow', 'shadow');
    setTokenHook(probe, shadow, 'sample-shadow');
    probe.style.boxShadow = shadow.token.value;
    sample.append(probe);
  }

  if (motion) {
    const probe = el('span', 'token-probe token-probe-motion', 'motion');
    setTokenHook(probe, motion, 'sample-motion');
    probe.style.transition = `transform ${motion.token.value}`;
    sample.append(probe);
  }

  if (state.prototypeOnly) {
    sample.append(el('span', 'prototype-flag', 'prototype'));
  }

  return sample;
}

function createGenericPrimitiveSample(primitive: PrimitiveDefinition, tokenIndex: TokenIndex, family: string): HTMLElement {
  const state: PrimitiveState = {
    id: 'default',
    name: primitive.name,
    tokens: primitive.tokenGroupIds.flatMap(groupId => tokenIndex.byGroup.get(groupId)?.tokens[0]?.id ? [`${groupId}.${tokenIndex.byGroup.get(groupId)?.tokens[0]?.id}`] : []),
    prototypeOnly: primitive.prototypeOnly,
    notes: [],
    implementationHints: []
  };
  return createPrimitiveStateSample(tokenIndex, primitive, state, family);
}

function groupPrimitivesByFamily(primitives: PrimitiveDefinition[]): FamilyGroup[] {
  const groups = new Map<string, PrimitiveDefinition[]>();
  for (const primitive of primitives) {
    const family = inferPrimitiveFamily(primitive);
    const current = groups.get(family) ?? [];
    current.push(primitive);
    groups.set(family, current);
  }
  return [...groups.entries()]
    .map(([family, items]) => ({ family, primitives: items }))
    .sort((a, b) => familySortIndex(a.family) - familySortIndex(b.family) || a.family.localeCompare(b.family));
}

function inferPrimitiveFamily(primitive: PrimitiveDefinition): string {
  const terms = primitiveFamilyTerms(primitive);
  if (hasFamilyTerm(terms, 'button')) return 'button';
  if (hasFamilyTerm(terms, 'otp', 'input')) return 'input';
  if (hasFamilyTerm(terms, 'checkbox')) return 'checkbox';
  if (hasFamilyTerm(terms, 'switch')) return 'switch';
  if (hasFamilyTerm(terms, 'slider')) return 'slider';
  if (hasFamilyTerm(terms, 'surface')) return 'surface';
  if (hasFamilyTerm(terms, 'media')) return 'media';
  if (hasFamilyTerm(terms, 'card')) return 'card';
  if (hasFamilyTerm(terms, 'nav', 'navbar', 'navigation', 'back')) return 'navigation';
  if (hasFamilyTerm(terms, 'separator')) return 'separator';
  if (hasFamilyTerm(terms, 'list')) return 'list';
  if (hasFamilyTerm(terms, 'row')) return 'row';
  if (hasFamilyTerm(terms, 'loading')) return 'loading';
  if (hasFamilyTerm(terms, 'badge', 'pill')) return 'badge';
  if (hasFamilyTerm(terms, 'icon')) return 'icon';
  if (hasFamilyTerm(terms, 'skeleton')) return 'skeleton';
  if (hasFamilyTerm(terms, 'dialog')) return 'dialog';
  if (hasFamilyTerm(terms, 'menu')) return 'menu';
  if (hasFamilyTerm(terms, 'sheet')) return 'sheet';
  return 'generic';
}

function primitiveFamilyTerms(primitive: PrimitiveDefinition): Set<string> {
  return new Set(
    `${primitive.id} ${primitive.name}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

function hasFamilyTerm(terms: Set<string>, ...candidates: string[]): boolean {
  return candidates.some(candidate => terms.has(candidate));
}

function familySortIndex(family: string): number {
  const index = FAMILY_ORDER.indexOf(family);
  return index === -1 ? FAMILY_ORDER.length : index;
}

function familyLabel(family: string): string {
  const labels: Record<string, string> = {
    button: 'Actions',
    input: 'Inputs',
    checkbox: 'Checks',
    switch: 'Switches',
    slider: 'Ranges',
    surface: 'Surfaces',
    card: 'Cards',
    media: 'Media',
    navigation: 'Navigation',
    separator: 'Separators',
    list: 'Lists',
    row: 'Rows',
    loading: 'Loading',
    badge: 'Badges',
    icon: 'Icons',
    skeleton: 'Skeletons',
    dialog: 'Dialogs',
    menu: 'Menus',
    sheet: 'Sheets',
    generic: 'Generic'
  };
  return labels[family] ?? family;
}

function familyAccent(family: string): string {
  const accents: Record<string, string> = {
    token: 'var(--accent-token)',
    button: 'var(--accent-action)',
    input: 'var(--accent-input)',
    checkbox: 'var(--accent-input)',
    switch: 'var(--accent-input)',
    slider: 'var(--accent-input)',
    surface: 'var(--accent-surface)',
    card: 'var(--accent-surface)',
    media: 'var(--accent-surface)',
    navigation: 'var(--accent-surface)',
    separator: 'var(--accent-surface)',
    list: 'var(--accent-row)',
    row: 'var(--accent-row)',
    loading: 'var(--accent-feedback)',
    badge: 'var(--accent-feedback)',
    icon: 'var(--accent-feedback)',
    skeleton: 'var(--accent-feedback)',
    dialog: 'var(--accent-overlay)',
    menu: 'var(--accent-overlay)',
    sheet: 'var(--accent-overlay)',
    generic: 'var(--fg)'
  };
  return accents[family] ?? 'var(--fg)';
}

function familyWidth(family: string): number {
  if (family === 'button' || family === 'input') return 460;
  if (family === 'row' || family === 'list') return 430;
  return 400;
}

function firstStateToken(tokenIndex: TokenIndex, state: PrimitiveState, type: DesignToken['type']): TokenRecord | undefined {
  return state.tokens.map(tokenRef => tokenIndex.byRef.get(tokenRef)).find(record => record?.token.type === type);
}

function firstTokenFromGroups(
  tokenIndex: TokenIndex,
  groupIds: string[],
  type: DesignToken['type'],
  preferredTokenId?: string
): TokenRecord | undefined {
  for (const groupId of groupIds) {
    const group = tokenIndex.byGroup.get(groupId);
    if (!group) {
      continue;
    }
    const token = group.tokens.find(candidate => candidate.type === type && (!preferredTokenId || candidate.id === preferredTokenId));
    if (token) {
      return tokenIndex.byRef.get(`${group.id}.${token.id}`);
    }
  }
  for (const groupId of groupIds) {
    const group = tokenIndex.byGroup.get(groupId);
    const token = group?.tokens.find(candidate => candidate.type === type);
    if (group && token) {
      return tokenIndex.byRef.get(`${group.id}.${token.id}`);
    }
  }
  return undefined;
}

function setTokenHook(element: HTMLElement, record: TokenRecord | undefined, templateHook: string): void {
  if (!record) {
    return;
  }
  element.dataset.tokenRole = record.ref;
  element.dataset.templateHook = templateHook;
  element.dataset.tokenType = record.token.type;
  element.dataset.tokenStyleRef = record.token.styleRef;
}

function applyTokenPreview(element: HTMLElement, token: DesignToken): void {
  switch (token.type) {
    case 'color':
      element.style.background = token.value;
      break;
    case 'space':
      element.style.width = token.value;
      break;
    case 'radius':
      element.style.borderRadius = token.value;
      break;
    case 'typography':
      element.style.font = token.value;
      element.textContent = 'Aa';
      break;
    case 'shadow':
      element.style.boxShadow = token.value;
      break;
    case 'motion':
      element.textContent = 'ms';
      break;
  }
}

function mountScreens({ root, canvas: boardCanvas, project: bundle }: BoardContext): BoardMount {
  const configure = (): CanvasController =>
    boardCanvas.configure({
      minScale: 0.15,
      fallbackWidth: 393,
      fallbackHeight: 852
    });
  const controller = configure();
  const screen = bundle.screens.screens[0];
  root.append(createPrototypeFrame(bundle, screen, 90, 160));

  return {
    configure,
    fit: () => controller.fitTo([...root.querySelectorAll<HTMLElement>('.frame')])
  };
}

function addGroupHeading(
  root: HTMLElement,
  controller: CanvasController,
  options: { title: string; subtitle: string; x: number; y: number; accent: string }
): HTMLElement {
  const heading = el('div', 'group-head');
  heading.style.left = `${options.x}px`;
  heading.style.top = `${options.y}px`;
  heading.style.setProperty('--head-accent', options.accent);
  heading.append(el('h1', '', options.title), el('div', 'sub', options.subtitle));
  root.append(heading);
  controller.makeDraggable(heading, heading);
  return heading;
}

function createPrototypeFrame(bundle: BlueprintProjectBundle, screen: ScreenDefinition, x: number, y: number): HTMLElement {
  const frame = el('article', 'frame');
  frame.style.left = `${x}px`;
  frame.style.top = `${y}px`;
  setBoundary(frame, 'screen', screen.id, bundle.manifest.project.id, screen.name);
  frame.dataset.screenId = screen.id;
  frame.dataset.boundarySummary = screen.description;

  const head = el('div', 'frame-head');
  const chip = el('button', 'frame-chip') as HTMLButtonElement;
  chip.type = 'button';
  chip.title = 'Copy screen boundary id';
  chip.dataset.boundaryAction = 'copy-id';
  chip.append(el('span', 'dot'), el('span', 'frame-name', `${screen.id.toUpperCase()} · ${screen.name}`));
  chip.addEventListener('click', () => {
    void copyText(boundaryId(bundle.manifest.project.id, 'screen', screen.id));
    const name = chip.querySelector<HTMLElement>('.frame-name');
    const original = name?.textContent ?? '';
    if (name) {
      name.textContent = `${screen.id} copied`;
    }
    chip.classList.add('copied');
    window.setTimeout(() => {
      chip.classList.remove('copied');
      if (name) {
        name.textContent = original;
      }
    }, 900);
  });
  const shot = createIconButton('frame-shot', 'Copy screen as PNG', cameraIcon());
  const save = createIconButton('frame-save', 'Save screen as PNG', downloadIcon());
  head.append(chip, shot, save);

  const screenEl = el('div', 'screen screen-template');
  const body = el('div', 'screen-template-body');
  screenEl.append(createStatusBar(), body, el('div', 'home-indicator'));
  wireFrameCapture({ screenEl, shot, save, screenId: screen.id });

  frame.append(head, screenEl);
  return frame;
}

function createStatusBar(): HTMLElement {
  const status = el('div', 'status-bar');
  const icons = el('span', 'status-icons');
  icons.append(el('span', 'signal'), el('span', 'wifi'), el('span', 'battery'));
  status.append(el('span', 'time', '9:41'), icons);
  return status;
}

function createSpecCard(options: {
  label: string;
  x: number;
  y: number;
  width: number;
  accent: string;
  boundary: [BoundaryKind, string, string];
}): HTMLElement {
  const card = el('article', 'spec');
  card.style.left = `${options.x}px`;
  card.style.top = `${options.y}px`;
  card.style.width = `${options.width}px`;
  card.style.setProperty('--accent', options.accent);
  setBoundary(card, options.boundary[0], options.boundary[1], options.boundary[2], options.label);

  const chip = el('button', 'spec-chip') as HTMLButtonElement;
  chip.type = 'button';
  chip.title = 'Drag canvas item';
  chip.append(el('span', 'dot'), el('span', '', options.label));
  card.append(chip);
  return card;
}

function appendSpecBody(card: HTMLElement): HTMLElement {
  const body = el('div', 'spec-body');
  card.append(body);
  return body;
}

function createIconButton(className: string, title: string, iconMarkup: string): HTMLButtonElement {
  const button = el('button', className) as HTMLButtonElement;
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = iconMarkup;
  return button;
}

function wireFrameCapture(options: {
  screenEl: HTMLElement;
  shot: HTMLButtonElement;
  save: HTMLButtonElement;
  screenId: string;
}): void {
  const capture = async (): Promise<Blob> => {
    const blob = await toBlob(options.screenEl, {
      pixelRatio: 2,
      style: {
        boxShadow: 'none'
      }
    });
    if (!blob) {
      throw new Error('Screen capture returned an empty image.');
    }
    return blob;
  };

  options.shot.addEventListener('click', async () => {
    if (options.shot.classList.contains('busy')) {
      return;
    }
    options.shot.classList.add('busy');
    const blobPromise = capture();
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      flashCaptureButton(options.shot, 'done');
    } catch {
      const blob = await blobPromise.catch(() => null);
      if (blob) {
        downloadBlob(blob, options.screenId);
        flashCaptureButton(options.shot, 'done');
      } else {
        flashCaptureButton(options.shot, 'fail');
      }
    }
  });

  options.save.addEventListener('click', async () => {
    if (options.save.classList.contains('busy')) {
      return;
    }
    options.save.classList.add('busy');
    const blob = await capture().catch(() => null);
    if (blob) {
      downloadBlob(blob, options.screenId);
    }
    flashCaptureButton(options.save, blob ? 'done' : 'fail');
  });
}

function downloadBlob(blob: Blob, id: string): void {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = `${id}.png`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function flashCaptureButton(button: HTMLButtonElement, result: 'done' | 'fail'): void {
  button.classList.remove('busy');
  button.classList.add(result);
  window.setTimeout(() => button.classList.remove(result), 1200);
}

function cameraIcon(): string {
  return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>';
}

function downloadIcon(): string {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
}

function refreshCanvasReviewState(boardId: BoardId): void {
  const state = boardState.get(boardId);
  if (!state) {
    return;
  }

  const records = collectVisibleBoundaryRecords(state.root, boardId);
  const boundarySync = validateVisibleBoundaryRecords(project, records);
  const screenId = records.find(record => record.kind === 'screen')?.screenId;
  window.__BLUEPRINT_REVIEW__ = {
    projectId: project.manifest.project.id,
    boundarySync,
    manifest: createReviewManifest(project, records, {
      board: boardId,
      screenId,
      packetCommandBase: 'blueprint extract'
    }),
    styleEvidence: createCanvasStyleEvidence(project, records)
  };
}

function collectVisibleBoundaryRecords(root: HTMLElement, board: BoardId): VisibleBoundaryRecord[] {
  return [...root.querySelectorAll<HTMLElement>('[data-boundary-id][data-boundary-kind]')].map(element => {
    const computed = window.getComputedStyle(element);
    return {
      id: element.dataset.boundaryId ?? '',
      kind: (element.dataset.boundaryKind ?? 'project') as BoundaryKind,
      board,
      label: element.dataset.boundaryLabel ?? element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '',
      screenId: element.dataset.screenId,
      renderedSnippet: element.outerHTML.slice(0, 900),
      computedStyles: {
        backgroundColor: computed.backgroundColor,
        borderColor: computed.borderColor,
        borderRadius: computed.borderRadius,
        color: computed.color
      }
    };
  });
}

function setBoundary(element: HTMLElement, kind: BoundaryKind, localId: string, projectId: string, label = localId): void {
  element.dataset.boundaryId = boundaryId(projectId, kind, localId);
  element.dataset.boundaryKind = kind;
  element.dataset.boundaryLocalId = localId;
  element.dataset.boundaryLabel = label;
  element.dataset.handoffCommand = `blueprint extract --project ${project.sourceRoot} --boundary ${kind}:${localId} --mode deep`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
}

function isVisibleBoard(board: BoardDefinition): board is BoardDefinition & { id: BoardId } {
  return isBoardId(board.id);
}

function isBoardId(value: unknown): value is BoardId {
  return value === 'primitives' || value === 'screens';
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text) {
    node.textContent = text;
  }
  return node;
}

showBoard(isBoardId(requestedBoard) ? requestedBoard : defaultBoard);

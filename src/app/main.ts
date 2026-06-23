import './styles.css';
import { toBlob } from 'html-to-image';
import { boundaryId } from '../core/address';
import type { BlueprintProjectBundle, BoardDefinition, BoundaryKind, ScreenDefinition } from '../core/types';
import { createCanvasController, type CanvasController, type CanvasView } from './canvas-controller';
import { createCanvasItemLayout } from './canvas-layout';
import { loadStarterProject } from './fixture-projects';

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

interface PrimitiveSpecOptions {
  label: string;
  x: number;
  y: number;
  width: number;
  accent: string;
  boundary: [BoundaryKind, string, string];
  html: string;
  note?: string;
}

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Blueprint app root is missing.');
}

const project = loadStarterProject();
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
  const tone = {
    tokens: 'var(--accent-token)',
    text: 'var(--accent-text)',
    actions: 'var(--accent-action)',
    inputs: 'var(--accent-input)',
    surfaces: 'var(--accent-surface)',
    rows: 'var(--accent-row)',
    feedback: 'var(--accent-feedback)',
    overlays: 'var(--accent-overlay)'
  };

  addGroupHeading(root, controller, { title: 'Tokens', subtitle: 'replace these roles per app theme', x: 70, y: 300, accent: tone.tokens });
  addPrimitiveSpec(root, controller, {
    label: 'COLOR · brand and semantic',
    x: 70,
    y: 380,
    width: 560,
    accent: tone.tokens,
    boundary: ['token-group', 'color', projectId],
    html: colorSwatches(),
    note: 'These are default Blueprint roles, not a product palette. A new app changes token values and the primitive samples inherit them.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'COLOR · surface ladder 1-8',
    x: 70,
    y: 880,
    width: 560,
    accent: tone.tokens,
    boundary: ['token-group', 'color', projectId],
    html: surfaceLadder(),
    note: 'The ladder gives every card, row, menu, and sheet a predictable nesting level without baking in one app style.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'RADIUS scale',
    x: 70,
    y: 1330,
    width: 560,
    accent: tone.tokens,
    boundary: ['token-group', 'shape', projectId],
    html: radiusScale(),
    note: 'Use this as the starter geometry scale, then tune values for the app theme.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'TYPE roles',
    x: 70,
    y: 1560,
    width: 560,
    accent: tone.text,
    boundary: ['token-group', 'typography', projectId],
    html: typeRoles(),
    note: 'Type roles are named for function, not for the reference app fonts.'
  });

  addGroupHeading(root, controller, { title: 'Text', subtitle: 'typographic variants', x: 750, y: 300, accent: tone.text });
  addPrimitiveSpec(root, controller, {
    label: 'TEXT · all variants',
    x: 750,
    y: 380,
    width: 560,
    accent: tone.text,
    boundary: ['token-group', 'typography', projectId],
    html: textVariants(),
    note: 'Every app can change the typeface and scale while preserving stable variant names for agents and implementation.'
  });

  addGroupHeading(root, controller, {
    title: 'Actions',
    subtitle: 'button variants x normal / loading / disabled',
    x: 1430,
    y: 300,
    accent: tone.actions
  });
  addPrimitiveSpec(root, controller, {
    label: 'BUTTON · variant x state matrix',
    x: 1430,
    y: 380,
    width: 430,
    accent: tone.actions,
    boundary: ['primitive', 'button', projectId],
    html: buttonMatrix(),
    note: 'Button is the baseline command primitive. Apps should change token values and variant mapping, not reinvent the state surface.'
  });

  addGroupHeading(root, controller, { title: 'Inputs', subtitle: 'fields, checkbox, switch, otp, slider', x: 1990, y: 300, accent: tone.inputs });
  addPrimitiveSpec(root, controller, {
    label: 'INPUT · variant x state matrix',
    x: 1990,
    y: 380,
    width: 960,
    accent: tone.inputs,
    boundary: ['primitive', 'input', projectId],
    html: inputMatrix(),
    note: 'Input variants and states stay explicit so agents can translate focus, invalid, and disabled behavior without reading the canvas.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'CHECKBOX · states',
    x: 1990,
    y: 800,
    width: 700,
    accent: tone.inputs,
    boundary: ['primitive', 'checkbox', projectId],
    html: checkboxStates(),
    note: 'The live example toggles locally; the structured matrix defines the states an app owns.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'SWITCH · states',
    x: 1990,
    y: 990,
    width: 700,
    accent: tone.inputs,
    boundary: ['primitive', 'switch', projectId],
    html: switchStates(),
    note: 'Switch uses the same on/off/disabled matrix as the reference primitive system, generalized to tokens.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'OTP INPUT GRID',
    x: 1990,
    y: 1180,
    width: 360,
    accent: tone.inputs,
    boundary: ['primitive', 'otp-input', projectId],
    html: otpGrid(),
    note: 'A fixed-cell input specimen proves dense control sizing and focus treatment.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'SLIDER · size x tone',
    x: 1990,
    y: 1380,
    width: 360,
    accent: tone.inputs,
    boundary: ['primitive', 'slider', projectId],
    html: sliderSamples(),
    note: 'Track height, thumb size, tone, and disabled behavior are visible because they often drift during app implementation.'
  });

  addGroupHeading(root, controller, { title: 'Surfaces', subtitle: 'surface, card, media, nav, separator', x: 3090, y: 300, accent: tone.surfaces });
  addPrimitiveSpec(root, controller, {
    label: 'SURFACE · nested 2-8',
    x: 3090,
    y: 380,
    width: 460,
    accent: tone.surfaces,
    boundary: ['primitive', 'surface', projectId],
    html: surfaceNest(2),
    note: 'The base canvas is level 1; anything sitting on it starts at level 2 and steps up as it nests.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'CARD · default / flat / elevated',
    x: 3090,
    y: 1110,
    width: 430,
    accent: tone.surfaces,
    boundary: ['primitive', 'card', projectId],
    html: cardVariants(),
    note: 'Cards are generic content containers. The treatment changes, but the card role remains stable.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'MEDIA CARD · cover / nested',
    x: 3090,
    y: 1540,
    width: 430,
    accent: tone.surfaces,
    boundary: ['primitive', 'media-card', projectId],
    html: mediaCards(),
    note: 'Media cards prove clipping, inset rhythm, overlay text, and nested radius behavior.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'NAVBAR · slot compositions',
    x: 3610,
    y: 455,
    width: 430,
    accent: tone.surfaces,
    boundary: ['primitive', 'nav-bar', projectId],
    html: navBarSamples(),
    note: 'The slot model preserves center alignment while allowing left and right controls to vary.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'BACK BUTTON + SEPARATOR',
    x: 3610,
    y: 880,
    width: 430,
    accent: tone.surfaces,
    boundary: ['primitive', 'back-button', projectId],
    html: backAndSeparator(),
    note: 'Small navigation pieces still need explicit primitive treatment because they repeat everywhere.'
  });

  addGroupHeading(root, controller, { title: 'Rows', subtitle: 'list, row layout, pressable groups', x: 4190, y: 300, accent: tone.rows });
  addPrimitiveSpec(root, controller, {
    label: 'LIST · grouped items + dividers',
    x: 4190,
    y: 380,
    width: 400,
    accent: tone.rows,
    boundary: ['primitive', 'list', projectId],
    html: groupedList(),
    note: 'List owns grouping and dividers; each row still exposes leading, body, and trailing slots.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'PRESSABLE ROW · standalone',
    x: 4190,
    y: 800,
    width: 400,
    accent: tone.rows,
    boundary: ['primitive', 'pressable-row', projectId],
    html: pressableRow(),
    note: 'Standalone rows own their own surface and tap target.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'PRESSABLE SURFACE · group shapes',
    x: 4190,
    y: 1000,
    width: 400,
    accent: tone.rows,
    boundary: ['primitive', 'pressable-row', projectId],
    html: groupedRows(),
    note: 'Group-first, group-middle, and group-last shapes let apps build row stacks without a wrapper card.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'ROW LAYOUT · slots only',
    x: 4190,
    y: 1330,
    width: 400,
    accent: tone.rows,
    boundary: ['primitive', 'row-layout', projectId],
    html: rowLayoutOnly(),
    note: 'The bare row layout gives agents a targetable composition primitive with no surface assumptions.'
  });

  addGroupHeading(root, controller, { title: 'Feedback', subtitle: 'loading, badge, icon, skeleton', x: 4770, y: 300, accent: tone.feedback });
  addPrimitiveSpec(root, controller, {
    label: 'LOADING MARK',
    x: 4770,
    y: 380,
    width: 400,
    accent: tone.feedback,
    boundary: ['primitive', 'loading-mark', projectId],
    html: loadingMarks(),
    note: 'The reference-specific mark becomes a generic loading primitive that inherits app colors.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'BADGE · variants',
    x: 4770,
    y: 840,
    width: 400,
    accent: tone.feedback,
    boundary: ['primitive', 'badge', projectId],
    html: badges(),
    note: 'Badge variants are small, but they carry important semantic and density behavior.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'ICON + SKELETON',
    x: 4770,
    y: 1040,
    width: 400,
    accent: tone.feedback,
    boundary: ['primitive', 'skeleton', projectId],
    html: iconAndSkeleton(),
    note: 'Icon and skeleton primitives are kept visible because they often become one-off app code otherwise.'
  });

  addGroupHeading(root, controller, { title: 'Overlays', subtitle: 'dialog, menu, sheet', x: 5350, y: 300, accent: tone.overlays });
  addPrimitiveSpec(root, controller, {
    label: 'ALERT DIALOG · neutral / destructive',
    x: 5350,
    y: 380,
    width: 380,
    accent: tone.overlays,
    boundary: ['primitive', 'alert-dialog', projectId],
    html: alertDialogs(),
    note: 'Dialog intent changes the action, not the whole panel treatment.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'CONTEXT MENU · open state',
    x: 5350,
    y: 960,
    width: 380,
    accent: tone.overlays,
    boundary: ['primitive', 'context-menu', projectId],
    html: contextMenu(),
    note: 'The open-state menu is rendered so row spacing, indicators, shortcuts, and destructive items can be inspected.'
  });
  addPrimitiveSpec(root, controller, {
    label: 'BOTTOM SHEET · nav + content + footer',
    x: 5810,
    y: 455,
    width: 420,
    accent: tone.overlays,
    boundary: ['primitive', 'bottom-sheet', projectId],
    html: bottomSheet(),
    note: 'Sheet is modeled as composed primitives: handle, navbar, body, and footer action slot.'
  });

  root.addEventListener('click', event => {
    const live = (event.target as HTMLElement).closest<HTMLElement>('.cbx.live, .sw.live');
    if (live) {
      live.classList.toggle('on');
    }
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

function addPrimitiveSpec(root: HTMLElement, controller: CanvasController, options: PrimitiveSpecOptions): HTMLElement {
  const card = createSpecCard({
    label: options.label,
    x: options.x,
    y: options.y,
    width: options.width,
    accent: options.accent,
    boundary: options.boundary
  });
  const body = appendSpecBody(card);
  body.innerHTML = options.html;
  if (options.note) {
    body.append(el('p', 'spec-note', options.note));
  }
  root.append(card);
  controller.makeDraggable(card, card.querySelector<HTMLElement>('.spec-chip') ?? card);
  return card;
}

function createPrototypeFrame(bundle: BlueprintProjectBundle, screen: ScreenDefinition, x: number, y: number): HTMLElement {
  const frame = el('article', 'frame');
  frame.style.left = `${x}px`;
  frame.style.top = `${y}px`;
  setBoundary(frame, 'screen', screen.id, bundle.manifest.project.id);
  frame.dataset.screenId = screen.id;

  const head = el('div', 'frame-head');
  const chip = el('button', 'frame-chip') as HTMLButtonElement;
  chip.type = 'button';
  chip.title = 'Copy screen id';
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
  screenEl.append(createStatusBar(), el('div', 'screen-template-body'), el('div', 'home-indicator'));
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
  setBoundary(card, options.boundary[0], options.boundary[1], options.boundary[2]);

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

function colorSwatches(): string {
  const swatches = [
    ['primary', 'default command role', 'var(--primary)'],
    ['primary-foreground', 'text on primary', 'var(--primary-fg)'],
    ['secondary', 'supporting command role', 'var(--secondary)'],
    ['accent', 'focus and accent role', 'var(--accent)'],
    ['destructive', 'negative action', 'var(--destructive)'],
    ['success', 'positive state', 'var(--success)'],
    ['warning', 'attention state', 'var(--warning)'],
    ['foreground', 'primary text', 'var(--fg)'],
    ['muted-foreground', 'secondary text', 'var(--muted-fg)'],
    ['border', 'default border', 'var(--border)'],
    ['background', 'canvas base', 'var(--canvas-bg)']
  ];
  return `<div class="swatches">${swatches
    .map(([name, detail, value]) => `<div class="swatch-row"><div class="chip" style="background:${value}"></div><div class="meta"><b>${name}</b><span>${detail}</span></div></div>`)
    .join('')}</div>`;
}

function surfaceLadder(): string {
  return `<div class="ladder">${Array.from({ length: 8 }, (_, index) => {
    const level = index + 1;
    return `<div class="rung" style="background:var(--surface-${level})"><b>surface-${level}</b><span>level ${level}</span></div>`;
  }).join('')}</div>`;
}

function radiusScale(): string {
  const radii = [
    ['sm', '6px', 'var(--r-sm)'],
    ['md', '9px', 'var(--r-md)'],
    ['lg', '14px', 'var(--r-lg)'],
    ['xl', '18px', 'var(--r-xl)'],
    ['2xl', '24px', 'var(--r-2xl)'],
    ['full', '999px', '999px']
  ];
  return `<div class="radii">${radii
    .map(([name, value, cssValue]) => `<div class="radius-item"><div class="box" style="border-radius:${cssValue}"></div><b>rounded-${name}</b><span>${value}</span></div>`)
    .join('')}</div>`;
}

function typeRoles(): string {
  const faces = [
    ['Display', 'headlines, hero labels, high-emphasis titles'],
    ['Interface', 'body, controls, rows, cards, sheets'],
    ['Mono Label', 'caption, badge, code, metadata'],
    ['Numeral', 'OTP, counters, index marks']
  ];
  return `<div class="faces">${faces.map(([name, detail]) => `<div class="face"><b>${name}</b><span>${detail}</span></div>`).join('')}</div>`;
}

const TEXT_VARIANTS = ['display', 'h1', 'h2', 'h3', 'h4', 'p', 'large', 'lead', 'base', 'small', 'muted', 'tiny', 'label', 'caption', 'blockquote', 'code'];

function textVariants(): string {
  return `<div class="tspec">${TEXT_VARIANTS.map(
    variant => `<div><div class="tlabel">${variant}</div><div class="t-${variant}">Blueprint primitive text sample</div></div>`
  ).join('')}</div>`;
}

const BUTTON_VARIANTS = ['primary', 'secondary', 'tonal', 'outline', 'ghost', 'destructive', 'accent', 'success', 'gradient', 'link'];

function buttonMatrix(): string {
  return `<div class="mx button-state-matrix">
    <div class="mx-row"><div class="mx-label">Type</div><div class="mx-h">Normal</div><div class="mx-h">Loading</div><div class="mx-h">Disabled</div></div>
    ${BUTTON_VARIANTS.map(
      variant => `<div class="mx-row"><div class="mx-label">${variant}</div>${buttonCell(variant, '')}${buttonCell(variant, 'loading')}${buttonCell(variant, 'disabled')}</div>`
    ).join('')}
    <div class="mx-row icon-row"><div class="mx-label">icon</div><button class="btn btn-primary btn-icon">${icon('home', 20)}</button><button class="btn btn-secondary btn-icon is-loading"><span class="btn-label">${icon('settings', 20)}</span><span class="loading-dot"></span></button><button class="btn btn-secondary btn-icon is-disabled">${icon('settings', 20)}</button></div>
  </div>`;
}

function buttonCell(variant: string, state: string): string {
  const stateClass = state ? ` is-${state}` : '';
  const loading = state === 'loading' ? '<span class="loading-dot"></span>' : '';
  const sparkle = variant === 'gradient' ? `${icon('sparkles', 14)}` : '';
  return `<button class="btn btn-${variant}${stateClass}"><span class="btn-label">${sparkle}Action</span>${loading}</button>`;
}

const INPUT_VARIANTS = ['default', 'filled', 'ghost', 'outline', 'underline'];
const INPUT_STATES: Array<[string, string, string, boolean]> = [
  ['Empty', '', 'Placeholder', true],
  ['Value', '', 'Field value', false],
  ['Focused', 'is-focused', 'Focused', false],
  ['Invalid', 'is-invalid', 'Invalid', false],
  ['Disabled', 'is-disabled', 'Disabled', false]
];

function inputMatrix(): string {
  return `<div class="mx input-state-matrix">
    <div class="mx-row"><div class="mx-label">Type</div>${INPUT_STATES.map(([label]) => `<div class="mx-h input-h">${label}</div>`).join('')}</div>
    ${INPUT_VARIANTS.map(
      variant => `<div class="mx-row"><div class="mx-label">${variant}</div>${INPUT_STATES.map(([, stateClass, text, placeholder]) => `<div class="inp inp-${variant} ${stateClass}">${placeholder ? `<span class="ph">${text}</span>` : text}</div>`).join('')}</div>`
    ).join('')}
  </div>`;
}

function checkboxStates(): string {
  return `<div class="mx compact-state-matrix"><div class="mx-row"><div class="mx-label wide">Type</div>${['Off', 'On', 'Disabled', 'Disabled On', 'Live'].map(label => `<div class="mx-h">${label}</div>`).join('')}</div>
    <div class="mx-row"><div class="mx-label wide">Default</div><div class="mx-c">${checkbox('')}</div><div class="mx-c">${checkbox('on')}</div><div class="mx-c">${checkbox('is-disabled')}</div><div class="mx-c">${checkbox('is-disabled on')}</div><div class="mx-c">${checkbox('on live')}</div></div></div>`;
}

function switchStates(): string {
  return `<div class="mx compact-state-matrix"><div class="mx-row"><div class="mx-label wide">Type</div>${['Off', 'On', 'Disabled', 'Disabled On', 'Live'].map(label => `<div class="mx-h">${label}</div>`).join('')}</div>
    <div class="mx-row"><div class="mx-label wide">Default</div><div class="mx-c">${switcherControl('')}</div><div class="mx-c">${switcherControl('on')}</div><div class="mx-c">${switcherControl('is-disabled')}</div><div class="mx-c">${switcherControl('is-disabled on')}</div><div class="mx-c">${switcherControl('on live')}</div></div></div>`;
}

function checkbox(state: string): string {
  return `<div class="cbx ${state}">${icon('check', 14)}</div>`;
}

function switcherControl(state: string): string {
  return `<div class="sw ${state}"><div class="thumb"></div></div>`;
}

function otpGrid(): string {
  return `<div class="otp"><div class="cell filled">2</div><div class="cell filled">4</div><div class="cell focused"></div><div class="cell"></div><div class="cell"></div><div class="cell"></div></div>`;
}

function sliderSamples(): string {
  return `<div class="slider-stack">${sliderRow('Primary', 38, 4, 18, '')}${sliderRow('Secondary small', 62, 3, 16, 'secondary')}${sliderRow('Contrast large', 24, 6, 20, 'contrast')}${sliderRow('Disabled', 38, 4, 18, 'disabled')}</div>`;
}

function sliderRow(label: string, pct: number, trackH: number, thumbSize: number, tone: string): string {
  return `<div class="slider-row"><div class="tlabel">${label}</div><div class="slider ${tone}"><div class="track" style="height:${trackH}px"></div><div class="fill" style="width:${pct}%;height:${trackH}px"></div><div class="thumb" style="left:${pct}%;width:${thumbSize}px;height:${thumbSize}px"></div></div></div>`;
}

function surfaceNest(level: number): string {
  const inner = level < 8 ? surfaceNest(level + 1) : '';
  return `<div class="surf" style="background:var(--surface-${level})"><div class="surf-head"><b>Surface ${level}</b><span>+1</span></div>${inner}</div>`;
}

function cardVariants(): string {
  return `<div class="card-stack">
    <div class="card"><div class="card-h"><div class="card-title">Default Card</div><div class="card-desc">Passive surface with frame only.</div></div><div class="card-c"><div class="t-small">Used for settings, summaries, and grouped content.</div></div><div class="card-f"><button class="btn btn-primary">Action</button></div></div>
    <div class="card flat"><div class="card-h"><div class="card-title">Flat Card</div><div class="card-desc">Quiet nested surface.</div></div></div>
    <div class="card elevated status-accent"><div class="card-h"><div class="card-title">Elevated Status</div><div class="card-desc">Semantic frame color.</div></div><div class="card-c"><span class="badge badge-accent">accent</span></div></div>
  </div>`;
}

function mediaCards(): string {
  return `<div class="card-stack">
    <div class="card media-cover"><div class="media"></div><span class="badge media-flag">0:24</span><div class="media-scrim"><div class="card-title">Media Cover</div><div class="card-desc">Full-bleed media with overlay content.</div></div></div>
    <div class="card media-nested"><div class="media-inset"><div class="media"></div></div><div class="card-h"><div class="card-title">Nested Media</div><div class="card-desc">Inset media on a stable gutter.</div></div><div class="card-f"><span class="badge badge-tonal">media</span><button class="btn btn-primary">Open</button></div></div>
  </div>`;
}

function navBarSamples(): string {
  return `<div class="sample-stack">
    <div class="navbar"><div class="side">${backButton('md')}</div><div class="center"><div class="title">Navigation Bar</div></div><div class="side right">${smallIconButton('bell')}</div></div>
    <div class="navbar"><div class="side">${backButton('md')}</div><div class="center"><div class="title">Back Only</div></div><div class="side"></div></div>
    <div class="navbar"><div class="side"></div><div class="center"><div class="title">Right Action</div></div><div class="side right">${smallIconButton('search')}</div></div>
    <div class="navbar"><div class="side">${backButton('md')}</div><div class="center"><div class="title">A Very Long Navigation Title</div></div><div class="side right">${smallIconButton('search')}${smallIconButton('moreHorizontal')}</div></div>
    <div class="navbar"><div class="side"></div><div class="center"><span class="badge badge-tonal">Custom center</span></div><div class="side right"><div class="circle-surface">A</div></div></div>
  </div>`;
}

function backAndSeparator(): string {
  return `<div class="sample-stack centered"><div class="inline-sample">${backButton('md')}${backButton('sm')}${backButton('md', true)}</div><div class="separator"></div></div>`;
}

function groupedList(): string {
  return `<div class="list">
    ${listRow('Default list item', 'Trailing chevron', icon('music2', 14), icon('chevronRight', 20))}
    <div class="sep-subtle"></div>
    ${listRow('Item with trailing', 'Custom trailing content', icon('share2', 14), '<span class="badge badge-secondary">New</span>')}
    <div class="sep-subtle"></div>
    ${listRow('Static item', 'No press behavior', icon('music2', 14), '<span class="badge badge-outline">Info</span>')}
  </div>`;
}

function pressableRow(): string {
  return `<div class="prow">${listRow('Standalone pressable row', 'Owns its surface', icon('music2', 20), icon('chevronRight', 20), 'iconbox')}</div>`;
}

function groupedRows(): string {
  return `<div class="group-rows">${['first', 'middle', 'last'].map((shape, index) => `<div class="prow ${shape}">${listRow(`Grouped pressable row ${index + 1}`, `group${shape}`, icon('music2', 18), icon('chevronRight', 18), 'iconbox small')}</div>`).join('')}</div>`;
}

function rowLayoutOnly(): string {
  return `<div class="lrow bare"><div class="iconbox small">${icon('share2', 16)}</div><div class="body"><b>Row layout only</b><span>No surface, no press</span></div><div class="trail"><span class="t-small">Slot</span></div></div>`;
}

function listRow(title: string, detail: string, leading: string, trailing: string, leadingClass = 'lead-circle'): string {
  return `<div class="lrow"><div class="${leadingClass}">${leading}</div><div class="body"><b>${title}</b><span>${detail}</span></div><div class="trail">${trailing}</div></div>`;
}

function loadingMarks(): string {
  return `<div class="loading-stack"><div class="loading-panel"><span class="load-mark"><i></i><i></i><i></i></span></div><div class="loading-row primary"><span>Primary loading</span><span class="load-mark small"><i></i><i></i><i></i></span></div><div class="loading-row surface"><span>Surface loading</span><span class="load-mark small"><i></i><i></i><i></i></span></div></div>`;
}

function badges(): string {
  return `<div class="badge-wrap">${['default', 'secondary', 'tonal', 'accent', 'destructive', 'success', 'outline'].map(variant => `<span class="badge badge-${variant}">${variant}</span>`).join('')}</div>`;
}

function iconAndSkeleton(): string {
  return `<div class="sample-stack"><div class="inline-sample">${icon('heart', 22)}${icon('sparkles', 22)}<span class="emoji">Aa</span></div><div class="skeleton-stack"><div class="skel w66"></div><div class="skel block"></div><div class="skel-card"><div class="skel w50"></div><div class="skel block small"></div></div></div></div>`;
}

function alertDialogs(): string {
  return `<div class="dialog-stack"><div class="dialog"><div><div class="d-title">AlertDialog title</div><div class="d-desc">Current alert dialog surface, title, description, and actions.</div></div><div class="d-foot"><button class="btn btn-secondary">Cancel</button><button class="btn btn-primary">Continue</button></div></div><div class="dialog"><div><div class="d-title">Delete item?</div><div class="d-desc">Destructive intent keeps the dialog surface neutral.</div></div><div class="d-foot"><button class="btn btn-secondary">Cancel</button><button class="btn btn-destructive">Delete</button></div></div></div>`;
}

function contextMenu(): string {
  return `<div class="menu-wrap"><button class="btn btn-secondary">${icon('moreHorizontal', 18)}Context menu</button><div class="menu"><div class="m-label">ContextMenu label</div><div class="m-item">Default item<span class="shortcut">Cmd K</span></div><div class="m-item inset"><span class="indicator">${icon('check', 14)}</span>Checkbox item</div><div class="m-sep"></div><div class="m-item inset"><span class="indicator"><span class="rdot"></span></span>Soft motion</div><div class="m-item inset">Firm motion</div><div class="m-sep"></div><div class="m-item">Sub menu<span class="chev">${icon('chevronRight', 16)}</span></div><div class="m-sep"></div><div class="m-item destructive">Destructive item</div></div></div>`;
}

function bottomSheet(): string {
  return `<div class="sheet-sample"><div class="handle"></div><div class="sheet-nav">${navBarSamples().replace('sample-stack', 'sheet-stack')}</div><div class="s-body"><div class="t-muted">Content slot with stable inset rhythm.</div><div class="s-input">BottomSheetTextInput</div></div><div class="s-foot"><button class="btn btn-primary">Continue</button></div></div>`;
}

function backButton(size: 'sm' | 'md', disabled = false): string {
  const className = size === 'sm' ? 'btn btn-secondary btn-round sm' : 'btn btn-secondary btn-round';
  return `<button class="${className} ${disabled ? 'is-disabled' : ''}">${icon('arrowLeft', size === 'sm' ? 18 : 20)}</button>`;
}

function smallIconButton(name: string): string {
  return `<button class="btn btn-secondary btn-icon-sm">${icon(name, 18)}</button>`;
}

const ICON_PATHS: Record<string, string> = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  moreHorizontal: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  music2: '<circle cx="8" cy="18" r="4"/><path d="M12 18V2l7 4"/>',
  share2: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>'
};

function icon(name: string, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ''}</svg>`;
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
  return icon('camera', 15);
}

function downloadIcon(): string {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
}

function setBoundary(element: HTMLElement, kind: BoundaryKind, localId: string, projectId: string): void {
  element.dataset.boundaryId = boundaryId(projectId, kind, localId);
  element.dataset.boundaryKind = kind;
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

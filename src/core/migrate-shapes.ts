import { humanizeId, isTitleCase, toSentenceCase } from './reusable-contract';
import {
  PAGE_FIELDS,
  PRODUCTION_RELATIONSHIP_FIELDS,
  PRODUCTION_RELATIONSHIP_OPTIONAL_FIELDS,
  SCREEN_FIELD_ORDER,
  SCREEN_FILE_FIELDS,
  SECTION_FIELDS,
  SECTION_USE_FIELDS,
  SECTION_USE_OPTIONAL_FIELDS
} from './screen-contract';
import { TOKEN_FIELDS, TOKEN_FILE_FIELDS, TOKEN_GROUP_FIELDS } from './token-contract';

type RawObject = Record<string, unknown>;

/** Values migrate adds for fields the fixed shapes require, when an older file left them out. */
const SCREEN_DEFAULTS: Record<string, () => unknown> = {
  styleRefs: () => [],
  styleEvidence: () => [],
  notes: () => [],
  prototypeOnly: () => false,
  implementationHints: () => [],
  implementationTargets: () => [],
  sections: () => []
};
const SECTION_DEFAULTS: Record<string, () => unknown> = {
  styleRefs: () => [],
  styleEvidence: () => [],
  uses: () => [],
  prototypeOnly: () => false,
  notes: () => [],
  implementationHints: () => [],
  implementationTargets: () => []
};
const RELATIONSHIP_DEFAULTS: Record<string, () => unknown> = { notes: () => [] };
const TOKEN_GROUP_DEFAULTS: Record<string, () => unknown> = { styleRefs: () => [], notes: () => [] };
/** Token types older sidecars wrote under another name. */
const TOKEN_TYPE_NAMES: Readonly<Record<string, string>> = { spacing: 'space', colour: 'color', sizing: 'size' };

const RELATIONSHIP_ORDER = ['kind', ...PRODUCTION_RELATIONSHIP_OPTIONAL_FIELDS, ...PRODUCTION_RELATIONSHIP_FIELDS.slice(1)];
const USE_ORDER = [...SECTION_USE_FIELDS, ...SECTION_USE_OPTIONAL_FIELDS];

interface ShapeTally {
  filled: number;
  reordered: number;
  renamed: string[];
}

/** Puts screens.json and every saved screen snapshot in the fixed screen shape; flows on current screens become declared pages, and snapshots keep theirs because restore puts a screen back on its current page. */
export function normalizeScreenShapes(files: ReadonlyMap<string, string>, writes: Map<string, string>, changes: string[]): void {
  const text = writes.get('screens.json') ?? files.get('screens.json');
  if (text === undefined) return;
  const file = asObject(JSON.parse(text));
  const tally: ShapeTally = { filled: 0, reordered: 0, renamed: [] };
  const pages = asArray(file.pages).filter(isObject);
  const pageIds = new Set(pages.map(page => String(page.id)));
  const addedPages: string[] = [];
  let movedFlows = 0;

  const screens = asArray(file.screens).map(screen => {
    if (!isObject(screen)) return screen;
    const page = movePageFromFlow(screen);
    if (page !== undefined) movedFlows += 1;
    if (page && !pageIds.has(page.id)) {
      pages.push({ id: page.id, name: page.name });
      pageIds.add(page.id);
      addedPages.push(page.id);
    }
    return normalizeScreen(screen, tally);
  });
  file.pages = pages.map(page => {
    sentenceCaseName(page, tally);
    return ordered(page, PAGE_FIELDS, tally);
  });
  file.screens = screens;
  writeIfChanged(writes, 'screens.json', text, ordered(file, SCREEN_FILE_FIELDS, tally));

  if (movedFlows > 0) {
    changes.push(addedPages.length > 0
      ? `screens.json: ${movedFlows} screen${plural(movedFlows)} moved from flow to page, and ${addedPages.length} new page${plural(addedPages.length)} ${addedPages.length > 1 ? 'are' : 'is'} declared: ${addedPages.map(id => `"${id}"`).join(', ')}. Give each new page a description.`
      : `screens.json: ${movedFlows} screen${plural(movedFlows)} moved from flow to page.`);
  }
  if (tally.filled > 0) {
    changes.push(`screens.json: added the fields the fixed shape requires to ${tally.filled} of the screens and sections, as empty lists or false.`);
  }
  reportNames(changes, 'screens.json', tally);
  if (tally.reordered > 0) {
    changes.push('screens.json: pages, screens, and sections now use the fixed field order.');
  }

  let snapshots = 0;
  for (const recordFile of [...new Set([...files.keys(), ...writes.keys()])].filter(isSnapshotRecord).sort()) {
    const before = writes.get(recordFile) ?? files.get(recordFile)!;
    const record = asObject(JSON.parse(before));
    const recordTally: ShapeTally = { filled: 0, reordered: 0, renamed: [] };
    const exploration = asObject(record.exploration);
    const baseline = asObject(asObject(exploration.target).baseline);
    const entry = asObject(record.entry);
    for (const holder of [baseline, entry]) {
      if (!isObject(holder.screen)) continue;
      holder.screen = normalizeScreen(holder.screen as RawObject, recordTally);
    }
    if (writeIfChanged(writes, recordFile, before, record)) snapshots += 1;
  }
  if (snapshots > 0) {
    changes.push(`explorations and history: ${snapshots} saved screen snapshot${plural(snapshots)} now use the fixed screen shape.`);
  }
}

export function normalizeTokenShapes(files: ReadonlyMap<string, string>, writes: Map<string, string>, changes: string[]): void {
  const text = writes.get('tokens.json') ?? files.get('tokens.json');
  if (text === undefined) return;
  const file = asObject(JSON.parse(text));
  const tally: ShapeTally = { filled: 0, reordered: 0, renamed: [] };
  const retyped = new Map<string, number>();
  file.tokenGroups = asArray(file.tokenGroups).map(group => {
    if (!isObject(group)) return group;
    fillDefaults(group, TOKEN_GROUP_DEFAULTS, tally);
    sentenceCaseName(group, tally);
    group.tokens = asArray(group.tokens).map(token => {
      if (!isObject(token)) return token;
      sentenceCaseName(token, tally);
      if (typeof token.type === 'string' && Object.hasOwn(TOKEN_TYPE_NAMES, token.type)) {
        retyped.set(token.type, (retyped.get(token.type) ?? 0) + 1);
        token.type = TOKEN_TYPE_NAMES[token.type];
      }
      return ordered(token, TOKEN_FIELDS, tally);
    });
    return ordered(group, TOKEN_GROUP_FIELDS, tally);
  });
  writeIfChanged(writes, 'tokens.json', text, ordered(file, TOKEN_FILE_FIELDS, tally));
  if (tally.filled > 0) {
    changes.push(`tokens.json: ${tally.filled} token group${plural(tally.filled)} now carry styleRefs and notes.`);
  }
  reportNames(changes, 'tokens.json', tally);
  for (const [from, count] of retyped) {
    changes.push(`tokens.json: ${count} token${plural(count)} of type "${from}" now use${count === 1 ? 's' : ''} the type "${TOKEN_TYPE_NAMES[from]}".`);
  }
  if (tally.reordered > 0) {
    changes.push('tokens.json: token groups and tokens now use the fixed field order.');
  }
}

/** Rewrites a title-case name in sentence case, as validation requires, and records it in the tally. */
export function sentenceCaseName(item: RawObject, tally: Pick<ShapeTally, 'renamed'>): void {
  if (typeof item.name === 'string' && isTitleCase(item.name)) {
    const name = toSentenceCase(item.name);
    item.name = name;
    tally.renamed.push(name);
  }
}

export function reportNames(changes: string[], file: string, tally: Pick<ShapeTally, 'renamed'>): void {
  if (tally.renamed.length === 0) return;
  const examples = tally.renamed.slice(0, 3).map(name => `"${name}"`).join(', ');
  changes.push(`${file}: ${tally.renamed.length} name${plural(tally.renamed.length)} now use sentence case, such as ${examples}. Capitalize any proper noun the change made lowercase.`);
}

function normalizeScreen(screen: RawObject, tally: ShapeTally): RawObject {
  fillDefaults(screen, SCREEN_DEFAULTS, tally);
  sentenceCaseName(screen, tally);
  if (isObject(screen.productionRelationship)) {
    const relationship = screen.productionRelationship as RawObject;
    fillDefaults(relationship, RELATIONSHIP_DEFAULTS, tally);
    screen.productionRelationship = ordered(relationship, RELATIONSHIP_ORDER, tally);
  }
  screen.sections = asArray(screen.sections).map(section => {
    if (!isObject(section)) return section;
    fillDefaults(section, SECTION_DEFAULTS, tally);
    sentenceCaseName(section, tally);
    section.uses = asArray(section.uses).map(use => (isObject(use) ? ordered(use, USE_ORDER, tally) : use));
    return ordered(section, SECTION_FIELDS, tally);
  });
  return ordered(screen, SCREEN_FIELD_ORDER, tally);
}

/** Removes `flow`; @returns the page it maps to when the screen has none, `null` when it keeps its page, or undefined without a flow. */
function movePageFromFlow(screen: RawObject): { id: string; name: string } | null | undefined {
  if (!('flow' in screen)) return undefined;
  const flow = screen.flow;
  delete screen.flow;
  if ((typeof screen.page === 'string' && screen.page) || typeof flow !== 'string' || !flow.trim()) return null;
  const id = flow.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'screens';
  screen.page = id;
  return { id, name: /[A-Z]/.test(flow) ? flow.trim() : humanizeId(flow.trim()) };
}

function fillDefaults(item: RawObject, defaults: Record<string, () => unknown>, tally: ShapeTally): void {
  let filled = false;
  for (const [field, value] of Object.entries(defaults)) {
    if (!(field in item)) {
      item[field] = value();
      filled = true;
    }
  }
  if (filled) tally.filled += 1;
}

/** Copies an object with its known fields in contract order, followed by any unknown fields for validation to report. */
function ordered(item: RawObject, order: readonly string[], tally: ShapeTally): RawObject {
  const result: RawObject = {};
  for (const field of order) {
    if (field in item) result[field] = item[field];
  }
  for (const [field, value] of Object.entries(item)) {
    if (!(field in result)) result[field] = value;
  }
  if (Object.keys(result).join('\u0000') !== Object.keys(item).join('\u0000')) tally.reordered += 1;
  return result;
}

function writeIfChanged(writes: Map<string, string>, file: string, before: string, value: unknown): boolean {
  if (JSON.stringify(JSON.parse(before)) === JSON.stringify(value)) return false;
  writes.set(file, `${JSON.stringify(value, null, 2)}\n`);
  return true;
}

function isSnapshotRecord(file: string): boolean {
  return /^(explorations|history)\/[^/]+\.json$/.test(file);
}

function plural(count: number): string {
  return count === 1 ? '' : 's';
}

function asObject(value: unknown): RawObject {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

import { boundaryId, parseBoundarySelector, reference } from './address';
import { placedBrandMarkIds } from './brand-lint';
import type {
  BlueprintProjectBundle,
  DeclaredGroup,
  BoundaryDependency,
  BoundaryKind,
  BoundaryPacket,
  BoundaryReference,
  BoundarySelector,
  ComponentDefinition,
  DeepHandoffPacket,
  DesignToken,
  ExtractionOptions,
  ExtractionPacket,
  PrimitiveDefinition,
  PrototypeRenderDecision,
  PrototypeSource,
  QueryResult,
  ResolvedToken,
  ReusableDefinition,
  ReusableDependency,
  ReusableKind,
  ScreenDefinition,
  ScreenSection,
  StyleEvidence,
  TokenUsage,
  TokenGroup,
  TraversalCycle
} from './types';

export function listBoundaryReferences(bundle: BlueprintProjectBundle): BoundaryReference[] {
  const projectId = bundle.manifest.project.id;

  return [
    reference(projectId, 'project', 'root', bundle.manifest.project.name),
    ...bundle.manifest.boards.map(board => reference(projectId, 'board', board.id, board.name)),
    ...bundle.tokens.tokenGroups.map(group => reference(projectId, 'token-group', group.id, group.name)),
    ...bundle.primitives.primitives.map(primitive => reference(projectId, 'primitive', primitive.id, primitive.name)),
    ...bundle.components.components.map(component => reference(projectId, 'component', component.id, component.name)),
    ...bundle.screens.screens.flatMap(screen => [
      reference(projectId, 'screen', screen.id, screen.name),
      ...screen.sections.map(section => reference(projectId, 'section', `${screen.id}/${section.id}`, section.name))
    ])
  ];
}

export interface DeclaredGroupIndex {
  pages: Array<DeclaredGroup & { screens: string[] }>;
  componentGroups: Array<DeclaredGroup & { components: string[] }>;
}

/** Declared screen pages and component groups with their members, so an agent can place new work without reading the JSON. */
export function listDeclaredGroups(bundle: BlueprintProjectBundle): DeclaredGroupIndex {
  return {
    pages: (bundle.screens.pages ?? []).map(page => ({
      ...page,
      screens: bundle.screens.screens.filter(screen => screen.page === page.id).map(screen => screen.id)
    })),
    componentGroups: (bundle.components.groups ?? []).map(group => ({
      ...group,
      components: bundle.components.components.filter(component => component.group === group.id).map(component => component.id)
    }))
  };
}

export function showBoundary(bundle: BlueprintProjectBundle, selectorOrInput: BoundarySelector | string): BoundaryPacket {
  const selector = typeof selectorOrInput === 'string' ? parseQueryBoundarySelector(selectorOrInput) : selectorOrInput;

  switch (selector.kind) {
    case 'project':
      return packet(bundle, selector.kind, 'root', {
        ...bundle.manifest.project,
        ...(bundle.brand ? { brand: bundle.brand } : {}),
        ...(bundle.inspo ? { inspo: bundle.inspo } : {})
      }, {
        sourceFiles: [bundle.sourceFiles.manifest, ...brandSourceFiles(bundle), ...(bundle.sourceFiles.inspo ? [bundle.sourceFiles.inspo] : [])],
        styleRefs: [],
        styleEvidence: [],
        uses: [],
        usedBy: [],
        notes: [bundle.manifest.project.description],
        prototypeOnly: false,
        implementationHints: [
          'Instantiate this sourceRoot inside an app-owned design/blueprint folder.',
          ...(bundle.brand ? [BRAND_IMPLEMENTATION_HINT] : [])
        ]
      });
    case 'board': {
      const board = requireItem(bundle.manifest.boards.find(item => item.id === selector.id), `board:${selector.id}`);
      return packet(bundle, selector.kind, board.id, board, {
        sourceFiles: [bundle.sourceFiles.manifest],
        styleRefs: [],
        styleEvidence: [],
        uses: [],
        usedBy: [],
        notes: [board.description],
        prototypeOnly: false,
        implementationHints: ['Boards organize inspectable boundaries but do not own app design content.']
      });
    }
    case 'token-group': {
      const group = findTokenGroup(bundle, selector.id);
      return tokenGroupPacket(bundle, group);
    }
    case 'primitive':
      return reusablePacket(bundle, 'primitive', findPrimitive(bundle, selector.id));
    case 'component':
      return reusablePacket(bundle, 'component', findComponent(bundle, selector.id));
    case 'screen': {
      const screen = findScreen(bundle, selector.id);
      return screenPacket(bundle, screen);
    }
    case 'section': {
      const { screen, section } = findSection(bundle, selector.id);
      return sectionPacket(bundle, screen, section);
    }
    default:
      throw new Error(`Unsupported boundary kind "${String(selector.kind)}".`);
  }
}

function parseQueryBoundarySelector(input: string): BoundarySelector {
  const separatorIndex = input.indexOf(':');
  if (separatorIndex > 0 && input.slice(0, separatorIndex) === 'component') {
    const id = input.slice(separatorIndex + 1);
    if (!id) {
      throw new Error(`Boundary selector "${input}" must include a non-empty id.`);
    }
    return { kind: 'component', id };
  }
  return parseBoundarySelector(input);
}

export function queryUses(bundle: BlueprintProjectBundle, selectorInput: string): QueryResult {
  const packet = showBoundary(bundle, selectorInput);
  return {
    query: `uses:${selectorInput}`,
    projectId: bundle.manifest.project.id,
    results: packet.dependencies.uses
  };
}

export function queryUsedBy(bundle: BlueprintProjectBundle, selectorInput: string): QueryResult {
  const packet = showBoundary(bundle, selectorInput);
  return {
    query: `used-by:${selectorInput}`,
    projectId: bundle.manifest.project.id,
    results: packet.dependencies.usedBy
  };
}

export function querySections(bundle: BlueprintProjectBundle, screenId: string): QueryResult {
  const screen = findScreen(bundle, screenId);
  return {
    query: `sections:screen:${screenId}`,
    projectId: bundle.manifest.project.id,
    results: screen.sections.map(section => sectionPacket(bundle, screen, section))
  };
}

export function queryPrototypeOnly(bundle: BlueprintProjectBundle): QueryResult {
  const projectId = bundle.manifest.project.id;
  const primitives = bundle.primitives.primitives
    .filter(primitive => primitive.prototypeOnly)
    .map(primitive => reusablePacket(bundle, 'primitive', primitive));
  const sections = bundle.screens.screens.flatMap(screen =>
    screen.sections.filter(section => section.prototypeOnly).map(section => sectionPacket(bundle, screen, section))
  );
  const components = bundle.components.components
    .filter(component => component.prototypeOnly)
    .map(component => reusablePacket(bundle, 'component', component));

  return {
    query: 'prototype-only',
    projectId,
    results: [...primitives, ...components, ...sections]
  };
}

export function createExtractionPacket(
  bundle: BlueprintProjectBundle,
  selectorInput: string,
  options: ExtractionOptions = {}
): ExtractionPacket {
  if ((options.mode ?? 'focused') === 'deep') {
    return createDeepHandoffPacket(bundle, selectorInput);
  }

  const packet = showBoundary(bundle, selectorInput);
  return packet;
}

function createDeepHandoffPacket(bundle: BlueprintProjectBundle, selectorInput: string): DeepHandoffPacket {
  const selectedPacket = showBoundary(bundle, selectorInput);
  const selected = referenceForPacket(bundle, selectedPacket);
  const boundaries: BoundaryPacket[] = [];
  const cycles: TraversalCycle[] = [];
  const unsupportedReferences: string[] = [];
  const visited = new Set<string>();
  const queue: Array<{ selector: string; from?: string; path: string[] }> = [
    { selector: selectorInput, path: [selectedPacket.id] }
  ];

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) {
      break;
    }

    let current: BoundaryPacket;
    try {
      current = showBoundary(bundle, entry.selector);
    } catch (error) {
      unsupportedReferences.push(`${entry.selector}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (visited.has(current.id)) {
      continue;
    }

    visited.add(current.id);
    boundaries.push(current);

    for (const dependency of deepDependencyReferences(bundle, current)) {
      if (entry.path.includes(dependency.id)) {
        cycles.push({
          from: current.id,
          to: dependency.id,
          path: [...entry.path, dependency.id],
          reason: 'dependency already exists in the current traversal path'
        });
        continue;
      }

      if (visited.has(dependency.id)) {
        continue;
      }

      queue.push({
        selector: selectorFromReference(dependency),
        from: current.id,
        path: [...entry.path, dependency.id]
      });
    }
  }

  const includedBoundaryIds = boundaries.map(boundary => boundary.id);
  return {
    ...selectedPacket,
    extraction: {
      mode: 'deep',
      selected,
      includedBoundaryIds,
      cycles,
      unsupportedReferences
    },
    boundaries,
    resolvedTokens: resolveTokensForPackets(bundle, boundaries),
    tokenUsage: resolveTokenUsageForPackets(bundle, boundaries),
    ...(bundle.brand ? { brand: bundle.brand } : {})
  };
}

const BRAND_IMPLEMENTATION_HINT =
  'Write interface copy in brand.voice, and render logos from brand.marks sources with an approved variant at or above its minimum size and clear space.';

function brandSourceFiles(bundle: BlueprintProjectBundle): string[] {
  if (!bundle.sourceFiles.brand || !bundle.brand) {
    return [];
  }
  return [bundle.sourceFiles.brand, ...new Set(bundle.brand.marks.map(mark => sidecarPath(bundle, mark.source)))];
}

function deepDependencyReferences(bundle: BlueprintProjectBundle, packet: BoundaryPacket): BoundaryReference[] {
  const refs = [...packet.dependencies.uses];
  const localId = localIdFromPacket(packet);
  const projectId = bundle.manifest.project.id;

  if (packet.kind === 'screen') {
    const screen = findScreen(bundle, localId);
    return dedupeReferences([
      ...screen.sections.map(section => reference(projectId, 'section', `${screen.id}/${section.id}`, section.name)),
      ...refs
    ]);
  }

  return dedupeReferences(refs).sort(compareReferences);
}

function resolveTokensForPackets(bundle: BlueprintProjectBundle, packets: BoundaryPacket[]): ResolvedToken[] {
  const tokenRefs = new Set<string>();
  for (const packet of packets) {
    const reusable = reusableForPacket(bundle, packet);
    if (!reusable) {
      continue;
    }
    for (const tokenRef of Object.keys(reusable.tokenRoles)) {
      tokenRefs.add(tokenRef);
    }
    for (const tokenGroupId of reusable.tokenGroupIds) {
      const group = findTokenGroup(bundle, tokenGroupId);
      for (const token of group.tokens) {
        tokenRefs.add(`${group.id}.${token.id}`);
      }
    }
  }

  const tokenIndex = createTokenIndex(bundle);
  return [...tokenRefs].sort().flatMap(tokenRef => {
    const resolved = tokenIndex.get(tokenRef);
    return resolved ? [resolved] : [];
  });
}

function resolveTokenUsageForPackets(bundle: BlueprintProjectBundle, packets: BoundaryPacket[]): TokenUsage[] {
  const includedBoundaryIds = new Set(packets.map(packet => packet.id));
  const projectId = bundle.manifest.project.id;
  const tokenIndex = createTokenIndex(bundle);
  const usage: TokenUsage[] = [];
  const usageKeys = new Set<string>();

  const reusables = [
    ...bundle.primitives.primitives.map(reusable => ({ kind: 'primitive' as const, reusable })),
    ...bundle.components.components.map(reusable => ({ kind: 'component' as const, reusable }))
  ];
  for (const { kind, reusable } of reusables) {
    const reusableBoundaryId = boundaryId(projectId, kind, reusable.id);
    if (!includedBoundaryIds.has(reusableBoundaryId)) {
      continue;
    }
    for (const [tokenId, role] of Object.entries(reusable.tokenRoles)) {
      const token = tokenIndex.get(tokenId);
      const key = `${reusableBoundaryId}\u0000${tokenId}\u0000${role}`;
      if (!token || usageKeys.has(key)) {
        continue;
      }
      usageKeys.add(key);
      usage.push({ tokenId, role, boundaryId: reusableBoundaryId, boundaryKind: kind, styleRef: token.styleRef });
    }
  }

  return usage.sort((left, right) => {
    const boundarySort = left.boundaryId.localeCompare(right.boundaryId);
    if (boundarySort !== 0) {
      return boundarySort;
    }
    const tokenSort = left.tokenId.localeCompare(right.tokenId);
    return tokenSort !== 0 ? tokenSort : left.role.localeCompare(right.role);
  });
}

function reusableForPacket(bundle: BlueprintProjectBundle, packet: BoundaryPacket): ReusableDefinition | undefined {
  const localId = localIdFromPacket(packet);
  if (packet.kind === 'primitive') {
    return findPrimitive(bundle, localId);
  }
  if (packet.kind === 'component') {
    return findComponent(bundle, localId);
  }
  return undefined;
}

function createTokenIndex(bundle: BlueprintProjectBundle): Map<string, ResolvedToken> {
  const tokenIndex = new Map<string, ResolvedToken>();
  for (const group of bundle.tokens.tokenGroups) {
    for (const token of group.tokens) {
      tokenIndex.set(`${group.id}.${token.id}`, resolvedToken(group.id, token));
    }
  }
  return tokenIndex;
}

function resolvedToken(groupId: string, token: DesignToken): ResolvedToken {
  return {
    id: `${groupId}.${token.id}`,
    groupId,
    tokenId: token.id,
    name: token.name,
    type: token.type,
    value: token.value,
    description: token.description,
    styleRef: token.styleRef
  };
}

function tokenGroupPacket(bundle: BlueprintProjectBundle, group: TokenGroup): BoundaryPacket<TokenGroup> {
  return packet(bundle, 'token-group', group.id, group, {
    sourceFiles: [bundle.sourceFiles.tokens],
    styleRefs: group.styleRefs,
    styleEvidence: styleEvidenceFor(group.styleRefs),
    uses: [],
    usedBy: usedBy(bundle, 'token-group', group.id),
    notes: group.notes,
    prototypeOnly: false,
    implementationHints: [`Map ${group.name} tokens into the target app's design-token layer before component work.`]
  });
}

function reusablePacket(bundle: BlueprintProjectBundle, kind: ReusableKind, reusable: ReusableDefinition): BoundaryPacket<ReusableDefinition> {
  return packet(bundle, kind, reusable.id, reusable, {
    sourceFiles: [
      kind === 'primitive' ? bundle.sourceFiles.primitives : bundle.sourceFiles.components,
      ...prototypeSourceFiles(bundle, reusable.prototype)
    ],
    styleRefs: reusable.styleRefs,
    styleEvidence: styleEvidenceFor(reusable.styleRefs, reusable.styleEvidence),
    uses: dedupeReferences([
      ...reusable.tokenGroupIds.map(tokenGroupId => {
        const group = findTokenGroup(bundle, tokenGroupId);
        return reference(bundle.manifest.project.id, 'token-group', group.id, group.name);
      }),
      ...dependenciesToReferences(bundle, reusable.uses)
    ]),
    usedBy: usedBy(bundle, kind, reusable.id),
    notes: reusable.notes,
    prototypeOnly: reusable.prototypeOnly,
    implementationHints: reusable.implementationHints,
    rendering: {
      mode: 'canonical-app-owned',
      source: reusable.prototype.source
    }
  });
}

function screenPacket(bundle: BlueprintProjectBundle, screen: ScreenDefinition): BoundaryPacket<ScreenDefinition> {
  return packet(bundle, 'screen', screen.id, screen, {
    sourceFiles: [
      bundle.sourceFiles.manifest,
      bundle.sourceFiles.screens,
      bundle.sourceFiles.primitives,
      bundle.sourceFiles.tokens,
      bundle.sourceFiles.components,
      ...prototypeSourceFiles(bundle, screen.prototype, screen.prototype.assetRefs)
    ],
    styleRefs: screen.styleRefs,
    styleEvidence: styleEvidenceFor(screen.styleRefs, screen.styleEvidence),
    uses: dedupeReferences(screen.sections.flatMap(section => dependenciesToReferences(bundle, section.uses))),
    usedBy: usedBy(bundle, 'screen', screen.id),
    notes: [...screen.notes, ...screen.sections.flatMap(section => section.notes)],
    prototypeOnly: screen.prototypeOnly,
    implementationHints: [...screen.implementationHints, ...screen.sections.flatMap(section => section.implementationHints)],
    rendering: {
      mode: 'canonical-app-owned',
      source: screen.prototype.source
    }
  });
}

function sectionPacket(
  bundle: BlueprintProjectBundle,
  screen: ScreenDefinition,
  section: ScreenSection
): BoundaryPacket<ScreenSection> {
  return packet(bundle, 'section', `${screen.id}/${section.id}`, section, {
    sourceFiles: [bundle.sourceFiles.screens],
    styleRefs: [...screen.styleRefs, ...section.styleRefs],
    styleEvidence: styleEvidenceFor([...screen.styleRefs, ...section.styleRefs], [
      ...(screen.styleEvidence ?? []),
      ...(section.styleEvidence ?? [])
    ]),
    uses: dependenciesToReferences(bundle, section.uses),
    usedBy: [reference(bundle.manifest.project.id, 'screen', screen.id, screen.name)],
    notes: section.notes,
    prototypeOnly: section.prototypeOnly,
    implementationHints: section.implementationHints
  });
}

function packet<TData>(
  bundle: BlueprintProjectBundle,
  kind: BoundaryKind,
  localId: string,
  data: TData,
  options: {
    sourceFiles: string[];
    styleRefs: string[];
    styleEvidence: StyleEvidence[];
    uses: BoundaryReference[];
    usedBy: BoundaryReference[];
    notes: string[];
    prototypeOnly: boolean;
    implementationHints: string[];
    rendering?: PrototypeRenderDecision;
  }
): BoundaryPacket<TData> {
  return {
    id: boundaryId(bundle.manifest.project.id, kind, localId),
    kind,
    projectId: bundle.manifest.project.id,
    sourceFiles: options.sourceFiles,
    data,
    styleRefs: options.styleRefs,
    styleEvidence: options.styleEvidence,
    dependencies: {
      uses: options.uses,
      usedBy: options.usedBy
    },
    notes: options.notes,
    prototypeOnly: options.prototypeOnly,
    implementationHints: options.implementationHints,
    ...(options.rendering ? { rendering: options.rendering } : {})
  };
}

function prototypeSourceFiles(
  bundle: BlueprintProjectBundle,
  prototype: Pick<PrototypeSource, 'source' | 'styles'>,
  extraRefs: string[] = []
): string[] {
  const markSources = placedBrandMarkIds(bundle.prototypeSourceContents[prototype.source] ?? '')
    .flatMap(id => bundle.brand?.marks.find(mark => mark.id === id)?.source ?? []);
  const refs = [prototype.source, ...prototype.styles, ...extraRefs, ...(markSources.length > 0 ? ['brand.json', ...markSources] : [])];
  return [...new Set(refs.map(sourceRef => sidecarPath(bundle, sourceRef)))];
}

function sidecarPath(bundle: BlueprintProjectBundle, sourceRef: string): string {
  return `${bundle.sourceRoot}/${sourceRef.replace(/\\/g, '/').replace(/^\.\//, '')}`;
}

function styleEvidenceFor(styleRefs: string[], evidence: StyleEvidence[] = []): StyleEvidence[] {
  const byRef = new Map(evidence.map(item => [item.styleRef, item]));
  return styleRefs.map(styleRef => byRef.get(styleRef) ?? {
    styleRef,
    status: 'unresolved',
    notes: ['No explicit style evidence has been recorded for this style reference.']
  });
}

function referenceForPacket(bundle: BlueprintProjectBundle, packet: BoundaryPacket): BoundaryReference {
  const ref = listBoundaryReferences(bundle).find(item => item.id === packet.id);
  if (!ref) {
    throw new Error(`No boundary reference found for packet "${packet.id}".`);
  }
  return ref;
}

function selectorFromReference(ref: BoundaryReference): string {
  return `${ref.kind}:${ref.localId}`;
}

function localIdFromPacket(packet: BoundaryPacket): string {
  return packet.id.slice(`${packet.projectId}/${packet.kind}/`.length);
}

function compareReferences(left: BoundaryReference, right: BoundaryReference): number {
  return left.id.localeCompare(right.id);
}

function dependenciesToReferences(bundle: BlueprintProjectBundle, dependencies: Array<BoundaryDependency | ReusableDependency>): BoundaryReference[] {
  return dependencies.map(dependency => {
    if (dependency.kind === 'token-group') {
      const group = findTokenGroup(bundle, dependency.id);
      return reference(bundle.manifest.project.id, 'token-group', group.id, group.name);
    }

    if (dependency.kind === 'primitive') {
      const primitive = findPrimitive(bundle, dependency.id);
      return reference(bundle.manifest.project.id, 'primitive', primitive.id, primitive.name);
    }

    if (dependency.kind === 'component') {
      const component = findComponent(bundle, dependency.id);
      return reference(bundle.manifest.project.id, 'component', component.id, component.name);
    }

    if (dependency.kind === 'screen') {
      const screen = findScreen(bundle, dependency.id);
      return reference(bundle.manifest.project.id, 'screen', screen.id, screen.name);
    }

    if (dependency.kind === 'section') {
      const { screen, section } = findSection(bundle, dependency.id);
      return reference(bundle.manifest.project.id, 'section', `${screen.id}/${section.id}`, section.name);
    }

    throw new Error(`Unsupported dependency kind "${String((dependency as { kind: unknown }).kind)}".`);
  });
}

function usedBy(bundle: BlueprintProjectBundle, kind: BoundaryKind, localId: string): BoundaryReference[] {
  const projectId = bundle.manifest.project.id;
  const refs: BoundaryReference[] = [];

  if (kind === 'token-group') {
    for (const primitive of bundle.primitives.primitives) {
      if (primitive.tokenGroupIds.includes(localId)) {
        refs.push(reference(projectId, 'primitive', primitive.id, primitive.name));
      }
    }
    for (const component of bundle.components.components) {
      if (component.tokenGroupIds.includes(localId)) {
        refs.push(reference(projectId, 'component', component.id, component.name));
      }
    }
  }

  for (const primitive of bundle.primitives.primitives) {
    const hasDependency = primitive.uses.some(dependency => dependency.kind === kind && dependency.id === localId);
    if (hasDependency) {
      refs.push(reference(projectId, 'primitive', primitive.id, primitive.name));
    }
  }

  for (const component of bundle.components.components) {
    const hasDependency = component.uses.some(dependency => dependency.kind === kind && dependency.id === localId);
    if (hasDependency) {
      refs.push(reference(projectId, 'component', component.id, component.name));
    }
  }

  for (const screen of bundle.screens.screens) {
    for (const section of screen.sections) {
      const hasDependency = section.uses.some(dependency => dependency.kind === kind && dependency.id === localId);
      if (hasDependency) {
        refs.push(reference(projectId, 'section', `${screen.id}/${section.id}`, section.name));
        refs.push(reference(projectId, 'screen', screen.id, screen.name));
      }
    }
  }

  return dedupeReferences(refs);
}

function dedupeReferences(refs: BoundaryReference[]): BoundaryReference[] {
  const seen = new Set<string>();
  return refs.filter(ref => {
    if (seen.has(ref.id)) {
      return false;
    }
    seen.add(ref.id);
    return true;
  });
}

function findTokenGroup(bundle: BlueprintProjectBundle, id: string): TokenGroup {
  return requireItem(bundle.tokens.tokenGroups.find(group => group.id === id), `token-group:${id}`);
}

function findPrimitive(bundle: BlueprintProjectBundle, id: string): PrimitiveDefinition {
  return requireItem(bundle.primitives.primitives.find(primitive => primitive.id === id), `primitive:${id}`);
}

function findComponent(bundle: BlueprintProjectBundle, id: string): ComponentDefinition {
  return requireItem(bundle.components.components.find(component => component.id === id), `component:${id}`);
}

function findScreen(bundle: BlueprintProjectBundle, id: string): ScreenDefinition {
  return requireItem(bundle.screens.screens.find(screen => screen.id === id), `screen:${id}`);
}

function findSection(bundle: BlueprintProjectBundle, id: string): { screen: ScreenDefinition; section: ScreenSection } {
  const [screenId, sectionId] = id.split('/');
  if (!screenId || !sectionId) {
    throw new Error(`Section selector "${id}" must use screenId/sectionId.`);
  }

  const screen = findScreen(bundle, screenId);
  const section = requireItem(screen.sections.find(item => item.id === sectionId), `section:${id}`);
  return { screen, section };
}

function requireItem<T>(item: T | undefined, label: string): T {
  if (!item) {
    throw new Error(`Unknown Blueprint boundary "${label}".`);
  }
  return item;
}

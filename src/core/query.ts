import { boundaryId, parseBoundarySelector, reference } from './address';
import type {
  BlueprintProjectBundle,
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
  PrimitiveState,
  PrimitiveStateSet,
  QueryResult,
  ResolvedToken,
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
    ...bundle.primitives.primitives.flatMap(primitive => [
      reference(projectId, 'primitive', primitive.id, primitive.name),
      ...primitive.stateSets.map(stateSet => reference(projectId, 'state-set', `${primitive.id}/${stateSet.id}`, stateSet.name))
    ]),
    ...bundle.components.components.map(component => reference(projectId, 'component', component.id, component.name)),
    ...bundle.screens.screens.flatMap(screen => [
      reference(projectId, 'screen', screen.id, screen.name),
      ...screen.sections.map(section => reference(projectId, 'section', `${screen.id}/${section.id}`, section.name))
    ])
  ];
}

export function showBoundary(bundle: BlueprintProjectBundle, selectorOrInput: BoundarySelector | string): BoundaryPacket {
  const selector = typeof selectorOrInput === 'string' ? parseQueryBoundarySelector(selectorOrInput) : selectorOrInput;

  switch (selector.kind) {
    case 'project':
      return packet(bundle, selector.kind, 'root', bundle.manifest.project, {
        sourceFiles: [bundle.sourceFiles.manifest],
        styleRefs: [],
        styleEvidence: [],
        uses: [],
        usedBy: [],
        notes: [bundle.manifest.project.description],
        prototypeOnly: false,
        implementationHints: ['Instantiate this sourceRoot inside an app-owned design/blueprint folder.']
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
    case 'primitive': {
      const primitive = findPrimitive(bundle, selector.id);
      return primitivePacket(bundle, primitive);
    }
    case 'state-set': {
      const { primitive, stateSet } = findStateSet(bundle, selector.id);
      return stateSetPacket(bundle, primitive, stateSet);
    }
    case 'component': {
      const component = findComponent(bundle, selector.id);
      return componentPacket(bundle, component);
    }
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
  const primitiveStates = bundle.primitives.primitives.flatMap(primitive =>
    primitive.stateSets.flatMap(stateSet =>
      stateSet.states
        .filter(state => state.prototypeOnly)
        .map(state => ({
          id: boundaryId(projectId, 'state-set', `${primitive.id}/${stateSet.id}`),
          kind: 'state-set',
          projectId,
          stateId: state.id,
          primitiveId: primitive.id,
          name: state.name,
          notes: state.notes
        }))
    )
  );

  const sections = bundle.screens.screens.flatMap(screen =>
    screen.sections.filter(section => section.prototypeOnly).map(section => sectionPacket(bundle, screen, section))
  );
  const components = bundle.components.components
    .filter(component => component.prototypeOnly)
    .map(component => componentPacket(bundle, component));

  return {
    query: 'prototype-only',
    projectId,
    results: [...primitiveStates, ...components, ...sections]
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
    tokenUsage: resolveTokenUsageForPackets(bundle, boundaries)
  };
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

  if (packet.kind === 'primitive') {
    const primitive = findPrimitive(bundle, localId);
    refs.push(
      ...primitive.stateSets.map(stateSet => reference(projectId, 'state-set', `${primitive.id}/${stateSet.id}`, stateSet.name))
    );
  }

  if (packet.kind === 'state-set') {
    const { primitive, stateSet } = findStateSet(bundle, localId);
    refs.push(reference(projectId, 'primitive', primitive.id, primitive.name));
    const groupIds = new Set(stateSet.states.flatMap(state => state.tokens.map(tokenRef => tokenRef.split('.')[0]).filter(Boolean)));
    for (const groupId of groupIds) {
      const group = findTokenGroup(bundle, groupId);
      refs.push(reference(projectId, 'token-group', group.id, group.name));
    }
  }

  return dedupeReferences(refs).sort(compareReferences);
}

function resolveTokensForPackets(bundle: BlueprintProjectBundle, packets: BoundaryPacket[]): ResolvedToken[] {
  const tokenRefs = new Set<string>();
  for (const packet of packets) {
    for (const state of statesForPacket(bundle, packet)) {
      for (const tokenRef of state.tokens) {
        tokenRefs.add(tokenRef);
      }
    }
    if (packet.kind === 'component') {
      const component = findComponent(bundle, localIdFromPacket(packet));
      for (const tokenGroupId of component.tokenGroupIds) {
        const group = findTokenGroup(bundle, tokenGroupId);
        for (const token of group.tokens) {
          tokenRefs.add(`${group.id}.${token.id}`);
        }
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

  for (const primitive of bundle.primitives.primitives) {
    const primitiveBoundaryId = boundaryId(projectId, 'primitive', primitive.id);
    const primitiveIncluded =
      includedBoundaryIds.has(primitiveBoundaryId) ||
      primitive.stateSets.some(stateSet => includedBoundaryIds.has(boundaryId(projectId, 'state-set', `${primitive.id}/${stateSet.id}`)));
    if (!primitiveIncluded) {
      continue;
    }

    const recordUsage = (tokenId: string, role: string): void => {
      const token = tokenIndex.get(tokenId);
      if (!token) {
        return;
      }
      const key = `${primitiveBoundaryId}\u0000${tokenId}\u0000${role}\u0000${token.styleRef}`;
      if (usageKeys.has(key)) {
        return;
      }
      usageKeys.add(key);
      usage.push({
        tokenId,
        role,
        boundaryId: primitiveBoundaryId,
        boundaryKind: 'primitive',
        styleRef: token.styleRef
      });
    };

    for (const [tokenId, role] of Object.entries(primitive.prototype.tokenRoles)) {
      recordUsage(tokenId, role);
    }

    for (const stateSet of primitive.stateSets) {
      for (const state of stateSet.states) {
        for (const [tokenId, role] of Object.entries(state.tokenRoles ?? {})) {
          if (!state.tokens.includes(tokenId)) {
            continue;
          }
          recordUsage(tokenId, role);
        }
      }
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

function statesForPacket(bundle: BlueprintProjectBundle, packet: BoundaryPacket): PrimitiveState[] {
  const localId = localIdFromPacket(packet);
  if (packet.kind === 'primitive') {
    return findPrimitive(bundle, localId).stateSets.flatMap(stateSet => stateSet.states);
  }
  if (packet.kind === 'state-set') {
    return findStateSet(bundle, localId).stateSet.states;
  }
  return [];
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

function primitivePacket(bundle: BlueprintProjectBundle, primitive: PrimitiveDefinition): BoundaryPacket<PrimitiveDefinition> {
  return packet(bundle, 'primitive', primitive.id, primitive, {
    sourceFiles: [bundle.sourceFiles.primitives, ...prototypeSourceFiles(bundle, primitive.prototype)],
    styleRefs: primitive.styleRefs,
    styleEvidence: styleEvidenceFor(primitive.styleRefs, primitive.styleEvidence),
    uses: [
      ...primitive.tokenGroupIds.map(tokenGroupId => {
        const group = findTokenGroup(bundle, tokenGroupId);
        return reference(bundle.manifest.project.id, 'token-group', group.id, group.name);
      }),
      ...dependenciesToReferences(bundle, primitive.uses ?? [])
    ],
    usedBy: usedBy(bundle, 'primitive', primitive.id),
    notes: primitive.notes,
    prototypeOnly: primitive.prototypeOnly,
    implementationHints: primitive.implementationHints,
    rendering: {
      mode: 'canonical-app-owned',
      source: primitive.prototype.source
    }
  });
}

function componentPacket(bundle: BlueprintProjectBundle, component: ComponentDefinition): BoundaryPacket<ComponentDefinition> {
  return packet(bundle, 'component', component.id, component, {
    sourceFiles: [
      bundle.sourceFiles.components,
      ...prototypeSourceFiles(bundle, component.prototype)
    ],
    styleRefs: component.styleRefs ?? component.prototype.styles,
    styleEvidence: styleEvidenceFor(component.styleRefs ?? component.prototype.styles, component.styleEvidence),
    uses: dedupeReferences([
      ...component.tokenGroupIds.map(tokenGroupId => {
        const group = findTokenGroup(bundle, tokenGroupId);
        return reference(bundle.manifest.project.id, 'token-group', group.id, group.name);
      }),
      ...dependenciesToReferences(bundle, component.uses)
    ]),
    usedBy: usedBy(bundle, 'component', component.id),
    notes: component.notes ?? [],
    prototypeOnly: component.prototypeOnly ?? false,
    implementationHints: component.implementationHints ?? [],
    rendering: {
      mode: 'canonical-app-owned',
      source: component.prototype.source
    }
  });
}

function stateSetPacket(
  bundle: BlueprintProjectBundle,
  primitive: PrimitiveDefinition,
  stateSet: PrimitiveStateSet
): BoundaryPacket<PrimitiveStateSet> {
  return packet(bundle, 'state-set', `${primitive.id}/${stateSet.id}`, stateSet, {
    sourceFiles: [bundle.sourceFiles.primitives],
    styleRefs: stateSet.styleRefs,
    styleEvidence: styleEvidenceFor(stateSet.styleRefs, stateSet.styleEvidence),
    uses: [],
    usedBy: usedBy(bundle, 'state-set', `${primitive.id}/${stateSet.id}`),
    notes: stateSet.states.flatMap(state => state.notes ?? []),
    prototypeOnly: stateSet.states.every(state => state.prototypeOnly),
    implementationHints: stateSet.states.flatMap(state => state.implementationHints ?? [])
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
  prototype: PrototypeSource,
  extraRefs: string[] = []
): string[] {
  const refs = [prototype.source, ...prototype.styles, ...extraRefs];
  return [...new Set(refs.map(sourceRef => `${bundle.sourceRoot}/${sourceRef.replace(/\\/g, '/').replace(/^\.\//, '')}`))];
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

function dependenciesToReferences(bundle: BlueprintProjectBundle, dependencies: BoundaryDependency[]): BoundaryReference[] {
  return dependencies.map(dependency => {
    if (dependency.kind === 'token-group') {
      const group = findTokenGroup(bundle, dependency.id);
      return reference(bundle.manifest.project.id, 'token-group', group.id, group.name);
    }

    if (dependency.kind === 'primitive') {
      const primitive = findPrimitive(bundle, dependency.id);
      return reference(bundle.manifest.project.id, 'primitive', primitive.id, primitive.name);
    }

    if (dependency.kind === 'state-set') {
      const { primitive, stateSet } = findStateSet(bundle, dependency.id);
      return reference(bundle.manifest.project.id, 'state-set', `${primitive.id}/${stateSet.id}`, stateSet.name);
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

    throw new Error(`Unsupported dependency kind "${dependency.kind}".`);
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
    const hasDependency = (primitive.uses ?? []).some(dependency => dependency.kind === kind && dependency.id === localId);
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

function findStateSet(bundle: BlueprintProjectBundle, id: string): { primitive: PrimitiveDefinition; stateSet: PrimitiveStateSet } {
  const [primitiveId, stateSetId] = id.split('/');
  if (!primitiveId || !stateSetId) {
    throw new Error(`State-set selector "${id}" must use primitiveId/stateSetId.`);
  }

  const primitive = findPrimitive(bundle, primitiveId);
  const stateSet = requireItem(primitive.stateSets.find(item => item.id === stateSetId), `state-set:${id}`);
  return { primitive, stateSet };
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

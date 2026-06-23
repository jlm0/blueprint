import { boundaryId, parseBoundarySelector, reference } from './address';
import type {
  BlueprintProjectBundle,
  BoundaryDependency,
  BoundaryKind,
  BoundaryPacket,
  BoundaryReference,
  BoundarySelector,
  PrimitiveDefinition,
  PrimitiveStateSet,
  QueryResult,
  ScreenDefinition,
  ScreenSection,
  TokenGroup
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
    ...bundle.screens.screens.flatMap(screen => [
      reference(projectId, 'screen', screen.id, screen.name),
      ...screen.sections.map(section => reference(projectId, 'section', `${screen.id}/${section.id}`, section.name))
    ])
  ];
}

export function showBoundary(bundle: BlueprintProjectBundle, selectorOrInput: BoundarySelector | string): BoundaryPacket {
  const selector = typeof selectorOrInput === 'string' ? parseBoundarySelector(selectorOrInput) : selectorOrInput;
  const projectId = bundle.manifest.project.id;

  switch (selector.kind) {
    case 'project':
      return packet(bundle, selector.kind, 'root', bundle.manifest.project, {
        sourceFiles: [bundle.sourceFiles.manifest],
        styleRefs: [],
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

  return {
    query: 'prototype-only',
    projectId,
    results: [...primitiveStates, ...sections]
  };
}

export function createExtractionPacket(bundle: BlueprintProjectBundle, selectorInput: string): BoundaryPacket {
  const packet = showBoundary(bundle, selectorInput);
  if (packet.kind !== 'primitive' && packet.kind !== 'screen') {
    throw new Error(`Extraction packets are supported for primitive and screen boundaries, not "${packet.kind}".`);
  }
  return packet;
}

function tokenGroupPacket(bundle: BlueprintProjectBundle, group: TokenGroup): BoundaryPacket<TokenGroup> {
  return packet(bundle, 'token-group', group.id, group, {
    sourceFiles: [bundle.sourceFiles.tokens],
    styleRefs: group.styleRefs,
    uses: [],
    usedBy: usedBy(bundle, 'token-group', group.id),
    notes: group.notes,
    prototypeOnly: false,
    implementationHints: [`Map ${group.name} tokens into the target app's design-token layer before component work.`]
  });
}

function primitivePacket(bundle: BlueprintProjectBundle, primitive: PrimitiveDefinition): BoundaryPacket<PrimitiveDefinition> {
  return packet(bundle, 'primitive', primitive.id, primitive, {
    sourceFiles: [bundle.sourceFiles.primitives],
    styleRefs: primitive.styleRefs,
    uses: primitive.tokenGroupIds.map(tokenGroupId => {
      const group = findTokenGroup(bundle, tokenGroupId);
      return reference(bundle.manifest.project.id, 'token-group', group.id, group.name);
    }),
    usedBy: usedBy(bundle, 'primitive', primitive.id),
    notes: primitive.notes,
    prototypeOnly: primitive.prototypeOnly,
    implementationHints: primitive.implementationHints
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
    uses: [],
    usedBy: usedBy(bundle, 'state-set', `${primitive.id}/${stateSet.id}`),
    notes: stateSet.states.flatMap(state => state.notes),
    prototypeOnly: stateSet.states.every(state => state.prototypeOnly),
    implementationHints: stateSet.states.flatMap(state => state.implementationHints)
  });
}

function screenPacket(bundle: BlueprintProjectBundle, screen: ScreenDefinition): BoundaryPacket<ScreenDefinition> {
  return packet(bundle, 'screen', screen.id, screen, {
    sourceFiles: [bundle.sourceFiles.manifest, bundle.sourceFiles.screens, bundle.sourceFiles.primitives, bundle.sourceFiles.tokens],
    styleRefs: screen.styleRefs,
    uses: dedupeReferences(screen.sections.flatMap(section => dependenciesToReferences(bundle, section.uses))),
    usedBy: usedBy(bundle, 'screen', screen.id),
    notes: [...screen.notes, ...screen.sections.flatMap(section => section.notes)],
    prototypeOnly: screen.prototypeOnly,
    implementationHints: [...screen.implementationHints, ...screen.sections.flatMap(section => section.implementationHints)]
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
    uses: BoundaryReference[];
    usedBy: BoundaryReference[];
    notes: string[];
    prototypeOnly: boolean;
    implementationHints: string[];
  }
): BoundaryPacket<TData> {
  return {
    id: boundaryId(bundle.manifest.project.id, kind, localId),
    kind,
    projectId: bundle.manifest.project.id,
    sourceFiles: options.sourceFiles,
    data,
    styleRefs: options.styleRefs,
    dependencies: {
      uses: options.uses,
      usedBy: options.usedBy
    },
    notes: options.notes,
    prototypeOnly: options.prototypeOnly,
    implementationHints: options.implementationHints
  };
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

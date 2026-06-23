import type {
  BlueprintProjectBundle,
  BoardDefinition,
  BoundaryDependency,
  FramePreset,
  PrimitiveDefinition,
  PrimitiveStateSet,
  ScreenDefinition,
  TokenGroup,
  ValidationResult
} from './types';

export function validateProject(bundle: BlueprintProjectBundle): ValidationResult {
  const errors: string[] = [];
  const projectId = bundle.manifest.project?.id;

  requireString(errors, 'manifest.project.id', projectId);
  requireString(errors, 'manifest.project.name', bundle.manifest.project?.name);
  requireString(errors, 'manifest.project.sourceRoot', bundle.manifest.project?.sourceRoot);
  requireString(errors, 'manifest.defaultBoardId', bundle.manifest.defaultBoardId);

  if (bundle.tokens.projectId !== projectId) {
    errors.push(`tokens.projectId "${bundle.tokens.projectId}" must match manifest project id "${projectId}".`);
  }

  if (bundle.primitives.projectId !== projectId) {
    errors.push(`primitives.projectId "${bundle.primitives.projectId}" must match manifest project id "${projectId}".`);
  }

  if (bundle.screens.projectId !== projectId) {
    errors.push(`screens.projectId "${bundle.screens.projectId}" must match manifest project id "${projectId}".`);
  }

  const boardIds = collectIds(errors, 'manifest.boards', bundle.manifest.boards, board => validateBoard(errors, board));
  if (!boardIds.has(bundle.manifest.defaultBoardId)) {
    errors.push(`manifest.defaultBoardId "${bundle.manifest.defaultBoardId}" does not match a board id.`);
  }

  const framePresetIds = collectIds(errors, 'manifest.framePresets', bundle.manifest.framePresets, framePreset => validateFramePreset(errors, framePreset));
  const tokenGroupIds = collectIds(errors, 'tokens.tokenGroups', bundle.tokens.tokenGroups, group => validateTokenGroup(errors, group));
  const primitiveIds = collectIds(errors, 'primitives.primitives', bundle.primitives.primitives, primitive => {
    validatePrimitive(errors, primitive, tokenGroupIds);
  });

  const stateSetIds = new Set<string>();
  for (const primitive of bundle.primitives.primitives) {
    for (const stateSet of primitive.stateSets ?? []) {
      const localId = `${primitive.id}/${stateSet.id}`;
      if (stateSetIds.has(localId)) {
        errors.push(`Duplicate state-set id "${localId}".`);
      }
      stateSetIds.add(localId);
    }
  }

  const screenIds = collectIds(errors, 'screens.screens', bundle.screens.screens, screen => {
    validateScreen(errors, screen, framePresetIds, primitiveIds, stateSetIds);
  });

  for (const screen of bundle.screens.screens) {
    for (const section of screen.sections ?? []) {
      for (const dependency of section.uses ?? []) {
        validateDependency(errors, `screens.${screen.id}.sections.${section.id}.uses`, dependency, {
          tokenGroupIds,
          primitiveIds,
          stateSetIds,
          screenIds,
          sectionIds: new Set(screen.sections.map(item => `${screen.id}/${item.id}`))
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateBoard(errors: string[], board: BoardDefinition): void {
  requireString(errors, 'board.id', board.id);
  requireString(errors, `board.${board.id}.kind`, board.kind);
  requireString(errors, `board.${board.id}.name`, board.name);
}

function validateFramePreset(errors: string[], framePreset: FramePreset): void {
  requireString(errors, 'framePreset.id', framePreset.id);
  requireString(errors, `framePreset.${framePreset.id}.name`, framePreset.name);
  requireNumber(errors, `framePreset.${framePreset.id}.width`, framePreset.width);
  requireNumber(errors, `framePreset.${framePreset.id}.height`, framePreset.height);
}

function validateTokenGroup(errors: string[], group: TokenGroup): void {
  requireString(errors, 'tokenGroup.id', group.id);
  requireString(errors, `tokenGroup.${group.id}.name`, group.name);
  requireArray(errors, `tokenGroup.${group.id}.tokens`, group.tokens);

  const tokenIds = new Set<string>();
  for (const token of group.tokens ?? []) {
    requireString(errors, `tokenGroup.${group.id}.token.id`, token.id);
    requireString(errors, `tokenGroup.${group.id}.token.${token.id}.type`, token.type);
    requireString(errors, `tokenGroup.${group.id}.token.${token.id}.value`, token.value);
    requireString(errors, `tokenGroup.${group.id}.token.${token.id}.styleRef`, token.styleRef);
    if (tokenIds.has(token.id)) {
      errors.push(`Duplicate token id "${group.id}.${token.id}".`);
    }
    tokenIds.add(token.id);
  }
}

function validatePrimitive(errors: string[], primitive: PrimitiveDefinition, tokenGroupIds: Set<string>): void {
  requireString(errors, 'primitive.id', primitive.id);
  requireString(errors, `primitive.${primitive.id}.name`, primitive.name);
  requireArray(errors, `primitive.${primitive.id}.tokenGroupIds`, primitive.tokenGroupIds);
  requireArray(errors, `primitive.${primitive.id}.stateSets`, primitive.stateSets);

  for (const tokenGroupId of primitive.tokenGroupIds ?? []) {
    if (!tokenGroupIds.has(tokenGroupId)) {
      errors.push(`primitive.${primitive.id}.tokenGroupIds references missing token group "${tokenGroupId}".`);
    }
  }

  collectIds(errors, `primitive.${primitive.id}.stateSets`, primitive.stateSets, stateSet => validateStateSet(errors, primitive, stateSet));
}

function validateStateSet(errors: string[], primitive: PrimitiveDefinition, stateSet: PrimitiveStateSet): void {
  requireString(errors, `primitive.${primitive.id}.stateSet.id`, stateSet.id);
  requireString(errors, `primitive.${primitive.id}.stateSet.${stateSet.id}.name`, stateSet.name);
  requireArray(errors, `primitive.${primitive.id}.stateSet.${stateSet.id}.states`, stateSet.states);

  collectIds(errors, `primitive.${primitive.id}.stateSet.${stateSet.id}.states`, stateSet.states, state => {
    requireString(errors, `stateSet.${stateSet.id}.state.id`, state.id);
    requireString(errors, `stateSet.${stateSet.id}.state.${state.id}.name`, state.name);
    requireArray(errors, `stateSet.${stateSet.id}.state.${state.id}.tokens`, state.tokens);
  });
}

function validateScreen(
  errors: string[],
  screen: ScreenDefinition,
  framePresetIds: Set<string>,
  primitiveIds: Set<string>,
  stateSetIds: Set<string>
): void {
  requireString(errors, 'screen.id', screen.id);
  requireString(errors, `screen.${screen.id}.name`, screen.name);
  requireString(errors, `screen.${screen.id}.framePresetId`, screen.framePresetId);
  requireArray(errors, `screen.${screen.id}.sections`, screen.sections);

  if (!framePresetIds.has(screen.framePresetId)) {
    errors.push(`screen.${screen.id}.framePresetId references missing frame preset "${screen.framePresetId}".`);
  }

  collectIds(errors, `screen.${screen.id}.sections`, screen.sections, section => {
    requireString(errors, `screen.${screen.id}.section.id`, section.id);
    requireString(errors, `screen.${screen.id}.section.${section.id}.name`, section.name);
    requireArray(errors, `screen.${screen.id}.section.${section.id}.uses`, section.uses);

    for (const dependency of section.uses ?? []) {
      if (dependency.kind === 'primitive' && !primitiveIds.has(dependency.id)) {
        errors.push(`screen.${screen.id}.section.${section.id}.uses references missing primitive "${dependency.id}".`);
      }
      if (dependency.kind === 'state-set' && !stateSetIds.has(dependency.id)) {
        errors.push(`screen.${screen.id}.section.${section.id}.uses references missing state-set "${dependency.id}".`);
      }
    }
  });
}

function validateDependency(
  errors: string[],
  path: string,
  dependency: BoundaryDependency,
  known: {
    tokenGroupIds: Set<string>;
    primitiveIds: Set<string>;
    stateSetIds: Set<string>;
    screenIds: Set<string>;
    sectionIds: Set<string>;
  }
): void {
  requireString(errors, `${path}.kind`, dependency.kind);
  requireString(errors, `${path}.id`, dependency.id);
  requireString(errors, `${path}.reason`, dependency.reason);

  const map = {
    'token-group': known.tokenGroupIds,
    primitive: known.primitiveIds,
    'state-set': known.stateSetIds,
    screen: known.screenIds,
    section: known.sectionIds
  } as const;

  if (dependency.kind in map && !map[dependency.kind].has(dependency.id)) {
    errors.push(`${path} references missing ${dependency.kind} "${dependency.id}".`);
  }
}

function collectIds<T extends { id: string }>(
  errors: string[],
  label: string,
  items: T[] | undefined,
  validate: (item: T) => void
): Set<string> {
  const ids = new Set<string>();
  requireArray(errors, label, items);

  for (const item of items ?? []) {
    validate(item);
    if (!item.id) {
      continue;
    }
    if (ids.has(item.id)) {
      errors.push(`Duplicate id "${item.id}" in ${label}.`);
    }
    ids.add(item.id);
  }

  return ids;
}

function requireString(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${label} must be a non-empty string.`);
  }
}

function requireNumber(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label} must be a finite number.`);
  }
}

function requireArray(errors: string[], label: string, value: unknown): void {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
  }
}

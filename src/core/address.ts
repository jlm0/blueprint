import type { BoundaryKind, BoundaryReference, BoundarySelector } from './types';

export function boundaryId(projectId: string, kind: BoundaryKind, localId = 'root'): string {
  return `${projectId}/${kind}/${localId}`;
}

export function selectorKey(selector: BoundarySelector): string {
  return `${selector.kind}:${selector.id}`;
}

export function parseBoundarySelector(input: string): BoundarySelector {
  const divider = input.indexOf(':');
  if (divider === -1) {
    throw new Error(`Boundary selector "${input}" must use kind:id format.`);
  }

  const kind = input.slice(0, divider) as BoundaryKind;
  const id = input.slice(divider + 1);
  const allowed: BoundaryKind[] = ['project', 'board', 'token-group', 'primitive', 'state-set', 'screen', 'section'];

  if (!allowed.includes(kind)) {
    throw new Error(`Boundary selector "${input}" uses unsupported kind "${kind}".`);
  }

  if (!id) {
    throw new Error(`Boundary selector "${input}" is missing an id.`);
  }

  return { kind, id };
}

export function reference(projectId: string, kind: BoundaryKind, localId: string, name: string): BoundaryReference {
  return {
    id: boundaryId(projectId, kind, localId),
    kind,
    projectId,
    localId,
    name
  };
}

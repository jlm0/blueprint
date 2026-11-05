import type { BlueprintAgentActivityFocus } from '../core/activity';
import { boundaryId } from '../core/address';
import { findSectionMarkers } from '../core/markup';
import type { BoundaryKind, CanvasProjectBundle, ReusableDefinition, ScreenDefinition } from '../core/types';

export const prototypeUsesByHost = new WeakMap<HTMLElement, PrototypeFrameUses>();

interface PrototypeFrameUses {
  targetBoundaryId: string;
  usedBoundaryIds: ReadonlySet<string>;
  sectionBoundaryIds: ReadonlySet<string>;
}

const reusablesByBundle = new WeakMap<CanvasProjectBundle, Map<string, ReusableDefinition>>();

function declaredUseClosure(bundle: CanvasProjectBundle, screen: ScreenDefinition): Array<{ kind: string; id: string; reusable?: ReusableDefinition }> {
  let reusables = reusablesByBundle.get(bundle);
  if (!reusables) {
    reusables = new Map([
      ...bundle.primitives.primitives.map(primitive => [`primitive:${primitive.id}`, primitive] as const),
      ...bundle.components.components.map(component => [`component:${component.id}`, component] as const)
    ]);
    reusablesByBundle.set(bundle, reusables);
  }
  const pending: Array<{ kind: string; id: string }> = [...screen.prototype.renderedUses
    ?? screen.sections.flatMap(section => section.uses.filter(use => use.kind === 'primitive' || use.kind === 'component'))];
  const closure = new Map<string, { kind: string; id: string; reusable?: ReusableDefinition }>();
  for (let use = pending.pop(); use; use = pending.pop()) {
    const key = `${use.kind}:${use.id}`;
    if (closure.has(key)) continue;
    const reusable = reusables.get(key);
    closure.set(key, { kind: use.kind, id: use.id, reusable });
    pending.push(...reusable?.uses ?? []);
  }
  return [...closure.values()];
}

export function declaredReusables(bundle: CanvasProjectBundle, screen: ScreenDefinition): ReusableDefinition[] {
  return declaredUseClosure(bundle, screen).flatMap(use => use.reusable ? [use.reusable] : []);
}

export function declaredFrameUses(bundle: CanvasProjectBundle, screen: ScreenDefinition): PrototypeFrameUses {
  const projectId = bundle.manifest.project.id;
  const usedBoundaryIds = new Set(declaredUseClosure(bundle, screen).map(use => boundaryId(projectId, use.kind as BoundaryKind, use.id)));
  const declaredSections = new Set(screen.sections.map(section => section.id));
  const markedSections = findSectionMarkers(bundle.prototypeSourceContents[screen.prototype.source] ?? '')
    .filter(sectionId => declaredSections.has(sectionId))
    .map(sectionId => boundaryId(projectId, 'section', `${screen.id}/${sectionId}`));
  return {
    targetBoundaryId: boundaryId(projectId, 'screen', screen.id),
    usedBoundaryIds,
    sectionBoundaryIds: new Set(markedSections)
  };
}

export function prototypeHostsUsingBoundary(root: HTMLElement, focus: BlueprintAgentActivityFocus): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.canonical-prototype-screen')].filter(host => {
    const uses = prototypeUsesByHost.get(host);
    if (!uses) return false;
    if (focus.kind === 'section') return uses.sectionBoundaryIds.has(focus.boundaryId);
    return uses.targetBoundaryId === focus.boundaryId || uses.usedBoundaryIds.has(focus.boundaryId);
  });
}

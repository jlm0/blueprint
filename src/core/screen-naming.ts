import type { ScreenDefinition } from './types';

/** Returns the canonical route used to group and name one screen frame. */
export function screenRoutePath(screen: ScreenDefinition): string {
  const declared = screen.productionRelationship?.routePath?.trim();
  const route = declared && declared.length > 0 ? declared : `/${screen.id}`;
  const withLeadingSlash = route.startsWith('/') ? route : `/${route}`;
  const normalized = withLeadingSlash.replace(/\/{2,}/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

/** Formats the human-facing Route · Frame name · optional Vn canvas label. */
export function screenFrameLabel(screen: ScreenDefinition): string {
  const segments = [humanizeRoute(screenRoutePath(screen)), screen.name.trim()];
  if (screen.version !== undefined) {
    segments.push(`V${screen.version}`);
  }
  return segments.join(' · ');
}

/** Groups screens that need explicit versions to keep their frame names unique. */
export function screenVersionGroupKey(screen: ScreenDefinition): string {
  return `${screenRoutePath(screen).toLowerCase()}\u0000${screen.name.trim().toLowerCase()}`;
}

function humanizeRoute(routePath: string): string {
  if (routePath === '/') {
    return 'Root';
  }

  return routePath
    .split('/')
    .filter(Boolean)
    .map(segment => segment
      .split(/[-_]+/)
      .filter(Boolean)
      .map(humanizeRouteWord)
      .join(' '))
    .join(' / ');
}

function humanizeRouteWord(word: string): string {
  if (/^[A-Z0-9]{2,4}$/.test(word)) {
    return word;
  }
  const normalized = word.toLowerCase();
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

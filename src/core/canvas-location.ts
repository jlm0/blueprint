import { parseBoundarySelector } from './address';
import { showBoundary } from './query';
import type { BlueprintProjectBundle } from './types';

/** Canvas URL search params that open the page showing one boundary. */
export function canvasLocationParams(bundle: BlueprintProjectBundle, selectorInput: string): Record<string, string> {
  const selector = parseBoundarySelector(selectorInput);
  showBoundary(bundle, selector);
  const document = (section: string, item?: string): Record<string, string> => ({
    board: 'primitives',
    section,
    ...(item ? { item } : {})
  });

  switch (selector.kind) {
    case 'project':
      return document('foundations', selector.id === 'inspo' && bundle.inspo ? 'inspo' : bundle.brand ? 'brand' : bundle.inspo ? 'inspo' : undefined);
    case 'board':
      return { board: selector.id };
    case 'token-group':
      return document('foundations', selector.id);
    case 'primitive':
      return document('primitives', selector.id);
    case 'component':
      return document('components', selector.id);
    case 'screen':
    case 'section': {
      const screenId = selector.kind === 'screen' ? selector.id : selector.id.split('/')[0];
      const screen = bundle.screens.screens.find(candidate => candidate.id === screenId);
      return { board: 'screens', ...(screen?.page ? { page: screen.page } : {}), screen: screenId };
    }
  }
}

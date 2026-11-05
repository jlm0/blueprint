import type { CanvasProjectBundle } from '../core/types';
import type { BoardContext, BoardMount } from './canvas-state';
import { documentView } from './chrome';
import { createBrandPage } from './document-brand';
import { createFoundationPage } from './document-foundation';
import { createInspoPage } from './document-inspo';
import { createEmptySectionPage } from './document-page';
import { createReusablePage } from './document-reusable';
import { BRAND_ITEM_ID, type DocumentSectionId, INSPO_ITEM_ID, activeItem, activeSection } from './sections';
import { type TokenIndex, createTokenIndex } from './tokens';

export function mountDocumentBoard({ root, project: bundle }: BoardContext): BoardMount {
  const tokenIndex = createTokenIndex(bundle);
  const item = activeItem(bundle, activeSection);
  root.dataset.section = activeSection;
  const page = item ? createDocumentItemPage(bundle, tokenIndex, activeSection, item.id) : undefined;
  root.append(page ?? createEmptySectionPage(activeSection));
  return {
    configure: () => undefined,
    fit: () => {
      documentView.scrollTop = 0;
    }
  };
}

function createDocumentItemPage(
  bundle: CanvasProjectBundle,
  tokenIndex: TokenIndex,
  section: DocumentSectionId,
  itemId: string
): HTMLElement | undefined {
  if (section === 'foundations') {
    if (itemId === INSPO_ITEM_ID && bundle.inspo) return createInspoPage(bundle.inspo);
    if (itemId === BRAND_ITEM_ID && bundle.brand) return createBrandPage(bundle, tokenIndex, bundle.brand);
    const group = tokenIndex.byGroup.get(itemId);
    return group ? createFoundationPage(bundle, tokenIndex, group) : undefined;
  }
  if (section === 'primitives') {
    const primitive = bundle.primitives.primitives.find(candidate => candidate.id === itemId);
    return primitive ? createReusablePage(bundle, tokenIndex, 'primitive', primitive) : undefined;
  }
  const component = bundle.components.components.find(candidate => candidate.id === itemId);
  return component ? createReusablePage(bundle, tokenIndex, 'component', component) : undefined;
}

/** Empty sandbox permission set: no scripts, same-origin privilege, forms, popups, or top navigation. */
export const PROTOTYPE_IFRAME_SANDBOX = '';

/** Applies the canonical canvas isolation contract through an observable attribute seam. */
export function applyPrototypeIframeIsolation(target: Pick<HTMLIFrameElement, 'setAttribute'>): void {
  target.setAttribute('sandbox', PROTOTYPE_IFRAME_SANDBOX);
}

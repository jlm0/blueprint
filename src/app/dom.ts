export function createPrototypeCompileError(error: unknown): HTMLElement {
  const message = el('div', 'prototype-compile-error');
  message.setAttribute('role', 'alert');
  message.append(
    el('strong', '', 'Prototype unavailable'),
    el('span', '', errorMessage(error))
  );
  return message;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createIconButton(className: string, title: string, iconMarkup: string): HTMLButtonElement {
  const button = el('button', className) as HTMLButtonElement;
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = iconMarkup;
  return button;
}

export function findBoundaryElement(root: HTMLElement, id: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('[data-boundary-id]')]
    .find(element => element.dataset.boundaryId === id);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
}

export function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text) {
    node.textContent = text;
  }
  return node;
}

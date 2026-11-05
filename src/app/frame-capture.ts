import { toBlob } from 'html-to-image';
import { checkIcon, failIcon } from './icons';

export function wireFrameCapture(options: {
  screenEl: HTMLElement;
  shot: HTMLButtonElement;
  save: HTMLButtonElement;
  screenId: string;
  captureDocument?: () => Promise<string | undefined>;
}): void {
  const capture = async (): Promise<Blob> => {
    const html = await options.captureDocument?.();
    const blob = html
      ? await captureCanonicalPrototype(options.screenEl, html)
      : await toBlob(options.screenEl, {
          pixelRatio: 2,
          style: {
            boxShadow: 'none'
          }
        });
    if (!blob) {
      throw new Error('Screen capture returned an empty image.');
    }
    return blob;
  };

  options.shot.addEventListener('click', async () => {
    if (options.shot.classList.contains('busy')) {
      return;
    }
    options.shot.classList.add('busy');
    const blobPromise = capture();
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      flashCaptureButton(options.shot, 'done', 'Copied');
    } catch {
      const blob = await blobPromise.catch(() => null);
      if (blob) {
        downloadBlob(blob, options.screenId);
        flashCaptureButton(options.shot, 'done', 'Saved');
      } else {
        flashCaptureButton(options.shot, 'fail', 'Failed');
      }
    }
  });

  options.save.addEventListener('click', async () => {
    if (options.save.classList.contains('busy')) {
      return;
    }
    options.save.classList.add('busy');
    const blob = await capture().catch(() => null);
    if (blob) {
      downloadBlob(blob, options.screenId);
    }
    flashCaptureButton(options.save, blob ? 'done' : 'fail', blob ? 'Saved' : 'Failed');
  });
}

/**
 * html-to-image cannot read the deliberately opaque iframe used by the canvas,
 * so serializing the visible host produces a white PNG. Render the same compiled,
 * no-script document in a short-lived readable iframe and capture its document
 * root instead. The review iframe remains fully sandboxed and unchanged.
 */
async function captureCanonicalPrototype(screenEl: HTMLElement, html: string): Promise<Blob | null> {
  const width = screenEl.clientWidth;
  const height = screenEl.clientHeight;
  if (width <= 0 || height <= 0) {
    throw new Error('Screen capture requires a visible frame with non-zero dimensions.');
  }

  const captureFrame = document.createElement('iframe');
  captureFrame.style.cssText = [
    'position:fixed',
    `left:-${width + 100}px`,
    'top:0',
    `width:${width}px`,
    `height:${height}px`,
    'border:0',
    'pointer-events:none'
  ].join(';');
  captureFrame.tabIndex = -1;
  captureFrame.setAttribute('aria-hidden', 'true');
  // Same-origin access is needed only for serialization. Scripts remain denied
  // by both the sandbox and the compiled document's content security policy.
  captureFrame.setAttribute('sandbox', 'allow-same-origin');

  try {
    await loadCaptureDocument(captureFrame, html);
    const captureRoot = captureFrame.contentDocument?.documentElement;
    if (!captureRoot) {
      throw new Error('Screen capture could not access the rendered prototype document.');
    }
    await waitForCaptureReadiness(captureRoot.ownerDocument);
    return await toBlob(captureRoot, {
      width,
      height,
      canvasWidth: width,
      canvasHeight: height,
      pixelRatio: 2,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        overflow: 'hidden',
        boxShadow: 'none'
      }
    });
  } finally {
    captureFrame.remove();
  }
}

async function loadCaptureDocument(frame: HTMLIFrameElement, html: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('Screen capture document did not load in time.'));
    }, 10000);
    frame.addEventListener(
      'load',
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
    frame.addEventListener(
      'error',
      () => {
        window.clearTimeout(timeout);
        reject(new Error('Screen capture document failed to load.'));
      },
      { once: true }
    );
    frame.srcdoc = html;
    document.body.append(frame);
  });
}

async function waitForCaptureReadiness(document: Document): Promise<void> {
  await document.fonts.ready;
  await Promise.all(
    Array.from(document.images).map(async image => {
      if (!image.complete) {
        await new Promise<void>((resolve, reject) => {
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => reject(new Error('Screen capture image failed to load.')), { once: true });
        });
      }
      await image.decode();
    })
  );

  const view = document.defaultView;
  if (!view) {
    return;
  }
  await new Promise<void>(resolve => view.requestAnimationFrame(() => resolve()));
  await new Promise<void>(resolve => view.requestAnimationFrame(() => resolve()));
}

function downloadBlob(blob: Blob, id: string): void {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = `${id}.png`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const captureButtonResets = new WeakMap<HTMLButtonElement, () => void>();

function flashCaptureButton(button: HTMLButtonElement, result: 'done' | 'fail', label: string): void {
  captureButtonResets.get(button)?.();
  const icon = button.innerHTML;
  const title = button.getAttribute('aria-label') ?? '';
  button.classList.remove('busy');
  button.classList.add(result);
  button.innerHTML = `${result === 'done' ? checkIcon() : failIcon()}<span class="bp-chrome-frame-tool-label" role="status">${label}</span>`;
  button.setAttribute('aria-label', label);
  const reset = (): void => {
    window.clearTimeout(timer);
    captureButtonResets.delete(button);
    button.classList.remove(result);
    button.innerHTML = icon;
    button.setAttribute('aria-label', title);
  };
  const timer = window.setTimeout(reset, 1600);
  captureButtonResets.set(button, reset);
}

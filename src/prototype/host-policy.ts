/** Empty sandbox permission set: no scripts, same-origin privilege, forms, popups, or top navigation. */
export const PROTOTYPE_IFRAME_SANDBOX = '';

/** Applies the canonical canvas isolation contract through an observable attribute seam. */
export function applyPrototypeIframeIsolation(target: Pick<HTMLIFrameElement, 'setAttribute'>): void {
  target.setAttribute('sandbox', PROTOTYPE_IFRAME_SANDBOX);
}

export const LOOPBACK_HOSTNAME = '127.0.0.1';

export interface BlueprintResponsePolicyOptions {
  contentType: string;
  contentSecurityPolicy?: string;
  additionalHeaders?: Readonly<Record<string, string>>;
}

export type LoopbackHostDecision =
  | {
      allowed: true;
      expectedHost: string;
    }
  | {
      allowed: false;
      expectedHost: string;
      status: 421;
      headers: Record<string, string>;
      body: string;
    };

const DEFENSIVE_RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin'
} as const;

/** Builds the shared defensive response baseline for every custom loopback route. */
export function createBlueprintResponseHeaders(options: BlueprintResponsePolicyOptions): Record<string, string> {
  return {
    ...options.additionalHeaders,
    ...DEFENSIVE_RESPONSE_HEADERS,
    'Content-Type': options.contentType,
    ...(options.contentSecurityPolicy ? { 'Content-Security-Policy': options.contentSecurityPolicy } : {})
  };
}

/** Admits only the exact Host advertised by the bound IPv4 loopback listener. */
export function evaluateLoopbackHost(hostHeader: string | undefined, port: number): LoopbackHostDecision {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('Loopback Host policy requires a bound port between 1 and 65535.');
  }

  const expectedHost = `${LOOPBACK_HOSTNAME}:${port}`;
  if (hostHeader === expectedHost) {
    return { allowed: true, expectedHost };
  }

  return {
    allowed: false,
    expectedHost,
    status: 421,
    headers: createBlueprintResponseHeaders({ contentType: 'text/plain; charset=utf-8' }),
    body: 'Misdirected Request\n'
  };
}

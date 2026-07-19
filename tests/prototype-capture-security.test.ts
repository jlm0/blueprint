import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAllowedPrototypeDocumentUrl } from '../src/cli/prototype-network-guard';
import { applyPrototypeIframeIsolation, PROTOTYPE_IFRAME_SANDBOX } from '../src/prototype/host-policy';
import type { PrototypeNetworkGuardRoute } from '../src/cli/prototype-network-guard';

describe('prototype capture network policy', () => {
  it('allows only the self-contained capture document and controlled data resources', () => {
    assert.equal(isAllowedPrototypeDocumentUrl('about:blank'), true);
    assert.equal(isAllowedPrototypeDocumentUrl('data:image/svg+xml;base64,PHN2Zz4='), true);
    for (const denied of [
      'https://example.com/track',
      'http://127.0.0.1:4444/private',
      'file:///Users/example/.ssh/config',
      'blob:https://example.com/value',
      '/auth',
      '#section'
    ]) {
      assert.equal(isAllowedPrototypeDocumentUrl(denied), false, denied);
    }
  });

  it('applies an empty-permission sandbox to canonical canvas iframes', () => {
    const attributes = new Map<string, string>();
    applyPrototypeIframeIsolation({ setAttribute: (name, value) => attributes.set(name, value) });
    assert.equal(PROTOTYPE_IFRAME_SANDBOX, '');
    assert.deepEqual([...attributes], [['sandbox', '']]);
  });

  it('aborts and reports an undeclared capture request through the installed behavior seam', async () => {
    let routeHandler: ((route: PrototypeNetworkGuardRoute) => Promise<void>) | undefined;
    let navigationHandler: ((url: string, isMainFrame: boolean) => void) | undefined;
    let currentUrl = 'about:blank';
    let aborted = false;
    const page = {
      route: async (handler: (route: PrototypeNetworkGuardRoute) => Promise<void>) => {
        routeHandler = handler;
      },
      onFrameNavigated: (handler: (url: string, isMainFrame: boolean) => void) => {
        navigationHandler = handler;
      },
      currentUrl: () => currentUrl
    };

    const { installPrototypeNetworkGuard } = await import('../src/cli/prototype-network-guard');
    const guard = await installPrototypeNetworkGuard(page);
    assert.ok(routeHandler);
    await routeHandler({
      url: 'https://example.com/track',
      continue: async () => undefined,
      abort: async () => {
        aborted = true;
      }
    });
    assert.equal(aborted, true);
    assert.throws(() => guard.assertClean(), /blocked undeclared network or navigation access.*example\.com/);

    currentUrl = 'https://example.com/replaced';
    navigationHandler?.(currentUrl, true);
    assert.throws(() => guard.assertClean(), /replaced/);
  });
});

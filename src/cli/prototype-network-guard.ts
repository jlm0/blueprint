export interface PrototypeNetworkGuardRoute {
  url: string;
  continue: () => Promise<void>;
  abort: () => Promise<void>;
}

export interface PrototypeNetworkGuardPage {
  route: (handler: (route: PrototypeNetworkGuardRoute) => Promise<void>) => Promise<void>;
  onFrameNavigated: (handler: (url: string, isMainFrame: boolean) => void) => void;
  currentUrl: () => string;
}

/** URLs that a self-contained prototype document may use without leaving its isolated document. */
export function isAllowedPrototypeDocumentUrl(url: string): boolean {
  return url === 'about:blank' || url.startsWith('data:');
}

/** Installs a fail-closed request/navigation guard for top-level prototype capture. */
export async function installPrototypeNetworkGuard(page: PrototypeNetworkGuardPage): Promise<{ assertClean: () => void }> {
  const blocked = new Set<string>();
  await page.route(async route => {
    const url = route.url;
    if (isAllowedPrototypeDocumentUrl(url)) {
      await route.continue();
      return;
    }
    blocked.add(url);
    await route.abort();
  });
  page.onFrameNavigated((url, isMainFrame) => {
    if (isMainFrame && !isAllowedPrototypeDocumentUrl(url)) {
      blocked.add(url);
    }
  });

  return {
    assertClean: () => {
      const currentUrl = page.currentUrl();
      if (!isAllowedPrototypeDocumentUrl(currentUrl)) {
        blocked.add(currentUrl);
      }
      if (blocked.size > 0) {
        throw new Error(
          `Canonical prototype capture blocked undeclared network or navigation access: ${[...blocked].sort().join(', ')}.`
        );
      }
    }
  };
}

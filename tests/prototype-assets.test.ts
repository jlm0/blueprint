import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import type { BlueprintProjectBundle, LinkedProjectBundle } from '../src/core/types';
import { hashProjectAssets } from '../src/mcp/project-validation-worker';
import { linkProjectAssets } from '../src/mcp/serve-snapshot';
import { compilePrototypeDocument, PROTOTYPE_CONTENT_SECURITY_POLICY } from '../src/prototype/compiler';

const umbraRoot = 'fixtures/valid/umbra-gaming/design/blueprint';
const reviewOrigin = 'http://127.0.0.1:4173';
const assetSource = `${reviewOrigin}/__blueprint/assets/`;

describe('linked prototype assets', () => {
  it('resolves each linked asset to its review server URL and admits only that route in the document policy', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    const hashes = hashProjectAssets(bundle);
    const linked = linkProjectAssets(bundle, hashes);
    const target = { kind: 'screen', id: 'launch' } as const;

    const inline = compilePrototypeDocument({ bundle, target });
    const urls = compilePrototypeDocument({ bundle: linked, target, assetOrigin: reviewOrigin });

    assert.match(inline.html, /;base64,/);
    assert.doesNotMatch(urls.html, /;base64,/);
    assert.doesNotMatch(urls.html, /data:[a-z]+\/[a-z0-9.+-]+;/i);
    const policy = urls.html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)?.[1].replaceAll('&#39;', "'");
    assert.equal(
      policy,
      PROTOTYPE_CONTENT_SECURITY_POLICY
        .replace('img-src data:', `img-src data: ${assetSource}`)
        .replace('font-src data:', `font-src data: ${assetSource}`)
    );
    assert.doesNotMatch(policy ?? '', /\*|'self'/);
    for (const assetRef of screenAssetRefs(bundle, 'launch')) {
      assert.ok(urls.html.includes(`${assetSource}${hashes[assetRef]}`), assetRef);
    }

    const restored = Object.entries(hashes).reduce(
      (html, [assetRef, sha256]) => html.replaceAll(`${assetSource}${sha256}`, dataUrl(bundle, assetRef)),
      urls.html.replace(urls.html.match(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/)![0], inline.html.match(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/)![0])
    );
    assert.equal(restored, inline.html);
    assert.deepEqual({ ...urls, html: '' }, { ...inline, html: '' });
  });

  it('keeps a data URL for an asset that carries its bytes, and refuses an origin that is not exact', async () => {
    const bundle = await loadProjectFromFs(umbraRoot);
    const target = { kind: 'screen', id: 'launch' } as const;
    const withBytes = compilePrototypeDocument({ bundle, target, assetOrigin: reviewOrigin });
    assert.match(withBytes.html, /data:image\/svg\+xml;base64,/);
    assert.ok(withBytes.html.includes(`img-src data: ${assetSource}`));

    const linked = linkProjectAssets(bundle, hashProjectAssets(bundle));
    for (const assetOrigin of ['*', "'self'", `${reviewOrigin}/`, `${reviewOrigin}/x`, 'null', 'data:', 'file:///tmp', `${reviewOrigin}; script-src *`]) {
      assert.throws(() => compilePrototypeDocument({ bundle: linked, target, assetOrigin }), /exact http or https origin/, assetOrigin);
    }
    const forged: LinkedProjectBundle = {
      ...linked,
      prototypeAssetContents: {
        ...linked.prototypeAssetContents,
        'prototype/assets/art/eclipse.svg': { mediaType: 'image/svg+xml', sha256: '") onerror=x' }
      }
    };
    assert.throws(() => compilePrototypeDocument({ bundle: forged, target, assetOrigin: reviewOrigin }), /64 lowercase hex/);
  });
});

function screenAssetRefs(bundle: BlueprintProjectBundle, screenId: string): string[] {
  return bundle.screens.screens.find(screen => screen.id === screenId)?.prototype.assetRefs ?? [];
}

function dataUrl(bundle: BlueprintProjectBundle, assetRef: string): string {
  const asset = bundle.prototypeAssetContents[assetRef];
  return `data:${asset.mediaType};base64,${asset.base64}`;
}

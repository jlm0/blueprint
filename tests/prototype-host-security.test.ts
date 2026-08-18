import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROTOTYPE_CONTENT_SECURITY_POLICY } from '../src/prototype/compiler';
import {
  createBlueprintResponseHeaders,
  evaluateLoopbackHost,
  LOOPBACK_HOSTNAME
} from '../src/prototype/host-policy';

describe('prototype loopback host isolation', () => {
  it('admits only the exact advertised loopback Host and port', () => {
    assert.deepEqual(evaluateLoopbackHost('127.0.0.1:4173', 4173), {
      allowed: true,
      expectedHost: '127.0.0.1:4173'
    });

    for (const forgedHost of [undefined, 'localhost:4173', 'evil.example:4173', '127.0.0.1:4174', '127.0.0.1']) {
      const decision = evaluateLoopbackHost(forgedHost, 4173);
      assert.equal(decision.allowed, false, String(forgedHost));
      if (decision.allowed) {
        continue;
      }
      assert.equal(decision.status, 421);
      assert.equal(decision.expectedHost, `${LOOPBACK_HOSTNAME}:4173`);
      assert.equal(decision.headers['Cache-Control'], 'no-store');
      assert.equal(decision.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(decision.headers['Cross-Origin-Resource-Policy'], 'same-origin');
      assert.doesNotMatch(decision.body, /blueprint|source|asset|project/i);
    }
  });

  it('builds successful response headers from values with one defensive baseline', () => {
    const prototypeHeaders = createBlueprintResponseHeaders({
      contentType: 'text/html; charset=utf-8',
      contentSecurityPolicy: PROTOTYPE_CONTENT_SECURITY_POLICY,
      additionalHeaders: {
        'X-Blueprint-Screen': 'waitlist'
      }
    });
    const assetHeaders = createBlueprintResponseHeaders({
      contentType: 'text/css; charset=utf-8'
    });

    for (const headers of [prototypeHeaders, assetHeaders]) {
      assert.equal(headers['Cache-Control'], 'no-store');
      assert.equal(headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-origin');
    }
    assert.equal(prototypeHeaders['Content-Security-Policy'], PROTOTYPE_CONTENT_SECURITY_POLICY);
    assert.equal(prototypeHeaders['X-Blueprint-Screen'], 'waitlist');
    assert.equal(assetHeaders['Content-Type'], 'text/css; charset=utf-8');
    assert.equal('Content-Security-Policy' in assetHeaders, false);
  });
});

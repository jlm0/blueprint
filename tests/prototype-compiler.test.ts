import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compilePrototypeDocument,
  PROTOTYPE_CONTENT_SECURITY_POLICY,
  selectPrototypeReviewCondition
} from '../src/prototype/compiler';
import { parseBoundarySelector } from '../src/core/address';
import { loadProjectFromFs } from '../src/core/load';
import { createReadinessReport, validateProject } from '../src/core/validate';

const fixtureRoot = 'fixtures/red/high-fidelity-prototype/design/blueprint';

describe('canonical prototype compiler', () => {
  it('recursively composes declared slots, sources, tokens, assets, and stable boundary evidence', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const first = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'waitlist' },
      state: 'initial'
    });
    const second = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'waitlist' },
      state: 'initial'
    });

    assert.equal(first.html, second.html);
    assert.doesNotMatch(first.html, /<blueprint-use\b/i);
    assert.doesNotMatch(first.html, /<blueprint-boundary\b/i);
    assert.match(first.html, /Join waitlist/);
    assert.match(first.html, /data-blueprint-boundary-id="high-fidelity-red\/component\/email-signup"/);
    assert.match(first.html, /data-blueprint-boundary-id="high-fidelity-red\/primitive\/action-button"/);
    assert.match(first.html, /<button[^>]*data-blueprint-boundary-kind="primitive"/);
    assert.match(first.html, /data:image\/svg\+xml;base64,/);
    assert.match(first.html, /script-src &#39;none&#39;/);
    assert.match(first.html, new RegExp(escapeRegExpForTest(PROTOTYPE_CONTENT_SECURITY_POLICY.replaceAll("'", '&#39;'))));
    assert.deepEqual(
      first.observedUses.map(use => `${use.kind}:${use.id}:${use.state}`),
      ['component:email-signup:empty', 'primitive:action-button:default']
    );

    const appCssIndex = first.html.indexOf('[data-blueprint-screen="waitlist"]');
    const tokenOverrideIndex = first.html.indexOf('<style data-blueprint-token-overrides>');
    assert.ok(appCssIndex >= 0 && tokenOverrideIndex > appCssIndex, 'JSON token overrides must follow app CSS');
    assert.match(first.html.slice(tokenOverrideIndex), /--app-color-accent: #d9ff5b/);
  });

  it('selects a declared primitive state without changing the canonical source contract', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const compiled = compilePrototypeDocument({
      bundle,
      target: { kind: 'primitive', id: 'action-button' },
      state: 'disabled'
    });

    assert.match(compiled.html, /data-blueprint-state="disabled"/);
    assert.equal(compiled.state, 'disabled');
  });

  it('selects declared screen review conditions by state, frame preset, or condition ID', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'waitlist');
    assert.ok(screen);

    assert.deepEqual(selectPrototypeReviewCondition(screen), {
      conditionId: 'desktop-initial',
      framePresetId: 'desktop-reference',
      state: 'initial'
    });
    assert.deepEqual(selectPrototypeReviewCondition(screen, { viewport: 'phone-review', state: 'initial' }), {
      conditionId: 'phone-initial',
      framePresetId: 'phone-review',
      state: 'initial'
    });
    assert.deepEqual(selectPrototypeReviewCondition(screen, { viewport: 'phone-initial' }), {
      conditionId: 'phone-initial',
      framePresetId: 'phone-review',
      state: 'initial'
    });
    assert.throws(
      () => selectPrototypeReviewCondition(screen, { viewport: 'tablet' }),
      /does not declare a review condition/
    );
  });

  it('forwards only allowlisted invocation attributes onto the reusable root', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const actionButton = bundle.primitives.primitives.find(primitive => primitive.id === 'action-button');
    assert.ok(actionButton?.prototype);
    actionButton.prototype.variants.push('quiet');
    bundle.prototypeSourceContents['prototype/screens/waitlist.html'] = bundle.prototypeSourceContents[
      'prototype/screens/waitlist.html'
    ].replace(
      '<blueprint-use kind="component" ref="email-signup" state="empty"></blueprint-use>',
      '<blueprint-use kind="primitive" ref="action-button" state="default" variant="quiet" class="waitlist-action"><span slot="label" class="slotted-label">Open</span></blueprint-use>'
    );
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'waitlist');
    assert.ok(screen);
    screen.sections[0].uses = [{ kind: 'primitive', id: 'action-button', reason: 'allowlist test' }];

    const compiled = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'waitlist' } });
    assert.match(compiled.html, /<button[^>]*class="waitlist-action"[^>]*data-blueprint-variant="quiet"/);
    assert.match(compiled.html, /<span class="slotted-label">Open<\/span>/);

    bundle.prototypeSourceContents['prototype/screens/waitlist.html'] = bundle.prototypeSourceContents[
      'prototype/screens/waitlist.html'
    ].replace('class="waitlist-action"', 'onclick="alert(1)"');
    assert.throws(
      () => compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'waitlist' } }),
      /executable|unsupported <blueprint-use> attribute "onclick"/
    );
  });

  it('keeps dollar-amount slot content literal instead of reading $N as replacement groups', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    bundle.prototypeSourceContents['prototype/screens/waitlist.html'] = bundle.prototypeSourceContents[
      'prototype/screens/waitlist.html'
    ].replace(
      '<blueprint-use kind="component" ref="email-signup" state="empty"></blueprint-use>',
      '<blueprint-use kind="primitive" ref="action-button" state="default"><span slot="label" class="slotted-label">$4.28M treasury balance</span></blueprint-use>'
    );
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'waitlist');
    assert.ok(screen);
    screen.sections[0].uses = [{ kind: 'primitive', id: 'action-button', reason: 'dollar slot regression' }];

    const compiled = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'waitlist' } });
    assert.match(compiled.html, /<span class="slotted-label">\$4\.28M treasury balance<\/span>/);
  });

  it('preserves safe review destinations as inert metadata and rejects navigation-capable source', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const primitive = bundle.primitives.primitives.find(candidate => candidate.id === 'action-button');
    assert.ok(primitive?.prototype);
    bundle.prototypeSourceContents[primitive.prototype.source] = '<a data-blueprint-primitive="action-button"><span data-blueprint-slot="label">Open</span></a>';
    bundle.prototypeSourceContents['prototype/screens/waitlist.html'] = '<main><blueprint-use kind="primitive" ref="action-button" state="default" href="/auth"><span slot="label">Sign in</span></blueprint-use></main>';
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'waitlist');
    assert.ok(screen);
    screen.sections[0].uses = [{ kind: 'primitive', id: 'action-button', reason: 'href test' }];

    const compiled = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'waitlist' } });
    assert.match(compiled.html, /<a[^>]*data-blueprint-href="\/auth"/);
    assert.doesNotMatch(compiled.html, /<a[^>]*\shref=/);

    bundle.prototypeSourceContents['prototype/screens/waitlist.html'] = bundle.prototypeSourceContents[
      'prototype/screens/waitlist.html'
    ].replace('/auth', 'javascript:alert(1)');
    assert.throws(
      () => compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'waitlist' } }),
      /received unsafe href/
    );

    for (const unsafeSource of [
      '<main><meta http-equiv="refresh" content="0;url=https://example.com"><p>Waitlist</p></main>',
      '<main><a href="https://example.com">Leave</a></main>',
      '<main><form action="/submit"><button>Submit</button></form></main>',
      '<main><button formaction="/submit">Submit</button></main>',
      '<main><base href="https://example.com"><p>Waitlist</p></main>',
      '<main><link rel="stylesheet" href="https://example.com/app.css"><p>Waitlist</p></main>',
      '<main><a href=https://example.com>Leave</a></main>',
      '<main><a href="/one" href="/two">Leave</a></main>',
      '<main><area href="https://example.com" alt="Leave"></main>'
    ]) {
      const unsafe = structuredClone(bundle);
      unsafe.prototypeSourceContents['prototype/screens/waitlist.html'] = unsafeSource;
      assert.throws(
        () => compilePrototypeDocument({ bundle: unsafe, target: { kind: 'screen', id: 'waitlist' } }),
        /navigation|unsafe href|executable/
      );
    }
  });

  it('requires observed reusable uses to exactly match the declared graph without optional renderedUses', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'waitlist');
    assert.ok(screen?.prototype);
    delete screen.prototype.renderedUses;
    bundle.prototypeSourceContents[screen.prototype.source] = '<main data-blueprint-screen="waitlist">No composition</main>';

    assert.throws(
      () => compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'waitlist' } }),
      /rendered uses do not match its declared reusable dependencies/
    );
  });

  it('blocks validation and readiness when governed source cannot compile', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    bundle.prototypeSourceContents['prototype/screens/waitlist.html'] = bundle.prototypeSourceContents[
      'prototype/screens/waitlist.html'
    ].replace(
      '</main>',
      '<blueprint-use kind="component" ref="missing" state="initial"></blueprint-use></main>'
    );

    const baseline = validateProject(bundle);
    const strict = validateProject(bundle, { mode: 'strict' });
    const readiness = createReadinessReport(bundle);
    assert.equal(baseline.ok, false);
    assert.equal(strict.ok, false);
    assert.match(baseline.errors.join('\n'), /Prototype source graph.*missing|renders undeclared component "missing"/);
    assert.equal(readiness.tier, 'blocked');
    assert.ok(readiness.blockers.some(item => /Prototype source graph.*missing|renders undeclared component "missing"/.test(item.message)));
  });

  it('keeps Blank Slate composition selectors attached to rendered component and primitive roots', async () => {
    const bundle = await loadProjectFromFs('fixtures/app-owned/blank-slate/design/blueprint');
    const compiled = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'home' }, state: 'initial' });

    assert.doesNotMatch(compiled.html, /<blueprint-boundary\b|<blueprint-use\b/i);
    assert.match(compiled.html, /data-blueprint-component="site-nav"/);
    assert.match(compiled.html, /data-blueprint-component="cta-band"/);
    assert.match(compiled.html, /Start building/);
    const badgeCount = (compiled.html.match(/data-blueprint-primitive="badge"/g) ?? []).length;
    assert.equal(badgeCount, 13, `home should render 13 badge specimens, saw ${badgeCount}`);
    assert.match(
      compiled.html,
      /data-blueprint-component="site-footer"[\s\S]*data-blueprint-primitive="badge"/
    );
  });

  it('fails closed for undeclared uses, cycles, unsafe resources, and unsupported state', async () => {
    const original = await loadProjectFromFs(fixtureRoot);

    const undeclared = structuredClone(original);
    undeclared.prototypeSourceContents['prototype/screens/waitlist.html'] = undeclared.prototypeSourceContents[
      'prototype/screens/waitlist.html'
    ].replace('email-signup', 'metric-table');
    assert.throws(
      () => compilePrototypeDocument({ bundle: undeclared, target: { kind: 'screen', id: 'waitlist' } }),
      /renders undeclared component "metric-table"/
    );

    const cyclic = structuredClone(original);
    const emailSignup = cyclic.components.components.find(component => component.id === 'email-signup');
    assert.ok(emailSignup);
    emailSignup.uses.push({ kind: 'component', id: 'email-signup', reason: 'cycle fixture' });
    cyclic.prototypeSourceContents[emailSignup.prototype.source] = '<blueprint-use kind="component" ref="email-signup" state="empty"></blueprint-use>';
    assert.throws(
      () => compilePrototypeDocument({ bundle: cyclic, target: { kind: 'component', id: 'email-signup' } }),
      /composition cycle detected/
    );

    const remote = structuredClone(original);
    remote.prototypeSourceContents['prototype/screens/waitlist.html'] = '<main><img src="https://example.com/tracker.png"></main>';
    assert.throws(
      () => compilePrototypeDocument({ bundle: remote, target: { kind: 'screen', id: 'waitlist' } }),
      /controlled relative path/
    );

    const media = structuredClone(original);
    media.prototypeSourceContents['prototype/screens/waitlist.html'] = '<main><video src="../assets/teaser.mp4" autoplay muted loop></video></main>';
    assert.throws(
      () => compilePrototypeDocument({ bundle: media, target: { kind: 'screen', id: 'waitlist' } }),
      /contains media content \(<video>\/<audio>\) that the isolated prototype host cannot play/
    );

    assert.throws(
      () => compilePrototypeDocument({ bundle: original, target: { kind: 'screen', id: 'waitlist' }, state: 'missing' }),
      /does not declare prototype state "missing"/
    );
  });

  it('parses component selectors through the public boundary-address contract', () => {
    assert.deepEqual(parseBoundarySelector('component:email-signup'), {
      kind: 'component',
      id: 'email-signup'
    });
  });
});

function escapeRegExpForTest(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compilePrototypeDocument,
  PROTOTYPE_CONTENT_SECURITY_POLICY,
  selectPrototypeReviewCondition
} from '../src/prototype/compiler';
import { parseBoundarySelector } from '../src/core/address';
import { loadProjectFromFs } from '../src/core/load';
import type { BlueprintProjectBundle, BoundaryDependency } from '../src/core/types';
import { createReadinessReport, validateProject } from '../src/core/validate';

const fixtureRoot = 'fixtures/valid/mira-ai/design/blueprint';
const chatSource = 'prototype/screens/chat.html';

describe('canonical prototype compiler', () => {
  it('recursively composes declared slots, sources, tokens, assets, and stable boundary evidence', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const first = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'chat' },
      state: 'default'
    });
    const second = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'chat' },
      state: 'default'
    });

    assert.equal(first.html, second.html);
    assert.doesNotMatch(first.html, /<blueprint-use\b/i);
    assert.doesNotMatch(first.html, /<blueprint-boundary\b/i);
    assert.match(first.html, /Q3 churn drivers/);
    assert.match(first.html, /data-blueprint-boundary-id="mira-ai\/component\/insight-chart"/);
    assert.match(first.html, /data-blueprint-boundary-id="mira-ai\/primitive\/badge"/);
    assert.match(first.html, /<button[^>]*data-blueprint-boundary-kind="primitive"/);
    assert.match(first.html, /script-src &#39;none&#39;/);
    assert.match(first.html, new RegExp(escapeRegExpForTest(PROTOTYPE_CONTENT_SECURITY_POLICY.replaceAll("'", '&#39;'))));
    assert.deepEqual(
      first.observedUses.map(use => `${use.kind}:${use.id}:${use.state}`),
      [
        'primitive:nav-bar:back-and-right',
        'primitive:nav-bar:right-only',
        'component:insight-chart:compact',
        'primitive:segmented-control:second-selected',
        'primitive:badge:default',
        'primitive:badge:default',
        'primitive:badge:default',
        'component:prompt-card:compact',
        'component:prompt-card:compact',
        'component:prompt-card:compact',
        'component:composer:compact',
        'primitive:button:normal',
        'primitive:badge:default',
        'primitive:button:normal',
        'component:composer:compact',
        'primitive:button:normal',
        'primitive:badge:default',
        'primitive:button:normal'
      ]
    );

    const appCssIndex = first.html.indexOf('[data-blueprint-screen="chat"]');
    const tokenOverrideIndex = first.html.indexOf('<style data-blueprint-token-overrides>');
    assert.ok(appCssIndex >= 0 && tokenOverrideIndex > appCssIndex, 'JSON token overrides must follow app CSS');
    assert.match(first.html.slice(tokenOverrideIndex), /--app-color-accent: #2563eb/);
  });

  it('inlines declared local assets as data URLs', async () => {
    const bundle = await loadProjectFromFs('fixtures/valid/umbra-gaming/design/blueprint');
    const launch = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'launch' }, state: 'default' });

    assert.match(launch.html, /data:image\/svg\+xml;base64,/);
    assert.doesNotMatch(launch.html, /src="\.\.\/assets\//);
  });

  it('selects a declared primitive state without changing the canonical source contract', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const compiled = compilePrototypeDocument({
      bundle,
      target: { kind: 'primitive', id: 'button' },
      state: 'disabled'
    });

    assert.match(compiled.html, /data-blueprint-state="disabled"/);
    assert.equal(compiled.state, 'disabled');
  });

  it('selects declared screen review conditions by state, frame preset, or condition ID', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const workspace = bundle.screens.screens.find(candidate => candidate.id === 'workspace');
    const chat = bundle.screens.screens.find(candidate => candidate.id === 'chat');
    assert.ok(workspace && chat);

    assert.deepEqual(selectPrototypeReviewCondition(workspace), {
      conditionId: 'desktop-web-default',
      framePresetId: 'desktop-web',
      state: 'default'
    });
    assert.deepEqual(selectPrototypeReviewCondition(chat, { viewport: 'phone', state: 'empty' }), {
      conditionId: 'phone-empty',
      framePresetId: 'phone',
      state: 'empty'
    });
    assert.deepEqual(selectPrototypeReviewCondition(chat, { viewport: 'phone-empty' }), {
      conditionId: 'phone-empty',
      framePresetId: 'phone',
      state: 'empty'
    });
    assert.throws(
      () => selectPrototypeReviewCondition(chat, { viewport: 'tablet' }),
      /does not declare a review condition/
    );
  });

  it('forwards only allowlisted invocation attributes onto the reusable root', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const button = bundle.primitives.primitives.find(primitive => primitive.id === 'button');
    assert.ok(button?.prototype);
    button.prototype.variants.push('quiet');
    focusChat(
      bundle,
      '<main><blueprint-use kind="primitive" ref="button" state="normal" variant="quiet" class="chat-action"><span slot="label" class="slotted-label">Open</span></blueprint-use></main>',
      [{ kind: 'primitive', id: 'button', reason: 'allowlist test' }]
    );

    const compiled = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'chat' } });
    const root = compiled.html.match(/<button[^>]*data-blueprint-primitive="button"[^>]*>/)?.[0] ?? '';
    assert.match(root, /class="chat-action"/);
    assert.match(root, /data-blueprint-variant="quiet"/);
    assert.match(compiled.html, /<span class="slotted-label">Open<\/span>/);

    bundle.prototypeSourceContents[chatSource] = bundle.prototypeSourceContents[chatSource].replace('class="chat-action"', 'onclick="alert(1)"');
    assert.throws(
      () => compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'chat' } }),
      /executable|unsupported <blueprint-use> attribute "onclick"/
    );
  });

  it('keeps dollar-amount slot content literal instead of reading $N as replacement groups', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    focusChat(
      bundle,
      '<main><blueprint-use kind="primitive" ref="button" state="normal"><span slot="label" class="slotted-label">$4.28M treasury balance</span></blueprint-use></main>',
      [{ kind: 'primitive', id: 'button', reason: 'dollar slot regression' }]
    );

    const compiled = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'chat' } });
    assert.match(compiled.html, /<span class="slotted-label">\$4\.28M treasury balance<\/span>/);
  });

  it('preserves safe review destinations as inert metadata and rejects navigation-capable source', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const primitive = bundle.primitives.primitives.find(candidate => candidate.id === 'button');
    assert.ok(primitive?.prototype);
    bundle.prototypeSourceContents[primitive.prototype.source] = '<a data-blueprint-primitive="button"><span data-blueprint-slot="label">Open</span></a>';
    focusChat(
      bundle,
      '<main><blueprint-use kind="primitive" ref="button" state="normal" href="/auth"><span slot="label">Sign in</span></blueprint-use></main>',
      [{ kind: 'primitive', id: 'button', reason: 'href test' }]
    );

    const compiled = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'chat' } });
    assert.match(compiled.html, /<a[^>]*data-blueprint-href="\/auth"/);
    assert.doesNotMatch(compiled.html, /<a[^>]*\shref=/);

    bundle.prototypeSourceContents[chatSource] = bundle.prototypeSourceContents[chatSource].replace('/auth', 'javascript:alert(1)');
    assert.throws(
      () => compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'chat' } }),
      /received unsafe href/
    );

    for (const unsafeSource of [
      '<main><meta http-equiv="refresh" content="0;url=https://example.com"><p>Chat</p></main>',
      '<main><a href="https://example.com">Leave</a></main>',
      '<main><form action="/submit"><button>Submit</button></form></main>',
      '<main><button formaction="/submit">Submit</button></main>',
      '<main><base href="https://example.com"><p>Chat</p></main>',
      '<main><link rel="stylesheet" href="https://example.com/app.css"><p>Chat</p></main>',
      '<main><a href=https://example.com>Leave</a></main>',
      '<main><a href="/one" href="/two">Leave</a></main>',
      '<main><area href="https://example.com" alt="Leave"></main>'
    ]) {
      const unsafe = structuredClone(bundle);
      unsafe.prototypeSourceContents[chatSource] = unsafeSource;
      assert.throws(
        () => compilePrototypeDocument({ bundle: unsafe, target: { kind: 'screen', id: 'chat' } }),
        /navigation|unsafe href|executable/
      );
    }
  });

  it('requires observed reusable uses to exactly match the declared graph without optional renderedUses', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const screen = bundle.screens.screens.find(candidate => candidate.id === 'chat');
    assert.ok(screen?.prototype);
    delete screen.prototype.renderedUses;
    bundle.prototypeSourceContents[screen.prototype.source] = '<main data-blueprint-screen="chat">No composition</main>';

    assert.throws(
      () => compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'chat' } }),
      /rendered uses do not match its declared reusable dependencies/
    );
  });

  it('blocks validation and readiness when governed source cannot compile', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    bundle.prototypeSourceContents[chatSource] = bundle.prototypeSourceContents[chatSource].replace(
      /<\/div>\s*$/,
      '<blueprint-use kind="component" ref="missing" state="default"></blueprint-use></div>'
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

  it('keeps Umbra composition selectors attached to rendered component and primitive roots', async () => {
    const bundle = await loadProjectFromFs('fixtures/valid/umbra-gaming/design/blueprint');
    const compiled = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'launch' }, state: 'default' });

    assert.doesNotMatch(compiled.html, /<blueprint-boundary\b|<blueprint-use\b/i);
    assert.match(compiled.html, /data-blueprint-component="mode-tile"/);
    assert.match(compiled.html, /data-blueprint-component="edition-card"/);
    assert.match(compiled.html, /Play free now/);
    const badgeCount = (compiled.html.match(/<\w[^>]*\sdata-blueprint-primitive="badge"/g) ?? []).length;
    assert.equal(badgeCount, 10, `launch should render 10 badge specimens, saw ${badgeCount}`);
    assert.match(
      compiled.html,
      /data-blueprint-component="edition-card"[\s\S]*data-blueprint-primitive="badge"/
    );
  });

  it('forwards declared primitive sizes to the rendered root and rejects undeclared ones', async () => {
    const bundle = await loadProjectFromFs('starter/design/blueprint');
    const button = { kind: 'primitive' as const, id: 'button' };
    const icon = compilePrototypeDocument({ bundle, target: button, state: 'normal', size: 'icon' });
    assert.match(icon.html, /<button[^>]*data-blueprint-size="icon"/);
    assert.throws(() => compilePrototypeDocument({ bundle, target: button, state: 'normal', size: 'xl' }), /does not declare size "xl"/);
    assert.throws(
      () => compilePrototypeDocument({ bundle, target: { kind: 'primitive', id: 'badge' }, state: 'default', size: 'sm' }),
      /does not declare size "sm"/
    );

    const source = 'prototype/components/action-cluster.html';
    bundle.prototypeSourceContents[source] = bundle.prototypeSourceContents[source].replace(
      /<blueprint-use kind="primitive" ref="button"/,
      '<blueprint-use kind="primitive" ref="button" size="sm"'
    );
    const cluster = compilePrototypeDocument({ bundle, target: { kind: 'component', id: 'action-cluster' } });
    assert.match(cluster.html, /<button[^>]*data-blueprint-size="sm"/);
  });

  it('exposes the frame preset safe-area insets to compiled screens', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const phone = bundle.manifest.framePresets.find(preset => preset.id === 'phone');
    assert.ok(phone);
    phone.safeArea = { top: 59, right: 20, bottom: 34, left: 20 };
    const framed = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'chat' }, framePreset: phone });
    assert.match(framed.html, /--blueprint-safe-area-top:59px;--blueprint-safe-area-right:20px;--blueprint-safe-area-bottom:34px;--blueprint-safe-area-left:20px;/);
    const unframed = compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'chat' } });
    assert.match(unframed.html, /--blueprint-safe-area-top:0px;/);
  });

  it('fails closed for undeclared uses, cycles, unsafe resources, and unsupported state', async () => {
    const original = await loadProjectFromFs(fixtureRoot);

    const undeclared = structuredClone(original);
    undeclared.prototypeSourceContents[chatSource] = undeclared.prototypeSourceContents[chatSource].replace('ref="insight-chart"', 'ref="metric-table"');
    assert.throws(
      () => compilePrototypeDocument({ bundle: undeclared, target: { kind: 'screen', id: 'chat' } }),
      /renders undeclared component "metric-table"/
    );

    const cyclic = structuredClone(original);
    const composer = cyclic.components.components.find(component => component.id === 'composer');
    assert.ok(composer);
    composer.uses.push({ kind: 'component', id: 'composer', reason: 'cycle fixture' });
    cyclic.prototypeSourceContents[composer.prototype.source] = '<blueprint-use kind="component" ref="composer" state="compact"></blueprint-use>';
    assert.throws(
      () => compilePrototypeDocument({ bundle: cyclic, target: { kind: 'component', id: 'composer' } }),
      /composition cycle detected/
    );

    const remote = structuredClone(original);
    remote.prototypeSourceContents[chatSource] = '<main><img src="https://example.com/tracker.png"></main>';
    assert.throws(
      () => compilePrototypeDocument({ bundle: remote, target: { kind: 'screen', id: 'chat' } }),
      /controlled relative path/
    );

    const media = structuredClone(original);
    media.prototypeSourceContents[chatSource] = '<main><video src="../assets/teaser.mp4" autoplay muted loop></video></main>';
    assert.throws(
      () => compilePrototypeDocument({ bundle: media, target: { kind: 'screen', id: 'chat' } }),
      /contains media content \(<video>\/<audio>\) that the isolated prototype host cannot play/
    );

    assert.throws(
      () => compilePrototypeDocument({ bundle: original, target: { kind: 'screen', id: 'chat' }, state: 'missing' }),
      /does not declare prototype state "missing"/
    );
  });

  it('annotates declared section markers, including markers forwarded through blueprint-use', async () => {
    const bundle = await loadProjectFromFs(fixtureRoot);
    const chat = compilePrototypeDocument({
      bundle,
      target: { kind: 'screen', id: 'chat' },
      state: 'default'
    });
    assert.match(chat.html, /<header class="chat__header" data-blueprint-section="header" data-blueprint-section-boundary-id="mira-ai\/section\/chat\/header">/);

    const forwarded = structuredClone(bundle);
    forwarded.prototypeSourceContents[chatSource] = forwarded.prototypeSourceContents[chatSource]
      .replace('<div class="dock" data-blueprint-section="composer">', '<div class="dock">')
      .replace('<blueprint-use kind="component" ref="composer"', '<blueprint-use kind="component" ref="composer" data-blueprint-section="composer"');
    const compiled = compilePrototypeDocument({ bundle: forwarded, target: { kind: 'screen', id: 'chat' } });
    const sectionRoot = compiled.html.match(/<[^>]*data-blueprint-section="composer"[^>]*>/)?.[0] ?? '';
    assert.match(sectionRoot, /data-blueprint-section-boundary-id="mira-ai\/section\/chat\/composer"/);
    assert.match(sectionRoot, /data-blueprint-boundary-id="mira-ai\/component\/composer"/);
  });

  it('rejects undeclared or repeated section markers and reports unmarked sections for strict handoff', async () => {
    const original = await loadProjectFromFs(fixtureRoot);
    const source = chatSource;

    const undeclared = structuredClone(original);
    undeclared.prototypeSourceContents[source] = undeclared.prototypeSourceContents[source].replace('<p class="stamp">', '<p class="stamp" data-blueprint-section="masthead">');
    assert.throws(
      () => compilePrototypeDocument({ bundle: undeclared, target: { kind: 'screen', id: 'chat' } }),
      /marks undeclared section "masthead"/
    );

    const repeated = structuredClone(original);
    repeated.prototypeSourceContents[source] = repeated.prototypeSourceContents[source].replace('<p class="stamp">', '<p class="stamp" data-blueprint-section="header">');
    assert.throws(
      () => compilePrototypeDocument({ bundle: repeated, target: { kind: 'screen', id: 'chat' } }),
      /marks section "header" more than once/
    );

    const unmarked = structuredClone(original);
    unmarked.prototypeSourceContents[source] = unmarked.prototypeSourceContents[source].replace(' data-blueprint-section="header"', '');
    assert.doesNotMatch(validateProject(unmarked).errors.join('\n'), /data-blueprint-section/);
    assert.match(validateProject(unmarked, { mode: 'strict' }).errors.join('\n'), /screen\.chat\.section\.header needs a data-blueprint-section="header" marker/);
    assert.ok(createReadinessReport(unmarked).blockers.some(item => item.path === 'screen.chat.section.header.marker'));
    assert.equal(createReadinessReport(original).items.some(item => item.path.endsWith('.marker')), false);
  });

  it('parses component selectors through the public boundary-address contract', () => {
    assert.deepEqual(parseBoundarySelector('component:insight-chart'), {
      kind: 'component',
      id: 'insight-chart'
    });
  });
});

function focusChat(bundle: BlueprintProjectBundle, markup: string, uses: BoundaryDependency[]): void {
  const screen = bundle.screens.screens.find(candidate => candidate.id === 'chat');
  assert.ok(screen?.prototype);
  screen.sections = [{ ...screen.sections[0], uses }];
  delete screen.prototype.renderedUses;
  bundle.prototypeSourceContents[chatSource] = markup;
}

function escapeRegExpForTest(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

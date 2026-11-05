import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadProjectFromFs } from '../src/core/load';
import { lintProse, type ProseErrorRule } from '../src/core/prose-lint';
import { validateReusables } from '../src/core/reusable-validate';
import type { BlueprintProjectBundle } from '../src/core/types';
import { createBlueprintMcpServer, toolErrorText } from '../src/mcp/create-server';
import { downloadInspoImage } from '../src/mcp/inspo-download';
import { initializeBlueprint } from '../src/mcp/operations';
import { compilePrototypeDocument, inspectPrototypeSourceGraph, selectPrototypeReviewCondition } from '../src/prototype/compiler';
import { parsePrototypeReviewRequest, resolvePrototypeReviewSelection } from '../src/prototype/review';
import { createReadinessReport, validateProject } from '../src/prototype/validate-project';
import {
  BANNED_FIX_TEXT,
  ERROR_SOURCE_DIRECTORIES,
  readErrorSites,
  type ErrorSiteReport,
  type FixAllowEntry
} from './support/error-fix-guard';
import { withProjectCopy } from './support/project-copies';

const WRAPPER = 'Wrapper: it adds a prefix to messages that each hold a Fix: line.';
const RETHROW = 'Rethrow: it passes on a message from a site that this guard checks.';
const PROSE_TABLE = 'The prose table in this file runs each error rule of lintProse.';

/** Each expression that the guard cannot prove, with the reason that it is safe. */
const ALLOW_LIST: readonly FixAllowEntry[] = [
  { file: 'src/core/brand-lint.ts', match: '(error as Error).message', reason: `${RETHROW} The site is the markup scan in src/core/markup.ts.` },
  { file: 'src/core/contract-checks.ts', match: '`${label} ${issue.message}`', reason: `Wrapper: it adds a label to a lintProse error. ${PROSE_TABLE}` },
  { file: 'src/mcp/migration-validation.ts', match: 'error.issues', reason: 'Each issue comes from agentErrorForIssue in src/core/schemas/issues.ts, which ends it with a Fix.' },
  { file: 'src/core/candidate-rules.ts', match: '`exploration.${exploration.id} candidate.${candidate.id}: ${error}`', reason: `${WRAPPER} The rule table in tests/rule-fixtures.test.ts runs each rule on a candidate file.` },
  { file: 'src/core/prose-lint.ts', match: 'message(match[0])', reason: `PATTERN_RULES holds error rules and advisory rules. ${PROSE_TABLE}` },
  { file: 'src/core/style-rules.ts', match: '`${issue.boundary} ${issue.location} ${issue.message}`', reason: `${WRAPPER} The rule table in tests/rule-fixtures.test.ts runs each style rule.` },
  { file: 'src/core/validate.ts', match: '`Prototype source graph ${issue.boundaryId} state "${issue.state}" cannot compile: ${issue.message}`', reason: `${WRAPPER} The messages are compiler errors.` },
  { file: 'src/core/validate.ts', match: '`${label}.target baseline cannot be digested: ${error instanceof Error ? error.message : String(error)}`', reason: `${WRAPPER} The messages come from the digest checks in src/core/exploration.ts.` },
  { file: 'src/prototype/compiler.ts', match: 'error instanceof Error ? error.message : String(error)', reason: `${RETHROW} inspectPrototypeSourceGraph reports a caught compiler error, and it adds a Fix: line when the error has none.` },
  { file: 'src/prototype/review.ts', match: '`Compiled screen review did not match the validated selection for "${selection.screenId}".`', reason: 'Internal invariant: resolvePrototypeReviewSelection derives both values from one bundle, and capture reads the result directly.' },
  { file: 'src/mcp/activity.ts', match: "signal.reason instanceof Error ? signal.reason : new Error('Operation aborted. Fix: call the tool again if you still need its result.')", reason: 'The caller that cancels the call sets the reason, and no agent reads it as a repair.' },
  { file: 'src/mcp/operation-support.ts', match: "signal.reason instanceof Error ? signal.reason : new Error('Blueprint tool call was cancelled. Fix: call the tool again if you still need its result.')", reason: 'The caller that cancels the call sets the reason, and no agent reads it as a repair.' },
  { file: 'src/mcp/create-server.ts', match: 'rejected.reason', reason: 'The server stops here, and no tool call is open to read the message.' },
  { file: 'src/mcp/operations.ts', match: 'validated.error', reason: `${RETHROW} The site is readValidatedProject.` },
  { file: 'src/mcp/project-files.ts', match: 'errors.push(error)', reason: 'The list holds caught errors for an AggregateError, and the message of that AggregateError holds the Fix: line.' },
  { file: 'src/mcp/project-validation.ts', match: 'reply.thrown', reason: `${RETHROW} The worker sends the message of an error that it caught.` },
  { file: 'src/mcp/serve-server.ts', match: 'snapshot.error', reason: `${RETHROW} The site is readValidatedProject.` }
];

const GUARD_FIX = 'Fix: append "Fix: <exact change>" to this message, or add a named entry to ALLOW_LIST in tests/errors-have-fix.test.ts.';

function assertNamesAChange(message: string, context: string): void {
  assert.ok(message.includes('Fix:'), `${context} has no Fix: line: ${message}\nFix: append "Fix: <exact change>" to this message where the source throws it.`);
  for (const fix of message.split('Fix:').slice(1)) {
    assert.ok(!/:\s+[.,]|\b(?:of|ids:|declares)\s+[.,]|(?<!display): none\b/.test(fix), `${context} has a Fix: line with an empty list: ${fix.trim()}\nFix: leave out the list when it has no entries, where the source writes this line.`);
    const generic = BANNED_FIX_TEXT.find(pattern => pattern.test(fix.trim()));
    assert.ok(!generic, `${context} has a generic Fix: line: ${fix.trim()}\nFix: name the file or field to edit, and the value or action.`);
  }
}

describe('each error site in the source', () => {
  let report: ErrorSiteReport;

  before(() => {
    report = readErrorSites(ALLOW_LIST);
  });

  it('reads the sites of each directory, so that a broken parse cannot pass', () => {
    for (const directory of ERROR_SOURCE_DIRECTORIES) {
      const sites = report.sites.filter(site => site.file.startsWith(`${directory}/`));
      assert.ok(sites.length > 0, `${directory} has no error sites. Fix: repair readErrorSites in tests/support/error-fix-guard.ts, which must find the sites of this directory.`);
    }
  });

  it('finds as many sites as the source held when this guard began', () => {
    assert.ok(report.sites.length >= 450, `The guard finds ${report.sites.length} sites. Fix: repair readErrorSites in tests/support/error-fix-guard.ts, which must find the sites of src/core, src/prototype, and src/mcp.`);
  });

  it('holds a Fix: line in its text or in the helper that it calls', () => {
    const failures = report.sites.flatMap(site => site.gaps.map(gap => (
      `${site.file}:${site.line} ${site.text.slice(0, 160)}\n  ${gap.file}:${gap.line} ${gap.reason}: ${gap.text.slice(0, 160)}\n  ${GUARD_FIX}`
    )));
    assert.deepEqual(failures, [], failures.join('\n'));
  });

  it('names a change in each Fix: line', () => {
    const failures = report.genericFixes.map(({ file, line, fix }) => (
      `${file}:${line} has the generic Fix: text "${fix}". Fix: name the file or field to edit, and the value or action, in ${file}:${line}.`
    ));
    assert.deepEqual(failures, [], failures.join('\n'));
  });

  it('keeps each allow list entry on a live expression', () => {
    const failures = report.staleAllowEntries.map(({ file, match }) => (
      `The allow list entry for ${file}:1 matches no expression: "${match}". Fix: remove this entry from ALLOW_LIST in tests/errors-have-fix.test.ts.`
    ));
    assert.deepEqual(failures, [], failures.join('\n'));
  });
});

describe('the errors of the broken fixture', () => {
  it('each hold a Fix: line in baseline, strict, and readiness', async () => {
    const bundle = await loadProjectFromFs('fixtures/invalid/broken/design/blueprint');
    for (const mode of ['baseline', 'strict'] as const) {
      const { errors } = validateProject(bundle, { mode });
      assert.ok(errors.length > 0, mode);
      for (const error of errors) assertNamesAChange(error, `validate ${mode}`);
    }
    for (const blocker of createReadinessReport(bundle).blockers) assertNamesAChange(blocker.message, 'readiness blocker');
  });
});

describe('the error rules of lintProse', () => {
  const inputs: Record<ProseErrorRule, string> = {
    semicolon: 'Use it; stop.',
    'phrasal-verb': 'We spin up a server.',
    'marketing-adjective': 'A seamless flow.',
    nominalization: 'Perform an analysis now.',
    'long-sentence': `${'word '.repeat(30).trim()}.`,
    'dangling-conjunction': 'Use this and',
    'line-break': 'One line.\nTwo lines.',
    'sentence-form': 'starts low'
  };

  for (const [rule, text] of Object.entries(inputs)) {
    it(`holds a Fix: line for ${rule}`, () => {
      const issue = lintProse(text).find(candidate => candidate.rule === rule);
      assert.ok(issue, `lintProse does not report ${rule}. Fix: change the input of ${rule} in tests/errors-have-fix.test.ts so that the rule fires.`);
      assertNamesAChange(issue.message, rule);
    });
  }
});

const CHAT_SOURCE = 'prototype/screens/chat.html';
const CHAT_STYLE = 'prototype/screens/chat.css';
const CHAT = { kind: 'screen', id: 'chat' } as const;

type Bundle = BlueprintProjectBundle;

function chat(bundle: Bundle): Bundle['screens']['screens'][number] {
  const screen = bundle.screens.screens.find(candidate => candidate.id === 'chat');
  assert.ok(screen?.prototype);
  return screen;
}

function primitive(bundle: Bundle, id: string): Bundle['primitives']['primitives'][number] {
  const found = bundle.primitives.primitives.find(candidate => candidate.id === id);
  assert.ok(found);
  return found;
}

function put(bundle: Bundle, markup: string, uses: Array<{ kind: 'primitive' | 'component'; id: string }> = []): void {
  const screen = chat(bundle);
  screen.sections = [{ ...screen.sections[0], uses: uses.map(use => ({ ...use, reason: 'test' })) }];
  delete screen.prototype.renderedUses;
  bundle.prototypeSourceContents[CHAT_SOURCE] = markup;
}

function main(markup: string): string {
  return `<main data-blueprint-screen="chat">${markup}</main>`;
}

const BADGE = [{ kind: 'primitive', id: 'badge' }] as const;
const BUTTON = [{ kind: 'primitive', id: 'button' }] as const;

interface CompileCase {
  name: string;
  expected: RegExp;
  arrange: (bundle: Bundle) => void;
  run?: (bundle: Bundle) => unknown;
}

const compileChat = (bundle: Bundle): unknown => compilePrototypeDocument({ bundle, target: CHAT });

const COMPILE_CASES: readonly CompileCase[] = [
  { name: 'a script element', expected: /Prototype source .* contains executable, navigation, form, or nested browsing content/, arrange: bundle => put(bundle, main('<script>run()</script>')) },
  { name: 'a media element', expected: /Prototype source .* contains media content/, arrange: bundle => put(bundle, main('<video></video>')) },
  { name: 'an unquoted asset attribute', expected: /Prototype source .* has an unquoted src value/, arrange: bundle => put(bundle, main('<img src=x.png alt="">')) },
  { name: 'a live link in a comment', expected: /Prototype source .* holds a navigation href/, arrange: bundle => put(bundle, main('<!-- <a href="/x">x</a> -->')) },
  { name: 'a reserved attribute', expected: /Prototype source .* cannot contain the reserved/, arrange: bundle => put(bundle, main('<i data-blueprint-slot-author="x"></i>')) },
  { name: 'two hrefs', expected: /Prototype source .* contains malformed or duplicate navigation href markup/, arrange: bundle => put(bundle, main('<a href="/a" href="/b">x</a>')) },
  { name: 'an external href', expected: /Prototype source .* contains unsafe href/, arrange: bundle => put(bundle, main('<a href="https://example.com">x</a>')) },
  { name: 'a noncharacter', expected: /contains a reserved noncharacter/, arrange: bundle => put(bundle, main('﷐')) },
  { name: 'a missing source', expected: /is missing from the loaded bundle/, arrange: bundle => { delete bundle.prototypeSourceContents[CHAT_SOURCE]; } },
  { name: 'a cut-off tag', expected: /contains an unclosed HTML tag/, arrange: bundle => put(bundle, '<main><blueprint-use kind="primitive" ref="badge"') },
  { name: 'an unclosed use', expected: /contains an unclosed <blueprint-use> element/, arrange: bundle => put(bundle, main('<blueprint-use kind="primitive" ref="badge">')) },
  { name: 'an undeclared resource', expected: /Prototype resource .* is not a declared controlled asset/, arrange: bundle => put(bundle, main('<img src="../assets/none.png" alt="">')) },
  { name: 'a resource with a query', expected: /Prototype resource URL .* must be a controlled relative path/, arrange: bundle => put(bundle, main('<img src="x.png?a=1" alt="">')) },
  { name: 'a resource with bad escaping', expected: /Prototype resource URL .* contains invalid escaping/, arrange: bundle => put(bundle, main('<img src="%E0%A4%A.png" alt="">')) },
  { name: 'a resource outside the project', expected: /Prototype resource URL .* escapes the app-owned sidecar root/, arrange: bundle => put(bundle, main('<img src="../../../../x.png" alt="">')) },
  {
    name: 'a declared asset that is gone',
    expected: /Declared prototype asset .* is missing from the loaded bundle/,
    arrange: bundle => {
      put(bundle, main('<img src="../assets/none.png" alt="">'));
      chat(bundle).prototype.assetRefs = ['prototype/assets/none.png'];
    }
  },
  { name: 'an import in a stylesheet', expected: /Prototype stylesheet .* cannot import/, arrange: bundle => { bundle.prototypeSourceContents[CHAT_STYLE] += '\n@import url(x.css);\n'; } },
  { name: 'a closing style tag', expected: /Prototype stylesheet contains an unsafe closing style tag/, arrange: bundle => { bundle.prototypeSourceContents[CHAT_STYLE] += '\n</style>\n'; } },
  {
    name: 'a composition cycle',
    expected: /Prototype composition cycle detected/,
    arrange: bundle => {
      const composer = bundle.components.components.find(component => component.id === 'composer');
      assert.ok(composer);
      composer.uses.push({ kind: 'component', id: 'composer', reason: 'test' });
      bundle.prototypeSourceContents[composer.prototype.source] = '<div data-blueprint-component="composer"><blueprint-use kind="component" ref="composer"></blueprint-use></div>';
    },
    run: bundle => compilePrototypeDocument({ bundle, target: { kind: 'component', id: 'composer' } })
  },
  { name: 'a use of another kind', expected: /uses unsupported reusable boundary kind "screen"/, arrange: bundle => put(bundle, main('<blueprint-use kind="screen" ref="chat"></blueprint-use>')) },
  { name: 'a use with no ref', expected: /contains <blueprint-use> without required "ref"/, arrange: bundle => put(bundle, main('<blueprint-use kind="primitive"></blueprint-use>')) },
  { name: 'a use with an unquoted attribute', expected: /contains a malformed or unquoted <blueprint-use> attribute/, arrange: bundle => put(bundle, main('<blueprint-use kind=primitive ref="badge"></blueprint-use>')) },
  { name: 'a use with a duplicate attribute', expected: /contains duplicate <blueprint-use> attribute "ref"/, arrange: bundle => put(bundle, main('<blueprint-use kind="primitive" ref="badge" ref="badge"></blueprint-use>')) },
  { name: 'an undeclared use', expected: /renders undeclared primitive "badge"/, arrange: bundle => put(bundle, main('<blueprint-use kind="primitive" ref="badge"></blueprint-use>')) },
  {
    name: 'a slot use that its author does not declare',
    expected: /renders undeclared primitive "badge" inside primitive "alert-dialog"/,
    arrange: bundle => {
      primitive(bundle, 'alert-dialog').slots.find(slot => slot.id === 'message')?.accepts.push('primitive:badge');
      put(bundle, main('<blueprint-use kind="primitive" ref="alert-dialog" variant="neutral"><div slot="message"><blueprint-use kind="primitive" ref="badge"></blueprint-use></div></blueprint-use>'), [{ kind: 'primitive', id: 'alert-dialog' }]);
    }
  },
  { name: 'uses that the source does not render', expected: /rendered uses do not match its declared reusable dependencies/, arrange: bundle => put(bundle, main('none'), [...BADGE]) },
  { name: 'an unknown primitive', expected: /Unknown prototype primitive "none"/, arrange: () => {}, run: bundle => compilePrototypeDocument({ bundle, target: { kind: 'primitive', id: 'none' } }) },
  { name: 'an unknown component', expected: /Unknown prototype component "none"/, arrange: () => {}, run: bundle => compilePrototypeDocument({ bundle, target: { kind: 'component', id: 'none' } }) },
  { name: 'an unknown screen', expected: /Unknown prototype screen "none"/, arrange: () => {}, run: bundle => compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'none' } }) },
  {
    name: 'a primitive with no source',
    expected: /Primitive "badge" has no canonical prototype source/,
    arrange: bundle => { delete (primitive(bundle, 'badge') as { prototype?: unknown }).prototype; },
    run: bundle => compilePrototypeDocument({ bundle, target: { kind: 'primitive', id: 'badge' } })
  },
  { name: 'a screen with no source', expected: /Screen "chat" has no browser-native prototype source/, arrange: bundle => { delete (chat(bundle) as { prototype?: unknown }).prototype; } },
  { name: 'a marker of an undeclared section', expected: /marks undeclared section "none"/, arrange: bundle => put(bundle, main('<div data-blueprint-section="none"></div>')) },
  { name: 'two markers of one section', expected: /marks section "header" more than once/, arrange: bundle => put(bundle, main('<div data-blueprint-section="header"></div><div data-blueprint-section="header"></div>')) },
  { name: 'a variant on a screen', expected: /cannot receive a variant/, arrange: () => {}, run: bundle => compilePrototypeDocument({ bundle, target: CHAT, variant: 'x' }) },
  { name: 'an undeclared size', expected: /does not declare size "xl"/, arrange: () => {}, run: bundle => compilePrototypeDocument({ bundle, target: { kind: 'primitive', id: 'button' }, size: 'xl' }) },
  {
    name: 'an unsupported pair',
    expected: /does not support variant "primary" in state "normal"/,
    arrange: bundle => { primitive(bundle, 'button').unsupported = [{ axis: 'variant', value: 'primary', state: 'normal', reason: 'Not offered.' }]; },
    run: bundle => compilePrototypeDocument({ bundle, target: { kind: 'primitive', id: 'button' } })
  },
  { name: 'an undeclared state', expected: /does not declare prototype state "none"/, arrange: () => {}, run: bundle => compilePrototypeDocument({ bundle, target: CHAT, state: 'none' }) },
  {
    name: 'a state on a component with no states',
    expected: /component "[^"]+" does not declare prototype state "default"/,
    arrange: bundle => { bundle.components.components[0]!.states.values = []; },
    run: bundle => compilePrototypeDocument({ bundle, target: { kind: 'component', id: bundle.components.components[0]!.id }, state: 'default' })
  },
  { name: 'a screen with no states', expected: /has no declared prototype state/, arrange: bundle => { chat(bundle).prototype.states = []; } },
  { name: 'an open host policy', expected: /Canonical prototype compilation requires prototypeHost/, arrange: bundle => { (bundle.manifest.prototypeHost as { network: string }).network = 'allow'; } },
  { name: 'a token style ref of the wrong form', expected: /must be a CSS custom property/, arrange: bundle => { bundle.tokens.tokenGroups[0].tokens[0].styleRef = 'color'; } },
  { name: 'a repeated token style ref', expected: /is declared more than once/, arrange: bundle => { bundle.tokens.tokenGroups[0].tokens[1].styleRef = bundle.tokens.tokenGroups[0].tokens[0].styleRef; } },
  { name: 'an unsafe token value', expected: /contains an unsafe CSS value/, arrange: bundle => { bundle.tokens.tokenGroups[0].tokens[0].value = 'red;}'; } },
  { name: 'content outside a slot', expected: /received content outside any named slot/, arrange: bundle => put(bundle, main('<blueprint-use kind="primitive" ref="badge"><b>x</b></blueprint-use>'), [...BADGE]) },
  { name: 'an undeclared slot', expected: /received undeclared slot "none"/, arrange: bundle => put(bundle, main('<blueprint-use kind="primitive" ref="badge"><b slot="none">x</b></blueprint-use>'), [...BADGE]) },
  {
    name: 'content that a slot refuses',
    expected: /slot "label" received .*, which it does not accept/,
    arrange: bundle => put(bundle, main('<blueprint-use kind="primitive" ref="badge"><span slot="label"><blueprint-use kind="primitive" ref="button"></blueprint-use></span></blueprint-use>'), [...BADGE, ...BUTTON])
  },
  {
    name: 'a default slot with no placeholder',
    expected: /received default slot content but declares no default slot placeholder/,
    arrange: bundle => {
      primitive(bundle, 'badge').slots.push({ id: 'default', name: 'Default', description: 'Content.', accepts: ['text'] });
      put(bundle, main('<blueprint-use kind="primitive" ref="badge"><b>x</b></blueprint-use>'), [...BADGE]);
    }
  },
  { name: 'an unsupported use attribute', expected: /received unsupported <blueprint-use> attribute "style"/, arrange: bundle => put(bundle, main('<blueprint-use kind="primitive" ref="badge" style="x"></blueprint-use>'), [...BADGE]) },
  { name: 'an unsafe use class', expected: /received an unsafe class invocation attribute/, arrange: bundle => put(bundle, main('<blueprint-use kind="primitive" ref="badge" class="a;b"></blueprint-use>'), [...BADGE]) },
  { name: 'an unsafe use href', expected: /received unsafe href/, arrange: bundle => put(bundle, main('<blueprint-use kind="primitive" ref="badge" href="https://example.com"></blueprint-use>'), [...BADGE]) },
  { name: 'an href on another root', expected: /cannot receive href because its root element is/, arrange: bundle => put(bundle, main('<blueprint-use kind="primitive" ref="badge" href="/x"></blueprint-use>'), [...BADGE]) },
  {
    name: 'invocation attributes on a source with no root',
    expected: /prototype source has no root element for invocation attributes/,
    arrange: bundle => {
      bundle.prototypeSourceContents[primitive(bundle, 'badge').prototype.source] = 'text';
      put(bundle, main('<blueprint-use kind="primitive" ref="badge" class="x"></blueprint-use>'), [...BADGE]);
    }
  },
  { name: 'a screen with no root', expected: /prototype source has no root element for boundary metadata/, arrange: bundle => put(bundle, 'text') },
  {
    name: 'a linked asset in an inline document',
    expected: /is a review server link, so a self-contained document cannot inline it/,
    arrange: bundle => {
      put(bundle, main('<img src="../assets/a.png" alt="">'));
      chat(bundle).prototype.assetRefs = ['prototype/assets/a.png'];
      (bundle.prototypeAssetContents as Record<string, unknown>)['prototype/assets/a.png'] = { mediaType: 'image/png', sha256: 'a'.repeat(64) };
    }
  },
  {
    name: 'a linked asset with a bad hash',
    expected: /must be 64 lowercase hex characters/,
    arrange: bundle => {
      put(bundle, main('<img src="../assets/a.png" alt="">'));
      chat(bundle).prototype.assetRefs = ['prototype/assets/a.png'];
      (bundle.prototypeAssetContents as Record<string, unknown>)['prototype/assets/a.png'] = { mediaType: 'image/png', sha256: 'x' };
    },
    run: bundle => compilePrototypeDocument({ bundle, target: CHAT, assetOrigin: 'http://127.0.0.1:4173' })
  },
  { name: 'an asset origin with a path', expected: /must be an exact http or https origin/, arrange: () => {}, run: bundle => compilePrototypeDocument({ bundle, target: CHAT, assetOrigin: 'ftp://x/y' }) },
  { name: 'a negative safe area', expected: /safe-area top must be a non-negative number/, arrange: () => {}, run: bundle => compilePrototypeDocument({ bundle, target: CHAT, framePreset: { ...bundle.manifest.framePresets[0], safeArea: { top: -1, right: 0, bottom: 0, left: 0 } } }) },
  { name: 'a review condition of another state', expected: /uses state "default", not "empty"/, arrange: () => {}, run: bundle => selectPrototypeReviewCondition(chat(bundle), { state: 'empty', viewport: 'phone-default' }) },
  { name: 'a pair with no review condition', expected: /does not declare a review condition for state="none"/, arrange: () => {}, run: bundle => selectPrototypeReviewCondition(chat(bundle), { state: 'none' }) },
  { name: 'a screen with no review conditions', expected: /has no browser-native prototype review conditions/, arrange: bundle => { delete (chat(bundle) as { prototype?: unknown }).prototype; }, run: bundle => selectPrototypeReviewCondition(bundle.screens.screens.find(screen => screen.id === 'chat') as never, {}) },
  { name: 'an unknown review screen', expected: /Screen not found: none/, arrange: () => {}, run: bundle => resolvePrototypeReviewSelection(bundle as never, { screenId: 'none' }) },
  { name: 'a review screen with no source', expected: /has no browser-native prototype review source/, arrange: bundle => { delete (chat(bundle) as { prototype?: unknown }).prototype; }, run: bundle => resolvePrototypeReviewSelection(bundle as never, { screenId: 'chat' }) },
  {
    name: 'a review condition with no preset',
    expected: /references missing frame preset "none"/,
    arrange: bundle => { chat(bundle).prototype.reviewConditions = [{ id: 'x', framePresetId: 'none', state: 'default' }]; },
    run: bundle => resolvePrototypeReviewSelection(bundle as never, { screenId: 'chat' })
  },
  {
    name: 'a preset with bad dimensions',
    expected: /must declare positive integer CSS-pixel dimensions/,
    arrange: bundle => { bundle.manifest.framePresets.forEach(preset => { preset.width = 0; }); },
    run: bundle => resolvePrototypeReviewSelection(bundle as never, { screenId: 'chat' })
  },
  { name: 'an unknown review parameter', expected: /Unsupported prototype review parameter "x"/, arrange: () => {}, run: () => parsePrototypeReviewRequest(new URL('http://127.0.0.1/?x=1')) },
  { name: 'a repeated review parameter', expected: /must appear exactly once/, arrange: () => {}, run: () => parsePrototypeReviewRequest(new URL('http://127.0.0.1/?screen=a&screen=b')) },
  { name: 'a missing review parameter', expected: /Missing prototype review parameter "screen"/, arrange: () => {}, run: () => parsePrototypeReviewRequest(new URL('http://127.0.0.1/')) },
  { name: 'an empty review parameter', expected: /must not be empty/, arrange: () => {}, run: () => parsePrototypeReviewRequest(new URL('http://127.0.0.1/?screen=a&state=')) }
];

const CLUSTER_SOURCE = 'prototype/components/action-cluster.html';
const CLUSTER = { kind: 'component', id: 'action-cluster' } as const;

function placeMark(bundle: Bundle, markup: string): void {
  bundle.prototypeSourceContents[CLUSTER_SOURCE] = bundle.prototypeSourceContents[CLUSTER_SOURCE].replace('>', `>${markup}`);
}

const BRAND_MARK_CASES: ReadonlyArray<{ name: string; expected: RegExp; markup: string; arrange?: (bundle: Bundle) => void }> = [
  { name: 'an undeclared mark', expected: /places brand mark "seal", which brand\.json does not declare/, markup: '<blueprint-use kind="brand-mark" ref="seal"></blueprint-use>' },
  { name: 'an undeclared variant', expected: /does not declare variant "neon"/, markup: '<blueprint-use kind="brand-mark" ref="mark" variant="neon"></blueprint-use>' },
  { name: 'an unsupported attribute', expected: /received unsupported <blueprint-use> attribute "style"/, markup: '<blueprint-use kind="brand-mark" ref="mark" style="color:red"></blueprint-use>' },
  { name: 'an unsafe class', expected: /received an unsafe class invocation attribute/, markup: '<blueprint-use kind="brand-mark" ref="mark" class="a;b"></blueprint-use>' },
  { name: 'aria-hidden false', expected: /accepts only aria-hidden="true"/, markup: '<blueprint-use kind="brand-mark" ref="mark" aria-hidden="false"></blueprint-use>' },
  { name: 'slot content', expected: /cannot receive slot content/, markup: '<blueprint-use kind="brand-mark" ref="mark"><b>Logo</b></blueprint-use>' },
  {
    name: 'a stylesheet in the source',
    expected: /carries a stylesheet/,
    markup: '<blueprint-use kind="brand-mark" ref="mark"></blueprint-use>',
    arrange: bundle => { bundle.prototypeSourceContents['brand/mark.svg'] = '<svg viewBox="0 0 8 8"><style>body{display:none}</style></svg>'; }
  },
  {
    name: 'a source with no viewBox',
    expected: /must be an <svg> with a viewBox/,
    markup: '<blueprint-use kind="brand-mark" ref="mark"></blueprint-use>',
    arrange: bundle => { bundle.prototypeSourceContents['brand/mark.svg'] = '<svg></svg>'; }
  },
  {
    name: 'a variant with an undeclared color',
    expected: /variant references undeclared color token "color\.none"/,
    markup: '<blueprint-use kind="brand-mark" ref="mark" variant="default"></blueprint-use>',
    arrange: bundle => { bundle.brand!.marks.find(mark => mark.id === 'mark')!.variants.find(variant => variant.id === 'default')!.foreground = 'color.none'; }
  }
];

describe('the compiler', () => {
  let mira: Bundle;
  let starter: Bundle;

  before(async () => {
    mira = await loadProjectFromFs('fixtures/valid/mira-ai/design/blueprint');
    starter = await loadProjectFromFs('starter/design/blueprint');
  });

  for (const { name, expected, arrange, run } of COMPILE_CASES) {
    it(`holds a Fix: line for ${name}`, () => {
      const bundle = structuredClone(mira);
      arrange(bundle);
      assert.throws(() => (run ?? compileChat)(bundle), (error: Error) => {
        assert.match(error.message, expected);
        assertNamesAChange(error.message, name);
        return true;
      });
    });
  }

  for (const { name, expected, markup, arrange } of BRAND_MARK_CASES) {
    it(`holds a Fix: line for a brand mark with ${name}`, () => {
      const bundle = structuredClone(starter);
      placeMark(bundle, markup);
      arrange?.(bundle);
      assert.throws(() => compilePrototypeDocument({ bundle, target: CLUSTER }), (error: Error) => {
        assert.match(error.message, expected);
        assertNamesAChange(error.message, name);
        return true;
      });
    });
  }

  it('holds a Fix: line when validate wraps a compiler error', () => {
    const bundle = structuredClone(mira);
    put(bundle, main('<script>run()</script>'));
    const wrapped = validateProject(bundle, { mode: 'baseline' }).errors.filter(error => error.includes('cannot compile:'));
    assert.ok(wrapped.length > 0);
    for (const error of wrapped) assertNamesAChange(error, 'validate');
  });
});

const ANY_DIGEST = 'a'.repeat(64);

function projectTools(out: string): ReadonlyArray<[string, Record<string, unknown>]> {
  return [
    ['validate', { mode: 'baseline' }],
    ['validate', { mode: 'strict' }],
    ['validate', { mode: 'readiness' }],
    ['migrate', { dryRun: true }],
    ['index', {}],
    ['query', { query: { type: 'prototype-only' } }],
    ['extract', { boundary: 'screen:home', mode: 'focused' }],
    ['capture', { boundary: 'screen:home', out }],
    ['serve', { port: 0, focus: 'screen:home' }],
    ['selection', {}],
    ['explore', { operation: { type: 'archive', explorationId: 'ledger-density' } }],
    ['promote', { explorationId: 'ledger-density', candidateId: 'x', expectedBaseDigest: ANY_DIGEST, expectedCurrentDigest: ANY_DIGEST, expectedCandidateDigest: ANY_DIGEST }],
    ['restore', { screenId: 'home', version: 1, expectedCurrentDigest: ANY_DIGEST, expectedVersionDigest: ANY_DIGEST }],
    ['inspo', { operation: { type: 'remove', id: 'ref-1' } }]
  ];
}

const BAD_ARGUMENTS: ReadonlyArray<[string, Record<string, unknown>]> = [
  ['init', { out: 5 }],
  ['init', {}],
  ['inspo', { project: 5 }],
  ['validate', { project: 5 }],
  ['validate', {}],
  ['validate', { project: 'x', mode: 'nope' }],
  ['validate', { project: 'x', nope: 1 }],
  ['migrate', { project: 5 }],
  ['index', { project: 5 }],
  ['query', { project: 5 }],
  ['query', { project: 'x', query: { type: 'zzz' } }],
  ['extract', { project: 5 }],
  ['capture', { project: 5 }],
  ['capture', { project: 'x', boundary: 5, out: 'y.png' }],
  ['capture', { project: 'x', boundary: 'nope', out: 'y.png' }],
  ['serve', { project: 5 }],
  ['serve', { project: 'x', port: 70000 }],
  ['serve', { project: 'x', focus: 'screen:home', explorationId: 'a' }],
  ['selection', { project: 5 }],
  ['explore', { project: 5 }],
  ['explore', { project: 'x', operation: { type: 'zzz' } }],
  ['promote', { project: 5 }],
  ['restore', { project: 5 }]
];

const NATIVE_ERRORS: ReadonlyArray<[string, string]> = [
  ['EACCES', 'denied path'],
  ['EEXIST', 'file in a directory path'],
  ['EISDIR', 'directory in a file path'],
  ['ENAMETOOLONG', 'long path'],
  ['ENOENT', 'missing path'],
  ['ENOSPC', 'full volume'],
  ['ENOTDIR', 'file in a directory path'],
  ['EPERM', 'denied path'],
  ['EROFS', 'read-only volume']
];

interface ToolAnswer {
  isError?: boolean;
  content?: unknown;
  structuredContent?: { errors?: unknown; validation?: { errors?: unknown } };
}

function errorTexts(answer: ToolAnswer): string[] {
  if (answer.isError) {
    return (answer.content as Array<{ text: string }>).map(part => part.text);
  }
  const errors = answer.structuredContent?.errors ?? answer.structuredContent?.validation?.errors ?? [];
  return errors as string[];
}

describe('each MCP tool that takes a project', () => {
  const server = createBlueprintMcpServer();
  const client = new Client({ name: 'errors-have-fix', version: '1.0.0' });
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'blueprint-errors-have-fix-'));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  after(async () => {
    await client.close();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const copyWithVersion = async (name: string, version: string): Promise<string> => {
    const project = path.join(tempDir, name, 'design', 'blueprint');
    await cp('fixtures/valid/meridian-finance/design/blueprint', project, { recursive: true });
    const manifestPath = path.join(project, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.schemaVersion = version;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return project;
  };

  const assertEachErrorNamesAChange = async (project: string, successAllowed: readonly string[] = []): Promise<void> => {
    for (const [name, args] of projectTools(path.join(tempDir, 'capture.png'))) {
      const answer = await client.callTool({ name, arguments: { project, ...args } }, { timeout: 600_000 }) as ToolAnswer;
      const texts = errorTexts(answer);
      const context = `${name} ${JSON.stringify(args)} on ${path.basename(path.dirname(path.dirname(project)))}`;
      if (!successAllowed.includes(name)) assert.ok(texts.length > 0, `${context} reports no error: ${JSON.stringify(answer).slice(0, 300)}`);
      for (const text of texts) assertNamesAChange(text, context);
    }
  };

  it('holds a Fix: line on a project with an older schema', async () => {
    await assertEachErrorNamesAChange(await copyWithVersion('older', '1.0.0'), ['migrate']);
  });

  it('holds a Fix: line on a project with a newer schema', async () => {
    await assertEachErrorNamesAChange(await copyWithVersion('newer', '9.0.0'));
  });

  it('holds a Fix: line on a path with no project', async () => {
    await assertEachErrorNamesAChange(path.join(tempDir, 'nothing', 'design', 'blueprint'));
  });

  it('holds a Fix: line on a JSON file that does not parse', async () => {
    const project = await copyWithVersion('unparsable', '1.0.0');
    await writeFile(path.join(project, 'tokens.json'), '{ nope');
    await assertEachErrorNamesAChange(project);
  });

  for (const [name, args] of BAD_ARGUMENTS) {
    it(`holds a Fix: line on ${name} with the arguments ${JSON.stringify(args)}`, async () => {
      const answer = await client.callTool({ name, arguments: args }) as ToolAnswer;
      const texts = errorTexts(answer);
      assert.ok(answer.isError && texts.length > 0, `${name} accepts ${JSON.stringify(args)}: ${JSON.stringify(answer).slice(0, 300)}`);
      for (const text of texts) {
        assert.match(text, /^Input validation error: /);
        assertNamesAChange(text, name);
      }
    });
  }

  for (const [code, label] of NATIVE_ERRORS) {
    it(`holds a Fix: line on the ${code} error of a ${label}`, () => {
      const error = Object.assign(new Error(`${code}: raw text, open '/x/y'`), { code, path: '/x/y' });
      const text = toolErrorText(error);
      assert.ok(text.startsWith(error.message), text);
      assert.match(text, /Fix: .*\/x\/y/);
      assertNamesAChange(text, code);
    });
  }

  it('names the destination of a native error that holds one', () => {
    const error = Object.assign(new Error('ENOENT: raw text'), { code: 'ENOENT', path: '/from/a', dest: '/to/b' });
    assert.match(toolErrorText(error), /Fix: create \/to\/b/);
  });

  for (const error of [new TypeError('raw type text'), new RangeError('raw range text')]) {
    it(`holds a Fix: line on a raw ${error.name}`, () => {
      const text = toolErrorText(error);
      assert.ok(text.startsWith(error.message), text);
      assertNamesAChange(text, error.name);
    });
  }

  it('leaves a TypeError that already holds a Fix: line as it is', () => {
    const error = new TypeError('raw. Fix: set x in y.json to 1.');
    assert.equal(toolErrorText(error), error.message);
  });

  for (const out of ['/dev/null/y.json', '/dev/null/x/y.json']) {
    it(`holds a Fix: line when validate cannot write ${out}`, async () => {
      const answer = await client.callTool({ name: 'validate', arguments: { project: 'fixtures/valid/meridian-finance/design/blueprint', mode: 'baseline', out } }) as ToolAnswer;
      assert.ok(answer.isError, JSON.stringify(answer).slice(0, 300));
      for (const text of errorTexts(answer)) assertNamesAChange(text, `validate out ${out}`);
    });
  }
});

describe('a Fix: line that a project state can make wrong', () => {
  async function withMeridian(run: (project: string) => Promise<void>): Promise<void> {
    await withProjectCopy(run, 'fixtures/valid/meridian-finance/design/blueprint');
  }

  it('sends init on a real project to an empty directory, and never to force', async () => {
    await withMeridian(async project => {
      await assert.rejects(initializeBlueprint({ out: project, projectId: 'x', name: 'X', force: false }), (error: Error) => {
        const fix = error.message.split('Fix:')[1] ?? '';
        assert.match(fix, /pass an empty out directory/);
        assert.doesNotMatch(error.message, /force/i);
        return true;
      });
    });
  });

  it('still offers force for a directory that holds no project', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'blueprint-init-'));
    try {
      await writeFile(path.join(directory, 'note.txt'), 'x');
      await assert.rejects(initializeBlueprint({ out: directory, projectId: 'x', name: 'X', force: false }), /Fix: pass force true/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('holds a Fix: line when a compile target ends in a raw error', async () => {
    const bundle = await loadProjectFromFs('fixtures/valid/mira-ai/design/blueprint');
    (bundle.primitives.primitives[0] as unknown as Record<string, unknown>).variants = undefined;
    const issues = inspectPrototypeSourceGraph(bundle);
    assert.ok(issues.length > 0);
    for (const issue of issues) assertNamesAChange(issue.message, issue.boundaryId);
  });

  it('leaves out an empty list of token groups', async () => {
    const bundle = await loadProjectFromFs('fixtures/valid/mira-ai/design/blueprint');
    const errors: string[] = [];
    validateReusables(errors, bundle, new Set(), new Set());
    const line = errors.find(error => error.includes('tokenGroupIds names'));
    assert.ok(line, errors.join('\n'));
    assertNamesAChange(line, 'tokenGroupIds');
    assert.doesNotMatch(line, /use one of\s*\./);
  });

  it('leaves out an empty list of declared values and of slots in a compile error', async () => {
    const bundle = await loadProjectFromFs('fixtures/valid/mira-ai/design/blueprint');
    const composer = bundle.components.components.find(component => component.id === 'composer')!;
    composer.slots = [];
    composer.sizes.values = [];
    const screen = bundle.screens.screens[0]!;
    const source = screen.prototype.source;
    bundle.prototypeSourceContents[source] = '<main><blueprint-use kind="component" ref="composer" size="big"><span slot="nope">x</span></blueprint-use></main>';
    const empty = inspectPrototypeSourceGraph(bundle).find(issue => /does not declare size|received/.test(issue.message));
    assert.ok(empty);
    assertNamesAChange(empty.message, empty.boundaryId);
    assert.doesNotMatch(empty.message, /declares \.|: none/);
  });

  it('wraps a network failure in a Fix: line that names the link, and passes an abort on', async () => {
    const fetcher = { lookup: async () => ['93.184.216.34'], fetch: async () => { throw new TypeError('fetch failed'); } };
    await assert.rejects(downloadInspoImage('https://images.example.com/a.png', fetcher), (error: Error) => {
      assert.ok(!(error instanceof TypeError));
      assert.ok(error.message.includes('https://images.example.com/a.png'), error.message);
      assertNamesAChange(error.message, 'inspo network failure');
      return true;
    });
    const controller = new AbortController();
    const reason = new Error('stopped');
    const hanging = { lookup: async () => ['93.184.216.34'], fetch: async () => { controller.abort(reason); throw reason; } };
    await assert.rejects(downloadInspoImage('https://images.example.com/a.png', hanging, controller.signal), /^Error: stopped$/);
  });

  it('does not tell a value that sizes already holds to run migrate, because migrate leaves it', async () => {
    const bundle = await loadProjectFromFs('fixtures/valid/mira-ai/design/blueprint');
    const composer = bundle.components.components.find(component => component.id === 'composer')!;
    composer.sizes.values.push({ id: 'sm', name: 'Small', description: 'A tighter composer.' });
    composer.variants.values.push({ id: 'sm', name: 'Small', description: 'A tighter composer.' });
    const errors: string[] = [];
    validateReusables(errors, bundle, new Set(bundle.tokens.tokenGroups.map(group => group.id)), new Set());
    const line = errors.find(error => error.startsWith('component.composer.variants.sm is a size'));
    assert.ok(line, errors.join('\n'));
    assert.doesNotMatch(line, /migrate/);
    assert.match(line, /Fix: remove "sm" from component\.composer\.variants/);
  });

  it('does not tell a value made only of sizes to keep a size as its variant', async () => {
    const bundle = await loadProjectFromFs('fixtures/valid/mira-ai/design/blueprint');
    const composer = bundle.components.components.find(component => component.id === 'composer')!;
    composer.variants.values.push({ id: 'md-lg', name: 'Medium large', description: 'A mixed composer.' });
    const errors: string[] = [];
    validateReusables(errors, bundle, new Set(bundle.tokens.tokenGroups.map(group => group.id)), new Set());
    const line = errors.find(error => error.startsWith('component.composer.variants.md-lg combines'));
    assert.ok(line, errors.join('\n'));
    assert.doesNotMatch(line, /as the variant/);
    assert.match(line, /Fix: remove "md-lg" from component\.composer\.variants/);
  });

  it('does not offer to delete brand.json when inspo has no approved direction', () => {
    const line = readFileSync('src/core/validate.ts', 'utf8').split('\n').find(text => text.includes('inspo.json has no approved direction'));
    assert.ok(line);
    assert.doesNotMatch(line, /delete brand\.json/);
  });

  it('does not name a ref for a fixed file, because no ref names it', async () => {
    await withMeridian(async project => {
      await rm(path.join(project, 'screens.json'));
      await assert.rejects(loadProjectFromFs(project), (error: Error) => {
        assert.match(error.message, /screens\.json/);
        assert.doesNotMatch(error.message, /remove the ref/);
        assertNamesAChange(error.message, 'missing fixed file');
        return true;
      });
    });
  });

  it('asks for a sentence, with no quote around a full stop, when prose only names a file', () => {
    const line = lintProse('prototype/screens/home.html');
    const text = line.map(issue => issue.message).join('\n');
    assert.match(text, /Fix: /);
    assert.doesNotMatch(text, /\.",/);
    const withPeriod = lintProse('apps/mobile/src/app/sleep.tsx.').map(issue => issue.message).join('\n');
    assert.match(withPeriod, /`apps\/mobile\/src\/app\/sleep\.tsx` renders it\.$/);
  });
});

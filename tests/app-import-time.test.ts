import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { appModules, ENTRY_MODULE, importTimeWorkInSource, readImportTimeWork, type ImportTimeAllowEntry } from './support/import-time-guard';

const ALLOWED_CONSTANT_SETUP: readonly ImportTimeAllowEntry[] = [
  { file: 'src/app/agent-focus.ts', text: 'new Map<string, { focuses: BlueprintAgentActivityFocus[]; startedAt: string }>()' },
  { file: 'src/app/agent-focus.ts', text: "createFrameOverlay('bp-chrome-agent-frame-focus', 'bp-chrome-agent-frame-focus-box', 'focusBoundaryIds', layer => { layer.classList.toggle('bp-chrome-agent-focus-failed', lastAgentActivity?.phase === 'failed'); })" },
  { file: 'src/app/boards.ts', text: 'new WeakMap<HTMLElement, FrameMounter>()' },
  { file: 'src/app/canvas-selection.ts', text: 'Promise.resolve()' },
  { file: 'src/app/canvas-state.ts', text: 'new Map<BoardId, MountedBoard>()' },
  { file: 'src/app/canvas-state.ts', text: 'Promise.resolve()' },
  { file: 'src/app/change-annotations.ts', text: "createFrameOverlay('bp-chrome-change-layer', 'bp-chrome-change-box', 'changeBoundaryIds')" },
  { file: 'src/app/design-findings.ts', text: "createFrameOverlay('bp-chrome-finding-layer', 'bp-chrome-finding-box', 'findingBoundaryIds')" },
  { file: 'src/app/design-findings.ts', text: 'new WeakMap<CanvasProjectBundle, DesignFinding[]>()' },
  { file: 'src/app/document-preview.ts', text: 'new ResizeObserver(entries => { for (const entry of entries) scalePreview(entry.target as HTMLElement); })' },
  { file: 'src/app/fixture-projects.ts', text: "import.meta.glob<string>( ['../../starter/design/blueprint/brand/*.svg', '../../starter/design/blueprint/prototype/**/*.{css,html}'], { eager: true, import: 'default', query: '?raw' } )" },
  { file: 'src/app/frame-capture.ts', text: 'new WeakMap<HTMLButtonElement, () => void>()' },
  { file: 'src/app/frame-host.ts', text: 'new WeakMap<HTMLElement, ScreenFrame>()' },
  { file: 'src/app/frame-host.ts', text: 'createFrameThumbnailCache(FRAME_THUMBNAIL_LIMIT, url => URL.revokeObjectURL(url))' },
  { file: 'src/app/frame-host.ts', text: 'new WeakMap<CanvasProjectBundle, Map<string, string>>()' },
  { file: 'src/app/frame-host.ts', text: 'createIdleQueue(captureFrameThumbnail, whenCanvasIdle)' },
  { file: 'src/app/frame-output.ts', text: 'new WeakMap<readonly CssOutputItem[], string[]>()' },
  { file: 'src/app/frame-output-client.ts', text: 'new Map<CanvasProjectBundle, number>()' },
  { file: 'src/app/frame-output-client.ts', text: 'new Map<number, Pending>()' },
  { file: 'src/app/frame-output-worker.ts', text: 'createFrameOutputService()' },
  { file: 'src/app/frame-output-worker.ts', text: 'scope.onmessage = event => { const reply = answer(event.data); if (reply) scope.postMessage(reply); };' },
  { file: 'src/app/frame-token-reads.ts', text: 'new WeakMap<CanvasProjectBundle, Map<string, ScreenTokenReads>>()' },
  { file: 'src/app/frame-loads.ts', text: 'new WeakMap<EventTarget, Promise<void>>()' },
  { file: 'src/app/frame-uses.ts', text: 'new WeakMap<HTMLElement, PrototypeFrameUses>()' },
  { file: 'src/app/frame-uses.ts', text: 'new WeakMap<CanvasProjectBundle, Map<string, ReusableDefinition>>()' },
  { file: 'src/app/frame-viewer.ts', text: 'new WeakMap<HTMLElement, FrameView>()' },
  { file: 'src/app/sections.ts', text: 'new Map<DocumentSectionId, string>()' }
];

const MUST_REPORT: Record<string, string> = {
  bare_call: 'start();',
  const_call: 'const a = start();',
  exported_const_call: 'export const a = start();',
  new_call: 'const a = new Map<string, string>();',
  method_call: "const a = document.querySelector('#app');",
  immediately_called_arrow: '(() => { start(); })();',
  immediately_called_function_in_const: 'const a = (function () { return 1; })();',
  call_in_object: 'const a = { b: start() };',
  call_in_array: 'const a = [start()];',
  call_in_template: 'const a = `${start()}`;',
  call_in_condition: 'const a = b ? start() : 1;',
  call_in_binding_default: 'const [a = start()] = [];',
  tagged_template: 'const a = tag`b`;',
  top_level_await: 'const a = await b;',
  dynamic_import: "const a = import('./b');",
  default_export_call: 'export default start();',
  static_field: 'class A { static b = start(); }',
  static_block: 'class A { static { start(); } }',
  class_heritage: 'class A extends start() {}',
  assignment: 'window.a = 1;',
  if_statement: 'if (a) { b; }',
  for_statement: 'for (const a of b) { a; }',
  try_statement: 'try { a; } catch { b; }',
  bare_import: "import './a';",
  namespace_body: 'namespace A { start(); }'
};

const MUST_PASS: Record<string, string> = {
  function_declaration: 'function a(): void { start(); }',
  exported_function: 'export function a(): void { start(); }',
  async_function: 'export async function a(): Promise<void> { await start(); }',
  arrow_constant: 'const a = (): void => { start(); };',
  function_expression: 'const a = function (): void { start(); };',
  method_in_object: 'const a = { b() { start(); } };',
  arrow_in_object: 'const a = { b: () => start() };',
  literal_constant: "const a = 'b';",
  list_constant: "const a = ['b', 'c'] as const;",
  table_constant: "const a: Record<string, string> = { b: 'c' };",
  unassigned_let: 'let a: string;',
  interface_declaration: 'interface A { b: string; }',
  type_alias: 'type A = string;',
  ambient_global: 'declare global { interface Window { a: string; } }',
  named_import: "import { a } from './a';",
  re_export: "export { a } from './a';",
  class_members: 'class A { b = start(); c(): void { start(); } }',
  default_parameter: 'function a(b = start()): void { b; }'
};

const STARTUP_AND_WIRING_ONLY = [
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration
];

describe('the modules of src/app', () => {
  it('run nothing at import time, other than the listed constant setup', () => {
    const files = appModules();
    assert.ok(files.length > 0);
    assert.ok(!files.includes(ENTRY_MODULE));
    const { work } = readImportTimeWork(files, ALLOWED_CONSTANT_SETUP);
    assert.deepEqual(work, [], `Fix: move each listed statement into a function that ${ENTRY_MODULE} calls, or add its exact text to ALLOWED_CONSTANT_SETUP when it only builds a constant.`);
  });

  it('list only constant setup that a module still holds', () => {
    const { staleAllowEntries } = readImportTimeWork(appModules(), ALLOWED_CONSTANT_SETUP);
    assert.deepEqual(staleAllowEntries, [], 'Fix: remove each listed entry from ALLOWED_CONSTANT_SETUP.');
  });

  it('keep the declarations out of the entry module, so that it holds only startup and wiring', () => {
    const source = ts.createSourceFile(ENTRY_MODULE, readFileSync(ENTRY_MODULE, 'utf8'), ts.ScriptTarget.Latest, true);
    const declared = source.statements.filter(statement => STARTUP_AND_WIRING_ONLY.includes(statement.kind)).map(statement => statement.getText().split('\n')[0]);
    assert.deepEqual(declared, [], `Fix: move each listed declaration from ${ENTRY_MODULE} to the module that owns it.`);
  });

  for (const [name, text] of Object.entries(MUST_REPORT)) {
    it(`report ${name}`, () => {
      assert.equal(importTimeWorkInSource('src/app/case.ts', text).length, 1, text);
    });
  }

  for (const [name, text] of Object.entries(MUST_PASS)) {
    it(`pass ${name}`, () => {
      assert.deepEqual(importTimeWorkInSource('src/app/case.ts', text), [], text);
    });
  }

  it('report the text of the work, so that an allowed entry can name it', () => {
    assert.deepEqual(importTimeWorkInSource('src/app/case.ts', 'const a = new Map<\n  string,\n  string\n>();').map(found => found.text), ['new Map< string, string >()']);
  });
});

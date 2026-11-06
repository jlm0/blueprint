import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ERROR_SOURCE_DIRECTORIES, NON_AGENT_DIRECTORIES, readErrorSites, type ErrorSiteReport } from './support/error-fix-guard';

const MUST_REPORT: Record<string, string> = {
  new_error: `export function a(): void { throw new Error('bad value'); }`,
  template: 'export function a(x: string): void { throw new Error(`bad ${x}`); }',
  call_without_new: `export function a(): void { throw Error('bad value'); }`,
  type_error_without_new: `export function a(): void { throw TypeError('bad value'); }`,
  throw_string: `export function a(): void { throw 'bad value'; }`,
  throw_object: `export function a(): void { throw { message: 'bad value' }; }`,
  reject_string: `export function a(): Promise<void> { return Promise.reject('bad value'); }`,
  class_with_no_error_suffix: `class Refusal extends Error {} export function a(): void { throw new Refusal('bad value'); }`,
  class_of_a_class: `class Refusal extends Error {} class Hard extends Refusal {} export function a(): void { throw new Hard('bad value'); }`,
  reassigned_let: `export function a(x: boolean): void { let message = 'bad. Fix: set x.'; if (x) message = 'worse value'; throw new Error(message); }`,
  let_with_no_first_value: `export function a(x: boolean): void { let message: string; if (x) message = 'worse value'; else message = 'bad. Fix: set x.'; throw new Error(message); }`,
  collector_named_errors: `export function a(): string[] { const errors: string[] = []; errors.push('bad value'); return errors; }`,
  list_of_another_name: `export function a(): { ok: boolean; errors: string[] } { const problems: string[] = []; problems.push('bad value'); return { ok: false, errors: problems }; }`,
  object_field_literal: `export function a(): { ok: boolean; errors: string[] } { return { ok: false, errors: ['bad value'] }; }`,
  table_with_one_bad_value: `const TEXT: Record<string, string> = { a: 'bad value', b: 'x. Fix: y' }; export function b(k: string): void { throw new Error(TEXT[k]); }`,
  refine_object: `import { z } from 'zod'; export const s = z.string().refine(v => v.length > 0, { message: 'bad value' });`,
  refine_string: `import { z } from 'zod'; export const s = z.string().refine(v => v.length > 0, 'bad value');`,
  refine_error_key: `import { z } from 'zod'; export const s = z.string().refine(v => v.length > 0, { error: 'bad value' });`,
  add_issue: `import { z } from 'zod'; export const s = z.string().superRefine((v, ctx) => { ctx.addIssue({ code: 'custom', message: 'bad value' }); });`,
  helper_other_name: `function add(out: string[], message: string): void { out.push(message); }\nexport function a(): string[] { const errors: string[] = []; errors.push('x. Fix: y.'); add(errors, 'bad value'); return errors; }`,
  index_assign: `export function a(): string[] { const errors: string[] = ['x. Fix: y.']; errors[1] = 'bad value'; return errors; }`,
  index_assign_field: `export function a(): { errors: string[] } { const errors: string[] = ['x. Fix: y.']; errors[1] = 'bad value'; return { errors: errors }; }`,
  shorthand_literal: `export function a(): { errors: string[] } { const errors = ['bad value']; return { errors }; }`,
  message_assign: `export function a(): void { const error = new Error('x. Fix: y.'); error.message = 'bad value'; throw error; }`,
  namespaced_class: `import * as errs from './errs';\nexport function a(): void { throw new errs.Refusal('bad value'); }`,
  reflect_thrown: `export function a(): void { throw Reflect.construct(Error, ['bad value']); }`,
  reflect_rejected: `export function a(): Promise<void> { return new Promise((resolve, reject) => { reject(Reflect.construct(Error, ['bad value'])); }); }`,
  console_error: `export function a(): void { console.error('bad value'); }`
};

const HELPERS: Record<string, string> = {
  errs: `export class Refusal extends Error {}`
};

const TOP_LEVEL_FORM = `export function a(): void { throw new Error('bad value'); }`;

const MUST_PASS: Record<string, string> = {
  fix_in_text: `export function a(): void { throw new Error('bad. Fix: set x in y.json to 1.'); }`,
  rethrow: `export function a(): void { try { a(); } catch (error) { throw error; } }`,
  reject_a_caught_error: `export function a(): Promise<void> { try { a(); } catch (error) { return Promise.reject(error); } return Promise.resolve(); }`,
  schema_field: `import { z } from 'zod'; export const s = z.object({ errors: z.array(z.string()) });`,
  checked_list: `export function a(v: { errors: string[] }): { errors: string[] } { return { errors: v.errors }; }`,
  empty_list: `export function a(): { errors: string[] } { return { errors: [] }; }`,
  refine_with_params: `import { z } from 'zod'; export const s = z.string().refine(v => v.length > 0, { message: 'bad', params: { fix: 'set x' } });`,
  assigned_with_fix: `export function a(x: boolean): void { let message = 'bad. Fix: set x.'; if (x) message = 'worse. Fix: set y.'; throw new Error(message); }`
};

describe('the Fix: line guard', () => {
  let root: string;
  let report: ErrorSiteReport;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'blueprint-fix-guard-'));
    mkdirSync(path.join(root, 'src/core'), { recursive: true });
    symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'));
    for (const [name, code] of Object.entries({ ...MUST_REPORT, ...MUST_PASS, ...HELPERS })) {
      writeFileSync(path.join(root, 'src/core', `${name}.ts`), `${code}\n`);
    }
    writeFileSync(path.join(root, 'src/core/empty_fix.ts'), `export function a(): void { throw new Error('bad. Fix:'); }\n`);
    writeFileSync(path.join(root, 'src/core/banned_fix.ts'), `export function a(): void { throw new Error('bad. Fix: try again.'); }\n`);
    writeFileSync(path.join(root, 'src/top_level.ts'), `${TOP_LEVEL_FORM}\n`);
    report = readErrorSites([], root, ['src/core']);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const gapsOf = (name: string): number => report.sites.filter(site => site.file === `src/core/${name}.ts`).flatMap(site => site.gaps).length;

  for (const name of Object.keys(MUST_REPORT)) {
    it(`reports the form ${name}`, () => {
      assert.ok(gapsOf(name) > 0, `${name}: the guard found no gap. Fix: read this form in readErrorSites in tests/support/error-fix-guard.ts.`);
    });
  }

  for (const name of Object.keys(MUST_PASS)) {
    it(`accepts the form ${name}`, () => {
      assert.equal(gapsOf(name), 0, JSON.stringify(report.sites.filter(site => site.file === `src/core/${name}.ts`)));
    });
  }

  it('reports a Fix: line with no text and a Fix: line with banned text', () => {
    assert.ok(report.genericFixes.some(entry => entry.file === 'src/core/empty_fix.ts'));
    assert.ok(report.genericFixes.some(entry => entry.file === 'src/core/banned_fix.ts'));
  });

  it('reads a top-level file of src', () => {
    const sites = readErrorSites([], root).sites.filter(site => site.file === 'src/top_level.ts');
    assert.ok(sites.flatMap(site => site.gaps).length > 0, `src/top_level.ts: the guard found no gap. Fix: read each top-level file of src in readErrorSites in tests/support/error-fix-guard.ts.`);
  });

  it('matches an allow entry on the whole expression, so that a new message in the file gets no excuse', () => {
    const allowed = readErrorSites(
      [{ file: 'src/core/template.ts', match: 'bad', reason: 'A part of the expression.' }, { file: 'src/core/new_error.ts', match: "'bad value'", reason: 'The whole expression.' }],
      root,
      ['src/core']
    );
    const gaps = (name: string): number => allowed.sites.filter(site => site.file === `src/core/${name}.ts`).flatMap(site => site.gaps).length;
    assert.ok(gaps('template') > 0);
    assert.equal(gaps('new_error'), 0);
    assert.deepEqual(allowed.staleAllowEntries.map(entry => entry.file), ['src/core/template.ts']);
  });

  it('reads each directory of src that is not named as a directory with no agent', () => {
    const directories = readdirSync('src', { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    assert.deepEqual(
      [...ERROR_SOURCE_DIRECTORIES, ...[...NON_AGENT_DIRECTORIES.keys()].map(name => `src/${name}`)].sort(),
      directories.map(name => `src/${name}`)
    );
    assert.ok(ERROR_SOURCE_DIRECTORIES.includes('src/core') && ERROR_SOURCE_DIRECTORIES.includes('src/mcp') && ERROR_SOURCE_DIRECTORIES.includes('src/prototype'));
  });
});

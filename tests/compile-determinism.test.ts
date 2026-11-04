import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { loadProjectFromFs } from '../src/core/load';
import { axisIds } from '../src/core/reusable-contract';
import type { BlueprintProjectBundle } from '../src/core/types';
import {
  compilePrototypeDocument,
  createPrototypeOutputCompiler,
  listPrototypeCompileTargets
} from '../src/prototype/compiler';

const goldenPath = 'tests/golden/compile-output.json';
const MAX_GROWTH_FOR_4X_PLACEMENTS = 9;
const updateGolden = process.env.BLUEPRINT_UPDATE_GOLDEN === '1';
const fixtureRoots: Record<string, string> = {
  starter: 'starter/design/blueprint',
  'mira-ai': 'fixtures/valid/mira-ai/design/blueprint',
  'umbra-gaming': 'fixtures/valid/umbra-gaming/design/blueprint',
  'meridian-finance': 'fixtures/valid/meridian-finance/design/blueprint'
};

/** One digest per boundary over every state, variant, and size, so a failure names the boundary that changed. */
function boundaryDigests(bundle: BlueprintProjectBundle): Record<string, string> {
  const hashes = new Map<string, ReturnType<typeof createHash>>();
  for (const { target, state } of listPrototypeCompileTargets(bundle)) {
    const key = `${target.kind}:${target.id}`;
    const hash = hashes.get(key) ?? createHash('sha256');
    hashes.set(key, hash);
    const reusable = target.kind === 'primitive'
      ? bundle.primitives.primitives.find(item => item.id === target.id)
      : target.kind === 'component'
        ? bundle.components.components.find(item => item.id === target.id)
        : undefined;
    for (const variant of reusable ? axisIds(reusable.variants) : [undefined]) {
      for (const size of reusable ? axisIds(reusable.sizes) : [undefined]) {
        const { html } = compilePrototypeDocument({ bundle, target, state, variant, size });
        hash.update(`${state}|${variant}|${size}\n${html}\n`);
      }
    }
  }
  return Object.fromEntries([...hashes].sort(([left], [right]) => (left < right ? -1 : 1)).map(([key, hash]) => [key, hash.digest('hex')]));
}

describe('compile determinism', () => {
  it('matches the recorded output of each fixture', async () => {
    const actual: Record<string, Record<string, string>> = {};
    for (const [name, root] of Object.entries(fixtureRoots)) {
      actual[name] = boundaryDigests(await loadProjectFromFs(root));
    }
    if (updateGolden) {
      writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
    }
    assert.equal(existsSync(goldenPath), true, 'Fix: run this test once with BLUEPRINT_UPDATE_GOLDEN=1, and review the diff.');
    assert.deepEqual(actual, JSON.parse(readFileSync(goldenPath, 'utf8')));
  });

  it('gives identical bytes when the same document compiles twice', async () => {
    for (const root of Object.values(fixtureRoots)) {
      const bundle = await loadProjectFromFs(root);
      for (const { target, state } of listPrototypeCompileTargets(bundle)) {
        assert.equal(
          compilePrototypeDocument({ bundle, target, state }).html,
          compilePrototypeDocument({ bundle, target, state }).html
        );
      }
    }
  });

  it('keeps token output independent of compile order and of shared fragment work', async () => {
    for (const root of Object.values(fixtureRoots)) {
      const bundle = await loadProjectFromFs(root);
      const targets = listPrototypeCompileTargets(bundle);
      const forward = createPrototypeOutputCompiler(bundle);
      const backward = createPrototypeOutputCompiler(bundle);
      const forwardOutput = targets.map(({ target, state }) => forward(target, state));
      const backwardOutput = [...targets].reverse().map(({ target, state }) => backward(target, state)).reverse();
      const aloneOutput = targets.map(({ target, state }) => createPrototypeOutputCompiler(bundle)(target, state));
      assert.deepEqual(forwardOutput, backwardOutput);
      assert.deepEqual(forwardOutput, aloneOutput);
    }
  });

  it('checks a root source again after the source changes', async () => {
    const bundle = await loadProjectFromFs(fixtureRoots['mira-ai']);
    const compile = createPrototypeOutputCompiler(bundle);
    const screen = bundle.screens.screens.find(candidate => candidate.prototype);
    assert.ok(screen?.prototype);
    const target = { kind: 'screen', id: screen.id } as const;
    compile(target);
    bundle.prototypeSourceContents[screen.prototype.source] += '<script>x</script>';
    assert.throws(() => compile(target), /executable, navigation, form/);
  });

  it('reports a one-byte source change as a changed boundary', async () => {
    const bundle = await loadProjectFromFs(fixtureRoots['mira-ai']);
    const before = boundaryDigests(bundle);
    const chat = bundle.screens.screens.find(screen => screen.id === 'chat');
    assert.ok(chat?.prototype);
    const styleRef = chat.prototype.styles[0];
    bundle.prototypeSourceContents[styleRef] += ' ';
    const after = boundaryDigests(bundle);
    assert.notEqual(after['screen:chat'], before['screen:chat']);
    assert.equal(after['primitive:button'], before['primitive:button']);
  });

  it('refuses a source that holds the reserved asset token characters', async () => {
    const bundle = await loadProjectFromFs(fixtureRoots['mira-ai']);
    const chat = bundle.screens.screens.find(screen => screen.id === 'chat');
    assert.ok(chat?.prototype);
    bundle.prototypeSourceContents[chat.prototype.source] += '﷐';
    assert.throws(
      () => compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'chat' } }),
      /reserved noncharacter.*Fix: delete/
    );
  });

  it('grows close to linearly with the placements of a nested component', async () => {
    const bundle = await loadProjectFromFs(fixtureRoots['mira-ai']);
    const component = bundle.components.components.find(item => (item.uses ?? []).length > 0);
    assert.ok(component);
    const chat = bundle.screens.screens.find(screen => screen.id === 'chat');
    assert.ok(chat?.prototype);
    chat.prototype.renderedUses = [{ kind: 'component', id: component.id }];
    chat.sections = [];
    const sourceRef = chat.prototype.source;
    const placement = `<blueprint-use kind="component" ref="${component.id}" state="${axisIds(component.states)[0]}"></blueprint-use>`;
    const fastest = (count: number): number => {
      bundle.prototypeSourceContents[sourceRef] = `<main data-blueprint-screen="chat">${placement.repeat(count)}</main>`;
      const times = Array.from({ length: 5 }, () => {
        const started = performance.now();
        compilePrototypeDocument({ bundle, target: { kind: 'screen', id: 'chat' } });
        return performance.now() - started;
      });
      return Math.min(...times);
    };
    // Other work on the machine can slow one measurement, but quadratic growth fails every attempt.
    const ratios: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const ratio = fastest(8_000) / fastest(2_000);
      if (ratio < MAX_GROWTH_FOR_4X_PLACEMENTS) return;
      ratios.push(ratio.toFixed(1));
    }
    assert.fail(`4x placements took ${ratios.join(', ')} times as long in each attempt`);
  });
});

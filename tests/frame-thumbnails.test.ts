import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFrameThumbnailCache, createIdleQueue, frameThumbnailKey } from '../src/app/frame-thumbnails';

describe('Blueprint frame thumbnails', () => {
  it('keys a thumbnail by the full compiled html', () => {
    const html = '<!doctype html><main>Sign in</main>';
    assert.equal(frameThumbnailKey(html), frameThumbnailKey(`${html}`));
    assert.notEqual(frameThumbnailKey(html), frameThumbnailKey(html.replace('Sign in', 'Sign up')));
    assert.notEqual(frameThumbnailKey(`${'a'.repeat(4096)}b`), frameThumbnailKey(`${'a'.repeat(4096)}c`));
  });

  it('keeps the most recently used thumbnails up to the count cap and releases the rest', () => {
    const released: string[] = [];
    const cache = createFrameThumbnailCache(2, url => released.push(url));
    cache.set('one', 'blob:one');
    cache.set('two', 'blob:two');
    assert.equal(cache.get('one'), 'blob:one');
    cache.set('three', 'blob:three');

    assert.deepEqual(released, ['blob:two']);
    assert.equal(cache.get('two'), undefined);
    assert.equal(cache.get('one'), 'blob:one');
    assert.equal(cache.get('three'), 'blob:three');
    cache.set('three', 'blob:three-again');
    assert.deepEqual(released, ['blob:two', 'blob:three']);
  });

  it('makes one thumbnail at a time, each after an idle period', async () => {
    const events: string[] = [];
    let idle = 0;
    let active = 0;
    const queue = createIdleQueue(async (item: string) => {
      active += 1;
      assert.equal(active, 1, 'only one capture should run at a time');
      events.push(`start ${item}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      events.push(`end ${item}`);
      active -= 1;
    }, async () => {
      idle += 1;
      events.push('idle');
      await new Promise(resolve => setTimeout(resolve, 1));
    });
    queue.add('a');
    queue.add('b');
    queue.add('a');
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.deepEqual(events, ['idle', 'start a', 'end a', 'idle', 'start b', 'end b']);
    assert.equal(idle, 2);
  });

  it('continues after a capture fails', async () => {
    const done: string[] = [];
    const queue = createIdleQueue(async (item: string) => {
      if (item === 'broken') throw new Error('capture failed');
      done.push(item);
    }, () => Promise.resolve());
    queue.add('broken');
    queue.add('next');
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.deepEqual(done, ['next']);
  });
});

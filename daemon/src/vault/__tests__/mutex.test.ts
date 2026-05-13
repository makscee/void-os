import { test, expect } from 'bun:test';
import { Mutex } from '../mutex';

test('runExclusive serializes same-key fns', async () => {
  const m = new Mutex();
  const log: number[] = [];
  const slow = (n: number, delay: number) => m.runExclusive('k', async () => {
    log.push(n);
    await Bun.sleep(delay);
    log.push(-n);
  });
  await Promise.all([slow(1, 20), slow(2, 5), slow(3, 1)]);
  // Each fn must complete before next starts: [1,-1,2,-2,3,-3]
  expect(log).toEqual([1, -1, 2, -2, 3, -3]);
});

test('different keys run in parallel', async () => {
  const m = new Mutex();
  const start = Date.now();
  await Promise.all([
    m.runExclusive('a', () => Bun.sleep(30)),
    m.runExclusive('b', () => Bun.sleep(30)),
  ]);
  expect(Date.now() - start).toBeLessThan(55);
});

test('chain entry cleared after settle', async () => {
  const m = new Mutex();
  await m.runExclusive('k', async () => {});
  // give microtasks a chance to clean up
  await Bun.sleep(1);
  // @ts-expect-error access private for test
  expect(m.chain.size).toBe(0);
});

test('thrown fn does not poison chain', async () => {
  const m = new Mutex();
  await expect(m.runExclusive('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  const v = await m.runExclusive('k', async () => 42);
  expect(v).toBe(42);
});

test('runExclusiveMany locks keys in sorted order', async () => {
  const m = new Mutex();
  const order: string[] = [];
  await Promise.all([
    m.runExclusiveMany(['b', 'a'], async () => { order.push('first'); }),
    m.runExclusiveMany(['a', 'b'], async () => { order.push('second'); }),
  ]);
  expect(order).toEqual(['first', 'second']);
});

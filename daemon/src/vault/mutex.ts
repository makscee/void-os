export class Mutex {
  private chain = new Map<string, Promise<unknown>>();

  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chain.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.chain.set(key, tail);
    tail.then(() => {
      if (this.chain.get(key) === tail) this.chain.delete(key);
    });
    return next;
  }

  async runExclusiveMany<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort();
    const acquire = (i: number): Promise<T> => {
      if (i === sorted.length) return fn();
      return this.runExclusive(sorted[i]!, () => acquire(i + 1));
    };
    return acquire(0);
  }
}

/** A tiny async mutex. `run` serialises async functions; errors do not poison the queue. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

/** One mutex per key (for example one per model slug). */
export class KeyedMutex {
  #locks = new Map<string, { mutex: Mutex; pending: number }>();

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    let entry = this.#locks.get(key);
    if (!entry) {
      entry = { mutex: new Mutex(), pending: 0 };
      this.#locks.set(key, entry);
    }
    entry.pending++;
    try {
      return await entry.mutex.run(fn);
    } finally {
      entry.pending--;
      if (entry.pending === 0) this.#locks.delete(key);
    }
  }
}

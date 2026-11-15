/** FIFO async mutex: `run` calls execute one at a time in call order; a throwing fn releases the lock. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** One Mutex per key; different keys run concurrently. Idle keys are dropped. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(() => fn());
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/**
 * Lock order (DESIGN 4.2): a method that holds several keys takes them in this order and never the reverse. Keys are
 * plain strings in service.ts (`pages` is `PAGES_MUTEX` in pages.ts); this list is the one place the order is written
 * in code. `layers` guards every change to a layer folder and the registry reload (P9); `layer:<name>` serialises one
 * layer's own actions.
 */
export const MUTEX_ORDER = ["pages", "settings", "themes", "ui_config", "prompts", "cron", "layers", "layer:<name>"] as const;
export const LAYERS_MUTEX = "layers";

import { describe, expect, it } from "vitest";
import { KeyedMutex, Mutex } from "../../src/core/mutex.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("Mutex", () => {
  it("runs calls one at a time in call order", async () => {
    const m = new Mutex();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([m.run(task("a", 30)), m.run(task("b", 1)), m.run(task("c", 10))]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("a throwing fn rejects its caller and releases the lock", async () => {
    const m = new Mutex();
    const failing = m.run(() => {
      throw new Error("boom");
    });
    const next = m.run(() => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});

describe("KeyedMutex", () => {
  it("is FIFO per key", async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
    };
    await Promise.all([m.run("k", task("1", 25)), m.run("k", task("2", 1)), m.run("k", task("3", 5))]);
    expect(log).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  });

  it("runs different keys concurrently", async () => {
    const m = new KeyedMutex();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let bStarted = false;
    const a = m.run("a", () => gate);
    const b = m.run("b", () => {
      bStarted = true;
    });
    await b;
    expect(bStarted).toBe(true); // b finished while a is still held
    release();
    await a;
  });

  it("a throwing fn releases the key", async () => {
    const m = new KeyedMutex();
    const failing = m.run("k", async () => {
      throw new Error("boom");
    });
    const next = m.run("k", () => 42);
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe(42);
    await expect(m.run("k", () => "again")).resolves.toBe("again");
  });
});

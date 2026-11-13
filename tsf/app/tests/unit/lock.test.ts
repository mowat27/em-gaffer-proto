import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isAlive,
  lockFile,
  readLockPid,
  readServerState,
  removeServerState,
  writeServerState,
  type ServerState,
} from "../../src/core/lock.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

afterEach(cleanupTmp);

/** A pid that existed and is gone. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout);
}

describe("lockFile", () => {
  it("writes the pid; a second lock fails naming the owner; unlock removes the file", async () => {
    const path = join(await tmpDir("tsf-lock"), "agent.sqlite.lock");
    const unlock = lockFile(path);
    expect(readLockPid(path)).toBe(process.pid);
    expect(() => lockFile(path)).toThrow(`already owned by process ${process.pid}`);
    unlock();
    expect(existsSync(path)).toBe(false);
    unlock(); // idempotent
    const again = lockFile(path);
    again();
  });

  it("takes over a lock whose pid is dead", async () => {
    const path = join(await tmpDir("tsf-lock"), "agent.sqlite.lock");
    const dead = deadPid();
    expect(isAlive(dead)).toBe(false);
    await writeFile(path, `${dead}\n`);
    const unlock = lockFile(path);
    expect(readLockPid(path)).toBe(process.pid);
    unlock();
  });

  it("takes over an unreadable lock and refuses a live foreign owner", async () => {
    const path = join(await tmpDir("tsf-lock"), "agent.sqlite.lock");
    await writeFile(path, "garbage");
    lockFile(path)();
    await writeFile(path, `${process.ppid}\n`);
    expect(isAlive(process.ppid)).toBe(true);
    expect(() => lockFile(path)).toThrow(`already owned by process ${process.ppid}`);
  });

  it("unlock leaves a lock that another process now owns", async () => {
    const path = join(await tmpDir("tsf-lock"), "agent.sqlite.lock");
    const unlock = lockFile(path);
    await writeFile(path, `${process.ppid}\n`);
    unlock();
    expect(await readFile(path, "utf8")).toBe(`${process.ppid}\n`);
  });
});

describe("isAlive / readLockPid", () => {
  it("knows this process, rejects nonsense", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-4)).toBe(false);
    expect(isAlive(1.5)).toBe(false);
  });

  it("readLockPid is undefined for a missing file", async () => {
    expect(readLockPid(join(await tmpDir("tsf-lock"), "none"))).toBeUndefined();
  });
});

describe("server.json", () => {
  const state: ServerState = {
    pid: 4242,
    url: "http://127.0.0.1:8000",
    host: "127.0.0.1",
    port: 8000,
    bootId: 7,
    startedAt: 1_700_000_000_000,
  };

  it("round-trips, and removeServerState deletes it", async () => {
    const file = join(await tmpDir("tsf-lock"), "data", "server.json");
    expect(readServerState(file)).toBeUndefined();
    await writeServerState(file, state);
    expect(readServerState(file)).toEqual(state);
    removeServerState(file);
    expect(readServerState(file)).toBeUndefined();
    removeServerState(file); // missing file is fine
  });

  it("returns undefined for malformed content", async () => {
    const dir = await tmpDir("tsf-lock");
    const file = join(dir, "server.json");
    await writeFile(file, "{not json");
    expect(readServerState(file)).toBeUndefined();
    await writeFile(file, JSON.stringify({ pid: 1 }));
    expect(readServerState(file)).toBeUndefined();
  });
});

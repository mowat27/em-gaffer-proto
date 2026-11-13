import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { atomicWrite } from "./fsutil.ts";

/** True when a process with this pid exists (signal 0). EPERM means it exists but belongs to someone else. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLockPid(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take the PID lock at `path` (flag `wx`, pid inside). A lock whose pid is dead is taken over; a live owner
 * throws `Error("already owned by process <pid>")`. Returns the unlock function (idempotent; removes the file
 * only while it still holds this process's pid).
 */
export function lockFile(path: string): () => void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (readLockPid(path) === process.pid) rmSync(path, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readLockPid(path);
      if (owner !== undefined && owner !== process.pid && isAlive(owner)) {
        throw new Error(`already owned by process ${owner}`);
      }
      if (owner === process.pid) throw new Error(`already owned by process ${owner}`);
      // Dead or unreadable owner: remove the stale lock and retry the exclusive create.
      rmSync(path, { force: true });
    }
  }
  throw new Error(`could not take lock ${path}`);
}

export interface ServerState {
  pid: number;
  url: string;
  host: string;
  port: number;
  bootId: number;
  startedAt: number;
}

export async function writeServerState(file: string, s: ServerState): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(s, null, 2)}\n`);
}

export function readServerState(file: string): ServerState | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<ServerState>;
    if (
      typeof v.pid === "number" &&
      typeof v.url === "string" &&
      typeof v.host === "string" &&
      typeof v.port === "number" &&
      typeof v.bootId === "number" &&
      typeof v.startedAt === "number"
    ) {
      return v as ServerState;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function removeServerState(file: string): void {
  rmSync(file, { force: true });
}

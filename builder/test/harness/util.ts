/** Small helpers the harness and the tests share: temp dirs, free ports, HTTP calls, waiting, git. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A new temp dir, removed by the returned function (kept when $KEEP_TEST_TMP is set, for debugging). */
export function tempDir(prefix: string): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return { dir, remove: () => (process.env.KEEP_TEST_TMP ? undefined : rmSync(dir, { recursive: true, force: true })) };
}

/** A TCP port that was free a moment ago on 127.0.0.1. Never one of the ports other local services use. */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
    if (![8013, 8787, 8788].includes(port)) return port;
  }
}

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  /** The body parsed as JSON, or undefined when it is not JSON. */
  json: unknown;
}

export async function http(method: string, url: string, body?: string | object): Promise<HttpResult> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Poll `probe` until it returns a value other than undefined, or fail after `timeoutMs`. */
export async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs: number, everyMs = 100): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** git with the user's global and system config ignored, so every machine behaves the same. */
export const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", ["-c", "user.name=contract-test", "-c", "user.email=contract-test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, ...GIT_ENV },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

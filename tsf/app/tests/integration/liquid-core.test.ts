/**
 * The liquid core under the REAL launcher: a project stamped WITH the app copy (`tsf/app`) boots from it (the first
 * start runs `npm install` there, a minute or two), serves the web built from the copy, rebuilds live and keeps the last
 * good build on a broken edit, restarts itself on the agent's `restart_factory` without looping (respawn mode), exits
 * 3 under a supervisor, and takes a real screenshot when Chromium is installed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatView, FactoryStatus } from "../../src/shared/types.ts";
import { exec, runInstall } from "../helpers/project.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

const SLOW = 420_000;

let root = "";
let port = 0;
let url = "";
const children: ChildProcess[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

interface Running {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
}

function startFactory(extraEnv: Record<string, string> = {}): Promise<Running> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "tsf", "app", "bin", "tsf.mjs"), "start"], {
      cwd: root,
      env: { ...process.env, TSF_PROJECT: root, TSF_MODEL_PROVIDER: "faux", TSF_PORT: String(port), TSF_HOST: "127.0.0.1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "";
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    const onData = (chunk: Buffer): void => {
      out += chunk.toString("utf8");
      if (/TSF running at (http:\/\/\S+)/.test(out)) resolve({ child, exited, output: () => out });
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("exit", (code) => reject(new Error(`factory exited ${code} before listening:\n${out.slice(-3000)}`)));
    setTimeout(() => reject(new Error(`factory did not start in ${SLOW / 1000} s:\n${out.slice(-3000)}`)), SLOW).unref();
  });
}

const statePid = (): number | undefined => {
  try {
    return (JSON.parse(readFileSync(join(root, "tsf", "data", "server.json"), "utf8")) as { pid: number }).pid;
  } catch {
    return undefined;
  }
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function status(): Promise<FactoryStatus> {
  return (await (await fetch(`${url}/api/status`)).json()) as FactoryStatus;
}
async function post(path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function until<T>(fn: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const logLines = async (event: string): Promise<number> => {
  const text = await readFile(join(root, "tsf", "data", "logs", "tsf.log"), "utf8").catch(() => "");
  return text.split("\n").filter((l) => l.includes(`"event":"${event}"`)).length;
};

async function stopAll(): Promise<void> {
  const pid = statePid();
  if (pid !== undefined && alive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // gone
    }
    await until(async () => (alive(pid) ? undefined : true), 15_000, "the factory to stop").catch(() => process.kill(pid, "SIGKILL"));
  }
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
}

beforeAll(async () => {
  root = await tmpDir("tsf-liquid");
  await exec("git", ["init", "-q"], { cwd: root });
  const r = await runInstall(root, { TSF_INSTALL_NO_APP: "" });
  if (r.code !== 0) throw new Error(`install.sh failed: ${r.stderr}`);
  expect(existsSync(join(root, "tsf", "app", "bin", "tsf.mjs"))).toBe(true);
  port = await freePort();
  url = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  await stopAll();
  await cleanupTmp();
}, 60_000);

describe("a project that owns its factory source", () => {
  it("boots from tsf/app and serves the web built there", async () => {
    await startFactory();
    const s = await status();
    expect(s.web.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(s.web.lastError).toBeNull();
    expect(existsSync(join(root, "tsf", "app", "dist", `web-${s.web.hash}`, "index.html"))).toBe(true);
    expect(existsSync(join(root, "tsf", "app", "node_modules", "tsx"))).toBe(true);
    // The running app and appDir agree.
    expect(await logLines("startup.app_mismatch")).toBe(0);
    const page = await (await fetch(`${url}/`)).text();
    expect(page).toContain(`<meta name="tsf-web-hash" content="${s.web.hash}">`);
  }, SLOW);

  it("keeps the last good build on a broken web edit, reports the error, and recovers when it is fixed", async () => {
    const before = (await status()).web.hash;
    const file = join(root, "tsf", "app", "src", "web", "App.tsx");
    const good = await readFile(file, "utf8");
    await writeFile(file, `${good}\nexport const broken = ;\n`);
    const failed = await until(async () => ((await status()).web.lastError ? await status() : undefined), 90_000, "web.lastError");
    expect(failed.web.hash).toBe(before);
    expect(failed.web.lastError).toMatch(/error|Unexpected|PARSE/i);
    // The old build still serves.
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`content="${before}"`);
    // rebuild_web reports the same failure at once.
    const manual = (await (await post("/api/factory/rebuild-web")).json()) as { ok: boolean; error?: string; hash: string };
    expect(manual.ok).toBe(false);
    expect(manual.error).toBeTruthy();
    expect(manual.hash).toBe(before);

    await writeFile(file, good);
    const fixed = await until(async () => ((await status()).web.lastError === null ? await status() : undefined), 90_000, "the error to clear");
    expect(fixed.web.hash).toBe(before);

    // A real change swaps the build and the hash.
    await writeFile(file, `${good}\nexport const added = 1;\n`);
    const swapped = await until(async () => (((await status()).web.hash ?? before) !== before ? await status() : undefined), 90_000, "a new web hash");
    expect(swapped.web.lastError).toBeNull();
    await writeFile(file, good);
    await until(async () => ((await status()).web.hash === before ? true : undefined), 90_000, "the original hash again");
  }, SLOW);

  it("restart_factory by the agent restarts the process once and the turn is not re-run", async () => {
    const oldPid = statePid()!;
    const send = await post("/api/chat/send", { text: 'probe restart_factory {"reason":"integration test"}', requestId: "restart-1" });
    expect(send.status).toBe(202);
    const newPid = await until(async () => {
      const p = statePid();
      return p !== undefined && p !== oldPid && alive(p) ? p : undefined;
    }, 60_000, "a new factory process");
    expect(alive(oldPid)).toBe(false);
    await until(async () => ((await status()).pid === newPid ? true : undefined), 60_000, "the new process to answer");

    const view = await until(
      async () => {
        const v = (await (await fetch(`${url}/api/chat`)).json()) as ChatView;
        const last = v.items.filter((i) => i.kind === "assistant").at(-1);
        return !v.live.busy && last && last.kind === "assistant" && last.text === "probe done" ? v : undefined;
      },
      60_000,
      'the final "probe done" and live.busy false',
    );
    const tools = view.items.filter((i) => i.kind === "tool" && i.name === "restart_factory");
    expect(tools).toHaveLength(1);
    expect(tools[0] && tools[0].kind === "tool" ? tools[0].status : undefined).toBe("done");
    // No loop: wait past another restart delay and count.
    await new Promise((r) => setTimeout(r, 4000));
    expect(statePid()).toBe(newPid);
    expect(await logLines("restart.requested")).toBe(1);
    expect(await logLines("restart.begin")).toBe(1);
    expect(await logLines("restart.respawned")).toBe(1);
  }, SLOW);

  it("a turn in flight when the factory restarts is continued afterwards", async () => {
    const oldPid = statePid()!;
    const send = await post("/api/chat/send", { text: "long turn", requestId: "restart-mid-turn" });
    expect(send.status).toBe(202);
    await until(async () => (((await (await fetch(`${url}/api/chat`)).json()) as ChatView).live.phase === "streaming" ? true : undefined), 30_000, "live.phase streaming");
    expect((await post("/api/factory/restart", { reason: "mid turn" })).status).toBe(200);
    const newPid = await until(async () => {
      const p = statePid();
      return p !== undefined && p !== oldPid && alive(p) ? p : undefined;
    }, 60_000, "a new factory process");
    await until(async () => ((await status()).pid === newPid ? true : undefined), 60_000, "the new process to answer");
    await until(
      async () => {
        const v = (await (await fetch(`${url}/api/chat`)).json()) as ChatView;
        const last = v.items.filter((i) => i.kind === "assistant").at(-1);
        return !v.live.busy && last && last.kind === "assistant" && last.text.startsWith("Long turn") ? true : undefined;
      },
      90_000,
      'an assistant item starting with "Long turn" and live.busy false',
    );
  }, SLOW);

  it("takes a real screenshot when Chromium is installed (else says how to install it)", async () => {
    const res = await post("/api/factory/screenshot", { mode: "dark", width: 1000, height: 700 });
    const body = (await res.json()) as { file?: string; url?: string; width?: number; height?: number; error?: { code: string; message: string } };
    if (res.status !== 200) {
      // eslint-disable-next-line no-console
      console.warn(`screenshot skipped: ${body.error?.message}`);
      expect(res.status).toBe(503);
      expect(body.error?.message).toContain("npx playwright install chromium");
      return;
    }
    expect(body.url).toMatch(/^\/api\/screenshots\/.+\.png$/);
    expect(body.width).toBe(1000);
    const img = await fetch(`${url}${body.url}`);
    expect(img.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await img.arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(bytes.length).toBeGreaterThan(5000);
    const el = await post("/api/factory/screenshot", { selector: '[data-testid="connection"]' });
    expect(el.status).toBe(200);
  }, 120_000);

  it("under a supervisor (TSF_SUPERVISED) the restart exits 3 so Restart=on-failure brings it back", async () => {
    await stopAll();
    const running = await startFactory({ TSF_SUPERVISED: "1" });
    const r = await post("/api/factory/restart", { reason: "supervised" });
    expect(await r.json()).toMatchObject({ mode: "systemd", restartingInMs: 1500 });
    expect(await running.exited).toBe(3);
    expect(statePid()).toBeUndefined();
  }, SLOW);
});

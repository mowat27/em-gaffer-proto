import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appDir } from "../../src/core/paths.ts";
import type { ChatView } from "../../src/shared/types.ts";
import { makeProject } from "../helpers/project.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

interface Running {
  child: ChildProcess;
  url: string;
  output: () => string;
  exited: Promise<NodeJS.Signals | number | null>;
}

const children: ChildProcess[] = [];

/** `node bin/tsf.mjs start` in `root` on faux with a free port; resolves at the `TSF running at <url>` line. */
function startFactory(root: string): Promise<Running> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(appDir, "bin", "tsf.mjs"), "start"], {
      cwd: root,
      env: { ...process.env, TSF_PROJECT: root, TSF_MODEL_PROVIDER: "faux", TSF_PORT: "0", TSF_HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "";
    const exited = new Promise<NodeJS.Signals | number | null>((r) => child.once("exit", (code, signal) => r(signal ?? code)));
    const onData = (chunk: Buffer): void => {
      out += chunk.toString("utf8");
      const m = /TSF running at (http:\/\/\S+)/.exec(out);
      if (m) resolve({ child, url: m[1]!, output: () => out, exited });
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("exit", (code) => reject(new Error(`factory exited ${code} before listening:\n${out}`)));
    setTimeout(() => reject(new Error(`factory did not start in 60 s:\n${out}`)), 60_000).unref();
  });
}

async function chat(url: string): Promise<ChatView> {
  return (await (await fetch(`${url}/api/chat`)).json()) as ChatView;
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

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  await cleanupTmp();
});

describe("durability", () => {
  it("a turn killed mid-stream with SIGKILL completes after a restart", async () => {
    const { root } = await makeProject();

    const first = await startFactory(root);
    const send = await fetch(`${first.url}/api/chat/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "long turn", requestId: "dur-long" }),
    });
    expect(send.status).toBe(202);

    await until(async () => ((await chat(first.url)).live.phase === "streaming" ? true : undefined), 30_000, "live.phase streaming");
    await new Promise((r) => setTimeout(r, 1000));
    first.child.kill("SIGKILL");
    await first.exited;

    const second = await startFactory(root);
    const view = await until(
      async () => {
        const v = await chat(second.url);
        const last = v.items.filter((i) => i.kind === "assistant").at(-1);
        return !v.live.busy && last && last.kind === "assistant" && last.text.startsWith("Long turn") ? v : undefined;
      },
      60_000,
      'an assistant item starting with "Long turn" and live.busy false',
    );
    expect(view.live.busy).toBe(false);

    second.child.kill("SIGTERM");
    expect(await second.exited).toBe(0);
  });

  it("a bash effect killed mid-call with SIGKILL runs once; the tool is interrupted and the run answers after a restart", async () => {
    const { root, paths } = await makeProject();
    const effects = join(paths.dataDir, "effects.log");
    const lines = async (): Promise<string[] | undefined> => {
      const text = await readFile(effects, "utf8").catch(() => "");
      return text === "" ? undefined : text.split("\n").filter(Boolean);
    };

    const first = await startFactory(root);
    const send = await fetch(`${first.url}/api/chat/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "effect turn", requestId: "dur-effect" }),
    });
    expect(send.status).toBe(202);

    // The effect line is written by bash, then bash sleeps 6 s: kill inside the sleep.
    await until(lines, 30_000, "the effect line in tsf/data/effects.log");
    await new Promise((r) => setTimeout(r, 300));
    first.child.kill("SIGKILL");
    await first.exited;

    const second = await startFactory(root);
    const view = await until(
      async () => {
        const v = await chat(second.url);
        const last = v.items.filter((i) => i.kind === "assistant").at(-1);
        return !v.live.busy && last && last.kind === "assistant" && last.text === "effect turn done" ? v : undefined;
      },
      60_000,
      'an assistant item "effect turn done" and live.busy false',
    );
    const bash = view.items.find((i) => i.kind === "tool" && i.name === "bash");
    expect(bash && bash.kind === "tool" ? bash.status : undefined).toBe("interrupted");
    expect(await lines()).toEqual(["effect"]);

    second.child.kill("SIGTERM");
    expect(await second.exited).toBe(0);
  });
});

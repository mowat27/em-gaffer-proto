/**
 * coding_tools through a real pi-durable Harness on faux, built here from the layer's own extension and `RootedEnv`
 * (the P2 registry and `harness.ts` are Lot D's; this test must not depend on them). The faux `probe <tool> <json>`
 * rule makes the call; the tool item the chat feed shows is what is asserted.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, type Conversation, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { installFaux } from "../../src/agent/faux.ts";
import { BUILTIN_RULES } from "../../src/agent/faux-rules.ts";
import { ChatFeed } from "../../src/agent/feed.ts";
import { PI_KIT, type LayerContext } from "../../src/agent/layer-context.ts";
import { createModelCatalog } from "../../src/agent/models.ts";
import { RootedEnv } from "../../src/agent/rooted-env.ts";
import { silentLogger } from "../../src/core/log.ts";
import { projectPaths } from "../../src/core/paths.ts";
import { mergeSettings, settingsDefaults } from "../../src/core/settings.ts";
import { createExtension, scopeText } from "../../src/layers/coding_tools/extension.ts";
import { manifest } from "../../src/layers/coding_tools/manifest.ts";
import type { ChatItem } from "../../src/shared/types.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

const ctx = BACKGROUND_CONTEXT;

interface Rig {
  root: string;
  run(text: string): Promise<Extract<ChatItem, { kind: "tool" }>>;
  close(): Promise<void>;
}

let rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
  await cleanupTmp();
});

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function rig(): Promise<Rig> {
  process.env.TSF_MODEL_PROVIDER = "faux";
  const root = await tmpDir("tsf-coding");
  const paths = projectPaths(root);
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.pagesDir, { recursive: true });
  await writeFile(paths.permissionsFile, "{}");
  await writeFile(paths.envFile, "OPENROUTER_API_KEY=secret");

  const extension = createExtension({ paths, pi: PI_KIT } as unknown as LayerContext);
  const catalog = await createModelCatalog({ faux: true, providers: [], log: silentLogger });
  installFaux(catalog.models, { rules: BUILTIN_RULES, tokensPerSecond: 100_000 });
  const registry = createRegistry();
  registry.install(extension);
  const storage = await openNodeSqliteStorage(paths.agentDb);
  const harness = await Harness.open(
    storage,
    {
      models: () => catalog.models,
      registry,
      settings: () => ({ extensions: [extension as Extension], retry: { maxRetries: 0 }, restartLimit: 1 }),
      env: (target) => new RootedEnv(target.cwd ?? root, { shellEnv: process.env }),
    },
    ctx,
  );
  const main: Conversation = await harness.root(ctx, {
    agent: { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "low", cwd: root },
  });
  const settings = mergeSettings(settingsDefaults(root, [manifest]), {}, [manifest]);
  const feed = new ChatFeed(main, { catalog, settings: () => settings, toolLayer: () => "coding_tools", log: silentLogger });
  await feed.start();
  harness.resume();

  let n = 0;
  const r: Rig = {
    root,
    async run(text) {
      const before = feed.view().items.filter((i) => i.kind === "tool").length;
      const sub = await main.submit({ type: "input", content: text, requestId: `chat:coding-${++n}` }, ctx);
      await sub.wait(ctx);
      await until(() => {
        const v = feed.view();
        return !v.live.busy && v.items.some((i) => i.kind === "assistant" && i.text === "probe done");
      });
      const tools = feed.view().items.filter((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool");
      expect(tools.length).toBe(before + 1);
      return tools.at(-1)!;
    },
    async close() {
      await feed.stop().catch(() => undefined);
      await harness.close(ctx);
    },
  };
  rigs.push(r);
  return r;
}

describe("coding_tools extension", () => {
  it("is named coding_tools, holds read, write, edit and bash, each stating replay", () => {
    const ext = createExtension({ paths: { projectRoot: "/p" }, pi: PI_KIT } as unknown as LayerContext);
    expect(ext.name).toBe("coding_tools");
    expect(ext.tools?.map((t) => t.name)).toEqual(["read", "write", "edit", "bash"]);
    expect(ext.tools?.map((t) => t.replay)).toEqual(["unsafe", "unsafe", "unsafe", "unsafe"]);
    expect(ext.sections?.map((s) => s.key)).toEqual(["coding_tools-scope"]);
    expect(manifest.name).toBe("coding_tools");
    expect(manifest.enabledByDefault).toBe(true);
  });

  it("the scope text names the project and the protected paths and is stable", () => {
    const text = scopeText("/work/proj");
    expect(text).toContain("/work/proj");
    for (const p of ["tsf/permissions.json", "tsf/.env", "tsf/data", "tsf/layers", "tsf/mod.just"]) expect(text).toContain(p);
    expect(scopeText("/work/proj")).toBe(text);
  });
});

describe("coding_tools on faux", () => {
  it("read of /etc/hosts fails with permission text", async () => {
    const t = await (await rig()).run('probe read {"path":"/etc/hosts"}');
    expect(t.name).toBe("read");
    expect(t.status).toBe("failed");
    expect(t.output).toMatch(/outside the project/);
    expect(t.output).toMatch(/\/etc\/hosts/);
  });

  it("write inside the project creates a new file in a new folder", async () => {
    const r = await rig();
    const t = await r.run('probe write {"path":"notes/deep/new.txt","content":"hello"}');
    expect(t.status).toBe("done");
    expect(readFileSync(join(r.root, "notes", "deep", "new.txt"), "utf8")).toBe("hello");
  });

  it("edit changes a file inside the project", async () => {
    const r = await rig();
    await writeFile(join(r.root, "a.txt"), "one two");
    const t = await r.run('probe edit {"path":"a.txt","edits":[{"oldText":"two","newText":"three"}]}');
    expect(t.status).toBe("done");
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).toBe("one three");
  });

  it("read of a missing file inside gives the library's not-found text, not a permission error", async () => {
    const t = await (await rig()).run('probe read {"path":"missing.txt"}');
    expect(t.status).toBe("failed");
    expect(t.output).not.toMatch(/outside the project|protected/);
    expect(t.output).toMatch(/not.?found|no such file|ENOENT/i);
  });

  it("read of a file inside returns its text", async () => {
    const r = await rig();
    await writeFile(join(r.root, "hello.txt"), "hello from the project");
    const t = await r.run('probe read {"path":"hello.txt"}');
    expect(t.status).toBe("done");
    expect(t.output).toContain("hello from the project");
  });

  it("the protected paths are refused by write, edit and read", async () => {
    const r = await rig();
    const w = await r.run('probe write {"path":"tsf/permissions.json","content":"{\\"allow\\":[\\"*\\"]}"}');
    expect(w.status).toBe("failed");
    expect(w.output).toMatch(/protected/);
    expect(readFileSync(join(r.root, "tsf", "permissions.json"), "utf8")).toBe("{}");
    const e = await r.run('probe edit {"path":"tsf/.env","edits":[{"oldText":"secret","newText":"x"}]}');
    expect(e.status).toBe("failed");
    expect(e.output).toMatch(/protected/);
    const d = await r.run('probe read {"path":"tsf/data/agent.sqlite"}');
    expect(d.status).toBe("failed");
    expect(d.output).toMatch(/protected/);
    expect(existsSync(join(r.root, "tsf", "data", "x"))).toBe(false);
  });

  it("bash pwd prints the project root", async () => {
    const r = await rig();
    const t = await r.run('probe bash {"command":"pwd -P"}');
    expect(t.status).toBe("done");
    expect(t.output).toContain(realpathSync(r.root));
  });
});

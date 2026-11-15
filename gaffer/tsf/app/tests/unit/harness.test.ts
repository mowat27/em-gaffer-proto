import { mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openFactoryAgent, type FactoryAgent } from "../../src/agent/harness.ts";
import { createBus } from "../../src/core/bus.ts";
import { openAppDb, type AppDb } from "../../src/core/db.ts";
import { ServiceError } from "../../src/core/errors.ts";
import { silentLogger } from "../../src/core/log.ts";
import { projectPaths, type ProjectPaths } from "../../src/core/paths.ts";
import type { ChatItem } from "../../src/shared/types.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

const ctx = BACKGROUND_CONTEXT;
/** The built-in layers present after P2, in load order (factory_controls arrives in P4). */
const BUILTIN_EXTENSIONS = ["factory_harness", "provider_openrouter", "coding_tools", "page_harness", "factory_controls", "model_controls"];
let savedProvider: string | undefined;

beforeAll(() => {
  savedProvider = process.env.TSF_MODEL_PROVIDER;
  process.env.TSF_MODEL_PROVIDER = "faux";
});
afterAll(async () => {
  if (savedProvider === undefined) delete process.env.TSF_MODEL_PROVIDER;
  else process.env.TSF_MODEL_PROVIDER = savedProvider;
  await cleanupTmp();
});

const open: { agent: FactoryAgent; db: AppDb }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.agent.close();
    o.db.close();
  }
});

async function project(): Promise<ProjectPaths> {
  const paths = projectPaths(await tmpDir("tsf-harness"));
  await mkdir(paths.dataDir, { recursive: true });
  return paths;
}

async function openAgent(paths: ProjectPaths): Promise<FactoryAgent> {
  const db = openAppDb(paths.appDb);
  const agent = await openFactoryAgent({
    paths,
    log: silentLogger,
    bus: createBus(silentLogger),
    db,
    service: () => {
      throw new ServiceError("unavailable", "the factory is still starting");
    },
    tools: null,
  });
  open.push({ agent, db });
  return agent;
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const assistantTexts = (items: readonly ChatItem[]) =>
  items.flatMap((i) => (i.kind === "assistant" ? [i.text] : []));

async function ping(agent: FactoryAgent, requestId: string): Promise<void> {
  const submission = await agent.main.submit({ type: "input", content: "ping", requestId }, ctx);
  const settled = await submission.wait(ctx);
  expect(settled.status).toBe("done");
  await until(() => !agent.feed.view().live.busy && assistantTexts(agent.feed.view().items).includes("pong"));
}

describe("openFactoryAgent (faux)", () => {
  it("nothing runs before resume(); resume() starts scheduling", async () => {
    const agent = await openAgent(await project());
    expect((await agent.harness.inspect(ctx)).scheduling).toBe("paused");
    agent.resume();
    agent.resume();
    expect((await agent.harness.inspect(ctx)).scheduling).toBe("running");
  });

  it("ping answers pong, with the faux model and the system section", async () => {
    const agent = await openAgent(await project());
    agent.resume();
    await ping(agent, "chat:ping-1");
    expect(agent.feed.view().items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(agent.feed.view().meta.model).toEqual({ provider: "faux", modelId: "faux-1" });
    expect(agent.feed.view().meta.extensions).toEqual(BUILTIN_EXTENSIONS);

    const page = await agent.main.entries({ order: "ascending" }, 50, undefined, ctx);
    const system = page.items.find((e) => e.kind === "pi.system");
    const sections = (system?.model?.[0] as { sections?: Record<string, string | null> } | undefined)?.sections ?? {};
    expect(Object.keys(sections)).toContain("factory_harness-system");
    expect(sections["factory_harness-system"]).toContain(agent.settings().factoryName);
    expect(Object.keys(sections)).toContain("factory_harness-identity");
  });

  it("close and reopen sees the transcript", async () => {
    const paths = await project();
    const first = await openAgent(paths);
    first.resume();
    await ping(first, "chat:ping-2");
    const o = open.pop()!;
    await o.agent.close();
    o.db.close();

    const again = await openAgent(paths);
    const items = again.feed.view().items;
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(assistantTexts(items)).toEqual(["pong"]);
  });

  it("settings come from the manifests and the db; applySettings configures the root", async () => {
    const paths = await project();
    const agent = await openAgent(paths);
    expect(agent.settings().layersEnabled).toEqual(BUILTIN_EXTENSIONS);
    expect(agent.catalog.source).toBe("faux");
    const db = open[open.length - 1]!.db;
    db.settings.set("thinkingLevel", "max");
    expect(agent.settings().thinkingLevel).toBe("max");
    await agent.applySettings();
    const resolved = await agent.main.agent(ctx);
    expect(resolved.thinkingLevel).toBe("max");
    expect(resolved.cwd).toBe(paths.projectRoot);
    expect(resolved.maxTurns).toBe(60);
  });

  it("testing.rules go ahead of the built-ins", async () => {
    const paths = await project();
    const db = openAppDb(paths.appDb);
    const agent = await openFactoryAgent({
      paths,
      log: silentLogger,
      bus: createBus(silentLogger),
      db,
      service: () => {
        throw new ServiceError("unavailable", "starting");
      },
      tools: null,
      testing: { rules: [{ name: "custom ping", match: (t) => t.lastUser === "ping", reply: () => ({ text: "custom pong" }) }] },
    });
    open.push({ agent, db });
    agent.resume();
    const submission = await agent.main.submit({ type: "input", content: "ping", requestId: "chat:c" }, ctx);
    await submission.wait(ctx);
    await until(() => assistantTexts(agent.feed.view().items).includes("custom pong"));
  });
});

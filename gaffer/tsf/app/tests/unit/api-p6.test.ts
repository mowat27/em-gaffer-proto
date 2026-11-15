/**
 * P6 (cron prompts, spec 8.6) through the HTTP app, the Service and the agent's own tools on the faux model, with the
 * real pi-durable agent: CRUD and validation, a manual run placing a "Cron" item and adding pages (acceptance 9's
 * work), the run recorded with trigger cron, the tools, and the two restart guarantees (a slot never runs twice; a
 * missed entry catches up once).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { projectPaths } from "../../src/core/paths.ts";
import type { AppEvent } from "../../src/shared/events.ts";
import type { ChatItem, CronEntry, Delta, FolderNode, PageTree } from "../../src/shared/types.ts";
import type { Factory } from "../../src/server/main.ts";
import { CRON_PROMPT, CRON_REPLY, rules } from "../fixtures/faux-demo.ts";
import { LANGUAGES } from "../fixtures/faux-pages.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ui = { by: "ui" } as const;
const NEVER = "0 0 1 1 *";

let factory: Factory & { root: string };
let events: AppEvent[];

function spy(f: Factory): void {
  events = [];
  const publish = f.hub.publish.bind(f.hub);
  vi.spyOn(f.hub, "publish").mockImplementation((d: Delta) => {
    if ("type" in d) events.push(d as AppEvent);
    return publish(d);
  });
}

const tps = process.env.TSF_FAUX_TPS;
beforeEach(async () => {
  process.env.TSF_FAUX_TPS = "2000";
  factory = await createTestFactory({ rules });
  spy(factory);
  for (const p of ["Languages", ...LANGUAGES.map((l) => `Languages/${l.folder}`)]) await factory.service.createFolder({ path: p }, ui);
});

afterEach(async () => {
  if (tps === undefined) delete process.env.TSF_FAUX_TPS;
  else process.env.TSF_FAUX_TPS = tps;
  vi.restoreAllMocks();
  await factory.close();
  await cleanupTmp();
});

const get = (path: string) => factory.app.request(`/api/${path}`);
const post = (path: string, body: unknown = {}) =>
  factory.app.request(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const ofType = (type: string) => events.filter((e) => e.type === type);
type CronItem = Extract<ChatItem, { kind: "cron" }>;
const cronItems = (): CronItem[] => factory.service.chatView().items.filter((i): i is CronItem => i.kind === "cron");

async function until<T>(what: string, fn: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const idle = () => until("idle", () => {
  const v = factory.service.chatView();
  return !v.live.busy && v.live.inbox.length === 0 && v.live.phase === "idle" ? true : undefined;
});

function languagePages(): Record<string, string[]> {
  const tree: PageTree = factory.service.listPages();
  const languages = tree.children.find((n): n is FolderNode => n.kind === "folder" && n.path === "Languages");
  const out: Record<string, string[]> = {};
  for (const l of LANGUAGES) {
    const f = languages?.children.find((n): n is FolderNode => n.kind === "folder" && n.path === `Languages/${l.folder}`);
    out[l.folder] = (f?.children ?? []).filter((n) => n.kind === "page").map((n) => n.path);
  }
  return out;
}

async function create(name: string, expr = NEVER, prompt = CRON_PROMPT): Promise<CronEntry> {
  const res = await post("cron/create", { name, expr, prompt });
  expect(res.status).toBe(200);
  return json<CronEntry>(res);
}

describe("cron entries over HTTP", () => {
  it("create, list, update, delete; each change publishes cron.changed and the snapshot carries the entries", async () => {
    const a = await create("Nightly", "*/5 * * * *", "ping");
    expect(a).toMatchObject({ name: "Nightly", expr: "*/5 * * * *", prompt: "ping", enabled: true, lastRunAt: null, lastSlot: null, lastStatus: null });
    expect(a.nextRunAt).toBeGreaterThan(Date.now());
    expect(a.nextRunAt! % 300_000).toBe(0);
    expect(await json<CronEntry[]>(await get("cron"))).toEqual([a]);
    expect(factory.service.snapshot().cron).toEqual([a]);
    expect(ofType("cron.changed")).toHaveLength(1);

    const off = await json<CronEntry>(await post("cron/update", { id: a.id, enabled: false }));
    expect(off).toMatchObject({ enabled: false, nextRunAt: null });
    const edited = await json<CronEntry>(await post("cron/update", { id: a.id, name: "Hourly", expr: "0 * * * *", prompt: "tool demo", enabled: true }));
    expect(edited).toMatchObject({ name: "Hourly", expr: "0 * * * *", prompt: "tool demo", enabled: true });
    expect(edited.nextRunAt! % 3_600_000).toBe(0);
    expect(ofType("cron.changed")).toHaveLength(3);
    const last = ofType("cron.changed").at(-1) as Extract<AppEvent, { type: "cron.changed" }>;
    expect(last.entries).toEqual([edited]);

    expect(await json(await post("cron/delete", { id: a.id }))).toEqual({ id: a.id, name: "Hourly" });
    expect(await json<CronEntry[]>(await get("cron"))).toEqual([]);
    expect(ofType("cron.changed")).toHaveLength(4);
  });

  it("validates input with the codes the UI shows", async () => {
    expect(await errorCode(await post("cron/create", { name: "", expr: NEVER, prompt: "p" }))).toBe("invalid");
    expect(await errorCode(await post("cron/create", { name: "A", expr: "not a cron", prompt: "p" }))).toBe("invalid");
    expect(await errorCode(await post("cron/create", { name: "A", expr: "* * * *", prompt: "p" }))).toBe("invalid");
    expect(await errorCode(await post("cron/create", { name: "A", expr: NEVER, prompt: "  " }))).toBe("invalid");
    expect(await errorCode(await post("cron/create", { name: "A", expr: NEVER }))).toBe("invalid");
    expect(await errorCode(await post("cron/create", { name: "A", expr: NEVER, prompt: "p", enabled: "yes" }))).toBe("invalid");
    await create("A");
    expect(await errorCode(await post("cron/create", { name: "A", expr: NEVER, prompt: "p" }))).toBe("conflict");
    const b = await create("B");
    expect(await errorCode(await post("cron/update", { id: b.id, name: "A" }))).toBe("conflict");
    expect(await errorCode(await post("cron/update", { id: b.id }))).toBe("invalid");
    expect(await errorCode(await post("cron/update", { id: "nope", name: "C" }))).toBe("not_found");
    expect(await errorCode(await post("cron/delete", { id: "nope" }))).toBe("not_found");
    expect(await errorCode(await post("cron/run-now", { id: "nope" }))).toBe("not_found");
    expect(await errorCode(await post("cron/run-now", {}))).toBe("invalid");
    expect(factory.service.listCrons().map((c) => c.name)).toEqual(["A", "B"]);
  });
});

describe("running a cron prompt", () => {
  it("run now puts a Cron item in the chat, the agent adds a new page to each language folder, and the run is recorded as cron", async () => {
    const entry = await create("Concept adder");
    const res = await post("cron/run-now", { id: entry.id });
    expect(res.status).toBe(200);
    const run = await json<{ cronId: string; slot: number; submissionId: number; manual: boolean }>(res);
    expect(run).toMatchObject({ cronId: entry.id, manual: true });
    const item = await until("the cron item", () => cronItems()[0]);
    expect(item).toMatchObject({ cronId: entry.id, name: "Concept adder", slot: run.slot, text: CRON_PROMPT });
    await until("the reply", () => factory.service.chatView().items.some((i) => i.kind === "assistant" && i.text === CRON_REPLY) || undefined);
    await idle();
    for (const l of LANGUAGES) expect(languagePages()[l.folder]).toEqual([`Languages/${l.folder}/Concept 1.md`]);

    const fired = ofType("cron.fired") as Extract<AppEvent, { type: "cron.fired" }>[];
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ cronId: entry.id, name: "Concept adder", slot: run.slot, submissionId: run.submissionId, catchUp: false });
    const after = await until("the outcome", () => {
      const e = factory.service.listCrons()[0]!;
      return e.lastStatus === "answered" ? e : undefined;
    });
    expect(after.lastRunAt).not.toBeNull();
    expect(after.nextRunAt).toBe(entry.nextRunAt);
    const recorded = await until("the recorded run", () => factory.service.listRuns({}).find((r) => r.trigger === "cron" && r.status === "answered"));
    expect(recorded.prompt).toBe(CRON_PROMPT);

    // A second run adds the next concept: the name is unique per run.
    await post("cron/run-now", { id: entry.id });
    await until("two cron items", () => cronItems().length === 2 || undefined);
    await until("the second reply", () => factory.service.chatView().items.filter((i) => i.kind === "assistant" && i.text === CRON_REPLY).length === 2 || undefined);
    await idle();
    for (const l of LANGUAGES) expect(languagePages()[l.folder]).toHaveLength(2);
  });

  it("a run now during a turn is queued behind it (followUp) and still runs", async () => {
    const entry = await create("Queued", NEVER, "ping");
    await factory.service.sendMessage({ text: "long turn", requestId: "long-1" }, ui);
    await until("busy", () => factory.service.chatView().live.busy || undefined);
    const run = await json<{ status: string }>(await post("cron/run-now", { id: entry.id }));
    expect(run.status).toBe("queued");
    expect(factory.service.chatView().live.inbox.some((i) => i.cron?.name === "Queued")).toBe(true);
    await until("the cron item", () => cronItems()[0]);
    await until("pong", () => factory.service.chatView().items.some((i) => i.kind === "assistant" && i.text === "pong") || undefined);
    const items = factory.service.chatView().items;
    const longIdx = items.findIndex((i) => i.kind === "assistant" && i.text.startsWith("Long turn"));
    const cronIdx = items.findIndex((i) => i.kind === "cron");
    expect(longIdx).toBeGreaterThanOrEqual(0);
    expect(cronIdx).toBeGreaterThan(longIdx);
  });

  it("run now works for a disabled entry and leaves it disabled", async () => {
    const entry = await create("Paused", NEVER, "ping");
    await post("cron/update", { id: entry.id, enabled: false });
    expect((await post("cron/run-now", { id: entry.id })).status).toBe(200);
    await until("the cron item", () => cronItems()[0]);
    expect(factory.service.listCrons()[0]).toMatchObject({ enabled: false, nextRunAt: null });
  });
});

describe("the agent's cron tools", () => {
  type ToolItem = Extract<ChatItem, { kind: "tool" }>;
  async function probe(tool: string, args: unknown): Promise<ToolItem> {
    const before = factory.service.chatView().items.filter((i) => i.kind === "tool").length;
    await factory.service.sendMessage({ text: `probe ${tool} ${JSON.stringify(args)}`, requestId: `p-${Math.random().toString(36).slice(2)}` }, ui);
    return await until(`probe ${tool}`, () => {
      const v = factory.service.chatView();
      const tools = v.items.filter((i): i is ToolItem => i.kind === "tool");
      return !v.live.busy && tools.length > before && v.items.some((i) => i.kind === "assistant" && i.text.includes("probe done")) ? tools.at(-1) : undefined;
    });
  }

  it("declares replay per DESIGN 7 and the factory_harness-cron section", () => {
    const infos = factory.service.listTools().filter((t) => t.name.endsWith("_cron") || t.name.endsWith("_crons") || t.name === "run_cron_now");
    expect(Object.fromEntries(infos.map((t) => [t.name, t.replay]))).toEqual({
      list_crons: "safe",
      create_cron: "safe",
      update_cron: "safe",
      delete_cron: "unsafe",
      run_cron_now: "safe",
    });
    expect(factory.service.listLayers().find((l) => l.name === "factory_harness")!.sections).toContain("factory_harness-cron");
  });

  it("create_cron, list_crons, update_cron, run_cron_now and delete_cron work and the UI sees each change", async () => {
    const created = await probe("create_cron", { name: "Agent made", expr: NEVER, prompt: "ping" });
    expect(created.status).toBe("done");
    const [entry] = factory.service.listCrons();
    expect(entry).toMatchObject({ name: "Agent made", prompt: "ping", enabled: true });
    expect(entry!.id).toMatch(/^c-/);
    expect(ofType("cron.changed")).toHaveLength(1);

    expect((await probe("list_crons", {})).status).toBe("done");
    expect((await probe("update_cron", { id: entry!.id, prompt: "tool demo", enabled: false })).status).toBe("done");
    expect(factory.service.listCrons()[0]).toMatchObject({ prompt: "tool demo", enabled: false });

    const now = await probe("run_cron_now", { id: entry!.id });
    expect(now.status).toBe("done");
    await until("the cron item", () => cronItems()[0]);
    await until("its answer", () => factory.service.chatView().items.some((i) => i.kind === "assistant" && i.text === "listed") || undefined);

    const bad = await probe("create_cron", { name: "Bad", expr: "nope", prompt: "x" });
    expect(bad.status).toBe("failed");
    expect(bad.output).toContain("expr");
    expect((await probe("delete_cron", { id: entry!.id })).status).toBe("done");
    expect(factory.service.listCrons()).toEqual([]);
  });

  it("a replayed create_cron finds its own row", async () => {
    const a = await factory.service.createCron({ name: "Once", expr: NEVER, prompt: "p" }, { by: "agent", callId: "call-1" });
    const b = await factory.service.createCron({ name: "Once", expr: NEVER, prompt: "p" }, { by: "agent", callId: "call-1" });
    expect(b.id).toBe(a.id);
    expect(factory.service.listCrons()).toHaveLength(1);
  });
});

describe("restarts", () => {
  // Seeded next_run_at values stand for a down server; the expression itself never fires during the test.
  const dbOf = (root: string) => new DatabaseSync(projectPaths(root).appDb);

  it("a missed entry runs once at boot (catch-up), then continues on schedule", async () => {
    const entry = await create("Catch up", NEVER, CRON_PROMPT);
    const missed = Date.now() - 5 * 60_000;
    await factory.close();
    const db = dbOf(factory.root);
    db.prepare("UPDATE crons SET next_run_at = ? WHERE id = ?").run(missed, entry.id);
    db.close();
    factory = await createTestFactory({ project: factory.root, rules });
    spy(factory);
    expect(cronItems()).toHaveLength(0);
    await factory.start();
    const item = await until("the catch-up item", () => cronItems()[0]);
    expect(item).toMatchObject({ cronId: entry.id, slot: missed, text: CRON_PROMPT });
    await until("its reply", () => factory.service.chatView().items.some((i) => i.kind === "assistant" && i.text === CRON_REPLY) || undefined);
    await idle();
    expect((ofType("cron.fired") as Extract<AppEvent, { type: "cron.fired" }>[])[0]).toMatchObject({ slot: missed, catchUp: true });
    const [now] = factory.service.listCrons();
    expect(now!.nextRunAt).toBeGreaterThan(Date.now());
    expect(now!.lastSlot).toBe(missed);
    for (const l of LANGUAGES) expect(languagePages()[l.folder]).toHaveLength(1);
  });

  it("a slot never runs twice across restarts, even if the schedule update was lost", async () => {
    const entry = await create("Once", NEVER, CRON_PROMPT);
    const slot = Date.now() - 2 * 60_000;
    await factory.close();
    let db = dbOf(factory.root);
    db.prepare("UPDATE crons SET next_run_at = ? WHERE id = ?").run(slot, entry.id);
    db.close();
    factory = await createTestFactory({ project: factory.root, rules });
    spy(factory);
    await factory.start();
    await until("the first run", () => cronItems()[0]);
    await until("its reply", () => factory.service.chatView().items.some((i) => i.kind === "assistant" && i.text === CRON_REPLY) || undefined);
    await idle();
    await factory.close();

    // As after a crash between the submission and the schedule write: next_run_at still names the slot that ran.
    db = dbOf(factory.root);
    db.prepare("UPDATE crons SET next_run_at = ? WHERE id = ?").run(slot, entry.id);
    db.close();
    factory = await createTestFactory({ project: factory.root, rules });
    spy(factory);
    await factory.start();
    await sleep(600);
    await idle();
    expect(cronItems()).toHaveLength(1);
    expect(ofType("cron.fired")).toHaveLength(0);
    for (const l of LANGUAGES) expect(languagePages()[l.folder]).toHaveLength(1);
    const runs = dbOf(factory.root);
    expect((runs.prepare("SELECT COUNT(*) AS n FROM cron_runs WHERE cron_id = ?").get(entry.id) as { n: number }).n).toBe(1);
    runs.close();
    expect(factory.service.listCrons()[0]!.nextRunAt).toBeGreaterThan(Date.now());
  });
});

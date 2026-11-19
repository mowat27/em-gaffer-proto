/**
 * The gate host (runtime/gate-host.ts) without pi: loading gates from the file the runner writes, running them in order
 * on tool calls and results, failing closed (E9, a gate that does not load, no gates file), journaling one tool.gate
 * decision per gate per call; and gateHostFor, the runner's half (what it loads, where, with which context), feeding
 * the real shared gates through the host.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { GateHostFile } from "../../engine/gates.ts";
import { PACKAGED_CONFIG } from "../../ops/config.ts";
import gateHost, { loadGateHost, onToolCall, onToolResult, toolSpan, type GateHost, type Send } from "../../runtime/gate-host.ts";
import { CONFIG_FILES_ENV, GATE_HOST, gateHostFor, protectedConfigPaths, resolve, resolveWrites } from "../../runtime/resolve.ts";
import { AGENTICS_DIR, BUILDER_ROOT } from "../../runtime/root.ts";
import { git, tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-gate-host");
after(() => tmp.remove());
const ENGINE = join(BUILDER_ROOT, "engine", "gates.ts");
const NO_LIMIT = { limit: { enable: ["*"], disable: [] } };

/** Gate modules in a temp dir: name → body after `import { … } from engine/gates.ts`. */
function gates(dir: string, mods: Record<string, string>): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const [name, body] of Object.entries(mods)) {
    const file = name.endsWith("/") ? join(dir, name, "index.ts") : join(dir, `${name}.ts`);
    writeTree("/", { [file]: `import { allow, block, defineGate } from ${JSON.stringify(ENGINE)};\n${body}\n` });
    paths[name.replace(/\/$/, "")] = name.endsWith("/") ? join(dir, name) : file;
  }
  return paths;
}

function gatesFile(dir: string, refs: [string, string][], ctx: Partial<GateHostFile["ctx"]> = {}): string {
  const file = join(dir, "gates.json");
  const json: GateHostFile = { gates: refs.map(([ref, path]) => ({ ref, path })), ctx: { cwd: dir, base: "", writes: [], areas: {}, protectedPaths: [], dispatch: false, ...ctx } };
  writeFileSync(file, JSON.stringify(json));
  return file;
}

function recorder(): { send: Send; events: { kind: string; span?: string; data: Record<string, unknown> }[] } {
  const events: { kind: string; span?: string; data: Record<string, unknown> }[] = [];
  return { send: (e) => events.push({ kind: e.kind, span: e.span, data: e.data }), events };
}

const call = (toolName: string, input: Record<string, unknown>, id = "c1") => ({ toolName, toolCallId: id, input });

describe("gate host: loading", () => {
  const dir = join(tmp.dir, "load");
  mkdirSync(dir, { recursive: true });
  const g = gates(dir, {
    ok: 'export default defineGate({ tools: ["write"], check: () => allow() });',
    pair: 'export default [defineGate({ tools: ["write"], check: () => allow() }), defineGate({ tools: ["read"], on: "tool_result", check: () => allow() })];',
    "folder/": 'export default defineGate({ tools: "*", check: () => allow() });',
    none: "export const x = 1;",
    broken: 'throw new Error("cannot even load");',
  });

  it("each module's gate or list of gates, in file order; a folder loads its index.ts", async () => {
    const host = await loadGateHost(gatesFile(dir, [["own:ok", g.ok], ["own:pair", g.pair], ["own:folder", g.folder]]), {});
    assert.ok(!("broken" in host));
    assert.deepEqual(host.gates.map((x) => [x.ref, x.gate.on]), [["own:ok", "tool_call"], ["own:pair", "tool_call"], ["own:pair", "tool_result"], ["own:folder", "tool_call"]]);
    assert.equal(host.ctx.cwd, dir);
  });

  it("fails closed: no $BUILDER_GATES, an unreadable file, a module without a gate or one that throws block every call", async () => {
    const cases: [GateHost, RegExp][] = [
      [await loadGateHost(undefined, {}), /\$BUILDER_GATES is not set/],
      [await loadGateHost(join(dir, "missing.json"), {}), /the gates file .*missing\.json cannot be read/],
      [await loadGateHost(gatesFile(dir, [["own:ok", g.ok], ["own:none", g.none]]), {}), /gate own:none did not load: its default export is not a gate/],
      [await loadGateHost(gatesFile(dir, [["own:broken", g.broken]]), {}), /gate own:broken did not load: cannot even load/],
      [await loadGateHost(gatesFile(dir, [["own:gone", join(dir, "gone.ts")]]), {}), /gate own:gone did not load/],
    ];
    for (const [host, why] of cases) {
      assert.ok("broken" in host);
      const r = recorder();
      const out = await onToolCall(host, call("read", { path: "x" }), r.send);
      assert.equal(out?.block, true);
      assert.match(out!.reason, why);
      assert.deepEqual(r.events.map((e) => [e.kind, e.data.gate, e.data.decision, e.data.error]), [["tool.gate", "gate-host", "block", true]]);
      assert.equal(await onToolResult(host, { ...call("read", {}), content: [], isError: false }, r.send), undefined);
    }
  });
});

describe("gate host: deciding", () => {
  const dir = join(tmp.dir, "decide");
  mkdirSync(dir, { recursive: true });
  const g = gates(dir, {
    allowAll: 'export default defineGate({ tools: "*", check: () => allow() });',
    noEnv: 'export default defineGate({ tools: ["write", "edit"], check: (c) => (String(c.input.path).endsWith(".env") ? block("no .env files", String(c.input.path)) : allow()) });',
    boom: 'export default defineGate({ tools: ["write"], check: () => { throw new Error("boom"); } });',
    garbage: 'export default defineGate({ tools: ["write"], check: () => "yes" as never });',
    moveToScratch: 'export default defineGate({ tools: ["write"], check: (c) => (String(c.input.path).startsWith("tmp/") ? { rewrite: { path: ".scratch/" + String(c.input.path).slice(4), note: undefined } } : allow()) });',
    seesPath: 'export const seen: string[] = []; export default defineGate({ tools: ["write"], check: (c) => { seen.push(String(c.input.path)); return allow(); } });',
    redact: 'export default defineGate({ tools: ["bash"], on: "tool_result", check: (c) => ({ patch: { content: (c.result!.content as { text: string }[]).map((x) => ({ type: "text", text: x.text.replace(/sk-[a-z0-9]+/g, "[key]") })) } }) });',
    markError: 'export default defineGate({ tools: ["bash"], on: "tool_result", check: (c) => ((c.result!.content as { text: string }[])[0].text.includes("[key]") ? { patch: { isError: true } } : allow()) });',
    resultBoom: 'export default defineGate({ tools: "*", on: "tool_result", check: () => { throw new Error("cannot judge"); } });',
  });
  const host = async (...names: string[]) => {
    const h = await loadGateHost(gatesFile(dir, names.map((n) => [`own:${n}`, g[n]])), {});
    assert.ok(!("broken" in h), "broken" in h ? h.broken : "");
    return h;
  };

  it("runs the gates that see the tool, in order; the first block wins; one tool.gate per decision", async () => {
    const h = await host("allowAll", "noEnv", "boom");
    const r = recorder();
    const out = await onToolCall(h, call("write", { path: "config/.env", content: "A=1" }, "call_7"), r.send);
    assert.deepEqual(out, { block: true, reason: "no .env files" });
    assert.deepEqual(r.events, [
      { kind: "tool.gate", span: toolSpan("call_7"), data: { tool: "write", gate: "own:allowAll", on: "tool_call", decision: "allow", path: "config/.env" } },
      { kind: "tool.gate", span: toolSpan("call_7"), data: { tool: "write", gate: "own:noEnv", on: "tool_call", decision: "block", reason: "no .env files", path: "config/.env" } },
    ]);
    assert.equal(toolSpan("call_7"), "t-call_7");
    const read = recorder();
    assert.equal(await onToolCall(h, call("read", { path: "a.ts" }), read.send), undefined);
    assert.deepEqual(read.events.map((e) => e.data.gate), ["own:allowAll"], "only gates that see read");
  });

  it("E9: a gate that throws, or answers with no decision, blocks the call with the error as the reason", async () => {
    for (const [name, why] of [["boom", "gate own:boom failed: boom"], ["garbage", 'gate own:garbage failed: returned "yes", not a decision']]) {
      const r = recorder();
      const out = await onToolCall(await host(name), call("write", { path: "a.ts", content: "" }), r.send);
      assert.deepEqual(out, { block: true, reason: why });
      assert.deepEqual(r.events[0].data, { tool: "write", gate: `own:${name}`, on: "tool_call", decision: "block", reason: why, path: "a.ts", error: true });
    }
  });

  it("a rewrite changes the input in place, for the gates after it and for the tool", async () => {
    const h = await host("moveToScratch", "seesPath");
    const seen = ((await import(g.seesPath)) as { seen: string[] }).seen;
    const r = recorder();
    const e = call("write", { path: "tmp/a.mjs", content: "1", note: "x" });
    assert.equal(await onToolCall(h, e, r.send), undefined);
    assert.deepEqual(e.input, { path: ".scratch/a.mjs", content: "1" });
    assert.deepEqual(seen, [".scratch/a.mjs"]);
    assert.deepEqual(r.events[0].data, { tool: "write", gate: "own:moveToScratch", on: "tool_call", decision: "rewrite", path: "tmp/a.mjs", fields: ["path", "note"] });
  });

  it("tool_result: patches chain and pi gets the merged patch; no change gives nothing; a throwing gate turns the result into the error", async () => {
    const h = await host("redact", "markError");
    const r = recorder();
    const result = { ...call("bash", { command: "env" }), content: [{ type: "text", text: "KEY=sk-abc123" }], isError: false };
    assert.deepEqual(await onToolResult(h, result, r.send), { content: [{ type: "text", text: "KEY=[key]" }], isError: true });
    assert.deepEqual(r.events.map((e) => [e.data.gate, e.data.on, e.data.decision, e.data.fields]), [["own:redact", "tool_result", "patch", ["content"]], ["own:markError", "tool_result", "patch", ["isError"]]]);
    assert.equal(await onToolResult(await host("markError"), { ...result, content: [{ type: "text", text: "clean" }] }, r.send), undefined);
    assert.equal(await onToolCall(h, call("bash", { command: "env" }), r.send), undefined, "tool_result gates do not run on tool_call");
    const failed = await onToolResult(await host("resultBoom"), result, r.send);
    assert.deepEqual(failed, { content: [{ type: "text", text: "gate own:resultBoom failed: cannot judge" }], isError: true });
  });

  it("as a pi extension: reads $BUILDER_GATES and registers tool_call and tool_result handlers", async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const before = process.env.BUILDER_GATES;
    process.env.BUILDER_GATES = gatesFile(dir, [["own:noEnv", g.noEnv]]);
    try {
      await gateHost({ on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, h) } as never);
    } finally {
      if (before === undefined) delete process.env.BUILDER_GATES;
      else process.env.BUILDER_GATES = before;
    }
    assert.deepEqual([...handlers.keys()].sort(), ["tool_call", "tool_result"]);
    assert.deepEqual(await handlers.get("tool_call")!({ type: "tool_call", ...call("edit", { path: ".env" }) }, {}), { block: true, reason: "no .env files" });
    assert.equal(await handlers.get("tool_call")!({ type: "tool_call", ...call("edit", { path: "a.ts" }) }, {}), undefined);
  });
});

describe("gateHostFor: how the runner loads the gates", () => {
  const SHARED_GATES = join(AGENTICS_DIR, "shared", "gates");

  it("supabase-api on a dispatch: the host last, $BUILDER_GATES in the run's folder, the four gates in order, the slice rules on", () => {
    const r = resolve({ agent: "supabase-api", workspace: { dir: { path: "/w/app" } }, input: { dispatch: "data:dispatches/createclient-new.json", base: "abc123" } }, { config: NO_LIMIT, runDir: "/runs/r1" });
    const h = gateHostFor(r, {})!;
    assert.deepEqual(h.args, ["-e", GATE_HOST]);
    assert.equal(GATE_HOST, join(BUILDER_ROOT, "runtime", "gate-host.ts"));
    assert.deepEqual(h.env, { BUILDER_GATES: "/runs/r1/gates.json" });
    assert.equal(h.file.path, "/runs/r1/gates.json");
    assert.deepEqual(h.file.json.gates, ["blocked-paths", "write-scope", "append-only-migrations", "learnings-file"].map((n) => ({ ref: `shared:${n}`, path: join(SHARED_GATES, `${n}.ts`) })));
    assert.deepEqual(h.file.json.ctx, {
      cwd: "/w/app",
      base: "abc123",
      writes: ["src/**", "supabase/migrations/**", "supabase/functions/**", "supabase/config.toml", "LEARNINGS.md", ".scratch/**"],
      areas: {},
      protectedPaths: [PACKAGED_CONFIG, join(homedir(), ".gaffer")],
      dispatch: true,
    });
    assert.equal(r.resources.filter((x) => x.kind === "extension").some((x) => x.path.includes("write-guards")), false, "write-guards is gone");
  });

  it("no dispatch: the slice rules are off and the base comes from $BUILDER_BASE at start", () => {
    const h = gateHostFor(resolve({ agent: "supabase-api", mode: "interactive" }, { config: NO_LIMIT, runDir: "/runs/r2" }), {})!;
    assert.equal(h.file.json.ctx.dispatch, false);
    assert.equal(h.file.json.ctx.base, "");
  });

  it("the verifier: write-scope with writes own:checks.ts made absolute", () => {
    const h = gateHostFor(resolve({ agent: "verifier" }, { config: NO_LIMIT, runDir: "/runs/v" }), {})!;
    assert.deepEqual(h.file.json.gates, [{ ref: "shared:write-scope", path: join(SHARED_GATES, "write-scope.ts") }]);
    assert.deepEqual(h.file.json.ctx.writes, [join(AGENTICS_DIR, "agents", "verifier", "checks.ts")]);
  });

  it("nothing to load: a workflow run, or an agent without gates", () => {
    const root = writeTree(join(tmp.dir, "tree"), { "agents/plain/agent.yml": "description: plain\nmode: interactive\n" });
    assert.equal(gateHostFor(resolve({ agent: "plain" }, { config: NO_LIMIT, agentics: root, runDir: "/runs/p" }), {}), null);
    assert.equal(gateHostFor(resolve({ workflow: "supabase-api" }, { config: NO_LIMIT, runDir: "/runs/w" }), {}), null);
  });

  it("protected config: packaged, ~/.gaffer, $GAFFER_CONFIG and the --config files the CLI passes down", () => {
    const env = { GAFFER_CONFIG: "~/cfg/layer.yml", [CONFIG_FILES_ENV]: JSON.stringify(["/etc/builder/extra.yml", "~/b.yml"]) };
    assert.deepEqual(protectedConfigPaths(env), [PACKAGED_CONFIG, join(homedir(), ".gaffer"), join(homedir(), "cfg", "layer.yml"), "/etc/builder/extra.yml", join(homedir(), "b.yml")]);
    assert.deepEqual(protectedConfigPaths({ [CONFIG_FILES_ENV]: "not json" }), [PACKAGED_CONFIG, join(homedir(), ".gaffer")]);
  });

  it("writes: relative globs stay relative to the workspace, own: and ~ become absolute, other prefixes are refused", () => {
    assert.deepEqual(resolveWrites(["src/**", "own:checks.ts", "~/notes/*.md", "/abs/x"], "/agents/v"), ["src/**", "/agents/v/checks.ts", join(homedir(), "notes", "*.md"), "/abs/x"]);
    assert.throws(() => resolveWrites(["shared:x"], "/agents/v"), /\/agents\/v\/agent\.yml: writes shared:x: a writes entry is a glob/);
  });

  it("end to end without pi: the runner's file through the host and the real gates blocks today's paths, journaled per gate", async () => {
    const app = writeTree(join(tmp.dir, "app"), { "package.json": "{}\n", "src/index.ts": "export {};\n", "supabase/migrations/V1__init.sql": "select 1;\n" });
    git(app, ["init", "-q", "-b", "main"]);
    git(app, ["add", "-A"]);
    git(app, ["commit", "-q", "-m", "base"]);
    const base = git(app, ["rev-parse", "HEAD"]);
    const runDir = join(tmp.dir, "runs", "r9");
    mkdirSync(runDir, { recursive: true });
    const h = gateHostFor(resolve({ agent: "supabase-api", workspace: { dir: { path: app } }, input: { dispatch: "data:dispatches/createclient-new.json", base } }, { config: NO_LIMIT, runDir }), {})!;
    writeFileSync(h.file.path, JSON.stringify(h.file.json));
    const host = await loadGateHost(h.env.BUILDER_GATES, {});
    assert.ok(!("broken" in host), "broken" in host ? host.broken : "");

    const r = recorder();
    const pkg = await onToolCall(host, call("write", { path: "package.json", content: "{}" }), r.send);
    assert.match(pkg?.reason ?? "", /^package\.json: dependency\/package manifest changes are not allowed from a slice commit\. Do not change it with write\./);
    assert.deepEqual(r.events.map((e) => [e.data.gate, e.data.decision]), [["shared:blocked-paths", "block"]]);

    const mig = recorder();
    assert.match((await onToolCall(host, call("edit", { path: "supabase/migrations/V1__init.sql" }), mig.send))?.reason ?? "", /append-only/);
    assert.deepEqual(mig.events.map((e) => [e.data.gate, e.data.decision]), [["shared:blocked-paths", "allow"], ["shared:write-scope", "allow"], ["shared:append-only-migrations", "block"]]);

    const ok = recorder();
    assert.equal(await onToolCall(host, call("write", { path: "src/slices/clients/CreateClient/CreateClientCommand.ts", content: "" }), ok.send), undefined);
    assert.deepEqual(ok.events.map((e) => e.data.decision), ["allow", "allow", "allow", "allow"]);

    assert.match((await onToolCall(host, call("write", { path: join(tmp.dir, "elsewhere.ts"), content: "" }), r.send))?.reason ?? "", /is outside what this agent may write/, "E24");
    assert.match((await onToolCall(host, call("write", { path: PACKAGED_CONFIG, content: "" }), r.send))?.reason ?? "", /is machine config/);
  });
});

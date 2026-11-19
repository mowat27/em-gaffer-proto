/**
 * The shared gates (agentics/shared/gates) and the gate toolkit they use (engine/gates.ts), without pi: what each gate
 * decides for write, edit and bash calls in a fixture git workspace. The slice rules keep the reasons and paths of the
 * write guards they replace (P2's write-guards.ts, learn.ts's guard), on only in runs with a dispatch; writes, writable
 * areas and protected config apply always.
 */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import appendOnlyMigrations from "../../agentics/shared/gates/append-only-migrations.ts";
import blockedPaths from "../../agentics/shared/gates/blocked-paths.ts";
import { HEADER, learningsFileGates } from "../../agentics/shared/gates/learnings-file.ts";
import writeScope from "../../agentics/shared/gates/write-scope.ts";
import { allow, block, decisionOf, defineGate, gateContext, gateSees, globRegExp, redirectTargets, relIn, resolvePath, shellWriteWords, type Decision, type Gate, type GateContextData } from "../../engine/gates.ts";
import { git, tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-gates");
after(() => tmp.remove());

/** A workspace like a clone at base: the package files, server.ts, a migration and one slice already in the app. */
function workspace(name: string): { cwd: string; base: string } {
  const cwd = writeTree(join(tmp.dir, name), {
    "package.json": "{}\n",
    "package-lock.json": "{}\n",
    "server.ts": "export {};\n",
    "README.md": "# app\n",
    "src/index.ts": "export {};\n",
    "src/slices/shop/ListOrders/routes.ts": "export {};\n",
    "supabase/migrations/V1__init.sql": "create table t (id int);\n",
  });
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "base"]);
  return { cwd, base: git(cwd, ["rev-parse", "HEAD"]) };
}

const SUPABASE_WRITES = ["src/**", "supabase/migrations/**", "supabase/functions/**", "supabase/config.toml", "LEARNINGS.md", ".scratch/**"];
const protectedDir = join(tmp.dir, "home", ".gaffer");
const packaged = join(tmp.dir, "builder", "ops", "config.yml");

function ctxOf(cwd: string, o: Partial<GateContextData> = {}) {
  return gateContext({ cwd, base: "", writes: SUPABASE_WRITES, areas: {}, protectedPaths: [packaged, protectedDir], dispatch: true, ...o }, {});
}

const write = (path: string, content = "x") => ({ tool: "write", input: { path, content } });
const edit = (path: string) => ({ tool: "edit", input: { path, edits: [{ oldText: "a", newText: "b" }] } });
const bash = (command: string) => ({ tool: "bash", input: { command } });

async function decide(g: Gate, call: { tool: string; input: Record<string, unknown> }, ctx: ReturnType<typeof ctxOf>): Promise<Decision> {
  return decisionOf(await g.check(call, ctx), g.on);
}
const reasonOf = (d: Decision) => ("block" in d ? d.reason : null);
const SLICE_TAIL = "Every file left in the clone goes into the patch, and done refuses a job that breaks this rule. Keep slice work inside src/slices/{context}/{slice}/ and the documented exceptions.";

describe("engine/gates: the toolkit", () => {
  it("defineGate checks its spec and defaults on to tool_call; allow, block, decisionOf, gateSees", () => {
    const g = defineGate({ tools: ["write"], check: () => allow() });
    assert.equal(g.on, "tool_call");
    assert.throws(() => defineGate({ tools: [], check: () => allow() }), /names its tools/);
    assert.throws(() => defineGate({ tools: "*", on: "tool_end" as never, check: () => allow() }), /tool_call or tool_result/);
    assert.throws(() => defineGate({ tools: "*" } as never), /check function/);
    assert.deepEqual(block("no", "a.ts"), { block: true, reason: "no", path: "a.ts" });
    assert.throws(() => decisionOf({ block: true, reason: " " }, "tool_call"), /without a reason/);
    assert.throws(() => decisionOf({ patch: {} }, "tool_call"), /only a tool_result gate patches/);
    assert.throws(() => decisionOf({ rewrite: {} }, "tool_result"), /only a tool_call gate rewrites/);
    assert.throws(() => decisionOf(undefined, "tool_call"), /not a decision/);
    assert.equal(gateSees(g, "write"), true);
    assert.equal(gateSees(g, "edit"), false);
    assert.equal(gateSees(defineGate({ tools: "*", check: () => allow() }), "anything"), true);
  });

  it("globs: * and ? stay in a segment, ** crosses segments, dir/** covers the dir itself", () => {
    const m = (glob: string, p: string) => globRegExp(glob).test(p);
    assert.ok(m("src/**", "src/a/b.ts") && m("src/**", "src") && !m("src/**", "srcx/a.ts"));
    assert.ok(m("*.md", "README.md") && !m("*.md", "docs/README.md"));
    assert.ok(m("**/*.md", "README.md") && m("**/*.md", "docs/a/README.md"));
    assert.ok(m("supabase/functions/*/index.ts", "supabase/functions/hook/index.ts") && !m("supabase/functions/*/index.ts", "supabase/functions/a/b/index.ts"));
    assert.ok(m("V?.sql", "V1.sql") && !m("V?.sql", "V10.sql"));
    assert.ok(m("LEARNINGS.md", "LEARNINGS.md") && !m("LEARNINGS.md", "LEARNINGSxmd"), "dots are literal");
  });

  it("paths as pi resolves them (@ dropped, ~ expanded); relIn is null outside the workspace", () => {
    assert.equal(resolvePath("/w", "@src/a.ts"), "/w/src/a.ts");
    assert.equal(resolvePath("/w", "~/x"), join(homedir(), "x"));
    assert.equal(relIn("/w", "/w/src/a.ts"), "src/a.ts");
    assert.equal(relIn("/w", "/w"), null);
    assert.equal(relIn("/w", "/other/a.ts"), null);
  });

  it("shell-write heuristics: only commands that write; options left out; redirect targets", () => {
    assert.equal(shellWriteWords("cat package.json"), null);
    assert.equal(shellWriteWords("sed 's/a/b/' server.ts"), null, "sed without -i does not write");
    assert.deepEqual(shellWriteWords("sed -i 's/a/b/' server.ts"), ["sed", "s/a/b/", "server.ts"]);
    assert.deepEqual(shellWriteWords("echo '{}' > package.json"), ["echo", "{}", "package.json"]);
    assert.deepEqual(shellWriteWords("rm -rf build && mv a.ts b.ts"), ["rm", "build", "mv", "a.ts", "b.ts"]);
    assert.deepEqual(redirectTargets("node x.mjs > out.txt 2>&1; echo y >> log/a.txt 2> err.txt"), ["out.txt", "log/a.txt", "err.txt"]);
  });

  it("the context: mayWrite is writes + writable areas − protected (also through a symlink); existsAtBase; changedFiles", () => {
    const { cwd, base } = workspace("ctx");
    const work = join(tmp.dir, "areas", "work");
    const apps = join(tmp.dir, "areas", "apps");
    mkdirSync(work, { recursive: true });
    mkdirSync(protectedDir, { recursive: true });
    symlinkSync(protectedDir, join(cwd, "src", "cfg"));
    const ctx = ctxOf(cwd, { base, areas: { work: { path: work, write: true }, apps: { path: apps, write: false } } });
    assert.equal(ctx.mayWrite("src/slices/a/B/x.ts"), true);
    assert.equal(ctx.mayWrite(join(cwd, "LEARNINGS.md")), true);
    assert.equal(ctx.mayWrite("README.md"), false);
    assert.equal(ctx.mayWrite("../elsewhere.ts"), false);
    assert.equal(ctx.mayWrite(join(work, "deep", "x.json")), true, "a writable area");
    assert.equal(ctx.mayWrite(join(apps, "x.json")), false, "a read-only area");
    assert.equal(ctx.isProtected(join(protectedDir, "config.yml")), true);
    assert.equal(ctx.isProtected("src/cfg/config.yml"), true, "a symlink into ~/.gaffer is still ~/.gaffer");
    assert.equal(ctx.mayWrite("src/cfg/config.yml"), false, "protected wins over writes");
    assert.equal(ctx.existsAtBase("supabase/migrations/V1__init.sql"), true);
    assert.equal(ctx.existsAtBase("supabase/migrations/V2__new.sql"), false);
    writeFileSync(join(cwd, "README.md"), "# changed\n");
    writeFileSync(join(cwd, "new.ts"), "export {};\n");
    assert.deepEqual(ctx.changedFiles().sort(), ["README.md", "new.ts", "src/cfg"]);
    assert.equal(gateContext({ cwd, base: "", writes: [], areas: {}, protectedPaths: [], dispatch: false }, { BUILDER_BASE: base }).base, base, "no base in the file: $BUILDER_BASE");
    assert.equal(gateContext({ cwd, base: "", writes: [], areas: {}, protectedPaths: [], dispatch: false }, {}).base, "HEAD");
    assert.throws(() => gateContext({ cwd: tmp.dir, base: "", writes: [], areas: {}, protectedPaths: [], dispatch: false }, {}).changedFiles(), "not a git work tree");
  });
});

describe("blocked-paths", () => {
  const { cwd } = workspace("blocked");
  const ctx = ctxOf(cwd);
  it("write and edit of the package files or server.ts: today's reasons and message", async () => {
    assert.equal(
      reasonOf(await decide(blockedPaths, write("package.json"), ctx)),
      `package.json: dependency/package manifest changes are not allowed from a slice commit. Do not change it with write. ${SLICE_TAIL}`,
    );
    assert.equal(
      reasonOf(await decide(blockedPaths, edit("./server.ts"), ctx)),
      `server.ts: server.ts is shared infra (routes/processors are auto-discovered) — never touched by slice work. Do not change it with edit. ${SLICE_TAIL}`,
    );
    for (const p of ["pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json", "package-lock.json"]) assert.equal((await decide(blockedPaths, write(p), ctx) as { path?: string }).path, p);
    assert.deepEqual(await decide(blockedPaths, write("src/slices/shop/PlaceOrder/x.ts"), ctx), { allow: true });
    assert.deepEqual(await decide(blockedPaths, write("sub/package.json"), ctx), { allow: true }, "only the app's own package.json");
  });
  it("bash commands that write and name one; reads pass", async () => {
    assert.match(reasonOf(await decide(blockedPaths, bash("echo '{}' > package.json"), ctx)) ?? "", /^package\.json: dependency.* Do not change it with bash\./);
    assert.match(reasonOf(await decide(blockedPaths, bash("sed -i 's/a/b/' server.ts"), ctx)) ?? "", /^server\.ts: /);
    assert.deepEqual(await decide(blockedPaths, bash("cat package.json"), ctx), { allow: true });
    assert.deepEqual(await decide(blockedPaths, bash("sed 's/a/b/' server.ts"), ctx), { allow: true });
  });
  it("off without a dispatch", async () => {
    assert.deepEqual(await decide(blockedPaths, write("package.json"), ctxOf(cwd, { dispatch: false })), { allow: true });
  });
});

describe("append-only-migrations", () => {
  const { cwd, base } = workspace("migrations");
  const ctx = ctxOf(cwd, { base });
  it("an existing migration is never changed; a new one is fine", async () => {
    assert.equal(
      reasonOf(await decide(appendOnlyMigrations, edit("supabase/migrations/V1__init.sql"), ctx)),
      `supabase/migrations/V1__init.sql: existing migrations are append-only; add a new V{n} file instead of editing this one. Do not change it with edit. ${SLICE_TAIL}`,
    );
    assert.deepEqual(await decide(appendOnlyMigrations, write("supabase/migrations/V2__orders.sql"), ctx), { allow: true });
    assert.match(reasonOf(await decide(appendOnlyMigrations, bash("rm supabase/migrations/V1__init.sql"), ctx)) ?? "", /append-only.*with bash/);
    assert.deepEqual(await decide(appendOnlyMigrations, bash("cp x.sql supabase/migrations/V2__orders.sql"), ctx), { allow: true });
    assert.deepEqual(await decide(appendOnlyMigrations, edit("supabase/migrations/V1__init.sql"), ctxOf(cwd, { base, dispatch: false })), { allow: true }, "off without a dispatch");
  });
});

describe("write-scope", () => {
  it("slice scope (with a dispatch): the first slice changed sets the scope; outside slices only the exceptions", async () => {
    const { cwd, base } = workspace("scope");
    const ctx = ctxOf(cwd, { base });
    assert.deepEqual(await decide(writeScope, write("src/slices/shop/PlaceOrder/PlaceOrderCommand.ts"), ctx), { allow: true }, "nothing changed yet: any slice");
    mkdirSync(join(cwd, "src/slices/shop/PlaceOrder"), { recursive: true });
    writeFileSync(join(cwd, "src/slices/shop/PlaceOrder/PlaceOrderCommand.ts"), "export {};\n");
    assert.equal(
      reasonOf(await decide(writeScope, write("src/slices/billing/Pay/PayCommand.ts"), ctx)),
      `src/slices/billing/Pay/PayCommand.ts: touches slice "billing/Pay" but this commit's scope is "shop/PlaceOrder" — split into separate commits. Do not change it with write. ${SLICE_TAIL}`,
    );
    assert.equal(
      reasonOf(await decide(writeScope, edit("src/index.ts"), ctx)),
      `src/index.ts: outside src/slices/{context}/{slice}/ and not a documented exception. Do not change it with edit. ${SLICE_TAIL}`,
    );
    for (const ok of ["src/slices/shop/ShopEvents.ts", "src/common/loadPostgresEventstore.ts", "supabase/config.toml", "supabase/functions/hook/index.ts", "supabase/migrations/V2__x.sql", "LEARNINGS.md", ".scratch/try.mjs"]) {
      assert.deepEqual(await decide(writeScope, write(ok), ctx), { allow: true }, ok);
    }
  });

  it("writes and writable areas apply with or without a dispatch, on paths in and outside the workspace", async () => {
    const { cwd } = workspace("writes");
    for (const dispatch of [true, false]) {
      const ctx = ctxOf(cwd, { dispatch });
      const d = await decide(writeScope, write("README.md"), ctx);
      assert.equal("block" in d && d.path, "README.md");
      assert.match(reasonOf(d) ?? "", dispatch ? /^README\.md: outside src\/slices/ : /^README\.md is outside what this agent may write \(writes: src\/\*\*, supabase\/migrations\/\*\*, .*\.scratch\/\*\*; writable areas: none\)\. Do not change it with write\.$/);
      assert.match(reasonOf(await decide(writeScope, write(join(tmp.dir, "outside.ts")), ctx)) ?? "", /outside\.ts is outside what this agent may write/);
    }
    const area = join(tmp.dir, "lab-work");
    const ctx = ctxOf(cwd, { dispatch: false, writes: [], areas: { work: { path: area, write: true } } });
    assert.deepEqual(await decide(writeScope, write(join(area, "notes.md")), ctx), { allow: true });
    assert.match(reasonOf(await decide(writeScope, write("src/index.ts"), ctx)) ?? "", /writes: none; writable areas: work \(.*lab-work\)/);
  });

  it("the verifier: writes [own:checks.ts] reaches only its checks.ts, from any working directory", async () => {
    const { cwd } = workspace("verifier-cwd");
    const checks = join(tmp.dir, "verifier", "checks.ts");
    const ctx = ctxOf(cwd, { dispatch: false, writes: [checks] });
    assert.deepEqual(await decide(writeScope, edit(checks), ctx), { allow: true });
    assert.match(reasonOf(await decide(writeScope, edit("src/index.ts"), ctx)) ?? "", /^src\/index\.ts is outside what this agent may write \(writes: .*verifier\/checks\.ts;/);
  });

  it("protected config is blocked always, even where writes or an area would allow it", async () => {
    const { cwd } = workspace("protected");
    const ctx = ctxOf(cwd, { dispatch: false, writes: ["**"], areas: { home: { path: join(tmp.dir, "home"), write: true } }, protectedPaths: [packaged, protectedDir, join(cwd, "local.yml")] });
    const reason = (p: string) => `${p} is machine config: only the operator changes it (the packaged builder/ops/config.yml, ~/.gaffer/, $GAFFER_CONFIG and --config files). Do not change it with write.`;
    assert.equal(reasonOf(await decide(writeScope, write(join(protectedDir, "config.yml")), ctx)), reason(join(protectedDir, "config.yml")));
    assert.equal(reasonOf(await decide(writeScope, write(packaged), ctx)), reason(packaged));
    assert.equal(reasonOf(await decide(writeScope, write("local.yml"), ctx)), reason("local.yml"), "a --config file in the workspace");
    assert.deepEqual(await decide(writeScope, write(join(tmp.dir, "home", "notes.md")), ctx), { allow: true }, "the area, outside .gaffer");
    assert.match(reasonOf(await decide(writeScope, bash(`echo x > ${join(protectedDir, "config.yml")}`), ctx)) ?? "", /is machine config: .* with bash\.$/);
  });

  it("bash: the paths a writing command names (existing, folder exists, or a redirect target) against writes", async () => {
    const { cwd } = workspace("bash");
    const ctx = ctxOf(cwd, { dispatch: false });
    mkdirSync(join(cwd, ".scratch"));
    assert.deepEqual(await decide(writeScope, bash("echo hi > .scratch/notes.txt"), ctx), { allow: true });
    assert.deepEqual(await decide(writeScope, bash("sed -i 's/a/b/' src/index.ts"), ctx), { allow: true }, "the sed script is not a path");
    assert.deepEqual(await decide(writeScope, bash("npx tsc --noEmit > .scratch/tsc.log 2>&1"), ctx), { allow: true });
    assert.deepEqual(await decide(writeScope, bash("ls src"), ctx), { allow: true }, "does not write");
    assert.deepEqual(await decide(writeScope, bash("./src/index.ts > .scratch/out.txt; ../bin/tool >> .scratch/out.txt"), ctx), { allow: true }, "the program a command runs is not written");
    assert.equal((await decide(writeScope, bash("echo x > README.md"), ctx) as { path?: string }).path, "README.md", "unless it is the redirect target");
    const redirected = await decide(writeScope, bash("echo hi > notes.txt"), ctx);
    assert.equal("block" in redirected && redirected.path, "notes.txt");
    assert.match(reasonOf(redirected) ?? "", /^notes\.txt is outside what this agent may write .* with bash\.$/);
    assert.equal((await decide(writeScope, bash("rm README.md"), ctx) as { path?: string }).path, "README.md");
    assert.equal((await decide(writeScope, bash(`cp src/index.ts ${join(tmp.dir, "copy.ts")}`), ctx) as { path?: string }).path, join(tmp.dir, "copy.ts"));
  });
});

describe("learnings-file", () => {
  it("write and edit of a file that starts with HEADER, or a write that adds HEADER, are refused and remembered", async () => {
    const [onCall] = learningsFileGates();
    const { cwd } = workspace("learn-1");
    writeFileSync(join(cwd, "LEARNINGS.md"), `${HEADER}\n\n## General\n- a\n`);
    const ctx = ctxOf(cwd, { dispatch: false });
    assert.equal(
      reasonOf(await decide(onCall, edit("LEARNINGS.md"), ctx)),
      'LEARNINGS.md is a learnings file generated by capture-learning. Do not modify it with edit. Record each learning with capture-learning (text, topic, file: "LEARNINGS.md") instead.',
    );
    assert.match(reasonOf(await decide(onCall, write("@LEARNINGS.md"), ctx)) ?? "", /Do not modify it with write\./);
    assert.match(reasonOf(await decide(onCall, write("notes/NEW.md", `${HEADER}\n- b\n`), ctx)) ?? "", /^notes\/NEW\.md is a learnings file/);
    assert.match(reasonOf(await decide(onCall, edit("notes/NEW.md"), ctx)) ?? "", /^notes\/NEW\.md is a learnings file/, "remembered for the session");
    assert.deepEqual(await decide(onCall, write("README.md", "# hi"), ctx), { allow: true });
    assert.deepEqual(await decide(onCall, edit("README.md"), ctx), { allow: true });
  });

  it("bash: commands that write and name a learnings file; reads pass", async () => {
    const [onCall] = learningsFileGates();
    const { cwd } = workspace("learn-2");
    writeFileSync(join(cwd, "LEARNINGS.md"), `${HEADER}\n`);
    const ctx = ctxOf(cwd, { dispatch: false });
    assert.match(reasonOf(await decide(onCall, bash("echo '- x' >> LEARNINGS.md"), ctx)) ?? "", /^LEARNINGS\.md is a learnings file .* with bash\./);
    assert.deepEqual(await decide(onCall, bash("cat LEARNINGS.md"), ctx), { allow: true });
    assert.match(reasonOf(await decide(onCall, bash(`truncate -s 0 ${join(cwd, "LEARNINGS.md")}`), ctx)) ?? "", /LEARNINGS\.md is a learnings file/, "seen this session: matched anywhere in the command");
  });

  it("a file a successful capture-learning wrote is a learnings file from then on; a failed call changes nothing", async () => {
    const [onCall, onResult] = learningsFileGates();
    assert.equal(onResult.on, "tool_result");
    const { cwd } = workspace("learn-3");
    const ctx = ctxOf(cwd, { dispatch: false });
    const result = (isError: boolean) => ({ tool: "capture-learning", input: { text: "t", file: "NOTES.md" }, result: { content: [], isError } });
    assert.deepEqual(decisionOf(await onResult.check(result(true), ctx), "tool_result"), { allow: true });
    assert.deepEqual(await decide(onCall, edit("NOTES.md"), ctx), { allow: true });
    assert.deepEqual(decisionOf(await onResult.check(result(false), ctx), "tool_result"), { allow: true });
    assert.match(reasonOf(await decide(onCall, edit("NOTES.md"), ctx)) ?? "", /^NOTES\.md is a learnings file/);
  });
});

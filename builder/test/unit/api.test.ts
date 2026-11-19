/**
 * The api adapter (runtime/api.ts): a run whose agent.yml has `api:` serves POST /messages, GET /events (SSE: the machine
 * feed, its journal and pi's rpc lines), POST /tools/<name> (its own tools through callTool, caller api) and GET
 * /instance, behind a bearer token from an env: reference. A run that cannot serve its API fails before pi starts. pi
 * is a stub: in rpc mode it answers every command and echoes prompts; headless, it waits to be stopped.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { apiSettings } from "../../runtime/api.ts";
import { readJournal } from "../../runtime/journal.ts";
import { checkAgentYml, resolve } from "../../runtime/resolve.ts";
import { createRuntime } from "../../runtime/run.ts";
import { isFinal } from "../../runtime/types.ts";
import { freePort, tempDir, waitFor } from "../harness/util.ts";
import { fakePi, writeTree } from "./tree.ts";

const tmp = tempDir("builder-api");
after(() => tmp.remove());
const TOKEN = "api-test-token-5f2c";
// The run processes inherit this environment: the token, and a HOME with no machine-wide config.
process.env.BUILDER_TEST_API_TOKEN = TOKEN;
process.env.HOME = join(tmp.dir, "home");
delete process.env.BUILDER_TEST_API_UNSET;
delete process.env.GAFFER_CONFIG;
delete process.env.GAFFER_INSTANCE;

const pi = fakePi(
  tmp.dir,
  "api-pi",
  `import { appendFileSync } from "node:fs";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.on("SIGTERM", () => process.exit(0));
if (!process.argv.includes("rpc")) setInterval(() => {}, 1000);
else {
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      appendFileSync(process.env.BUILDER_RUN_DIR + "/commands.jsonl", line + "\\n");
      const c = JSON.parse(line);
      if (c.message === "refuse") { out({ id: c.id, type: "response", command: c.type, success: false, error: "not now" }); continue; }
      out({ id: c.id, type: "response", command: c.type, success: true, data: { disposition: "started" } });
      if (c.type === "prompt") out({ type: "echo", message: c.message });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
`,
);

const runsDir = join(tmp.dir, "runs");
const layer = join(tmp.dir, "machine.yml");
writeTree(tmp.dir, { "machine.yml": `builder:\n  server: { runsDir: ${JSON.stringify(runsDir)} }\n  limit: { tools: { enable: ['*'] } }\n` });
const api = (listen: string, token = "env:BUILDER_TEST_API_TOKEN") => `api: { listen: "${listen}", token: ${token} }\n`;
let agentics = "";
const rt = () => createRuntime({ runsDir, piCommand: pi, agenticsDir: agentics, configFiles: [layer] });

async function call(base: string, method: string, path: string, o: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }),
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...o.headers,
    },
    ...(o.body !== undefined ? { body: typeof o.body === "string" ? o.body : JSON.stringify(o.body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

interface Sse {
  events: { id: string; event: string; data: any }[];
  close(): void;
  next(what: string, match: (e: { id: string; event: string; data: any }) => boolean): Promise<{ id: string; event: string; data: any }>;
}

/** A GET /events client that collects every event. */
async function sse(base: string, query = "", headers: Record<string, string> = {}): Promise<Sse> {
  const ac = new AbortController();
  const res = await fetch(`${base}/events${query}`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
  const events: Sse["events"] = [];
  void (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let end = buf.indexOf("\n\n"); end >= 0; end = buf.indexOf("\n\n")) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const f: Record<string, string> = {};
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            const i = line.indexOf(": ");
            if (i > 0) f[line.slice(0, i)] = line.slice(i + 2);
          }
          if (f.event) events.push({ id: f.id ?? "", event: f.event, data: JSON.parse(f.data ?? "null") });
        }
      }
    } catch {
      /* closed */
    }
  })();
  return {
    events,
    close: () => ac.abort(),
    next: (what, match) => waitFor(what, () => events.find(match), 15_000, 50),
  };
}

describe("api: settings", () => {
  it("listen is [host:]port (host 127.0.0.1 by default, [v6] allowed); the token is an env: reference, never a value", () => {
    assert.deepEqual(apiSettings({ listen: "127.0.0.1:8090", token: "env:OPS_API_TOKEN" }), { host: "127.0.0.1", port: 8090, token: "env:OPS_API_TOKEN" });
    assert.deepEqual(apiSettings({ listen: 8090, token: "env:T" }), { host: "127.0.0.1", port: 8090, token: "env:T" });
    assert.deepEqual(apiSettings({ listen: ":0", token: "env:T" }), { host: "127.0.0.1", port: 0, token: "env:T" });
    assert.deepEqual(apiSettings({ listen: "[::1]:9000", token: "env:T" }), { host: "::1", port: 9000, token: "env:T" });
    assert.deepEqual(apiSettings({ listen: "0.0.0.0:9000", token: "env:T" }).host, "0.0.0.0");
    assert.throws(() => apiSettings({ listen: "127.0.0.1:8090", token: "s3cret" }), /api\.token must be an env: reference/);
    assert.throws(() => apiSettings({ listen: "127.0.0.1:8090" }), /api\.token/);
    assert.throws(() => apiSettings({ listen: "127.0.0.1:99999", token: "env:T" }), /api\.listen must be \[host:\]port/);
    assert.throws(() => apiSettings({ listen: "http://x:1", token: "env:T" }), /api\.listen/);
    assert.throws(() => apiSettings({ listen: "1", token: "env:T", cors: true }), /unknown key api\.cors/);
    assert.throws(() => apiSettings("8090"), /api must be a map/);
  });

  it("agent.yml is checked when read (naming the file) and its api reaches the resolved run (config_resolve)", () => {
    assert.throws(() => checkAgentYml({ description: "x", api: { listen: "1", token: "plain" } }, "/a/agent.yml", { requireDescription: true }), /^Error: \/a\/agent\.yml: api\.token must be an env: reference/);
    const root = writeTree(join(tmp.dir, "resolve-tree"), { "agents/desk/agent.yml": `description: desk\nmode: rpc\n${api("127.0.0.1:8095")}` });
    const r = resolve({ agent: "desk", workspace: "none" }, { config: { limit: { enable: ["*"], disable: [] } }, agentics: root });
    assert.deepEqual(r.api, { host: "127.0.0.1", port: 8095, token: "env:BUILDER_TEST_API_TOKEN" });
  });
});

describe("api: a run that serves it", () => {
  let desk = "";
  let base = "";
  before(async () => {
    agentics = writeTree(join(tmp.dir, "agentics"), {
      "agents/desk/agent.yml": `description: a desk behind the API\nmode: rpc\ntools: { enable: [runs, observe, run_send] }\n${api("127.0.0.1:0")}`,
      "agents/quiet/agent.yml": `description: headless behind the API\nmode: headless\ntools: { enable: [observe] }\n${api("127.0.0.1:0")}`,
      "agents/tokenless/agent.yml": `description: its token is not set\nmode: rpc\n${api("127.0.0.1:0", "env:BUILDER_TEST_API_UNSET")}`,
    });
    const rec = await rt().start({ agent: "desk", workspace: "none", journal: true });
    desk = rec.id;
    base = await waitFor("the API's address in run.json", () => rt().get(desk)?.api, 15_000, 50);
  });
  after(async () => {
    if (desk) await rt().stop(desk, "test over");
  });

  it("listens where run.json says; every request needs the bearer token; no secret is written anywhere", async () => {
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
    const none = await call(base, "GET", "/instance", { token: null });
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("www-authenticate"), 'Bearer realm="builder"');
    assert.equal(none.json.error.code, "unauthorized");
    assert.equal((await call(base, "GET", "/instance", { token: "wrong" })).status, 401);
    assert.equal((await call(base, "GET", "/nowhere", { token: null })).status, 401, "unauthenticated callers learn nothing about the endpoints");
    const notFound = await call(base, "GET", "/nowhere");
    assert.equal(notFound.status, 404);
    assert.match(notFound.json.error.message, /POST \/messages, GET \/events, POST \/tools\/<name>, GET \/instance/);
    assert.equal((await call(base, "GET", "/messages")).status, 405);
    assert.equal((await call(base, "DELETE", "/tools/run_list")).status, 405);
    const rec = readFileSync(join(runsDir, desk, "run.json"), "utf8");
    assert.ok(!rec.includes(TOKEN) && rec.includes("env:BUILDER_TEST_API_TOKEN"));
  });

  it("GET /instance: instance_get (layers, merged config, the layer of each value) and this run", async () => {
    const r = await call(base, "GET", "/instance");
    assert.equal(r.status, 200);
    assert.ok(r.json.layers.includes(`--config ${layer}`), JSON.stringify(r.json.layers));
    assert.equal(r.json.config.server.runsDir, runsDir);
    assert.equal(r.json.sources["server.runsDir"], `--config ${layer}`);
    assert.equal(r.json.run.id, desk);
    assert.equal(r.json.run.agent, "desk");
    assert.equal(r.json.run.mode, "rpc");
    assert.equal(r.json.run.api, base);
    assert.ok(r.json.run.tools.includes("run_list") && !r.json.run.tools.includes("control_send"));
  });

  it("POST /tools/<name>: the agent's own tools through callTool; errors carry the core's code as an HTTP status", async () => {
    const list = await call(base, "POST", "/tools/run_list", { body: { limit: 50 } });
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json.runs.some((x: { id: string }) => x.id === desk));
    const self = await call(base, "POST", "/tools/run_get", { body: { run: "self" } });
    assert.equal(self.status, 200, "the caller is the serving run: self names it");
    assert.equal(self.json.id, desk);
    const empty = await call(base, "POST", "/tools/instance_get");
    assert.equal(empty.status, 200, "no body is no arguments");
    const refused = await call(base, "POST", "/tools/control_send", { body: { action: "drain" } });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error.code, "refused");
    assert.match(refused.json.error.message, new RegExp(`control_send is not allowed for the API of run ${desk}`));
    assert.equal((await call(base, "POST", "/tools/read", { body: {} })).status, 404, "pi's own tools are not core tools");
    const invalid = await call(base, "POST", "/tools/run_list", { body: { bogus: 1 } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, "invalid");
    assert.equal((await call(base, "POST", "/tools/run_list", { body: "{not json" })).status, 400);
    assert.equal((await call(base, "POST", "/tools/run_get", { body: { run: "no-such-run" } })).status, 422);
    assert.equal((await call(base, "POST", "/tools/run_send", { body: {} })).status, 400, "run_send needs a target and a message");
    const journal = readJournal(join(runsDir, desk), { kind: "api.*" });
    assert.equal(journal[0].kind, "api.start");
    assert.equal(journal[0].data.url, base);
    const calls = journal.filter((e) => e.kind === "api.tool");
    assert.ok(calls.some((e) => e.data.tool === "run_list" && e.data.ok === true));
    assert.ok(calls.some((e) => e.data.tool === "control_send" && e.data.ok === false && e.data.code === "refused"));
  });

  it("GET /events and POST /messages: the feed, the journal and pi's lines; a message is an rpc prompt that starts a turn", async () => {
    const s = await sse(base);
    const start = await s.next("this run's run.start in the feed", (e) => e.event === "feed" && e.data.kind === "run.start" && e.data.runId === desk);
    assert.match(start.id, /^\d+:\d+$/);
    await s.next("this run's journal", (e) => e.event === "journal" && e.data.kind === "run.start");
    // The agent stream attaches to the control socket on its own: send until pi's echo of a message comes through it.
    let sent: Awaited<ReturnType<typeof call>> | null = null;
    let echo: Sse["events"][number] | undefined;
    for (let i = 1; !echo && i <= 20; i++) {
      sent = await call(base, "POST", "/messages", { body: { message: `ping ${i}` } });
      assert.equal(sent.status, 202, sent.text);
      assert.equal(sent.json.disposition, "started");
      assert.match(sent.json.id, new RegExp(`^api-${i}-`));
      echo = await waitFor("pi's echo on the agent stream", () => s.events.find((e) => e.event === "agent" && e.data.type === "echo" && e.data.message === `ping ${i}`), 500, 20).catch(() => undefined);
    }
    assert.ok(echo && sent, "pi's lines reach the agent stream");
    const commands = readFileSync(join(runsDir, desk, "commands.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(commands.at(-1), { id: sent.json.id, type: "prompt", message: echo.data.message, streamingBehavior: "followUp" });
    const received = await s.next("message.received in the journal", (e) => e.event === "journal" && e.data.kind === "message.received" && e.data.data.id === sent!.json.id);
    assert.deepEqual({ via: received.data.data.via, message: received.data.data.message, disposition: received.data.data.disposition }, { via: "api", message: echo.data.message, disposition: "started" });

    const refused = await call(base, "POST", "/messages", { body: { message: "refuse" } });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error.message, /pi refused the message: not now/);
    assert.equal((await call(base, "POST", "/messages", { body: { text: "x" } })).status, 400);
    s.close();

    // Reconnecting with the last id resumes both streams after it: nothing already seen comes again.
    const lastId = s.events.at(-1)!.id;
    const again = await sse(base, "?streams=feed,journal", { "last-event-id": lastId });
    await call(base, "POST", "/tools/run_list", { body: { limit: 1 } });
    const fresh = await again.next("the new api.tool event", (e) => e.event === "journal" && e.data.kind === "api.tool");
    const [f, j] = lastId.split(":").map(Number);
    assert.ok(fresh.data.seq > j);
    assert.ok(again.events.every((e) => (e.event === "feed" ? e.data.seq > f : e.data.seq > j)), "only events after the resume point");
    again.close();
    assert.equal((await call(base, "GET", "/events?streams=bogus")).status, 400);
  });

  it("a run in another mode takes no messages; a run whose token is not set fails before pi starts", async () => {
    const quiet = await rt().start({ agent: "quiet", workspace: "none", input: { message: "wait" } });
    const url = await waitFor("the headless run's API", () => rt().get(quiet.id)?.api, 15_000, 50);
    const r = await call(url, "POST", "/messages", { body: { message: "hi" } });
    assert.equal(r.status, 409);
    assert.match(r.json.error.message, /runs headless: only rpc and durable runs take messages/);
    await rt().stop(quiet.id, "test over");
    await assert.rejects(fetch(`${url}/instance`, { headers: { authorization: `Bearer ${TOKEN}` } }), "the API ends with its run");

    const tokenless = await rt().start({ agent: "tokenless", workspace: "none" });
    const result = await rt().wait(tokenless.id);
    assert.deepEqual(result, { outcome: "failed", reason: "api: the token env:BUILDER_TEST_API_UNSET: BUILDER_TEST_API_UNSET is not set" });
  });

  it("a run whose address is taken fails, naming it", async () => {
    const port = await freePort();
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(port, "127.0.0.1", () => r()));
    try {
      writeTree(agentics, { "agents/clash/agent.yml": `description: its port is taken\nmode: rpc\n${api(`127.0.0.1:${port}`)}` });
      const rec = await rt().start({ agent: "clash", workspace: "none" });
      const result = await rt().wait(rec.id);
      assert.equal(result.outcome, "failed");
      assert.match((result as { reason: string }).reason, new RegExp(`^api: cannot listen on 127\\.0\\.0\\.1:${port}: .*EADDRINUSE`));
      assert.ok(isFinal(rt().get(rec.id)!.state));
    } finally {
      holder.close();
    }
  });
});

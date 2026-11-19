/**
 * The machine config: layered YAML, lowest first.
 *
 *   1. built-in defaults (below)          limit: observe and notify only, so a builder without its packaged file is
 *                                          locked down
 *   2. builder/ops/config.yml             packaged with builder/: no limit
 *   3. ~/.gaffer/config.yml               machine-wide, outside the repository
 *   4. $GAFFER_CONFIG                      a file merged on top
 *   5. --config <path>                     a file merged on top
 *
 * Maps merge key by key, lists replace. Every layer is checked before it is merged: an unknown key, a value of the
 * wrong type or an unknown tool name throws, naming the layer and the key (E22). The instance id ($GAFFER_INSTANCE or
 * --instance) picks `instances.<id>`, merged over `builder`. `gaffer` sections are allowed and ignored. Relative paths
 * resolve against the directory of the file that sets them. Secrets are `env:NAME` references, never values.
 *
 * The server reads it at start and again at every accept. Run processes get the parts they need as an env snapshot
 * (runtime/run.ts), so a run tree keeps the settings its root started with. `config_reload` (ops/core/operate.ts)
 * reads the layers again with the same options (`loadOptions`) and tells every live run.
 *
 * `sources` names the layer each value came from (`server.port` -> `--config /path`), for instance_get and
 * `builder config`: a list is one value, an instance's override is labelled `<layer> instances.<id>`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { BUILDER_ROOT } from "../runtime/root.ts";
import { unknownToolName, type ToolLimit } from "./groups.ts";

export interface ServerSettings {
  host: string;
  port: number;
  /** The hard cap on a job, over all of its steps. */
  jobTimeoutMinutes: number;
  /** Callback retries after the first try (backoff 1, 2, 4 ... seconds, capped at 30). */
  callbackRetries: number;
  /** How many run workspaces (clones) to keep after a job (the newest). 0 deletes each one when its job ends. */
  keepWorkspaces: number;
  /** Days everything else under the runs directory is kept (runtime/retention.ts). 0 keeps it for ever. */
  retentionDays: number;
  /** The active builder: an id (agentics/builders/<id>/builder.ts) or a path to a builder module. */
  builder: string;
  /** Where runs live (absolute). The machine feed is runs/index.jsonl, the server's control inbox control/ beside it. */
  runsDir: string;
}

/**
 * Where notify_operator sends a notification (ops/core/notify.ts), besides control/notifications.jsonl and the feed:
 *   { sink: tsf, url, token? }   POST to the TSF at url (its builder layer's notification action); token an env: ref
 *   { sink: file, path }         append one JSON line to path
 *   { sink: command, command }   run the command (sh -c) with the notification's JSON on stdin
 */
export interface NotifySink {
  sink: string;
  url?: string;
  token?: string;
  path?: string;
  command?: string;
}

export const NOTIFY_SINKS: Record<string, "url" | "path" | "command"> = { tsf: "url", file: "path", command: "command" };

/** The effective config of this builder: the merged layers with `instances.<id>` applied. */
export interface MachineConfig {
  instance: string | null;
  /** The outer limit on every run's tools. */
  limit: ToolLimit;
  /** The notify sinks (ops/core/notify.ts). */
  notify: NotifySink[];
  server: ServerSettings;
  pi: { command: string };
  /** The layers that were read, lowest first. */
  layers: string[];
  /** The layer each value came from, by dotted key (`server.port`, `limit.tools.enable`). */
  sources: Record<string, string>;
  /** How it was loaded, so a reload reads the same layers. */
  loadOptions: Omit<LoadOptions, "env">;
}

export const PACKAGED_CONFIG = join(BUILDER_ROOT, "ops", "config.yml");

export function builtInLayer(): Record<string, unknown> {
  return {
    builder: {
      limit: { tools: { enable: ["observe", "notify"], disable: [] } },
      notify: [],
      server: {
        host: "127.0.0.1",
        port: 8788,
        jobTimeoutMinutes: 20,
        callbackRetries: 8,
        keepWorkspaces: 3,
        retentionDays: 30,
        builder: "supabase-api",
        runsDir: resolve(BUILDER_ROOT, "runs"),
      },
      // The pi binary itself: the factory already runs under the vault wrapper, and the `pi` shell wrapper (av pi)
      // nested inside it swallows the agent's output.
      pi: { command: "~/.pi/agent/bin/pi" },
    },
  };
}

// ---- merging ----

export const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `over` merged onto `under`: maps merge key by key, everything else (lists included) replaces. */
export function mergeLayers<T>(under: T, over: unknown): T {
  if (over === undefined) return under;
  if (!isMap(under) || !isMap(over)) return over as T;
  const out: Record<string, unknown> = { ...under };
  for (const [k, v] of Object.entries(over)) out[k] = mergeLayers(out[k], v);
  return out as T;
}

// ---- checking one layer ----

type Shape =
  | "string"
  | "number"
  | "boolean"
  | "path"
  | "command"
  | "tools"
  | "any"
  | { map: Record<string, Shape> }
  | { list: Shape; each?: (item: unknown, key: string) => void }
  | { mapOf: Shape };

const BUILDER_SHAPE: Shape = {
  map: {
    limit: { map: { tools: { map: { enable: "tools", disable: "tools" } } } },
    notify: { list: { map: { sink: "string", url: "string", token: "string", path: "path", command: "string" } }, each: (n, key) => checkSink(n as NotifySink, key) },
    server: {
      map: {
        host: "string",
        port: "number",
        jobTimeoutMinutes: "number",
        callbackRetries: "number",
        keepWorkspaces: "number",
        retentionDays: "number",
        builder: "string",
        runsDir: "path",
      },
    },
    pi: { map: { command: "command" } },
  },
};
const FILE_SHAPE: Shape = { map: { builder: BUILDER_SHAPE, instances: { mapOf: BUILDER_SHAPE }, gaffer: "any" } };

const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

/** Check `v` against `shape` and return it with relative paths resolved against `base`. Throws `<key>: <why>`. */
function check(v: unknown, shape: Shape, key: string, base: string): unknown {
  const fail = (why: string): never => {
    throw new Error(`${key || "the file"}: ${why}`);
  };
  if (shape === "any") return v;
  if (shape === "string" || shape === "path" || shape === "command") {
    if (typeof v !== "string") fail("must be a string");
    const s = v as string;
    if (shape === "path") return isAbsolute(expandHome(s)) ? expandHome(s) : resolve(base, s);
    // A command with a slash is a path; a bare name is looked up on PATH. `~` is expanded when it starts.
    if (shape === "command" && s.includes("/") && !s.startsWith("~") && !isAbsolute(s)) return resolve(base, s);
    return s;
  }
  if (shape === "number") {
    if (typeof v !== "number" || !Number.isFinite(v)) fail("must be a number");
    return v;
  }
  if (shape === "boolean") {
    if (typeof v !== "boolean") fail("must be true or false");
    return v;
  }
  if (shape === "tools") {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail("must be a list of tool or group names");
    for (const name of v as string[]) {
      const why = unknownToolName(name);
      if (why) fail(why);
    }
    return v;
  }
  if ("list" in shape) {
    if (!Array.isArray(v)) fail("must be a list");
    const items = (v as unknown[]).map((x, i) => check(x, shape.list, `${key}[${i}]`, base));
    items.forEach((x, i) => shape.each?.(x, `${key}[${i}]`));
    return items;
  }
  if (!isMap(v)) return fail("must be a map");
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const sub = key ? `${key}.${k}` : k;
    if (x === null || x === undefined) continue;
    if ("mapOf" in shape) out[k] = check(x, shape.mapOf, sub, base);
    else if (!(k in shape.map)) throw new Error(`unknown key ${sub}`);
    else out[k] = check(x, shape.map[k], sub, base);
  }
  return out;
}

/** A notify sink names a known kind and the field it needs; a token is an env: reference. Throws `<key>: <why>`. */
function checkSink(n: NotifySink, key: string): void {
  const needs = NOTIFY_SINKS[n.sink];
  if (!needs) throw new Error(`${key}.sink: must be one of ${Object.keys(NOTIFY_SINKS).join(", ")}`);
  if (typeof n[needs] !== "string" || !n[needs]) throw new Error(`${key}: a ${n.sink} sink needs ${needs}`);
  if (n.token !== undefined && !/^env:\w+$/.test(n.token)) throw new Error(`${key}.token: must be an env:NAME reference, never the secret itself`);
}

/** Parse and check one layer file. Throws naming the layer. */
export function readLayer(label: string, file: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`config ${label}: ${(err as Error).message.split("\n")[0]}`);
  }
  return checkLayer(label, raw ?? {}, dirname(file));
}

/** Check a layer already parsed. Throws `config <label>: <key>: <why>`. */
export function checkLayer(label: string, raw: unknown, base: string): Record<string, unknown> {
  try {
    return check(raw, FILE_SHAPE, "", base) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`config ${label}: ${(err as Error).message}`);
  }
}

// ---- loading ----

/** A JSON list of the machine config files given with --config: the CLI sets it, and run processes carry it. */
export const CONFIG_FILES_ENV = "BUILDER_CONFIG_FILES";

export interface LoadOptions {
  /** `--config <path>`. */
  configPath?: string;
  /** `--instance <id>`, else $GAFFER_INSTANCE. */
  instance?: string;
  env?: NodeJS.ProcessEnv;
  /** The machine-wide layer (default ~/.gaffer/config.yml). */
  userConfig?: string;
  /** The packaged layer (default builder/ops/config.yml). */
  packaged?: string;
}

/** Each leaf of `data` (maps recurse, lists and scalars are leaves) as `prefix.key` -> `label`, into `out`. */
function attribute(data: unknown, prefix: string, label: string, out: Record<string, string>): void {
  if (!isMap(data)) {
    if (prefix) out[prefix] = label;
    return;
  }
  for (const [k, v] of Object.entries(data)) attribute(v, prefix ? `${prefix}.${k}` : k, label, out);
}

/** Read every layer, check each, merge them and apply the instance. Throws on any broken layer (E22). */
export function loadConfig(o: LoadOptions = {}): MachineConfig {
  const env = o.env ?? process.env;
  const layers: { label: string; data: Record<string, unknown> }[] = [{ label: "built-in", data: checkLayer("built-in", builtInLayer(), BUILDER_ROOT) }];
  const optional = (label: string, file: string) => {
    if (existsSync(file)) layers.push({ label, data: readLayer(label, file) });
  };
  const required = (label: string, file: string) => {
    const path = resolve(expandHome(file));
    if (!existsSync(path)) throw new Error(`config ${label}: ${path} does not exist`);
    layers.push({ label, data: readLayer(label, path) });
  };
  optional(`packaged ${o.packaged ?? PACKAGED_CONFIG}`, o.packaged ?? PACKAGED_CONFIG);
  const user = o.userConfig ?? join(homedir(), ".gaffer", "config.yml");
  optional(user, user);
  if (env.GAFFER_CONFIG) required(`GAFFER_CONFIG ${env.GAFFER_CONFIG}`, env.GAFFER_CONFIG);
  if (o.configPath) required(`--config ${o.configPath}`, o.configPath);

  let merged: Record<string, unknown> = {};
  for (const l of layers) merged = mergeLayers(merged, l.data);
  const instance = o.instance ?? env.GAFFER_INSTANCE ?? null;
  const instances = isMap(merged.instances) ? merged.instances : {};
  const b = mergeLayers(merged.builder as Record<string, unknown>, instance ? instances[instance] : undefined) as {
    limit: { tools: { enable?: string[]; disable?: string[] } };
    notify: NotifySink[];
    server: ServerSettings;
    pi: { command: string };
  };
  // The instance's section wins over every layer's builder section, whatever layer it is in.
  const sources: Record<string, string> = {};
  for (const l of layers) attribute(l.data.builder, "", l.label, sources);
  if (instance) for (const l of layers) attribute(isMap(l.data.instances) ? l.data.instances[instance] : undefined, "", `${l.label} instances.${instance}`, sources);
  const { env: _env, ...loadOptions } = o;
  return {
    instance,
    limit: { enable: b.limit?.tools?.enable ?? [], disable: b.limit?.tools?.disable ?? [] },
    notify: b.notify ?? [],
    server: b.server,
    pi: b.pi,
    layers: layers.map((l) => l.label),
    sources,
    loadOptions,
  };
}

/**
 * The load options a run process (or code inside its pi) uses: the --config file its tree was started with
 * ($BUILDER_CONFIG_FILES) and the instance ($GAFFER_INSTANCE, read by loadConfig itself).
 */
export function runLoadOptions(env: NodeJS.ProcessEnv = process.env): LoadOptions {
  try {
    const files: unknown = JSON.parse(env[CONFIG_FILES_ENV] || "[]");
    if (Array.isArray(files) && typeof files[0] === "string" && files[0]) return { configPath: files[0], env };
  } catch {
    /* not a list: no --config layer */
  }
  return { env };
}

/**
 * The merged `builder` section as a layer would write it (so `sources` keys find their values), with secrets hidden: a
 * notify sink's token unless it is an env: reference.
 */
export function publicConfig(c: MachineConfig): { limit: { tools: ToolLimit }; notify: NotifySink[]; server: ServerSettings; pi: { command: string } } {
  const hide = (t: string | undefined) => (t === undefined ? undefined : /^env:\w+$/.test(t) ? t : "[hidden]");
  return {
    limit: { tools: c.limit },
    notify: c.notify.map((n) => ({ ...n, ...(n.token !== undefined ? { token: hide(n.token) } : {}) })),
    server: c.server,
    pi: c.pi,
  };
}

/** The value an `env:NAME` reference stands for. Anything else is returned as is. */
export function secret(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const m = /^env:(\w+)$/.exec(value);
  if (!m) return value;
  const v = env[m[1]];
  if (v === undefined) throw new Error(`${value}: ${m[1]} is not set`);
  return v;
}

/** The run spec options `builder run` and `builder resolve` share, and how a resolved run is printed. */
import { readFileSync } from "node:fs";
import { isAgent } from "../runtime/paths.ts";
import { redactEnv } from "../runtime/resolve.ts";
import { MODES, type Mode, type Resolved, type RunSpec, type WorkspaceSpec } from "../runtime/types.ts";
import { usage } from "./common.ts";

export const SPEC_USAGE = `<agent:<id>|workflow:<id>|id> [options]

<target>: agent:<id>, workflow:<id>, or a bare id: an agent when agentics/agents/<id>/agent.yml exists, else a builder
(agentics/builders/<id>/builder.ts) or a path to a builder module.

  --mode <m>                 headless | interactive | rpc | durable (default: the agent.yml's mode)
  --workspace <w>            empty | none | a JSON workspace spec, e.g. {"dir":"parent"} (default empty)
  --dir <path>               workspace: a folder worked in place
  --snapshot <from>          workspace: a snapshot of a repository at --ref, or of the folder as it is without one
  --ref <ref>, --into <path> the snapshot's commit and where it goes (default the run's folder)
  --dispatch <path>          input.dispatch: a data: path or a file
  --message <text>           input.message: the first message instead of the agent's prompt template
  --arg <value>              input.args, repeatable: the prompt template's arguments
  --base <ref>               input.base: the commit changes are measured from (default the workspace's HEAD)
  --input <json>             merged into input
  --spec <json|file>         a whole run spec; the options above override it
  --provider, --model, --thinking   override the agent's settings.json for this run
  --budget <minutes>, --name <name>, --detach, --journal

Paths may be area:<name>[/sub] (an area the agent declares), data:<path>, ~/..., or relative to this directory.`;

export const SPEC_OPTIONS = {
  mode: { type: "string" },
  workspace: { type: "string" },
  dir: { type: "string" },
  snapshot: { type: "string" },
  ref: { type: "string" },
  into: { type: "string" },
  dispatch: { type: "string" },
  message: { type: "string" },
  arg: { type: "string", multiple: true },
  base: { type: "string" },
  input: { type: "string" },
  spec: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  thinking: { type: "string" },
  budget: { type: "string" },
  name: { type: "string" },
  detach: { type: "boolean" },
  journal: { type: "boolean" },
} as const;

export interface SpecValues {
  mode?: string;
  workspace?: string;
  dir?: string;
  snapshot?: string;
  ref?: string;
  into?: string;
  dispatch?: string;
  message?: string;
  arg?: string[];
  base?: string;
  input?: string;
  spec?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  budget?: string;
  name?: string;
  detach?: boolean;
  journal?: boolean;
}

function json(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    return usage(`${what} is not JSON: ${(err as Error).message}`);
  }
}

/** The run spec the options describe. */
export function specOf(target: string, o: SpecValues): RunSpec {
  const base: RunSpec = o.spec ? (json(o.spec.trim().startsWith("{") ? o.spec : readFileSync(o.spec, "utf8"), "--spec") as RunSpec) : {};
  const spec: RunSpec = { ...base };
  delete spec.agent;
  delete spec.workflow;
  if (target.startsWith("agent:")) spec.agent = target.slice(6);
  else if (target.startsWith("workflow:")) spec.workflow = target.slice(9);
  else if (isAgent(target)) spec.agent = target;
  else spec.workflow = target;
  if (o.mode) {
    if (!MODES.includes(o.mode as Mode)) usage(`--mode ${o.mode}: one of ${MODES.join(", ")}`);
    spec.mode = o.mode as Mode;
  }
  const workspaces = [o.workspace, o.dir, o.snapshot].filter((x) => x !== undefined);
  if (workspaces.length > 1) usage("give one of --workspace, --dir and --snapshot");
  if (o.workspace) spec.workspace = (o.workspace === "empty" || o.workspace === "none" ? o.workspace : json(o.workspace, "--workspace")) as WorkspaceSpec;
  if (o.dir) spec.workspace = { dir: { path: o.dir } };
  if (o.snapshot) spec.workspace = { snapshot: { from: o.snapshot, ...(o.ref ? { ref: o.ref } : {}), ...(o.into ? { into: o.into } : {}) } };
  else if (o.ref || o.into) usage("--ref and --into go with --snapshot");
  const input = { ...(spec.input ?? {}), ...(o.input ? (json(o.input, "--input") as object) : {}) };
  if (o.dispatch) input.dispatch = o.dispatch;
  if (o.message !== undefined) input.message = o.message;
  if (o.arg) input.args = o.arg;
  if (o.base) input.base = o.base;
  if (Object.keys(input).length) spec.input = input;
  const settings = { ...(spec.settings ?? {}), ...(o.provider ? { provider: o.provider } : {}), ...(o.model ? { model: o.model } : {}), ...(o.thinking ? { thinking: o.thinking } : {}) };
  if (Object.keys(settings).length) spec.settings = settings;
  if (o.budget) {
    const n = Number(o.budget);
    if (!(n > 0)) usage("--budget is a number of minutes");
    spec.budgetMinutes = n;
  }
  if (o.name) spec.name = o.name;
  if (o.detach) spec.detach = true;
  if (o.journal) spec.journal = true;
  return spec;
}

/** A resolved run, as `builder resolve` prints it. */
export function printResolved(r: Resolved): string {
  const rows: string[] = [];
  const row = (k: string, v: string) => rows.push(`${k.padEnd(10)} ${v}`);
  if (r.agent) row("agent", `${r.agent.id}  ${r.agent.dir}  (agent.yml ${r.agent.ymlHash.slice(0, 12)}${r.agent.defaults.length ? `, defaults ${r.agent.defaults.map((d) => d.path).join(", ")}` : ""})`);
  if (r.workflow) row("workflow", r.workflow.id);
  row("mode", r.mode);
  row("workspace", typeof r.workspace === "string" ? r.workspace : JSON.stringify(r.workspace));
  row("cwd", r.cwd);
  if (r.settings) row("model", `${r.settings.provider}/${r.settings.model}${r.settings.thinking ? ` (thinking ${r.settings.thinking})` : ""}`);
  row("tools", r.tools.join(", ") || "(none)");
  if (r.dispatch) row("dispatch", `${r.dispatch.ref}  ${r.dispatch.path}  ${r.dispatch.sha256.slice(0, 12)}`);
  for (const [name, repo] of Object.entries(r.repos ?? {})) row(`repo ${name}`, `${repo.from}  ${repo.path}${repo.base ? `  at ${repo.ref} ${repo.base.slice(0, 12)}` : ""}`);
  if (r.message !== undefined) row("message", r.message);
  row("areas", Object.entries(r.areas).map(([k, a]) => `${k}=${a.path}${a.write ? " (write)" : ""}`).join(", ") || "(none)");
  row("may start", r.mayStart.join(", ") || "(none)");
  if (r.api) row("api", `http://${r.api.host.includes(":") ? `[${r.api.host}]` : r.api.host}:${r.api.port}  token ${r.api.token}`);
  if (r.triggers?.length) row("triggers", r.triggers.map((t) => ("on" in t ? `on ${t.on}` : `cron ${t.cron}: ${t.prompt}`)).join("; "));
  if (r.resources.length) {
    rows.push("resources");
    for (const res of r.resources) rows.push(`  ${res.kind.padEnd(9)} ${res.ref.padEnd(28)} ${res.sha256.slice(0, 12)}  ${res.path}`);
  }
  if (Object.keys(r.env).length) {
    rows.push("env");
    for (const [k, v] of Object.entries(redactEnv(r.env))) rows.push(`  ${k}=${v}`);
  }
  if (r.argv.length) {
    rows.push("argv");
    for (let i = 0; i < r.argv.length; i++) {
      const a = r.argv[i];
      const next = r.argv[i + 1];
      const q = (s: string) => (/[\s"'$]/.test(s) || s === "" ? JSON.stringify(s) : s);
      if (a.startsWith("-") && a !== "--" && next !== undefined && !next.startsWith("-") && !["-p"].includes(a)) {
        rows.push(`  ${a} ${q(next)}`);
        i++;
      } else rows.push(`  ${q(a)}`);
    }
  }
  return rows.join("\n");
}

/**
 * The tool core (design section 9, D8). Every builder tool is a ToolDef in one group module, ops/core/<group>.ts,
 * registered in ops/core/index.ts. Three adapters reach the same functions and add no logic of their own:
 * ops/pi-extension.ts (any agent), the CLI (`builder tool <name> [json]`) and the api adapter (`POST /tools/<name>`).
 * No tool knows which adapter called it: what it needs comes in its ToolContext.
 *
 * callTool is the one entry, and on every call it
 *   1. finds the tool                                          unknown      -> ToolError "unknown"
 *   2. refuses it unless `caller.allowed` has it (an agent's resolved tools within the live machine limit, the machine
 *      limit for the CLI)                                      refused      -> ToolError "refused"
 *   3. validates the arguments against the tool's schema      invalid      -> ToolError "invalid"
 *   4. answers a stub (a tool design section 9 names that a later phase builds) with "not available"
 *                                                                           -> ToolError "unavailable"
 *   5. runs it; anything it throws becomes                                  -> ToolError "failed"
 *
 * Group modules sit in an import cycle with this file (they use defineTool and stub at load time, callTool reads the
 * registry they feed). Only function declarations are used across it, which are bound before any module runs.
 */
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { LocalRuntime } from "../../runtime/run.ts";
import type { MachineConfig } from "../config.ts";
import { registry } from "./index.ts";

export type GroupName = "observe" | "runs" | "messaging" | "operate" | "process" | "definitions" | "files" | "project" | "outcome" | "verify" | "git" | "notify";

export interface ToolDef<A = any, R = any> {
  /** snake_case, unique across every group. */
  name: string;
  group: GroupName;
  /** What it does, for the model, the CLI's `builder tools` and UIs. */
  description: string;
  /** typebox: the arguments are validated against it before `run`. */
  params: TSchema;
  run(args: A, ctx: ToolContext): Promise<R>;
  /** A tool named now and built later: why it is not available ("not available until P6"). */
  stub?: string;
}

export interface Caller {
  kind: "agent" | "cli" | "api";
  /** The run the caller is (an agent's own run, an api run). */
  runId?: string;
  agent?: string;
  /** The tools it may call: an agent's resolved tools within the live limit, or the machine limit (cli). */
  allowed: Set<string>;
}

export interface ToolContext {
  caller: Caller;
  /** The merged machine config (ops/config.ts), with the layer of each value. */
  config: MachineConfig;
  /** The runtime the caller starts and reads runs through (its runs directory is `runtime.options.runsDir`). */
  runtime: LocalRuntime;
  /** builder/ */
  builderRoot: string;
}

export type ToolErrorCode = "unknown" | "refused" | "invalid" | "unavailable" | "failed";

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

const CODES: readonly string[] = ["unknown", "refused", "invalid", "unavailable", "failed"];

/** A ToolError, also one made by another copy of this module (pi loads extensions with their own module copies). */
export function isToolError(err: unknown): err is ToolError {
  const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && CODES.includes(code);
}

/** Typed identity: a group module's tool. */
export function defineTool<A, R>(def: ToolDef<A, R>): ToolDef<A, R> {
  return def;
}

/** A tool named now (so agent.yml and the machine limit can name it) and built later. Calling it answers `note`. */
export function stub(group: GroupName, name: string, description: string, note = "not available yet"): ToolDef {
  return {
    name,
    group,
    description,
    params: Type.Object({}, { additionalProperties: true }),
    stub: note,
    run: async () => {
      throw new ToolError("unavailable", `${name} is ${note}`);
    },
  };
}

/** Who is calling, in messages. */
export function callerLabel(c: Caller): string {
  if (c.kind === "agent") return `agent ${c.agent ?? "?"}${c.runId ? ` (run ${c.runId})` : ""}`;
  return c.kind === "cli" ? "the CLI (the machine limit)" : `the API${c.runId ? ` of run ${c.runId}` : ""}`;
}

/** The first few schema errors, readable: `run: must be string; extra: must not have additional properties`. */
export function schemaErrors(schema: TSchema, value: unknown, max = 5): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of Value.Errors(schema, value)) {
    if (e.message === "schema is false") continue;
    const at = e.instancePath ? e.instancePath.slice(1).replace(/\//g, ".") : "";
    const extra = (e.params as { additionalProperties?: unknown }).additionalProperties;
    const text = Array.isArray(extra) ? `unknown argument${extra.length > 1 ? "s" : ""} ${extra.join(", ")}` : `${at || "the arguments"}: ${e.message}`;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out.join("; ") || "the arguments do not match the tool's schema";
}

/** Call a tool for a caller. The one entry for every adapter: see the file comment. */
export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
  const def = registry().get(name);
  if (!def) throw new ToolError("unknown", `unknown tool "${name}" (builder tools lists them)`);
  if (!ctx.caller.allowed.has(name)) throw new ToolError("refused", `${name} is not allowed for ${callerLabel(ctx.caller)}`);
  const a = args === undefined || args === null ? {} : args;
  if (!Value.Check(def.params, a)) throw new ToolError("invalid", `${name}: ${schemaErrors(def.params, a)}`);
  if (def.stub) throw new ToolError("unavailable", `${name} is ${def.stub}`);
  try {
    return await def.run(a, ctx);
  } catch (err) {
    if (isToolError(err)) throw err;
    throw new ToolError("failed", err instanceof Error ? err.message : String(err));
  }
}

export interface ToolInfo {
  name: string;
  group: GroupName;
  description: string;
  params: TSchema;
  /** False for a stub. */
  available: boolean;
}

/** Every tool, in group order; with a context, only the ones its caller may call. */
export function listTools(ctx?: ToolContext): ToolInfo[] {
  return [...registry().values()]
    .filter((d) => !ctx || ctx.caller.allowed.has(d.name))
    .map((d) => ({ name: d.name, group: d.group, description: d.description, params: d.params, available: !d.stub }));
}

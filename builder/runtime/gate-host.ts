/**
 * The gate host: a pi extension (`-e runtime/gate-host.ts`) the runner loads when the resolved run has gates
 * (runtime/resolve.ts gateHostFor). $BUILDER_GATES names a JSON file in the run's folder:
 *
 *   { "gates": [{ "ref": "shared:write-scope", "path": "/…/agentics/shared/gates/write-scope.ts" }, …],
 *     "ctx": { "cwd", "base", "writes", "areas", "protectedPaths", "dispatch" } }
 *
 * It loads each gate module once (engine/gates.ts) and runs the gates, in the file's order, on the tool calls and tool
 * results they name:
 *   tool_call    the first block wins: pi gets { block, reason } and the gates after it do not run. A rewrite changes
 *                the call's input, for the gates after it and for the tool.
 *   tool_result  patches chain, each gate seeing the result as patched so far, and pi gets the merged patch. A block
 *                replaces the result with an error carrying the reason.
 * Every decision is journaled as `tool.gate { tool, gate, on, decision, reason, path }`.
 *
 * Fails closed (G7): a gate that throws, or returns something that is not a decision, blocks the call with the error as
 * the reason (E9), and on tool_result turns the result into that error. When $BUILDER_GATES is unset or unreadable, or
 * a gate module does not load or exports no gate, every tool call is blocked with that reason.
 *
 * Load it after the agent's other extensions, so its gates see a call's input as those extensions left it.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { decisionOf, gateContext, gateSees, isGate, type Decision, type Gate, type GateContext, type GateEvent, type GateHostFile, type ToolResultFields } from "../engine/gates.ts";
import { journalSend } from "./journal-client.ts";

export interface LoadedGate {
  ref: string;
  gate: Gate;
}

/** The loaded gates, or why none could be loaded (then every call is blocked). */
export type GateHost = { gates: LoadedGate[]; ctx: GateContext } | { broken: string };

/** The tool call or tool result as pi hands it to the host. */
export interface HostEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export type Send = typeof journalSend;

/** The journal span of a tool call (shared:journal uses the same). */
export const toolSpan = (toolCallId: string): string => `t-${toolCallId}`;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A module's gates: its default export, a gate or a list of gates (through any CommonJS interop wrapping). */
function gatesOf(mod: unknown): Gate[] | null {
  for (let v: unknown = mod, depth = 0; v && depth < 3; v = (v as { default?: unknown }).default, depth++) {
    if (isGate(v)) return [v];
    if (Array.isArray(v) && v.length && v.every(isGate)) return v;
  }
  return null;
}

/** Read the gates file and load every gate module. Never throws: what fails becomes the reason every call is blocked. */
export async function loadGateHost(file: string | undefined = process.env.BUILDER_GATES, env: NodeJS.ProcessEnv = process.env): Promise<GateHost> {
  if (!file) return { broken: "the gate host is loaded but $BUILDER_GATES is not set" };
  let spec: GateHostFile;
  try {
    spec = JSON.parse(readFileSync(file, "utf8")) as GateHostFile;
  } catch (err) {
    return { broken: `the gates file ${file} cannot be read: ${messageOf(err)}` };
  }
  if (!spec || !Array.isArray(spec.gates) || !spec.ctx || typeof spec.ctx.cwd !== "string") return { broken: `${file} is not a gates file` };
  const gates: LoadedGate[] = [];
  for (const g of spec.gates) {
    const ref = String(g?.ref ?? g?.path);
    try {
      const path = statSync(g.path).isDirectory() ? join(g.path, "index.ts") : g.path;
      const list = gatesOf(await import(path));
      if (!list) throw new Error("its default export is not a gate (defineGate) or a list of gates");
      for (const gate of list) gates.push({ ref, gate });
    } catch (err) {
      return { broken: `gate ${ref} did not load: ${messageOf(err)}` };
    }
  }
  try {
    return { gates, ctx: gateContext(spec.ctx, env) };
  } catch (err) {
    return { broken: `the gate context in ${file} is invalid: ${messageOf(err)}` };
  }
}

const kindOf = (d: Decision): string => ("allow" in d ? "allow" : "block" in d ? "block" : "rewrite" in d ? "rewrite" : "patch");

function journal(send: Send, e: HostEvent, gate: string, on: GateEvent, d: Decision, error?: true): void {
  const inputPath = typeof e.input?.path === "string" ? e.input.path : undefined;
  const path = "block" in d && d.path !== undefined ? d.path : inputPath;
  try {
    send({
      kind: "tool.gate",
      span: toolSpan(e.toolCallId),
      data: {
        tool: e.toolName,
        gate,
        on,
        decision: kindOf(d),
        ...("block" in d ? { reason: d.reason } : {}),
        ...(path !== undefined ? { path } : {}),
        ...("rewrite" in d ? { fields: Object.keys(d.rewrite) } : {}),
        ...("patch" in d ? { fields: Object.keys(d.patch) } : {}),
        ...(error ? { error: true } : {}),
      },
    });
  } catch {
    /* observing never breaks a decision */
  }
}

/** Run one gate: its decision, or a block with the error when it throws or answers with something else (E9). */
async function decide(g: LoadedGate, call: Parameters<Gate["check"]>[0], ctx: GateContext): Promise<{ d: Decision; error?: true }> {
  try {
    return { d: decisionOf(await g.gate.check(call, ctx), g.gate.on) };
  } catch (err) {
    return { d: { block: true, reason: `gate ${g.ref} failed: ${messageOf(err)}` }, error: true };
  }
}

/** The tool_call gates for one call. Returns what pi should get: a block, or nothing (the call runs, maybe rewritten). */
export async function onToolCall(host: GateHost, e: HostEvent, send: Send = journalSend): Promise<{ block: true; reason: string } | undefined> {
  if ("broken" in host) {
    const d: Decision = { block: true, reason: host.broken };
    journal(send, e, "gate-host", "tool_call", d, true);
    return { block: true, reason: host.broken };
  }
  const call = { tool: e.toolName, input: e.input };
  for (const g of host.gates) {
    if (g.gate.on !== "tool_call" || !gateSees(g.gate, e.toolName)) continue;
    const { d, error } = await decide(g, call, host.ctx);
    journal(send, e, g.ref, "tool_call", d, error);
    if ("block" in d) return { block: true, reason: d.reason };
    if ("rewrite" in d) {
      // pi runs the tool with event.input as it is after the handlers, mutated in place.
      for (const [k, v] of Object.entries(d.rewrite)) {
        if (v === undefined) delete e.input[k];
        else e.input[k] = v;
      }
    }
  }
  return undefined;
}

/** The tool_result gates for one result. Returns the merged patch for pi, or nothing when no gate changed it. */
export async function onToolResult(host: GateHost, e: HostEvent & ToolResultFields, send: Send = journalSend): Promise<ToolResultEventResult | undefined> {
  if ("broken" in host) return undefined; // every call was blocked, so no result reaches here
  let current: ToolResultFields = { content: e.content, details: e.details, isError: e.isError, ...(e.structuredContent !== undefined ? { structuredContent: e.structuredContent } : {}) };
  let patch: Partial<ToolResultFields> | undefined;
  for (const g of host.gates) {
    if (g.gate.on !== "tool_result" || !gateSees(g.gate, e.toolName)) continue;
    const { d, error } = await decide(g, { tool: e.toolName, input: e.input, result: { ...current } }, host.ctx);
    journal(send, e, g.ref, "tool_result", d, error);
    const change: Partial<ToolResultFields> | null = "patch" in d ? d.patch : "block" in d ? { content: [{ type: "text", text: d.reason }], isError: true } : null;
    if (!change) continue;
    current = { ...current, ...change };
    patch = { ...patch, ...change };
  }
  return patch as ToolResultEventResult | undefined;
}

export default async function gateHost(pi: ExtensionAPI): Promise<void> {
  const host = await loadGateHost();
  pi.on("tool_call", (event) => onToolCall(host, event as HostEvent));
  pi.on("tool_result", (event) => onToolResult(host, event as unknown as HostEvent & ToolResultFields));
}

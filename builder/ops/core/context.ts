/**
 * ToolContexts for the adapters. The adapters add no logic: they say who is calling and with what config and runtime,
 * and callTool does the rest.
 *
 *   cliContext     the CLI (and any process acting for the operator): the machine limit is what it may call
 *   apiContext     the api adapter of a run: the run's own tools (the api agent builds on it)
 *   AgentTools     code inside an agent's pi process (ops/pi-extension.ts): the run's resolved tools within the live
 *                  machine limit (runs/<id>/config.json after a reload), recomputed on every call
 */
import { basename, dirname } from "node:path";
import { createRuntime, liveLimit, NO_LIMIT, optionsFromEnv, readRecord, readRunConfig, type LocalRuntime } from "../../runtime/run.ts";
import { BUILDER_ROOT } from "../../runtime/root.ts";
import type { RunRecord } from "../../runtime/types.ts";
import { builtInLayer, loadConfig, runLoadOptions, type LoadOptions, type MachineConfig, type ServerSettings } from "../config.ts";
import { toolsOf } from "../groups.ts";
import type { Caller, ToolContext } from "./tool.ts";

/** The runtime a config describes: its runs directory, pi command and limit, and the --config file runs carry. */
export function runtimeFor(config: MachineConfig, extra: { self?: string; agenticsDir?: string } = {}): LocalRuntime {
  const configFiles = config.loadOptions.configPath ? [config.loadOptions.configPath] : [];
  return createRuntime({ runsDir: config.server.runsDir, piCommand: config.pi.command, limit: config.limit, ...(configFiles.length ? { configFiles } : {}), ...extra });
}

/** The CLI's context: it may call what the machine limit allows. */
export function cliContext(config: MachineConfig, runtime: LocalRuntime = runtimeFor(config)): ToolContext {
  return { caller: { kind: "cli", allowed: new Set(toolsOf(config.limit)) }, config, runtime, builderRoot: BUILDER_ROOT };
}

/** An api adapter's context: the serving run's own tools (`allowed`), with its id and agent. */
export function apiContext(config: MachineConfig, runtime: LocalRuntime, caller: Omit<Caller, "kind">): ToolContext {
  return { caller: { kind: "api", ...caller }, config, runtime, builderRoot: BUILDER_ROOT };
}

/** The tools a run may use now: what it resolved at start, within the live machine limit. */
export function allowedNow(resolvedTools: readonly string[], runDir: string, startedWith: { enable: string[]; disable: string[] }): Set<string> {
  let inLimit: string[];
  try {
    inLimit = toolsOf(liveLimit(runDir, startedWith));
  } catch {
    inLimit = []; // a limit that names something unknown allows nothing (G7)
  }
  return new Set(resolvedTools.filter((t) => inLimit.includes(t)));
}

/** A config for a run whose layers no longer load: the settings its tree started with, from its environment. */
function fallbackConfig(o: { runsDir: string; piCommand: string; limit?: { enable: string[]; disable: string[] } }, why: string): MachineConfig {
  const server = (builtInLayer().builder as { server: ServerSettings }).server;
  return {
    instance: process.env.GAFFER_INSTANCE ?? null,
    limit: o.limit ?? NO_LIMIT,
    notify: [],
    server: { ...server, runsDir: o.runsDir },
    pi: { command: o.piCommand },
    layers: [`run environment (the layers do not load: ${why})`],
    sources: {},
    loadOptions: {},
  };
}

/**
 * The tool context of an agent's own run, for code inside its pi process: who it is comes from $BUILDER_RUN_DIR and
 * its run.json, the runtime from the run tree's environment. Null outside a run (then nothing is registered).
 */
export class AgentTools {
  readonly runId: string;
  readonly runDir: string;
  readonly record: RunRecord;
  readonly runtime: LocalRuntime;
  private readonly startLimit: { enable: string[]; disable: string[] };
  private readonly loadOptions: LoadOptions;
  private config: MachineConfig | null = null;
  private configStamp = "";

  private constructor(runDir: string, record: RunRecord, env: NodeJS.ProcessEnv) {
    const o = optionsFromEnv(env);
    this.runId = record.id;
    this.runDir = runDir;
    this.record = record;
    this.startLimit = o?.limit ?? NO_LIMIT;
    this.runtime = createRuntime({ ...(o ?? { runsDir: dirname(runDir), piCommand: "pi" }), self: record.id });
    this.loadOptions = runLoadOptions(env);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): AgentTools | null {
    const runDir = env.BUILDER_RUN_DIR;
    if (!runDir) return null;
    const rec = readRecord(dirname(runDir), basename(runDir));
    if (!rec || rec.kind !== "agent") return null;
    return new AgentTools(runDir, rec, env);
  }

  /** The tools the run resolved at start (its agent.yml within the limit and its parent's tools then). */
  get resolvedTools(): string[] {
    return this.record.resolved?.tools ?? [];
  }

  /** What it may call now. */
  allowed(): Set<string> {
    return allowedNow(this.resolvedTools, this.runDir, this.startLimit);
  }

  /** A stamp that changes when config_reload tells this run something. */
  stamp(): string {
    const c = readRunConfig(this.runDir);
    return c ? `${c.loadedAt}|${JSON.stringify(c.limit)}` : "";
  }

  /** The machine config, read again after a reload; the run tree's settings when a layer is broken. */
  private machineConfig(): MachineConfig {
    const stamp = this.stamp();
    if (this.config && stamp === this.configStamp) return this.config;
    let c: MachineConfig;
    try {
      c = loadConfig(this.loadOptions);
    } catch (err) {
      c = fallbackConfig({ ...this.runtime.options, limit: this.startLimit }, (err as Error).message);
    }
    // The run's tree keeps the runs directory it started with.
    this.config = { ...c, server: { ...c.server, runsDir: this.runtime.options.runsDir } };
    this.configStamp = stamp;
    return this.config;
  }

  context(): ToolContext {
    return {
      caller: { kind: "agent", runId: this.runId, ...(this.record.spec.agent ? { agent: this.record.spec.agent } : {}), allowed: this.allowed() },
      config: this.machineConfig(),
      runtime: this.runtime,
      builderRoot: BUILDER_ROOT,
    };
  }
}

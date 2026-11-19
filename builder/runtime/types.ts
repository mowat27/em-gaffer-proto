/**
 * The runtime's types: what a run is asked to do (RunSpec), what it resolves to (Resolved), what it is on disk
 * (RunRecord, runs/<id>/run.json) and how it ended (RunResult). The runtime knows nothing about the contract or about
 * workflow steps.
 */

/** How pi runs: `-p` once, the TUI in the launching terminal, `--mode rpc` relayed over control.sock, or rpc long-lived. */
export type Mode = "headless" | "interactive" | "rpc" | "durable";
export const MODES: readonly Mode[] = ["headless", "interactive", "rpc", "durable"];

/**
 * Where a run works. Paths may be `area:<name>[/sub]`, `data:<path>`, `~/...` or relative to the starter's directory.
 *   empty                          a new folder under the run (a workflow fills it with clone steps)
 *   none                           no workspace: the run's own folder is its working directory
 *   { dir: { path } }              a local folder, worked in place
 *   { snapshot: { from, ref?, into? } }  a copy: `git archive` of `ref` in the repository `from` (npm ci once per
 *                                  commit, cached), or with no ref a copy of the folder `from`; then git init and one
 *                                  commit. `into` defaults to the run's workspace folder.
 */
export type WorkspaceSpec = "empty" | "none" | { dir: { path: string } } | { snapshot: { from: string; ref?: string; into?: string } };

/**
 * A run spec's workspace: a WorkspaceSpec, or `{ dir: "parent" }`, the starting run's own workspace worked in place
 * (a subagent sharing its parent's files). runtime/resolve.ts turns it into `{ dir: { path } }`.
 */
export type SpecWorkspace = WorkspaceSpec | { dir: "parent" };

export interface PiSettingsOverride {
  provider?: string;
  model?: string;
  thinking?: string;
}

/**
 * Where a workflow's clone step gets a repository (design section 3, Repositories), instead of the dispatch's url:
 *   "<path>"                   cloned at the dispatch's base (the source must have that commit)
 *   { from: "<path>", ref }    cloned at `ref` in the source, which becomes the job's base: `HEAD` builds on top of
 *                              what the source has committed, e.g. the previous run's workspace
 * Paths may be area:, data:, ~ or relative, as anywhere in a run spec. Only committed work is cloned.
 */
export type RepoSource = string | { from: string; ref?: string };

/** A repository source resolved when the run starts: the path to clone and, with a ref, the commit it named then. */
export interface ResolvedRepo {
  /** As the spec wrote it. */
  from: string;
  /** Absolute. */
  path: string;
  ref?: string;
  /** The commit `ref` named when the run started: the job's base for this repository. */
  base?: string;
}

export interface RunInput {
  /** The dispatch the agent builds: inline, or a `data:` path / file path to one. */
  dispatch?: unknown;
  /** Workflow runs: a clone source per repository name (`app` is the dispatch's repository). */
  repos?: Record<string, RepoSource>;
  /** Arguments for the agent's prompt template (`/<template> args...`). */
  args?: string[];
  /** The first message, instead of the prompt template. */
  message?: string;
  /** The commit the agent's changes are measured from (BUILDER_BASE). Default: the workspace's HEAD at start. */
  base?: string;
  /** The job id the agent works for (BUILDER_JOB_ID). Default: the dispatch callback's job id, else the run id. */
  jobId?: string;
  [k: string]: unknown;
}

export interface RunSpec {
  /** A builder id (agentics/builders/<id>/builder.ts) or a path to a builder module. */
  workflow?: string;
  /** An agent id: its path under agentics/agents/. */
  agent?: string;
  /** Overrides the agent.yml's mode. A workflow run itself is always headless. */
  mode?: Mode;
  workspace?: SpecWorkspace;
  input?: RunInput;
  /** Overrides the agent's settings.json for this run. */
  settings?: PiSettingsOverride;
  /** Workflow runs: per-step overrides. */
  steps?: Record<string, { mode?: Mode; agent?: string; settings?: PiSettingsOverride }>;
  /**
   * Keep a journal (runs/<id>/journal.jsonl). Workflow runs, server job runs and the children of a run with a journal
   * always have one; for an agent run started directly it is off unless this is true.
   */
  journal?: boolean;
  /** The workflow step this run serves (an agent step's child run): its journal events carry it. */
  step?: string;
  /**
   * An address for messaging (runtime/messaging.ts): run_send and run_subscribe take it instead of the run id. At most
   * one live run has a given name. A named run always keeps a journal.
   */
  name?: string;
  /** Keep running when the run that started it ends (E23). Its budget is still at most what the parent had left. */
  detach?: boolean;
  /**
   * Agent runs: pi is killed at the budget. Workflow runs: a hard cap over every step, with the builder's own budget.
   * A run started by an agent run gets at most what is left of that run's budget (RunRecord.budgetMinutes).
   */
  budgetMinutes?: number;
}

export interface Resource {
  kind: "skill" | "extension" | "prompt" | "system" | "gate";
  /** As the agent.yml wrote it (an absolute path for a resource taken from an extended agent). */
  ref: string;
  path: string;
  sha256: string;
}

/** What a run spec resolves to (config_resolve): everything the runner passes to pi, before anything starts. */
export interface Resolved {
  agent?: { id: string; dir: string; ymlHash: string; defaults: { path: string; sha256: string }[] };
  workflow?: { id: string };
  mode: Mode;
  /** The working directory (the workspace, or the run's folder for `none`). */
  cwd: string;
  /** The workspace with every path made absolute. */
  workspace: WorkspaceSpec;
  /** After the agent.yml, the machine limit and the parent's tools. */
  tools: string[];
  resources: Resource[];
  /** pi's arguments. */
  argv: string[];
  /** Added to pi's environment (BUILDER_BASE is added at start, from the workspace). */
  env: Record<string, string>;
  areas: Record<string, { path: string; write: boolean }>;
  /** Agent runs: the agent.yml's writes, globs relative to cwd with own: and ~ entries absolute (the write-scope gate). */
  writes?: string[];
  mayStart: string[];
  /** The first message: on the command line (headless, interactive) or as an rpc prompt (rpc, durable). */
  message?: string;
  /** The model flags passed to pi. */
  settings?: { provider: string; model: string; thinking: string };
  /** Where a dispatch given by path came from. */
  dispatch?: { ref: string; path: string; sha256: string };
  /** Agent runs: the agent.yml's `api:`. The run serves the API (runtime/api.ts) with the token its env: names. */
  api?: { host: string; port: number; token: string };
  /** Workflow runs: input.repos, resolved (the clone step reads them from the job). */
  repos?: Record<string, ResolvedRepo>;
  /** Agent runs whose agent.yml has `definitions: { changes: propose }`: their change tools save change sets. */
  changes?: "propose";
  /** Durable runs: the agent.yml's `triggers:` (runtime/triggers.ts), armed by the run's own process. */
  triggers?: Trigger[];
}

/** A trigger in agent.yml (runtime/triggers.ts): a failed server job, or a schedule with the prompt it sends. */
export type Trigger = { on: "job.failed" } | { cron: string; prompt: string };

export type RunState = "starting" | "running" | "done" | "failed" | "stopped";

export type RunResult = { outcome: "done"; patches?: Record<string, string>; data?: unknown } | { outcome: "failed"; reason: string; halted?: boolean };

/** The job a server-started run carries out: who to call back, and whether that callback has been made. */
export interface RunJob {
  jobId: string;
  callback: string;
  callbackDone?: boolean;
  /** The pid of the server that accepted the job, so a restarted server knows which runs it must recover (E13). */
  server?: number;
}

/** runs/<id>/run.json, rewritten atomically (tmp + rename). */
export interface RunRecord {
  id: string;
  /** The run that started this one, or null when a process that is not a run (a test, the CLI) did. */
  parent: string | null;
  /** server: the build server registered as a run (`builder server run`); the runtime never starts one itself. */
  kind: "workflow" | "agent" | "server";
  spec: RunSpec;
  state: RunState;
  pid: number | null;
  startedAt: string;
  endedAt?: string;
  /** Workflow runs: the current step. */
  step?: string;
  /** Server job runs only. */
  job?: RunJob;
  result?: RunResult;
  /** What the spec resolved to when the run started (pinned: a later change to a definition does not reach it). */
  resolved?: Resolved;
  /** The most a child of this run may use: an agent run's tools, a workflow run's parent's ceiling, null = no ceiling. */
  ceiling?: string[] | null;
  /** rpc and durable runs: the control socket clients connect to. */
  socket?: string;
  /** Runs whose agent.yml has `api:`: where the API listens (http://host:port), once it does. */
  api?: string;
  /** Whether the run keeps a journal (decided when it starts, see RunSpec.journal). */
  journal?: boolean;
  /**
   * The run's budget in minutes as it started with it: spec.budgetMinutes, or less when the agent run that started it
   * had less left (subagents, design section 5). Absent: no budget.
   */
  budgetMinutes?: number;
  /** When that budget ends (ISO): what a run this one starts measures its own budget against. */
  deadline?: string;
}

export interface StartOptions {
  parent?: string;
  job?: RunJob;
  /** Called once the run's folder and record exist, before its process starts (the server journals job.accepted here). */
  onRecord?(rec: RunRecord, dir: string): void;
}

export interface Runtime {
  start(spec: RunSpec, opts?: StartOptions): Promise<RunRecord>;
  /** Resolves with the run's result once it has ended. Rejects with the signal's reason when the signal aborts first. */
  wait(id: string, signal?: AbortSignal): Promise<RunResult>;
  /** SIGTERM, SIGKILL after 5 s. Resolves once the run has ended. */
  stop(id: string, reason?: string): Promise<void>;
  get(id: string): RunRecord | null;
  list(): RunRecord[];
  /** runs/<id>: where a run's files are (run.json, log, sessions/, context/, workspace/), so a parent can read its child's. */
  dir(id: string): string;
}

/** Progress events: a line on stderr (the run's log); the engine also journals them. */
export type Emit = (kind: string, msg: string, data?: Record<string, unknown>) => void;

export const FINAL_STATES: readonly RunState[] = ["done", "failed", "stopped"];
export const isFinal = (s: RunState): boolean => FINAL_STATES.includes(s);

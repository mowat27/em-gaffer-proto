/**
 * The engine's types: the dispatch a workflow builds, the job a workflow run carries out, the context every step
 * gets, and the builder definition (a workflow of steps). The engine knows nothing about HTTP or about how a run's
 * process starts.
 */
import type { Emit, ResolvedRepo, RunSpec, Runtime } from "../runtime/types.ts";
import type { Listener } from "./listeners.ts";
import type { Sidecar } from "./sidecars.ts";

/** The contract's dispatch, as server/validate.ts normalises it. */
export interface Dispatch {
  requires: string[];
  repo: { url: string; base: string };
  task: { sliceId: string; title: string; context: string; handover: boolean; attempt: number };
  slice: unknown;
  /** What changed since the slice was last built (docs/contract.md, Changes): `verdict` NEW or CHANGED, and the elements. */
  changes?: { verdict?: string; [key: string]: unknown } | null;
  /** STATE_VIEW slices: the definitions of the events their read models project (docs/contract.md). */
  sourceEvents?: unknown[];
  callback: string;
}

/** context/job.json: what the workflow run is building, and by when. */
export interface Job {
  runId: string;
  jobId: string;
  dispatch: Dispatch;
  /** ms since the epoch. */
  startedAt: number;
  /** ms since the epoch: the hard cap over every step. */
  deadline: number;
  /** The builder the run loaded: its name and the content hash of its definition (the Builder-Version trailer). */
  builder?: { name: string; version: string };
  /**
   * The run spec's input.repos, resolved: where clone steps get each repository instead of the dispatch's url. When
   * `app` names a ref, `dispatch.repo.base` above is already its commit.
   */
  repos?: Record<string, ResolvedRepo>;
}

export interface StepContext {
  job: Readonly<Job>;
  /** The workspace root. */
  dir: string;
  /** outputs/<step>.json of a finished step. Throws when that step has not finished. */
  get<T>(step: string): T;
  /** Aborts at the step's budget, at the job deadline, or when the run is stopped. */
  signal: AbortSignal;
  /** Appends to runs/<runId>/log, the job log. */
  log(text: string): void;
  /** A progress line on the run's stderr, and the run's journal as `{ kind, step, data: { msg, ... } }`. */
  emit: Emit;
  /** Agent steps start child runs through it. */
  runtime: Runtime;
  /** The workflow run spec's per-step overrides (mode, agent, settings). */
  steps?: RunSpec["steps"];
  /** A path in the agent tree's templates as the run pinned it at start (runtime/pin.ts pinTemplates, E1). */
  pinned?(path: string): string;
}

export type Step =
  | { kind: "code"; name: string; run: (ctx: StepContext) => Promise<unknown>; budgetMinutes?: number }
  | {
      kind: "template";
      name: string;
      /** The template set to render: an absolute directory (engine/templates.ts). */
      set: (ctx: StepContext) => string;
      /** The set's view model: what its templates render from. Called only when the set has templates. */
      data: (ctx: StepContext) => unknown;
      /** Where the set renders (default the workspace root). */
      dir?: (ctx: StepContext) => string;
    }
  | {
      kind: "agent";
      name: string;
      /** An agent id in agentics/agents/. */
      agent: string;
      /** The first message instead of the agent's prompt template. */
      prompt?: string | ((ctx: StepContext) => string);
      /** Arguments for the agent's prompt template. */
      args?: (ctx: StepContext) => string[];
      /** Where the agent works (default the workspace root). */
      cwd?: (ctx: StepContext) => string;
      budgetMinutes?: number;
    }
  | { kind: "workflow"; name: string; builder: string };

export interface Builder {
  name: string;
  /** `requires` entries this builder satisfies besides `repo:*`. */
  provides: string[];
  /** The workflow's own budget. The server's jobTimeoutMinutes caps it too: the smaller one is the job deadline. */
  budgetMinutes?: number;
  steps: Step[];
  /** Observe-only hooks on the journal events of the run and its child runs, besides agentics/shared/listeners/. */
  listeners?: Listener[];
  /** Runs started on batches of the run's journal events, never awaited (engine/sidecars.ts, E7). */
  sidecars?: Sidecar[];
}

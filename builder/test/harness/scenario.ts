/**
 * What the pi stub (./pi-stub.ts) does in place of a real agent run, one step after another, in the directory the
 * builder starts it in. Shared by the tests, which write scenarios, and the stub, which performs them.
 */

export type Step =
  /** Write a file (relative to the stub's working directory), creating its directories. */
  | { op: "write"; path: string; content: string }
  /** Append to a file, creating it when missing. */
  | { op: "append"; path: string; content: string }
  /** Delete a file. */
  | { op: "remove"; path: string }
  /** Hand the work over as the agent's `done` tool does once its checks pass. */
  | { op: "done" }
  /** Stop the job as the agent's `halt` tool does, with this reason. */
  | { op: "halt"; reason: string }
  /** Wait. The stub exits early when the builder that started it goes away. */
  | { op: "sleep"; ms: number }
  | { op: "stdout"; text: string }
  | { op: "stderr"; text: string }
  /** Exit now with this code (the stub exits 0 after the last step otherwise). */
  | { op: "exit"; code: number };

export interface Scenario {
  steps: Step[];
}

/** What the stub saw when the builder started it (written to records/<key>.json in the stub directory). */
export interface StubRecord {
  /** The scenario key the stub used (normally the job id), or "default". */
  key: string;
  argv: string[];
  cwd: string;
  /** BUILDER_* and PI_* variables, with anything that looks like a secret redacted. */
  env: Record<string, string>;
  startedAt: string;
}

export const scenario = (...steps: Step[]): Scenario => ({ steps });

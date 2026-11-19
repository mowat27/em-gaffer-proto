/**
 * The context store: runs/<runId>/context/job.json and one outputs/<step>.json per finished step. Only the engine
 * writes it, each file once, and only JSON. Steps read it through StepContext.get, which throws for a step that has
 * not finished.
 *
 * Everything else reads it through readContextJob and findStepOutput (the one implementation): the `context_get`
 * tool (ops/core/observe.ts) for agents, the CLI and UIs, and shared:context's slice summary in the prompt. A step's
 * output is looked up in the run's own store, then in each run above it, so an agent step reads its workflow's.
 */
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Throws unless `v` is plain JSON: null, booleans, finite numbers, strings, arrays and plain objects of them. */
export function assertJson(v: unknown, path = "output"): void {
  if (v === null || typeof v === "string" || typeof v === "boolean") return;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${path} is not JSON: ${v}`);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertJson(x, `${path}[${i}]`));
    return;
  }
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error(`${path} is not JSON: a ${proto?.constructor?.name ?? "non-plain"} object`);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) assertJson(x, `${path}.${k}`);
    return;
  }
  throw new Error(`${path} is not JSON: a ${typeof v}`);
}

const STEP_NAME = /^[\w.-]+$/;

export class ContextStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, "outputs"), { recursive: true });
  }

  private file(step: string): string {
    if (!STEP_NAME.test(step) || step === "." || step === "..") throw new Error(`invalid step name: ${JSON.stringify(step)}`);
    return join(this.dir, "outputs", `${step}.json`);
  }

  /** Write once: a second write of the same file throws. */
  private writeOnce(file: string, value: unknown, what: string): void {
    assertJson(value, what);
    const text = JSON.stringify(value, null, 2) + "\n";
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    try {
      linkSync(tmp, file); // atomic, and fails when the file exists
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${what} is already written: the context store is write-once`);
      throw err;
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  writeJob(job: unknown): void {
    this.writeOnce(join(this.dir, "job.json"), job, "job.json");
  }

  job<T>(): T {
    return JSON.parse(readFileSync(join(this.dir, "job.json"), "utf8")) as T;
  }

  /** A step's output. A step that returns nothing stores null. */
  put(step: string, value: unknown): void {
    this.writeOnce(this.file(step), value === undefined ? null : value, `the output of step ${step}`);
  }

  has(step: string): boolean {
    return existsSync(this.file(step));
  }

  get<T>(step: string): T {
    const file = this.file(step);
    if (!existsSync(file)) throw new Error(`step ${step} has not finished: no output in the context store`);
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/** A run's context/job.json (the dispatch it works on), or undefined when it has none. */
export function readContextJob(runDir: string | undefined): unknown {
  return runDir ? readJson(join(runDir, "context", "job.json")) : undefined;
}

/** A finished step's output: in this run's context store first, then in each run above it (by run.json's parent). */
export function findStepOutput(step: string, runDir: string | undefined): { found: true; value: unknown; run: string } | { found: false } {
  if (!runDir || !STEP_NAME.test(step) || step === "." || step === "..") return { found: false };
  const runsDir = dirname(runDir);
  let dir: string | null = runDir;
  for (let depth = 0; dir && depth < 16; depth++) {
    const file = join(dir, "context", "outputs", `${step}.json`);
    if (existsSync(file)) return { found: true, value: readJson(file), run: dir };
    const parent: string | null | undefined = (readJson(join(dir, "run.json")) as { parent?: string | null } | undefined)?.parent;
    dir = parent ? join(runsDir, parent) : null;
  }
  return { found: false };
}

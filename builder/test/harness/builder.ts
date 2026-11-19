/**
 * Start a build server for a test. This is the only module that knows how the builder is configured and started:
 * today a machine config layer named by $GAFFER_CONFIG (YAML: builder.server.* and builder.pi.command) and
 * `node builder/cli/builder.ts server run` (the server as a run, as systemd starts it), plus a test builder module that
 * imports the real supabase-api builder and replaces only the options a test sets. When the builder's configuration
 * changes, this file changes and the tests do not.
 *
 * Each builder gets its own temp dir: its config, its test builder module, its runs and the pi stub's scenarios and
 * records. pi is the stub (./pi-stub.ts), reached through a launcher that names the stub dir, so a test decides what
 * "the agent" does with `setScenario`. git runs with the user's global config ignored.
 *
 * Where the options go: `capabilities` is the builder's `provides`; `setupCommands` and `baseCheckCommands` are the
 * prepare step's options; `piTimeoutMinutes` is the implement step's budget; `jobTimeoutMinutes`, `callbackRetries` and
 * `keepWorkspaces` are builder.server settings; the stub launcher is builder.pi.command. The builder's classify and
 * scaffold steps run, with the template sets pointed at an empty folder so the scaffold skips.
 *
 * $BUILDER_TREE runs the tests against another builder directory (default: the builder/ this file is in).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FIXTURE_SETUP_COMMANDS } from "./fixture-repo.ts";
import type { Scenario, StubRecord } from "./scenario.ts";
import { freePort, GIT_ENV, http, sleep, tempDir, waitFor } from "./util.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "pi-stub.ts");
const DEFAULT_TREE = resolve(HERE, "..", "..");

export interface StartBuilderOptions {
  /** `requires` entries the builder satisfies besides `repo:*`. Default ["stack:stub"]. */
  capabilities?: string[];
  /** Commands run in the app directory before the agent starts. Default: install the fixture's fake tsc. */
  setupCommands?: string[];
  /** Commands the base must pass after setup. Default ["npx tsc --noEmit"] (today's default). */
  baseCheckCommands?: string[];
  /** How long the agent may run. Default 10. The builder never allows less than 1 minute. */
  piTimeoutMinutes?: number;
  /** How long a whole job may run. Default 20. */
  jobTimeoutMinutes?: number;
  /** Callback retries after the first try. Default 8. */
  callbackRetries?: number;
  /** Job workspaces kept after a job. Default 3. */
  keepWorkspaces?: number;
  /** The builder directory to run. Default $BUILDER_TREE, else this tree's builder/. */
  builderDir?: string;
}

export interface RunningBuilder {
  /** Base URL, e.g. http://127.0.0.1:54321. */
  url: string;
  /** Where the builder keeps its runs (run.json, journal.jsonl, ... per run). */
  runsDir: string;
  /** Its machine config layer (the server reads it through $GAFFER_CONFIG). */
  configFile: string;
  /** What the pi stub does for the job with this id. */
  setScenario(jobId: string, scenario: Scenario): void;
  /** What the pi stub saw for the job, or null when it never ran. */
  stubRecord(jobId: string): StubRecord | null;
  /** Everything the server printed, for failure messages. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * How to start the build server of a builder directory: `cli/builder.ts server run`, or `server.ts` in a tree from
 * before the server became a run (the baseline tree, through $BUILDER_TREE).
 */
export function serverCommand(builderDir: string): string[] {
  const legacy = join(builderDir, "server.ts");
  return existsSync(legacy) ? [legacy] : [join(builderDir, "cli", "builder.ts"), "server", "run"];
}

export async function startBuilder(opts: StartBuilderOptions = {}): Promise<RunningBuilder> {
  const builderDir = resolve(opts.builderDir ?? process.env.BUILDER_TREE ?? DEFAULT_TREE);
  const tmp = tempDir("builder-contract");
  const stubDir = join(tmp.dir, "pi-stub");
  for (const d of [join(stubDir, "scenarios"), join(stubDir, "records")]) mkdirSync(d, { recursive: true });

  // The launcher bakes the stub dir in, so the stub finds its scenarios whatever environment the builder gives pi.
  const launcher = join(tmp.dir, "pi");
  writeFileSync(launcher, `#!/bin/sh\nPI_STUB_DIR='${stubDir}' exec '${process.execPath}' '${STUB}' "$@"\n`);
  chmodSync(launcher, 0o755);

  // The real supabase-api builder with only the builder-level options a test sets replaced. Its template sets point at
  // an empty folder, so the scaffold step always skips ("no template set") and the stub alone decides what the patch
  // holds, whatever templates the builder ships.
  const builderModule = join(tmp.dir, "test-builder.mts");
  const templates = join(tmp.dir, "templates");
  mkdirSync(templates, { recursive: true });
  const options = {
    provides: opts.capabilities ?? ["stack:stub"],
    setup: opts.setupCommands ?? FIXTURE_SETUP_COMMANDS,
    baseCheck: opts.baseCheckCommands ?? ["npx tsc --noEmit"],
    setupTimeoutMinutes: 1,
    implementBudgetMinutes: opts.piTimeoutMinutes ?? 10,
    templates,
  };
  const realBuilder = pathToFileURL(join(builderDir, "agentics", "builders", "supabase-api", "builder.ts")).href;
  writeFileSync(builderModule, `import { supabaseApi } from ${JSON.stringify(realBuilder)};\nexport default supabaseApi(${JSON.stringify(options, null, 2)});\n`);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const configFile = join(tmp.dir, "builder-config.yml");
    const server = {
      host: "127.0.0.1",
      port,
      runsDir: join(tmp.dir, "runs"),
      jobTimeoutMinutes: opts.jobTimeoutMinutes ?? 20,
      keepWorkspaces: opts.keepWorkspaces ?? 3,
      callbackRetries: opts.callbackRetries ?? 8,
      builder: builderModule,
    };
    // YAML; JSON values keep paths with any character safe.
    const yaml = ["builder:", "  server:", ...Object.entries(server).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`), "  pi:", `    command: ${JSON.stringify(launcher)}`, ""].join("\n");
    writeFileSync(configFile, yaml);
    let out = "";
    const child: ChildProcess = spawn(process.execPath, serverCommand(builderDir), {
      cwd: tmp.dir,
      env: { ...process.env, ...GIT_ENV, GAFFER_CONFIG: configFile, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitFor(
        "the builder to answer /health",
        async () => {
          if (child.exitCode !== null) throw new Error(`builder exited ${child.exitCode} on start:\n${out}`);
          try {
            return (await http("GET", `${url}/health`)).status === 200 ? true : undefined;
          } catch {
            return undefined;
          }
        },
        15_000,
      );
    } catch (err) {
      lastError = err as Error;
      child.kill("SIGKILL");
      if (/EADDRINUSE/.test(out)) continue;
      tmp.remove();
      throw err;
    }
    return {
      url,
      runsDir: server.runsDir,
      configFile,
      setScenario: (jobId, scenario) => writeFileSync(join(stubDir, "scenarios", `${jobId}.json`), JSON.stringify(scenario, null, 2)),
      stubRecord: (jobId) => {
        const file = join(stubDir, "records", `${jobId}.json`);
        return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as StubRecord) : null;
      },
      output: () => out,
      stop: async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((r) => child.once("exit", () => r()));
          child.kill("SIGTERM");
          await Promise.race([exited, sleep(5000).then(() => child.kill("SIGKILL"))]);
        }
        // A stub the builder left running notices its parent is gone and exits within a moment.
        await sleep(300);
        tmp.remove();
      },
    };
  }
  tmp.remove();
  throw lastError ?? new Error("could not start the builder");
}

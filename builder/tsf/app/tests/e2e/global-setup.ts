/**
 * Starts the factory every e2e spec runs against: a temp git repo with the factory installed (`makeProject`), then
 * `node bin/tsf.mjs start` on faux with the demo rules. Writes `{ url, pid, root }` to `test-results/factory.json`.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeProject } from "../helpers/project.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.TSF_E2E_PORT) || 48731;
/** The first start may build the web app with Vite. */
const START_TIMEOUT_MS = 240_000;

export default async function globalSetup(): Promise<void> {
  const resultsDir = join(appDir, "test-results");
  const stateFile = join(resultsDir, "factory.json");
  mkdirSync(resultsDir, { recursive: true });
  rmSync(stateFile, { force: true });

  const { root } = await makeProject();
  const logFile = join(resultsDir, "factory.log");
  const fd = openSync(logFile, "w");
  const child = spawn(process.execPath, [join(appDir, "bin", "tsf.mjs"), "start"], {
    cwd: root,
    env: {
      ...process.env,
      TSF_PROJECT: root,
      TSF_MODEL_PROVIDER: "faux",
      TSF_FAUX_RULES: join(appDir, "tests", "fixtures", "faux-demo.ts"),
      TSF_PORT: String(PORT),
      // The jev panel (Settings > Advanced > jev) answers locally and deterministically: no key, no network.
      TSF_JEV_PROVIDER: "faux",
    },
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);

  let exited: string | undefined;
  child.once("exit", (code, signal) => {
    exited = `exited with ${code ?? signal}`;
  });
  child.once("error", (err) => {
    exited = `failed to start: ${err.message}`;
  });

  const read = (): string => {
    try {
      return readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
  };
  const deadline = Date.now() + START_TIMEOUT_MS;
  let url: string | undefined;
  while (url === undefined) {
    const m = /TSF running at (\S+)/.exec(read());
    if (m) {
      url = m[1];
      break;
    }
    if (exited !== undefined || Date.now() > deadline) {
      const why = exited ?? `no "TSF running at" line within ${START_TIMEOUT_MS / 1000}s`;
      if (exited === undefined) child.kill("SIGKILL");
      throw new Error(`the factory ${why}\n--- ${logFile}\n${read().slice(-3000)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  writeFileSync(stateFile, `${JSON.stringify({ url, pid: child.pid, root }, null, 2)}\n`);
  // Do not keep the Playwright runner alive on the child's handles; teardown stops it by pid.
  child.unref();
}

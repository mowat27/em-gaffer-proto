/** core/systemd.ts (DESIGN 12): the unit name, and stop and status when a unit is installed. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectPaths } from "../../src/core/paths.ts";
import { writeServerState } from "../../src/core/lock.ts";
import { unitName } from "../../src/core/systemd.ts";
import { runCli } from "../../src/main.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

let out = "";
let errOut = "";

beforeEach(() => {
  out = "";
  errOut = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => ((out += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => ((errOut += String(c)), true));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupTmp();
});

async function project(name = "tsf-sysd"): Promise<ReturnType<typeof projectPaths>> {
  const root = join(await tmpDir("tsf-sysd"), name);
  const paths = projectPaths(root);
  await mkdir(paths.dataDir, { recursive: true });
  vi.stubEnv("TSF_PROJECT", root);
  vi.stubEnv("TSF_SKILL_DIR", "/home/exe/skills/tsf");
  return paths;
}

describe("unit name", () => {
  it("names the unit after the project folder, made safe", () => {
    expect(unitName("/home/x/demo")).toBe("tsf-demo.service");
    expect(unitName("/home/x/my project!")).toBe("tsf-my-project-.service");
  });
});

describe("stop and status with a unit installed", () => {
  it("stop says systemd owns the process unless --force; status shows the unit", async () => {
    const paths = await project();
    const units = join(paths.dataDir, "units");
    await mkdir(units, { recursive: true });
    await writeFile(join(units, "tsf-tsf-sysd.service"), "[Unit]\n");
    vi.stubEnv("TSF_SYSTEMD_DIR", units);
    // our own pid stands in for a live server: stop must not signal it
    await writeServerState(paths.serverState, { pid: process.pid, url: "http://127.0.0.1:1", host: "127.0.0.1", port: 1, bootId: 1, startedAt: 1 });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await runCli(["stop"])).toBe(0);
    expect(out).toContain("managed by systemd: sudo systemctl stop tsf-tsf-sysd.service");
    expect(kill).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
    kill.mockRestore();
  });

  it("status of a stopped factory points at systemctl start", async () => {
    const paths = await project();
    const units = join(paths.dataDir, "units");
    await mkdir(units, { recursive: true });
    await writeFile(join(units, "tsf-tsf-sysd.service"), "[Unit]\n");
    vi.stubEnv("TSF_SYSTEMD_DIR", units);
    expect(await runCli(["status"])).toBe(3);
    expect(out).toContain("not running");
    expect(out).toContain("sudo systemctl start tsf-tsf-sysd.service");
  });
});

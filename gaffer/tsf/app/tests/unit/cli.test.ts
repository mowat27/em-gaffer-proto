import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeServerState } from "../../src/core/lock.ts";
import { appDir, projectPaths } from "../../src/core/paths.ts";
import { runCli } from "../../src/main.ts";
import { exec } from "../helpers/project.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

let out = "";
let errOut = "";
let server: Server | undefined;

beforeEach(() => {
  out = "";
  errOut = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    errOut += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  await cleanupTmp();
});

async function project(): Promise<ReturnType<typeof projectPaths>> {
  const root = await tmpDir("tsf-cli");
  const paths = projectPaths(root);
  await mkdir(paths.dataDir, { recursive: true });
  vi.stubEnv("TSF_PROJECT", root);
  return paths;
}

function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""]);
    const pid = child.pid!;
    child.on("exit", () => resolve(pid));
  });
}

async function stubServer(body: unknown): Promise<string> {
  server = createServer((req, res) => {
    if (req.url === "/api/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("status", () => {
  it("prints not running and exits 3 with no server.json", async () => {
    await project();
    expect(await runCli(["status"])).toBe(3);
    expect(out).toContain("not running");
  });

  it("explains a missing tsf/ folder", async () => {
    const root = await tmpDir("tsf-cli");
    vi.stubEnv("TSF_PROJECT", root);
    expect(await runCli(["status"])).toBe(3);
    expect(out).toContain("not running");
    expect(out).toContain("run /tsf install");
  });

  it("treats a server.json with a dead pid as not running", async () => {
    const paths = await project();
    await writeServerState(paths.serverState, {
      pid: await deadPid(),
      url: "http://127.0.0.1:1",
      host: "127.0.0.1",
      port: 1,
      bootId: 1,
      startedAt: 1,
    });
    expect(await runCli(["status"])).toBe(3);
    expect(out).toContain("not running");
  });

  it("prints the url from server.json and the status fields", async () => {
    const paths = await project();
    const url = await stubServer({
      name: "TSF",
      projectRoot: paths.projectRoot,
      model: { provider: "faux", modelId: "faux-1" },
      busy: true,
    });
    await writeServerState(paths.serverState, { pid: process.pid, url, host: "127.0.0.1", port: 1, bootId: 1, startedAt: 1 });
    // a flag or env cannot redirect the CLI: only server.json counts
    vi.stubEnv("TSF_PORT", "9");
    expect(await runCli(["status", "--port", "9"])).toBe(0);
    expect(out).toContain(url);
    expect(out).toContain("faux/faux-1");
    expect(out).toMatch(/busy\s+yes/);
  });

  it("--json prints running, url and the raw status", async () => {
    const paths = await project();
    const url = await stubServer({ name: "TSF", busy: false });
    await writeServerState(paths.serverState, { pid: process.pid, url, host: "127.0.0.1", port: 1, bootId: 1, startedAt: 1 });
    expect(await runCli(["status", "--json"])).toBe(0);
    expect(JSON.parse(out)).toEqual({ running: true, url, status: { name: "TSF", busy: false } });
  });

  it("reports a live pid whose server does not answer", async () => {
    const paths = await project();
    const url = await stubServer({});
    await new Promise<void>((r) => server!.close(() => r()));
    await writeServerState(paths.serverState, { pid: process.pid, url, host: "127.0.0.1", port: 1, bootId: 1, startedAt: 1 });
    expect(await runCli(["status"])).toBe(1);
    expect(out).toContain("GET /api/status failed");
  });

  it("prints starting for a live lock pid without server.json", async () => {
    const paths = await project();
    await writeFile(paths.lockFile, `${process.pid}\n`);
    expect(await runCli(["status"])).toBe(0);
    expect(out).toContain("starting");
  });
});

describe("stop", () => {
  it("with a dead pid reports not running and clears the stale server.json", async () => {
    const paths = await project();
    await writeServerState(paths.serverState, {
      pid: await deadPid(),
      url: "http://127.0.0.1:1",
      host: "127.0.0.1",
      port: 1,
      bootId: 1,
      startedAt: 1,
    });
    expect(await runCli(["stop"])).toBe(0);
    expect(out).toContain("not running");
    expect(await runCli(["status"])).toBe(3);
  });

  it("with nothing recorded reports not running", async () => {
    await project();
    expect(await runCli(["stop"])).toBe(0);
    expect(out).toContain("not running");
  });

  it("sends SIGTERM to the recorded pid and reports stopped", async () => {
    const paths = await project();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>((r) => child.on("exit", () => r()));
    await writeFile(paths.lockFile, `${child.pid}\n`);
    await writeServerState(paths.serverState, {
      pid: child.pid!,
      url: "http://127.0.0.1:1",
      host: "127.0.0.1",
      port: 1,
      bootId: 1,
      startedAt: 1,
    });
    expect(await runCli(["stop"])).toBe(0);
    expect(out).toContain("stopped");
    await exited;
  });
});

describe("other commands", () => {
  it("an unknown command and no command exit 2", async () => {
    expect(await runCli(["frobnicate"])).toBe(2);
    expect(errOut).toContain("unknown command frobnicate");
    expect(await runCli([])).toBe(2);
  });

  it("start rejects a bad port before loading the server", async () => {
    expect(await runCli(["start", "--port", "99999"])).toBe(2);
    expect(errOut).toContain("--port must be an integer");
  });

  it("logs prints the end of the log file", async () => {
    const paths = await project();
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(join(paths.logsDir, "tsf.log"), ["one", "two", "three", "four"].join("\n") + "\n");
    expect(await runCli(["logs", "-n", "2"])).toBe(0);
    expect(out).toBe("three\nfour\n");
  });
});

describe("bin/tsf.mjs", () => {
  it("runs the CLI end to end: status with no server exits 3", async () => {
    const root = await tmpDir("tsf-cli");
    await mkdir(join(root, "tsf", "data"), { recursive: true });
    const r = await exec("node", [join(appDir, "bin", "tsf.mjs"), "status"], {
      cwd: root,
      env: { ...process.env, TSF_PROJECT: root },
    });
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("not running");
  }, 120_000);
});

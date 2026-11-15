import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appDir, projectPaths, resolveProjectRoot, skillDir } from "../../src/core/paths.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

beforeEach(() => {
  vi.stubEnv("TSF_PROJECT", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTmp();
});

describe("resolveProjectRoot", () => {
  it("TSF_PROJECT wins over everything", async () => {
    const repo = await tmpDir("tsf-paths");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const other = await tmpDir("tsf-paths-other");
    vi.stubEnv("TSF_PROJECT", other);
    expect(resolveProjectRoot(repo)).toBe(other);
  });

  it("a tsf/ in a subfolder of a git repo wins over the toplevel", async () => {
    const repo = await tmpDir("tsf-paths");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const sub = join(repo, "apps", "web");
    await mkdir(join(sub, "tsf", "pages", "deep"), { recursive: true });
    await writeFile(join(sub, "tsf", "mod.just"), "# mod\n");
    expect(resolveProjectRoot(join(sub, "tsf", "pages", "deep"))).toBe(sub);
    expect(resolveProjectRoot(sub)).toBe(sub);
  });

  it("falls back to the git toplevel", async () => {
    const repo = await tmpDir("tsf-paths");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const sub = join(repo, "a", "b");
    await mkdir(sub, { recursive: true });
    expect(resolveProjectRoot(sub)).toBe(repo);
  });

  it("falls back to cwd outside a repo", async () => {
    const dir = await tmpDir("tsf-paths");
    expect(resolveProjectRoot(dir)).toBe(dir);
  });
});

describe("projectPaths", () => {
  it("lays out tsf/ and the skill", () => {
    const p = projectPaths("/work/proj");
    expect(p.tsfDir).toBe("/work/proj/tsf");
    expect(p.pagesDir).toBe("/work/proj/tsf/pages");
    expect(p.layersDir).toBe("/work/proj/tsf/layers");
    expect(p.dataDir).toBe("/work/proj/tsf/data");
    expect(p.logsDir).toBe("/work/proj/tsf/data/logs");
    expect(p.agentDb).toBe("/work/proj/tsf/data/agent.sqlite");
    expect(p.appDb).toBe("/work/proj/tsf/data/tsf.sqlite");
    expect(p.lockFile).toBe("/work/proj/tsf/data/agent.sqlite.lock");
    expect(p.serverState).toBe("/work/proj/tsf/data/server.json");
    expect(p.envFile).toBe("/work/proj/tsf/.env");
    expect(p.permissionsFile).toBe("/work/proj/tsf/permissions.json");
    expect(p.skillDir).toBe(skillDir);
    expect(p.appDir).toBe(appDir);
    expect(p.builtinLayersDir).toBe(join(appDir, "src", "layers"));
    expect(p.webSrc).toBe(join(appDir, "src", "web"));
    expect(p.distDir).toBe(join(appDir, "dist"));
  });

  it("finds the app and skill directories from the module location", () => {
    expect(appDir.endsWith(join("skills", "tsf", "app"))).toBe(true);
    expect(skillDir.endsWith(join("skills", "tsf"))).toBe(true);
  });
});

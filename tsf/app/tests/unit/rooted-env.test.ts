import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTECTED, protectedPaths, RootedEnv } from "../../src/agent/rooted-env.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

const ctx = BACKGROUND_CONTEXT;

let root: string;
let outside: string;
let env: RootedEnv;

beforeEach(async () => {
  root = await tmpDir("rooted-root");
  outside = await tmpDir("rooted-outside");
  await mkdir(join(root, "tsf", "data"), { recursive: true });
  await mkdir(join(root, "tsf", "pages"), { recursive: true });
  await writeFile(join(root, "tsf", "permissions.json"), "{}");
  await writeFile(join(root, "tsf", ".env"), "K=v");
  await writeFile(join(root, "tsf", ".env.example"), "K=");
  await writeFile(join(root, "tsf", "data", "x"), "x");
  await writeFile(join(root, "a.txt"), "a");
  await writeFile(join(outside, "secret.txt"), "secret");
  env = new RootedEnv(root);
});

afterEach(cleanupTmp);

async function check(path: string) {
  return env.absolutePath(path, ctx);
}

async function denied(path: string): Promise<string> {
  const r = await check(path);
  expect(r.ok, `${path} should be denied`).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.error.code).toBe("permission_denied");
  return r.error.message;
}

describe("RootedEnv", () => {
  it("allows a relative path inside the project", async () => {
    const r = await check("a.txt");
    expect(r).toEqual({ ok: true, value: join(root, "a.txt") });
    expect((await check("tsf/pages/Start Here.md")).ok).toBe(true);
    expect((await check(".")).ok).toBe(true);
  });

  it("allows a new file in a new nested folder inside", async () => {
    const r = await check("new/deep/er/file.md");
    expect(r).toEqual({ ok: true, value: join(root, "new", "deep", "er", "file.md") });
  });

  it("allows a missing file inside, so the tool reports its own not-found", async () => {
    expect((await check("missing.txt")).ok).toBe(true);
    const read = await env.readTextFile(join(root, "missing.txt"), ctx);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("not_found");
  });

  it("denies ../x, an absolute path outside and ~/x", async () => {
    expect(await denied("../x")).toMatch(/outside the project/);
    expect(await denied("/etc/hosts")).toMatch(/outside the project/);
    expect(await denied("~/x")).toMatch(/outside the project/);
    expect(await denied(`${outside}/new.txt`)).toMatch(/outside the project/);
    // the sibling whose name starts with the root's name is outside too
    expect(await denied(`${root}-sibling/x`)).toMatch(/outside the project/);
    expect(homedir().startsWith(realpathSync(root))).toBe(false);
  });

  it("denies a symlink that points out", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    await denied("link.txt");
  });

  it("denies a dangling symlink whose target is outside (a write would create it there)", async () => {
    await symlink(join(outside, "not-yet.txt"), join(root, "dangling.txt"));
    await denied("dangling.txt");
  });

  it("denies a symlink loop", async () => {
    await symlink(join(root, "loop-b"), join(root, "loop-a"));
    await symlink(join(root, "loop-a"), join(root, "loop-b"));
    await denied("loop-a");
  });

  it("denies a new file under a symlinked folder that points out", async () => {
    await symlink(outside, join(root, "out"));
    await denied("out/new/file.txt");
    await denied("out/secret.txt");
  });

  it("allows a symlink that stays inside", async () => {
    await symlink(join(root, "tsf", "pages"), join(root, "pages-link"));
    expect((await check("pages-link/new.md")).ok).toBe(true);
  });

  it("denies the protected paths, however they are spelled", async () => {
    expect(PROTECTED).toEqual([
      "tsf/permissions.json",
      "tsf/.env",
      "tsf/data",
      "tsf/layers",
      "tsf/mod.just",
      "tsf/app/node_modules",
      "tsf/app/.tsf-base",
    ]);
    expect(await denied("tsf/permissions.json")).toMatch(/protected/);
    expect(await denied("tsf/.env")).toMatch(/protected/);
    expect(await denied("tsf/data/x")).toMatch(/protected/);
    await denied("tsf/data/new/deeper.txt");
    await denied("tsf/data");
    await denied("tsf/pages/../data/x");
    await denied(join(root, "tsf", "permissions.json"));
    await denied("./tsf/./.env");
    // Code the factory runs without asking: a project layer is imported into the server at the next start.
    expect(await denied("tsf/layers/evil/extension.ts")).toMatch(/protected path: tsf\/layers/);
    await denied("tsf/layers/evil/manifest.ts");
    await denied("tsf/layers");
    await denied("tsf/mod.just");
  });

  it("protects the skill folder when the project contains it, and only then", async () => {
    expect(protectedPaths(root, join(root, "skills", "tsf"))).toEqual([...PROTECTED, join("skills", "tsf")]);
    expect(protectedPaths(root, join(outside, "skills", "tsf"))).toEqual(PROTECTED);
    expect(protectedPaths(root, root)).toEqual([...PROTECTED, "."]);
    const withSkill = new RootedEnv(root, { protectedPaths: protectedPaths(root, join(root, "skills", "tsf")) });
    expect((await withSkill.absolutePath("skills/tsf/app/src/main.ts", ctx)).ok).toBe(false);
    expect((await withSkill.absolutePath("skills/other/x.md", ctx)).ok).toBe(true);
  });

  it("denies a protected path reached through a symlink", async () => {
    await symlink(join(root, "tsf", "data"), join(root, "d"));
    await denied("d/x");
    await symlink(join(root, "tsf", "permissions.json"), join(root, "perm"));
    await denied("perm");
  });

  it("denies a protected path spelled with other case on a case-insensitive file system", async () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return;
    await denied("TSF/Data/x");
    await denied("tsf/PERMISSIONS.json");
  });

  it("does not protect siblings that share a prefix", async () => {
    expect((await check("tsf/.env.example")).ok).toBe(true);
    expect((await check("tsf/data-notes.md")).ok).toBe(true);
    expect((await check("tsf/permissions.json.bak")).ok).toBe(true);
    expect((await check("tsf/layers-notes.md")).ok).toBe(true);
  });

  it("takes extra protected paths", async () => {
    const strict = new RootedEnv(root, { protectedPaths: ["tsf/pages"] });
    expect((await strict.absolutePath("tsf/pages/x.md", ctx)).ok).toBe(false);
    expect((await strict.absolutePath("tsf/data/x", ctx)).ok).toBe(true);
  });

  it("a root that is itself reached through a symlink still works", async () => {
    const viaLink = join(outside, "root-link");
    await symlink(root, viaLink);
    const linked = new RootedEnv(viaLink);
    expect((await linked.absolutePath("a.txt", ctx)).ok).toBe(true);
    expect((await linked.absolutePath("tsf/data/x", ctx)).ok).toBe(false);
    expect((await linked.absolutePath("../x", ctx)).ok).toBe(false);
  });

  it("runs commands in the project", async () => {
    let out = "";
    const r = await env.exec("pwd -P", { onOutput: (text) => void (out += text) }, ctx);
    expect(r.ok).toBe(true);
    expect(out.trim()).toBe(realpathSync(root));
  });
});

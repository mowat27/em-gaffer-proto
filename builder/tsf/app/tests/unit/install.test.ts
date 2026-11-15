import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { skillDir } from "../../src/core/paths.ts";
import { installScript } from "../helpers/project.ts";
import { exec, runInstall } from "../helpers/project.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

afterEach(cleanupTmp);

async function gitRepo(): Promise<string> {
  const dir = await tmpDir("tsf-install");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/** Report lines as `[word, rest]`, without the `target` line and the next-steps text. */
function items(stdout: string): [string, string][] {
  return stdout
    .split("\n")
    .map((l) => /^(stamped|created|appended|kept)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!, m[2]!]);
}

const wordOf = (list: [string, string][], path: string): string | undefined => list.find(([, p]) => p === path)?.[0];

describe("scripts/install.sh", () => {
  it("prints the target first and gives each item type its word", async () => {
    const dir = await gitRepo();
    const r = await runInstall(dir);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe(`target ${dir}`);
    const list = items(r.stdout);
    for (const d of ["tsf/", "tsf/pages/", "tsf/layers/", "tsf/data/"]) expect(wordOf(list, d)).toBe("created");
    for (const f of ["mod.just", "permissions.json", ".env.example", "pages/Start Here.md", "layers/.gitkeep"]) {
      expect(wordOf(list, `tsf/${f}`)).toBe("stamped");
    }
    expect(wordOf(list, ".gitignore (tsf/.env, tsf/data/)")).toBe("created");
    expect(wordOf(list, "justfile (mod tsf)")).toBe("created");
    // fixed column: the word is padded to 8 characters plus a space
    expect(r.stdout).toContain("stamped  tsf/mod.just\n");
    expect(r.stdout).toContain("created  tsf/\n");
    for (const f of ["mod.just", "permissions.json", ".env.example", "pages/Start Here.md", "layers/.gitkeep"]) {
      expect(existsSync(join(dir, "tsf", f))).toBe(true);
    }
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("tsf/.env\ntsf/data/\n");
  });

  it("a second run reports only kept and changes nothing", async () => {
    const dir = await gitRepo();
    await runInstall(dir);
    const before = await readFile(join(dir, "tsf", "mod.just"), "utf8");
    const justfile = await readFile(join(dir, "justfile"), "utf8");
    const r = await runInstall(dir);
    expect(r.code).toBe(0);
    const list = items(r.stdout);
    expect(list.length).toBeGreaterThan(10);
    expect(list.every(([w]) => w === "kept")).toBe(true);
    expect(r.stdout).not.toMatch(/^(stamped|created|appended) /m);
    expect(await readFile(join(dir, "tsf", "mod.just"), "utf8")).toBe(before);
    expect(await readFile(join(dir, "justfile"), "utf8")).toBe(justfile);
    expect((await readFile(join(dir, ".gitignore"), "utf8")).match(/tsf\/data\//g)).toHaveLength(1);
  });

  it("never overwrites a file the user owns", async () => {
    const dir = await gitRepo();
    await mkdir(join(dir, "tsf"), { recursive: true });
    await writeFile(join(dir, "tsf", "permissions.json"), '{"allow":["page_harness.*"],"deny":[]}\n');
    const r = await runInstall(dir);
    expect(wordOf(items(r.stdout), "tsf/permissions.json")).toBe("kept");
    expect(await readFile(join(dir, "tsf", "permissions.json"), "utf8")).toBe('{"allow":["page_harness.*"],"deny":[]}\n');
  });

  it("appends to an existing .gitignore and justfile", async () => {
    const dir = await gitRepo();
    await writeFile(join(dir, ".gitignore"), "node_modules/"); // no trailing newline
    await writeFile(join(dir, "justfile"), 'set shell := ["zsh", "-cu"]\n\n# Say hi\nhello:\n    @echo hi');
    const r = await runInstall(dir);
    const list = items(r.stdout);
    expect(wordOf(list, ".gitignore (tsf/.env)")).toBe("appended");
    expect(wordOf(list, ".gitignore (tsf/data/)")).toBe("appended");
    expect(wordOf(list, "justfile (mod tsf)")).toBe("appended");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\ntsf/.env\ntsf/data/\n");
    const justfile = await readFile(join(dir, "justfile"), "utf8");
    expect(justfile).toContain("@echo hi\n");
    expect(justfile).toMatch(/\n# TSF: Tiny Software Factory[^\n]*\nmod tsf\n$/);
    const second = items((await runInstall(dir)).stdout);
    expect(second.every(([w]) => w === "kept")).toBe(true);
  });

  it("treats an existing optional `mod? tsf` line as registered", async () => {
    const dir = await gitRepo();
    const text = "# Mine\nmod? tsf\n";
    await writeFile(join(dir, "justfile"), text);
    const r = await runInstall(dir);
    expect(r.code).toBe(0);
    const entry = items(r.stdout).find(([, p]) => p.startsWith("justfile"));
    expect(entry?.[0]).toBe("kept");
    expect(entry?.[1]).toContain("already registered");
    expect(await readFile(join(dir, "justfile"), "utf8")).toBe(text);
  });

  it("refuses to install inside the skill directory", async () => {
    const before = await readdir(join(skillDir, "template"));
    const r = await runInstall(join(skillDir, "template"));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("refusing to install inside the skill directory");
    expect(r.stdout).not.toMatch(/^(stamped|created|appended) /m);
    expect(await readdir(join(skillDir, "template"))).toEqual(before);
    expect(existsSync(join(skillDir, "template", "tsf"))).toBe(false);
  });

  it("reports kept, not an error, when the root justfile already defines a recipe named tsf", async () => {
    const dir = await gitRepo();
    await writeFile(join(dir, "justfile"), "# Mine\ntsf *ARGS:\n    @echo mine\n");
    const r = await runInstall(dir);
    expect(r.code).toBe(0);
    const entry = items(r.stdout).find(([, p]) => p.startsWith("justfile"));
    expect(entry?.[0]).toBe("kept");
    expect(entry?.[1]).toContain("recipe tsf");
    expect(await readFile(join(dir, "justfile"), "utf8")).toBe("# Mine\ntsf *ARGS:\n    @echo mine\n");
    const list = await exec("just", ["--list"], { cwd: dir });
    expect(list.code).toBe(0);
  });

  it("registers the mod: just --list shows tsf and every recipe", async () => {
    const dir = await gitRepo();
    await runInstall(dir);
    const list = await exec("just", ["--list"], { cwd: dir });
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/^\s*tsf\b/m);
    const all = await exec("just", ["--list", "--list-submodules"], { cwd: dir });
    for (const name of ["start", "stop", "status", "logs", "push"]) expect(all.stdout).toContain(name);
  });

  it("the stamped mod exports TSF_PROJECT = the install dir and resolves the skill from TSF_SKILL_DIR", async () => {
    const dir = await gitRepo();
    await runInstall(dir);
    const mod = join(dir, "tsf", "mod.just");
    const env = { ...process.env };
    delete env.TSF_SKILL_DIR;
    const evaluated = await exec("just", ["--justfile", mod, "--evaluate"], { cwd: join(dir, "tsf"), env });
    expect(evaluated.code).toBe(0);
    expect(evaluated.stdout).toMatch(new RegExp(`^TSF_PROJECT\\s*:= "${dir}"$`, "m"));
    // unset: the stamped absolute path
    const stamped = await exec("just", ["--justfile", mod, "--evaluate", "skill"], { cwd: dir, env });
    expect(stamped.stdout.trim()).toBe(skillDir);
    expect(await readFile(mod, "utf8")).not.toContain("__SKILL_DIR__");
    // set: the override
    const overridden = await exec("just", ["--justfile", mod, "--evaluate", "skill"], {
      cwd: dir,
      env: { ...env, TSF_SKILL_DIR: "/x" },
    });
    expect(overridden.stdout.trim()).toBe("/x");
  });

  it("installs into a repo subfolder, not the git toplevel", async () => {
    const top = await gitRepo();
    const sub = join(top, "apps", "factory");
    await mkdir(sub, { recursive: true });
    const r = await runInstall(sub);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe(`target ${sub}`);
    expect(existsSync(join(sub, "tsf", "mod.just"))).toBe(true);
    expect(existsSync(join(sub, "justfile"))).toBe(true);
    expect(existsSync(join(sub, ".gitignore"))).toBe(true);
    expect(existsSync(join(top, "tsf"))).toBe(false);
    expect(existsSync(join(top, "justfile"))).toBe(false);
    const evaluated = await exec("just", ["--justfile", join(sub, "tsf", "mod.just"), "--evaluate", "TSF_PROJECT"], { cwd: sub });
    expect(evaluated.stdout.trim()).toBe(sub);
  });

  it("stamps the template content", async () => {
    const dir = await gitRepo();
    await runInstall(dir);
    const perms = JSON.parse(await readFile(join(dir, "tsf", "permissions.json"), "utf8")) as { allow: string[]; deny: string[] };
    expect(perms).toEqual({ allow: ["*"], deny: [] });
    const page = await readFile(join(dir, "tsf", "pages", "Start Here.md"), "utf8");
    expect(page.startsWith("# Start Here\n")).toBe(true);
    expect(page).toContain("Explain the basics of Python, TypeScript and Rust in nested folders in our pages.");
    const envExample = await readFile(join(dir, "tsf", ".env.example"), "utf8");
    for (const key of ["OPENROUTER_API_KEY=", "TYPESAFE_API_KEY=", "TSF_HOST=127.0.0.1", "TSF_PORT=8000", "agent-vault"]) {
      expect(envExample).toContain(key);
    }
    expect(envExample).toMatch(/^# TSF_MODEL_PROVIDER=faux$/m);
  });
});

describe("scripts/install.sh: the tsf/app copy", () => {
  const withApp = { TSF_INSTALL_NO_APP: "" };

  it("copies the app, leaves out installed and built folders, keeps the vendored @pw/ui and records the base", async () => {
    const dir = await gitRepo();
    const r = await runInstall(dir, withApp);
    expect(r.code).toBe(0);
    expect(wordOf(items(r.stdout), "tsf/app/ (copy of the skill app; tsf/app/.tsf-base records its base)")).toBe("stamped");
    const app = join(dir, "tsf", "app");
    for (const f of ["package.json", "bin/tsf.mjs", "src/main.ts", "src/web/index.html", "src/server/main.ts", "tsconfig.json", "vite.config.ts", ".tsf-base"]) {
      expect(existsSync(join(app, f)), f).toBe(true);
    }
    for (const f of ["node_modules", "dist", ".vite", "test-results", "playwright-report"]) expect(existsSync(join(app, f)), f).toBe(false);

    const skillPkg = JSON.parse(await readFile(join(skillDir, "app", "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
    const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
    // The dependency is a tarball inside the app, so the copied spec resolves in the copy.
    const spec = pkg.dependencies["@pw/ui"]!;
    expect(spec).toMatch(/^file:vendor\/.+\.tgz$/);
    expect(existsSync(join(app, spec.slice("file:".length)))).toBe(true);
    expect(pkg).toEqual(skillPkg);

    const base = JSON.parse(await readFile(join(app, ".tsf-base"), "utf8")) as { appVersion: string; skillDir: string; commit: string | null; date: string };
    expect(base.appVersion).toBe(skillPkg.version);
    expect(base.skillDir).toBe(skillDir);
    expect(Number.isNaN(Date.parse(base.date))).toBe(false);
    const head = await exec("git", ["-C", skillDir, "rev-parse", "HEAD"], { cwd: dir });
    expect(base.commit).toBe(head.code === 0 ? head.stdout.trim() : null);

    const ignore = await readFile(join(dir, ".gitignore"), "utf8");
    for (const line of ["tsf/app/node_modules/", "tsf/app/dist/", "tsf/app/.vite/"]) expect(ignore).toContain(line);
  });

  it("makes the mod run the project's own launcher, and the skill's without a copy", async () => {
    const dir = await gitRepo();
    await runInstall(dir, withApp);
    const own = await exec("just", ["--justfile", join(dir, "tsf", "mod.just"), "--evaluate", "launcher"], { cwd: dir });
    expect(own.stdout.trim()).toBe(join(dir, "tsf", "app", "bin", "tsf.mjs"));
    const plain = await gitRepo();
    await runInstall(plain);
    const shared = await exec("just", ["--justfile", join(plain, "tsf", "mod.just"), "--evaluate", "launcher"], { cwd: plain });
    expect(shared.stdout.trim()).toBe(join(skillDir, "app", "bin", "tsf.mjs"));
  });

  it("keeps an existing tsf/app untouched on a re-stamp", async () => {
    const dir = await gitRepo();
    await runInstall(dir, withApp);
    const edited = join(dir, "tsf", "app", "src", "web", "App.tsx");
    await writeFile(edited, "// the agent was here\n");
    const baseBefore = await readFile(join(dir, "tsf", "app", ".tsf-base"), "utf8");
    const again = await runInstall(dir, withApp);
    expect(again.code).toBe(0);
    expect(wordOf(items(again.stdout), "tsf/app/")).toBe("kept");
    expect(await readFile(edited, "utf8")).toBe("// the agent was here\n");
    expect(await readFile(join(dir, "tsf", "app", ".tsf-base"), "utf8")).toBe(baseBefore);
    expect(again.stdout).not.toContain("Next steps");
  });

  it("skips the copy with --no-app and with TSF_INSTALL_NO_APP=1", async () => {
    const a = await gitRepo();
    const r = await exec("bash", [installScript, "--no-app"], { cwd: a, env: { ...process.env, TSF_INSTALL_NO_APP: "" } });
    expect(r.code).toBe(0);
    expect(existsSync(join(a, "tsf", "app"))).toBe(false);
    expect(r.stdout).not.toContain("tsf/app");
    expect(await readFile(join(a, ".gitignore"), "utf8")).not.toContain("tsf/app");
    const b = await gitRepo();
    expect((await runInstall(b, { TSF_INSTALL_NO_APP: "1" })).code).toBe(0);
    expect(existsSync(join(b, "tsf", "app"))).toBe(false);
    const bad = await exec("bash", [installScript, "--bogus"], { cwd: await gitRepo() });
    expect(bad.code).toBe(2);
  });
});

/**
 * Deploy keys per target repository: vm/repo-key.sh (on the VM) and `vm.sh key` (on the laptop), here with a temp
 * HOME, and stand-ins for ssh (runs the command locally) and gh (a file of registered keys). GitHub accepts a deploy key
 * on one repository only, so each repository gets its own key, and git picks it by the repository's URL.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "../harness/util.ts";

const VM = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "vm");
const tmp = tempDir("builder-repo-key");
after(() => tmp.remove());

/** A VM's home: github.com already in known_hosts, so nothing reaches the network. */
function home(name: string): string {
  const h = join(tmp.dir, name);
  mkdirSync(join(h, ".ssh"), { recursive: true });
  writeFileSync(join(h, ".ssh", "known_hosts"), "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n");
  return h;
}
const envFor = (h: string, extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "", HOME: h, GIT_CONFIG_NOSYSTEM: "1", ...extra });
const repoKey = (h: string, ...args: string[]) => spawnSync("bash", [join(VM, "repo-key.sh"), ...args], { env: envFor(h), encoding: "utf8" });

/** The host git's ssh is asked to connect to for `url` (a stand-in ssh records its arguments and fails). */
function sshHostFor(h: string, url: string): string {
  const rec = join(h, "ssh-args");
  const fake = join(h, "fake-ssh");
  writeFileSync(fake, `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(rec)}\nexit 1\n`);
  chmodSync(fake, 0o755);
  spawnSync("git", ["ls-remote", url], { env: envFor(h, { GIT_SSH: fake }), encoding: "utf8" });
  return readFileSync(rec, "utf8").split("\n").find((a) => a.includes("github.com")) ?? "";
}

describe("vm/repo-key.sh", () => {
  it("one key per repository, an ssh alias with that key only, and git rewriting the repository's URLs to it", () => {
    const h = home("vm-a");
    const app = repoKey(h, "acme/app");
    const admin = repoKey(h, "acme/app-admin.git");
    assert.equal(app.status, 0, app.stderr);
    assert.equal(admin.status, 0, admin.stderr);
    const appPub = readFileSync(join(h, ".ssh", "builder_deploy_acme_app.pub"), "utf8");
    assert.equal(app.stdout, appPub, "prints the public key, nothing else");
    assert.notEqual(appPub, readFileSync(join(h, ".ssh", "builder_deploy_acme_app-admin.pub"), "utf8"), "a key of its own per repository");

    const g = spawnSync("ssh", ["-G", "-F", join(h, ".ssh", "config"), "github.com-builder-acme_app"], { encoding: "utf8" }).stdout;
    assert.match(g, /^hostname github\.com$/m);
    assert.match(g, /^user git$/m);
    assert.match(g, /^identitiesonly yes$/m);
    assert.ok(g.includes(`identityfile ${join(h, ".ssh", "builder_deploy_acme_app")}`), g);

    // Each form of the repository's URL goes through its alias; the longest match wins for app-admin.
    assert.equal(sshHostFor(h, "git@github.com:acme/app.git"), "git@github.com-builder-acme_app");
    assert.equal(sshHostFor(h, "ssh://git@github.com/acme/app.git"), "git@github.com-builder-acme_app");
    assert.equal(sshHostFor(h, "https://github.com/acme/app"), "git@github.com-builder-acme_app");
    assert.equal(sshHostFor(h, "git@github.com:acme/app-admin.git"), "git@github.com-builder-acme_app-admin");

    // Again: the same key, no second alias or rewrite.
    const again = repoKey(h, "acme/app");
    assert.equal(again.stdout, appPub);
    assert.equal(readFileSync(join(h, ".ssh", "config"), "utf8").split("Host github.com-builder-acme_app\n").length, 2);
    const rewrites = spawnSync("git", ["config", "--global", "--get-all", "url.git@github.com-builder-acme_app:acme/app.insteadOf"], { env: envFor(h), encoding: "utf8" }).stdout.trim().split("\n");
    assert.deepEqual(rewrites, ["git@github.com:acme/app", "ssh://git@github.com/acme/app", "https://github.com/acme/app"]);
  });

  it("--adopt takes the VM's old single key for the repository it is registered on; a bad name is refused", () => {
    const h = home("vm-b");
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(h, ".ssh", "builder_deploy")]);
    const r = repoKey(h, "acme/app", "--adopt");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, readFileSync(join(h, ".ssh", "builder_deploy.pub"), "utf8"));
    assert.equal(readFileSync(join(h, ".ssh", "builder_deploy_acme_app"), "utf8"), readFileSync(join(h, ".ssh", "builder_deploy"), "utf8"));
    assert.equal(repoKey(h, "not a repo").status, 2);
  });
});

describe("vm.sh key", () => {
  const bin = join(tmp.dir, "bin");
  const keys = join(tmp.dir, "registered");
  const calls = join(tmp.dir, "gh-calls");
  mkdirSync(bin, { recursive: true });
  // ssh: run the command in the VM's home (the last argument; stdin passed on).
  writeFileSync(join(bin, "ssh"), `#!/bin/bash\ncmd="\${@: -1}"\ncd "$HOME" && exec bash -c "$cmd"\n`);
  // gh: the registered keys of every repository in one file, "<repo> <type> <key>".
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/bash
echo "gh $*" >> ${JSON.stringify(calls)}
if [ "$1" = api ]; then repo="\${2#repos/}"; repo="\${repo%/keys}"; grep "^$repo " ${JSON.stringify(keys)} 2>/dev/null | cut -d' ' -f2-3; exit 0; fi
if [ "$1 $2 $3" = "repo deploy-key add" ]; then read -r t k _; echo "$6 $t $k" >> ${JSON.stringify(keys)}; exit 0; fi
exit 1
`,
  );
  for (const f of ["ssh", "gh"]) chmodSync(join(bin, f), 0o755);
  const key = (h: string, repo: string) =>
    spawnSync("bash", [join(VM, "vm.sh"), "key", "test-vm", repo], { env: { ...envFor(h), PATH: `${bin}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
  const registered = () => (existsSync(keys) ? readFileSync(keys, "utf8").trim().split("\n") : []);

  it("adds a new key per repository, keeps one already added, and adopts the old key where it is registered", () => {
    const h = home("vm-c");
    // The VM's old single key, registered on acme/app before keys were per repository.
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(h, ".ssh", "builder_deploy")]);
    const old = readFileSync(join(h, ".ssh", "builder_deploy.pub"), "utf8").split(" ").slice(0, 2).join(" ");
    writeFileSync(keys, `acme/app ${old}\n`);

    const a = key(h, "acme/app");
    assert.match(a.stdout, /acme\/app already has test-vm's deploy key for it/, a.stdout + a.stderr);
    assert.equal(registered().length, 1, "the old key is adopted, nothing added");

    const b = key(h, "acme/manager");
    assert.match(b.stdout, /added deploy key "builder test-vm" to acme\/manager, read-only/, b.stdout + b.stderr);
    const added = registered().find((l) => l.startsWith("acme/manager "))!;
    assert.equal(added.split(" ").slice(1).join(" "), readFileSync(join(h, ".ssh", "builder_deploy_acme_manager.pub"), "utf8").split(" ").slice(0, 2).join(" "));
    assert.notEqual(added.split(" ")[2], old.split(" ")[1], "a different key from acme/app's");

    const c = key(h, "acme/manager");
    assert.match(c.stdout, /already has test-vm's deploy key/);
    assert.equal(registered().length, 2);
  });

  it("says what gh needs when it cannot read the repository's keys", () => {
    const h = home("vm-d");
    writeFileSync(join(bin, "gh"), "#!/bin/bash\necho 'HTTP 404: Not Found' >&2\nexit 1\n");
    const r = key(h, "acme/private");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /needs admin rights on the repository \(gh auth refresh -h github\.com -s repo\)/);
  });
});

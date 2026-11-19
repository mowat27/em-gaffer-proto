/**
 * vm/install.sh, the VM side of vm.sh launch, on the laptop: a copy of builder/ (as vm.sh ships it, node_modules
 * linked), a temp HOME, units written to a temp folder, and stand-ins for sudo, npm and systemctl on PATH. The
 * stand-in systemctl starts the installed unit's ExecStart line, so the rendered unit is what starts the server. Never
 * the real systemctl, never a VM. vm.sh itself only parses here (it needs exe.dev).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readFeed } from "../../runtime/feed.ts";
import { readRecord } from "../../runtime/run.ts";
import { liveServerRuns } from "../../server/run.ts";
import { freePort, GIT_ENV, http, tempDir } from "../harness/util.ts";

const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = tempDir("builder-vm-install");
const copy = join(tmp.dir, "builder");
const bin = join(tmp.dir, "bin");
const units = join(tmp.dir, "units");
const fake = join(tmp.dir, "systemd");

// builder/ as vm.sh launch ships it (what git tracks), without the runs, tests or TSF, with node_modules linked.
const SKIP = new Set(["node_modules", "runs", "jobs", "test", "tsf", "control", "work"]);
cpSync(BUILDER, copy, { recursive: true, filter: (src) => !SKIP.has(src.split("/").pop() ?? "") || src === BUILDER });
symlinkSync(join(BUILDER, "node_modules"), join(copy, "node_modules"));
for (const d of [bin, units, fake]) mkdirSync(d, { recursive: true });

const script = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}`);
  chmodSync(join(bin, name), 0o755);
};
script("sudo", `[ "$1" = -n ] && shift\necho "sudo $*" >> "${fake}/calls"\nexec "$@"\n`);
script("npm", `echo "npm $*" >> "${fake}/calls"\n`);
// The ops agent's unit is only recorded: starting it would start a durable agent on a real model.
script(
  "systemctl",
  `echo "systemctl $*" >> "${fake}/calls"
args=("$@"); [ "\${args[0]}" = "--no-ask-password" ] && args=("\${args[@]:1}")
[ "\${args[0]}" != enable ] && [ "\${args[1]}" = builder-ops.service ] && exit 0
pid=$(cat "${fake}/pid" 2>/dev/null || true)
alive() { [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; }
stop() { if alive; then kill -TERM "$pid"; for i in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; fi; rm -f "${fake}/pid"; }
start() { alive && return 0; exec_line=$(sed -n 's/^ExecStart=//p' "$BUILDER_UNIT_DIR/builder-server.service"); nohup $exec_line < /dev/null >> "${fake}/journal" 2>&1 & echo $! > "${fake}/pid"; }
case "\${args[0]}" in
  show) [ -f "$BUILDER_UNIT_DIR/builder-server.service" ] || { echo LoadState=not-found; exit 0; }; echo LoadState=loaded; if alive; then echo ActiveState=active; echo "MainPID=$pid"; else echo ActiveState=inactive; echo MainPID=0; fi ;;
  start) start ;;
  stop) stop ;;
  restart) stop; pid=""; start ;;
  daemon-reload|enable) ;;
  *) echo "fake systemctl: $*" >&2; exit 1 ;;
esac
`,
);

const env = (home: string) => ({ ...process.env, ...GIT_ENV, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, BUILDER_UNIT_DIR: units, NO_COLOR: "1", GAFFER_CONFIG: "" });
function install(home: string, args: string[]): { code: number | null; out: string } {
  const e = env(home) as Record<string, string | undefined>;
  delete e.GAFFER_CONFIG;
  delete e.GAFFER_INSTANCE;
  const r = spawnSync("bash", [join(copy, "vm", "install.sh"), ...args], { env: e, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const calls = () => (existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n") : []);
const stopUnit = () => spawnSync(join(bin, "systemctl"), ["stop", "builder-server.service"], { env: env(tmp.dir) });

after(() => {
  stopUnit();
  tmp.remove();
});

describe("vm/install.sh", () => {
  it("first install: npm ci, a machine config, the unit rendered and enabled, and the server started by it", { timeout: 120_000 }, async () => {
    const home = join(tmp.dir, "home-new");
    mkdirSync(home, { recursive: true });
    const port = await freePort();
    const r = install(home, ["--host", "127.0.0.1", "--port", String(port)]);
    assert.equal(r.code, 0, r.out);
    try {
      const config = readFileSync(join(home, ".gaffer", "config.yml"), "utf8");
      assert.match(config, new RegExp(`server: \\{ host: 127\\.0\\.0\\.1, port: ${port} \\}`));
      assert.match(config, /pi: \{ command: ~\/\.local\/share\/builder-pi\/node_modules\/\.bin\/pi \}/);
      const unit = readFileSync(join(units, "builder-server.service"), "utf8");
      const real = realpathSync(copy);
      assert.ok(unit.includes(`ExecStart=${spawnSync("bash", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim()} ${real}/cli/builder.ts server run\n`), unit);
      assert.ok(unit.includes(`User=${userInfo().username}\n`));
      assert.ok(unit.includes(`WorkingDirectory=${real}\n`));
      assert.doesNotMatch(unit, /@[A-Z]+@/, "every placeholder filled in");
      assert.ok(!existsSync(join(units, "builder-ops.service")), "the ops unit only with --ops");
      assert.ok(!existsSync(join(home, ".gaffer", "ops.env")), "ops.env only with --ops");
      assert.equal(readFileSync(join(home, "justfile"), "utf8"), '# Written by builder/vm/install.sh: `just builder <recipe>` from ~ (`just builder ops` attaches to the ops agent).\nset shell := ["bash", "-cu"]\n\nmod builder\n');
      const c = calls();
      assert.ok(c.includes("npm ci --no-audit --no-fund --loglevel=error"), c.join("\n"));
      for (const want of ["systemctl daemon-reload", "systemctl enable --quiet builder-server.service", "systemctl --no-ask-password start builder-server.service"]) assert.ok(c.some((l) => l.endsWith(want)), `${want} in\n${c.join("\n")}`);
      assert.match(r.out, /was not running, started: http:\/\/127\.0\.0\.1:\d+ \(systemd builder-server, run \S+, pid \d+\)/);
      assert.equal((await http("GET", `http://127.0.0.1:${port}/health`)).status, 200);
      const [run] = liveServerRuns(join(copy, "runs"));
      assert.equal(run.pid, Number(readFileSync(join(fake, "pid"), "utf8")), "the unit's process is the server run");
    } finally {
      stopUnit();
    }
  });

  it("redeploy: --config replaces the machine config (the old one kept), a running server restarts after a drain; --ops installs the ops agent's unit, and needs the agent", { timeout: 180_000 }, async () => {
    const home = join(tmp.dir, "home-config");
    const runsDir = join(tmp.dir, "runs");
    const port = await freePort();
    const file = join(tmp.dir, "machine.yml");
    writeFileSync(file, `builder:\n  server: { host: 127.0.0.1, port: ${port}, runsDir: ${JSON.stringify(runsDir)} }\n  pi: { command: /bin/false }\n`);
    mkdirSync(join(home, ".gaffer"), { recursive: true });
    writeFileSync(join(home, ".gaffer", "config.yml"), "builder:\n  server: { port: 1 }\n");
    writeFileSync(join(home, "justfile"), "# the user's own\n");
    try {
      const first = install(home, ["--config", file]);
      assert.equal(first.code, 0, first.out);
      assert.equal(readFileSync(join(home, "justfile"), "utf8"), "# the user's own\n", "an existing ~/justfile is kept");
      assert.match(first.out, /justfile \S+ kept/);
      assert.equal(readFileSync(join(home, ".gaffer", "config.yml"), "utf8"), readFileSync(file, "utf8"));
      assert.equal(readFileSync(join(home, ".gaffer", "config.yml.bak"), "utf8"), "builder:\n  server: { port: 1 }\n");
      const [before] = liveServerRuns(runsDir);
      assert.ok(before, first.out);

      const again = install(home, []);
      assert.equal(again.code, 0, again.out);
      assert.match(again.out, /config\s+\S+ kept/);
      assert.match(again.out, /restarted: http:\/\/127\.0\.0\.1:\d+ \(systemd builder-server/);
      const [after_] = liveServerRuns(runsDir);
      assert.notEqual(after_.id, before.id);
      assert.equal(readRecord(runsDir, before.id)?.state, "stopped");
      assert.ok(readFeed(runsDir, { kind: "control.applied" }).some((e) => e.data.action === "drain"), "drained before the restart");

      // --ops: the ops agent's unit too, rendered, enabled and restarted (the stand-in systemctl starts nothing for it).
      const ops = install(home, ["--ops"]);
      assert.equal(ops.code, 0, ops.out);
      const real = realpathSync(copy);
      const node = spawnSync("bash", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim();
      const opsUnit = readFileSync(join(units, "builder-ops.service"), "utf8");
      assert.ok(opsUnit.includes(`ExecStart=/bin/bash ${real}/vm/ops-tmux.sh run\n`), opsUnit);
      assert.ok(opsUnit.includes(`ExecStop=/bin/bash ${real}/vm/ops-tmux.sh stop\n`), opsUnit);
      assert.ok(opsUnit.includes(`Environment=NODE=${node}\n`), opsUnit);
      assert.ok(opsUnit.includes("Restart=on-failure\n"), opsUnit);
      assert.ok(opsUnit.includes("EnvironmentFile=-/etc/agent-vault.env\n"), "the vault's environment");
      assert.ok(opsUnit.includes(`EnvironmentFile=-${home}/.gaffer/ops.env\n`), "the API token comes from ops.env");
      // ops.env: a token generated once, mode 600, kept by the next install.
      const opsEnv = join(home, ".gaffer", "ops.env");
      const token = readFileSync(opsEnv, "utf8");
      assert.match(token, /^OPS_API_TOKEN=[0-9a-f]{64}\n$/);
      assert.equal(statSync(opsEnv).mode & 0o777, 0o600);
      assert.match(ops.out, /ops env\s+\S+ written/);
      const opsAgain = install(home, ["--ops"]);
      assert.equal(opsAgain.code, 0, opsAgain.out);
      assert.equal(readFileSync(opsEnv, "utf8"), token, "the token is kept");
      assert.match(opsAgain.out, /ops env\s+\S+ kept/);
      assert.doesNotMatch(opsUnit, /@[A-Z]+@/, "every placeholder filled in");
      assert.ok(calls().some((l) => l.endsWith("systemctl enable --quiet builder-server.service builder-ops.service")), calls().join("\n"));
      assert.ok(calls().some((l) => l.endsWith("systemctl restart builder-ops.service")), calls().join("\n"));
      assert.match(ops.out, /ops\s+builder-ops\.service restarted/);

      // Without the ops agent, --ops stops before doing anything.
      rmSync(join(copy, "agentics", "agents", "ops"), { recursive: true, force: true });
      const n = calls().length;
      const none = install(home, ["--ops"]);
      assert.equal(none.code, 1);
      assert.match(none.out, /--ops: there is no ops agent/);
      assert.equal(calls().length, n, "nothing done");
      const broken = join(tmp.dir, "broken.yml");
      writeFileSync(broken, "builder:\n  server: { prot: 1 }\n");
      const bad = install(home, ["--config", broken]);
      assert.equal(bad.code, 1);
      assert.match(bad.out, /unknown key builder\.server\.prot[\s\S]*the machine config does not load/);
    } finally {
      stopUnit();
    }
  });

  it("vm.sh parses and prints its usage", () => {
    assert.equal(spawnSync("bash", ["-n", join(BUILDER, "vm", "vm.sh")]).status, 0);
    assert.equal(spawnSync("bash", ["-n", join(BUILDER, "vm", "setup.sh")]).status, 0);
    const help = spawnSync("bash", [join(BUILDER, "vm", "vm.sh"), "--help"], { encoding: "utf8" });
    assert.equal(help.status, 2);
    assert.match(help.stderr, /^ {2}vm\.sh launch <vm> \[--config <file>\] \[--ops\] \[--tsf\] \[--keep\]$/m);
    assert.match(help.stderr, /^ {2}vm\.sh rejoin <vm> \[--keep\]/m);
  });
});

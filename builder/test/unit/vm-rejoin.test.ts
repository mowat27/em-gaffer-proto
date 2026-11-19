/**
 * `vm.sh rejoin`: put a builder VM back on the tailnet with pw-sandbox's first boot, and keep the build server on the
 * VM's tailnet name. Stand-ins: ssh runs the command in a temp HOME, sudo runs it, tailscale keeps its state in a file,
 * node records the CLI call, and first-boot.sh ($PW_FIRST_BOOT) joins under $NEXT_NAME with the EPHEMERAL it was given.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "../harness/util.ts";

const VM_SH = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "vm", "vm.sh");
const tmp = tempDir("builder-rejoin");
after(() => tmp.remove());

const bin = join(tmp.dir, "bin");
mkdirSync(bin, { recursive: true });
const tool = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}`);
  chmodSync(join(bin, name), 0o755);
};
tool("ssh", `cmd="\${@: -1}"\ncd "$HOME" && exec bash -c "$cmd"\n`);
tool("sudo", `exec "$@"\n`);
tool(
  "tailscale",
  `state="$HOME/ts-name"
case "$1" in
  logout) echo logout >> "$HOME/calls"; rm -f "$state" ;;
  status) [ -f "$state" ] || exit 1; printf '{"Self":{"DNSName":"%s."}}\\n' "$(cat "$state")" ;;
esac
`,
);
tool("node", `echo "node $*" >> "$HOME/calls"\n`);
const firstBoot = join(tmp.dir, "first-boot.sh");
writeFileSync(firstBoot, `echo "first-boot EPHEMERAL=$EPHEMERAL" >> "$HOME/calls"\nprintf '%s' "$NEXT_NAME" > "$HOME/ts-name"\n`);

function vm(name: string, tsName: string, host: string): string {
  const h = join(tmp.dir, name);
  mkdirSync(join(h, ".gaffer"), { recursive: true });
  writeFileSync(join(h, "ts-name"), tsName);
  writeFileSync(join(h, ".gaffer", "config.yml"), `builder:\n  server: { host: ${host}, port: 8788 }\n`);
  return h;
}
const rejoin = (h: string, next: string, ...args: string[]) =>
  spawnSync("bash", [VM_SH, "rejoin", "pw-builder-9", ...args], {
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: h, PW_FIRST_BOOT: firstBoot, NEXT_NAME: next },
    encoding: "utf8",
  });
const calls = (h: string) => (existsSync(join(h, "calls")) ? readFileSync(join(h, "calls"), "utf8").trim().split("\n") : []);

describe("vm.sh rejoin", () => {
  it("rejoins ephemeral, and moves the build server to the new tailnet name", () => {
    const h = vm("renamed", "pw-builder-9-1.tail1.ts.net", "pw-builder-9-1.tail1.ts.net");
    const r = rejoin(h, "pw-builder-9.tail1.ts.net");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(calls(h), ["logout", "first-boot EPHEMERAL=true", "node /" + h.slice(1) + "/builder/cli/builder.ts server restart"]);
    assert.equal(readFileSync(join(h, ".gaffer", "config.yml"), "utf8"), "builder:\n  server: { host: pw-builder-9.tail1.ts.net, port: 8788 }\n");
    assert.match(r.stdout, /pw-builder-9 is on the tailnet as pw-builder-9\.tail1\.ts\.net/);
    assert.match(r.stdout, /server\.host: pw-builder-9\.tail1\.ts\.net \(was pw-builder-9-1\.tail1\.ts\.net\)/);
    assert.match(r.stdout, /just gaffer vm launch <gaffer-vm> pw-builder-9 sets its builderHost/);
  });

  it("--keep rejoins persistent; the same name leaves the server alone; a name still taken is said", () => {
    const same = vm("same", "pw-builder-9.tail1.ts.net", "pw-builder-9.tail1.ts.net");
    const r = rejoin(same, "pw-builder-9.tail1.ts.net", "--keep");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(calls(same), ["logout", "first-boot EPHEMERAL=false"], "no restart");

    // Dropped from the tailnet (an ephemeral VM stopped too long), and its name still held by a stale machine.
    const dropped = vm("dropped", "", "pw-builder-9.tail1.ts.net");
    spawnSync("rm", [join(dropped, "ts-name")]);
    const d = rejoin(dropped, "pw-builder-9-1.tail1.ts.net");
    assert.equal(d.status, 0, d.stdout + d.stderr);
    assert.match(d.stdout, /note: still not pw-builder-9: a machine named pw-builder-9 is on the tailnet/);
    assert.ok(!calls(dropped).some((c) => c.startsWith("node")), "no old name to move from");
    assert.equal(rejoin(dropped, "x", "--bad").status, 2);
  });
});

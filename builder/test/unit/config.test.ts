/** The machine config: layers in priority order, instances.<id>, E22 (a broken layer names itself and the key), tool groups. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { builtInLayer, loadConfig, PACKAGED_CONFIG, secret } from "../../ops/config.ts";
import { allTools, expandTools, groups, toolsOf, unknownToolName } from "../../ops/groups.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-config");
after(() => tmp.remove());
let n = 0;
const dir = (files: Record<string, string>) => writeTree(join(tmp.dir, `c-${++n}`), files);
const none = join(tmp.dir, "absent.yml");

describe("machine config layers", () => {
  it("lowest first: built-in, packaged, ~/.gaffer/config.yml, $GAFFER_CONFIG, --config; maps merge, lists replace", () => {
    const d = dir({
      "packaged.yml": "builder:\n  limit: { tools: { enable: [files, project], disable: [bash] } }\n  server: { port: 1001, keepWorkspaces: 5 }\n",
      "user.yml": "builder:\n  server: { port: 1002, callbackRetries: 3 }\n  notify: [{ sink: tsf, url: http://localhost:8013 }]\ngaffer: { anything: [goes, here] }\n",
      "env.yml": "builder:\n  server: { port: 1003 }\n  limit: { tools: { enable: [files] } }\n",
      "flag.yml": "builder:\n  server: { port: 1004, host: 0.0.0.0 }\n",
    });
    const cfg = loadConfig({ packaged: join(d, "packaged.yml"), userConfig: join(d, "user.yml"), env: { GAFFER_CONFIG: join(d, "env.yml") }, configPath: join(d, "flag.yml") });
    assert.deepEqual(cfg.layers, ["built-in", `packaged ${join(d, "packaged.yml")}`, join(d, "user.yml"), `GAFFER_CONFIG ${join(d, "env.yml")}`, `--config ${join(d, "flag.yml")}`]);
    assert.equal(cfg.server.port, 1004, "--config is the highest layer");
    assert.equal(cfg.server.host, "0.0.0.0");
    assert.equal(cfg.server.callbackRetries, 3, "a key no higher layer sets keeps its value");
    assert.equal(cfg.server.keepWorkspaces, 5);
    assert.equal(cfg.server.jobTimeoutMinutes, 20, "built-in default");
    assert.deepEqual(cfg.limit, { enable: ["files"], disable: ["bash"] }, "the enable list was replaced, disable kept");
    assert.deepEqual(cfg.notify, [{ sink: "tsf", url: "http://localhost:8013" }]);
    assert.equal(cfg.instance, null);
  });

  it("the built-in limit (observe, notify) applies only without the packaged file; the packaged file has no limit", () => {
    const bare = loadConfig({ packaged: none, userConfig: none, env: {} });
    assert.deepEqual(bare.limit.enable, ["observe", "notify"]);
    assert.deepEqual(toolsOf(bare.limit), [...groups().observe, ...groups().notify]);
    const packaged = loadConfig({ packaged: PACKAGED_CONFIG, userConfig: none, env: {} });
    assert.deepEqual(packaged.limit.enable, ["*"]);
    assert.deepEqual(toolsOf(packaged.limit), [...allTools()]);
    assert.equal(packaged.server.runsDir, (builtInLayer().builder as { server: { runsDir: string } }).server.runsDir);
  });

  it("instances.<id> merges over builder for the instance named by $GAFFER_INSTANCE or --instance", () => {
    const d = dir({
      "c.yml": "builder:\n  server: { port: 2000, keepWorkspaces: 3 }\n  limit: { tools: { enable: ['*'] } }\ninstances:\n  vm-2:\n    server: { port: 2002 }\n    limit: { tools: { disable: [git_push] } }\n",
    });
    const base = { packaged: none, userConfig: none };
    assert.equal(loadConfig({ ...base, env: { GAFFER_CONFIG: join(d, "c.yml") } }).server.port, 2000);
    const viaEnv = loadConfig({ ...base, env: { GAFFER_CONFIG: join(d, "c.yml"), GAFFER_INSTANCE: "vm-2" } });
    assert.equal(viaEnv.instance, "vm-2");
    assert.equal(viaEnv.server.port, 2002);
    assert.equal(viaEnv.server.keepWorkspaces, 3);
    assert.deepEqual(viaEnv.limit, { enable: ["*"], disable: ["git_push"] });
    assert.ok(!toolsOf(viaEnv.limit).includes("git_push"));
    const viaFlag = loadConfig({ ...base, env: { GAFFER_CONFIG: join(d, "c.yml"), GAFFER_INSTANCE: "vm-2" }, instance: "vm-9" });
    assert.equal(viaFlag.instance, "vm-9", "--instance wins over $GAFFER_INSTANCE");
    assert.equal(viaFlag.server.port, 2000, "an instance with no section changes nothing");
  });

  it("relative paths resolve against the directory of the layer that sets them; ~ expands", () => {
    const d = dir({ "sub/c.yml": "builder:\n  server: { runsDir: ../runs }\n  pi: { command: ./bin/pi }\n" });
    const cfg = loadConfig({ packaged: none, userConfig: none, env: { GAFFER_CONFIG: join(d, "sub", "c.yml") } });
    assert.equal(cfg.server.runsDir, join(d, "runs"));
    assert.equal(cfg.pi.command, join(d, "sub", "bin", "pi"));
    const bare = loadConfig({ packaged: none, userConfig: none, env: {} });
    assert.equal(bare.pi.command, "~/.pi/agent/bin/pi", "a ~ command stays for the runner to expand");
  });

  describe("E22: a broken layer refuses to load, naming the layer and the key", () => {
    const cases: [string, string, RegExp][] = [
      ["an unknown key", "builder:\n  server: { prot: 8080 }\n", /: unknown key builder\.server\.prot$/],
      ["an unknown top-level section", "builders: {}\n", /: unknown key builders$/],
      ["an unknown tool", "builder:\n  limit: { tools: { enable: [files, fils] } }\n", /builder\.limit\.tools\.enable: unknown tool or group "fils"$/],
      ["an unknown tool in an instance", "instances:\n  vm: { limit: { tools: { disable: [git_pull] } } }\n", /instances\.vm\.limit\.tools\.disable: unknown tool or group "git_pull"$/],
      ["a wrong type", "builder:\n  server: { port: eighty }\n", /builder\.server\.port: must be a number$/],
      ["YAML that does not parse", "builder: [unclosed\n", /^config GAFFER_CONFIG .*bad\.yml: /],
    ];
    for (const [what, text, error] of cases) {
      it(what, () => {
        const d = dir({ "bad.yml": text });
        assert.throws(
          () => loadConfig({ packaged: none, userConfig: none, env: { GAFFER_CONFIG: join(d, "bad.yml") } }),
          (err: Error) => err.message.startsWith(`config GAFFER_CONFIG ${join(d, "bad.yml")}: `) && error.test(err.message),
        );
      });
    }
    it("names the machine-wide layer when that is the broken one, and --config when that is", () => {
      const d = dir({ "user.yml": "builder: { pi: { cmd: x } }\n", "flag.yml": "builder: { notify: [{ sink: tsf, colour: red }] }\n" });
      assert.throws(() => loadConfig({ packaged: none, userConfig: join(d, "user.yml"), env: {} }), new RegExp(`Error: config ${join(d, "user.yml")}: unknown key builder\\.pi\\.cmd$`));
      assert.throws(() => loadConfig({ packaged: none, userConfig: none, env: {}, configPath: join(d, "flag.yml") }), /Error: config --config .*flag\.yml: unknown key builder\.notify\[0\]\.colour$/);
    });
    it("a layer that is named but missing is an error", () => {
      assert.throws(() => loadConfig({ packaged: none, userConfig: none, env: { GAFFER_CONFIG: join(tmp.dir, "nope.yml") } }), /Error: config GAFFER_CONFIG .*nope\.yml: .*does not exist$/);
    });
  });

  it("secrets are env: references", () => {
    assert.equal(secret("env:OPS_TOKEN", { OPS_TOKEN: "s3cret" }), "s3cret");
    assert.equal(secret("plain"), "plain");
    assert.throws(() => secret("env:MISSING_ONE", {}), /MISSING_ONE is not set/);
  });
});

describe("tool groups", () => {
  it("a group expands to its tools, tool:<name> names one tool, * is every tool, and an unknown name throws", () => {
    assert.deepEqual(expandTools(["files", "project", "outcome", "capture-learning"]), ["read", "write", "edit", "bash", "grep", "find", "ls", "git", "npm", "npx", "docker", "done", "halt", "capture-learning"]);
    assert.deepEqual(expandTools(["git"]), groups().git, "a group name wins over a tool of the same name");
    assert.deepEqual(expandTools(["tool:git"]), ["git"]);
    assert.deepEqual(expandTools(["*"]), [...allTools()]);
    assert.equal(unknownToolName("verify"), null);
    assert.throws(() => expandTools(["files", "nope"]), /unknown tool or group "nope"/);
    assert.deepEqual(toolsOf({ enable: ["files"], disable: ["bash", "write"] }), ["read", "edit", "grep", "find", "ls"]);
  });
});

/** agent.yml and defaults.yml: merging (maps merge, lists replace, nearest folder last), extends, unknown keys refused. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { mergeLayers } from "../../ops/config.ts";
import { checkAgentYml, loadAgent } from "../../runtime/resolve.ts";
import { listAgents } from "../../runtime/paths.ts";
import { tempDir } from "../harness/util.ts";
import { writeTree } from "./tree.ts";

const tmp = tempDir("builder-agent-yml");
after(() => tmp.remove());
let n = 0;
const tree = (files: Record<string, string>) => writeTree(join(tmp.dir, `tree-${++n}`), files);

describe("mergeLayers", () => {
  it("maps merge key by key, lists and scalars replace, undefined keeps", () => {
    const under = { a: 1, m: { x: 1, y: [1, 2], deep: { p: 1, q: 2 } }, l: [1, 2, 3] };
    const over = { a: 2, m: { y: [9], deep: { q: 3 } }, l: [4], z: true };
    assert.deepEqual(mergeLayers(under, over), { a: 2, m: { x: 1, y: [9], deep: { p: 1, q: 3 } }, l: [4], z: true });
    assert.deepEqual(mergeLayers(under, undefined), under);
  });
});

describe("agent.yml and defaults.yml", () => {
  it("defaults.yml in every folder above merges under agent.yml, nearest folder last; lists replace", () => {
    const root = tree({
      "agents/defaults.yml": "mode: rpc\nuses: { skills: [shared:a/*], prompts: [own:prompts/*] }\nwrites: [a/**, b/**]\nareas: { data: { write: false } }\n",
      "agents/team/defaults.yml": "mode: interactive\nuses: { skills: [shared:team/*] }\nareas: { data: { write: true }, work: { path: ./work } }\n",
      "agents/team/lab/agent.yml": "description: a lab\nwrites: [src/**]\nareas: { work: { write: true } }\n",
    });
    const a = loadAgent("team/lab", root);
    assert.equal(a.id, "team/lab");
    assert.equal(a.dir, join(root, "agents", "team", "lab"));
    assert.deepEqual(
      a.defaults.map((d) => d.path),
      [join(root, "agents", "defaults.yml"), join(root, "agents", "team", "defaults.yml")],
    );
    assert.equal(a.yml.mode, "interactive", "the nearest defaults.yml wins over the farther one");
    assert.deepEqual(a.yml.uses, { skills: ["shared:team/*"], prompts: ["own:prompts/*"] }, "maps merge, lists replace");
    assert.deepEqual(a.yml.writes, ["src/**"], "agent.yml's list replaces the defaults'");
    assert.deepEqual(a.yml.areas, { data: { write: true }, work: { path: "./work", write: true } });
    assert.match(a.ymlHash, /^[0-9a-f]{64}$/);
  });

  it("a folder without agent.yml is a group, not an agent", () => {
    const root = tree({ "agents/team/defaults.yml": "mode: rpc\n", "agents/team/lab/agent.yml": "description: x\n", "agents/solo/agent.yml": "description: y\n" });
    assert.deepEqual(listAgents(root), ["solo", "team/lab"]);
    assert.throws(() => loadAgent("team", root), /no agent team: .*agent\.yml does not exist/);
  });

  it("extends reuses another agent's prompt, uses and gates; own keys win; own: refs keep pointing at the base", () => {
    const root = tree({
      "agents/base/agent.yml": "description: base\nmode: headless\nprompt: own:prompts/p.md\nuses: { skills: [shared:s/*], extensions: [shared:e, own:extensions/x.ts] }\ngates: [shared:g]\ntools: { enable: [files] }\n",
      "agents/dev/child/agent.yml": "description: child\nextends: base\nuses: { skills: [shared:other/*] }\n",
    });
    const c = loadAgent("dev/child", root);
    assert.equal(c.yml.prompt, join(root, "agents", "base", "prompts", "p.md"));
    assert.deepEqual(c.yml.uses, { skills: ["shared:other/*"], extensions: ["shared:e", join(root, "agents", "base", "extensions", "x.ts")] });
    assert.deepEqual(c.yml.gates, ["shared:g"]);
    assert.equal(c.yml.tools, undefined, "tools are not inherited: only prompt, uses and gates");
    assert.equal(c.yml.mode, undefined);
  });

  it("an agent that extends itself, directly or not, is refused", () => {
    const root = tree({ "agents/a/agent.yml": "description: a\nextends: b\n", "agents/b/agent.yml": "description: b\nextends: a\n" });
    assert.throws(() => loadAgent("a", root), /extends itself: a -> b -> a/);
  });

  for (const [what, yml, error] of [
    ["an unknown top-level key", "description: x\nmodel: fast\n", /agent\.yml: unknown key model/],
    ["an unknown nested key", "description: x\nuses: { skils: [shared:a] }\n", /agent\.yml: unknown key uses\.skils/],
    ["an unknown key in an area", "description: x\nareas: { work: { path: ., writable: true } }\n", /unknown key areas\.work\.writable/],
    ["an unknown tool name", "description: x\ntools: { enable: [files, fils] }\n", /tools\.enable names an unknown tool or group "fils"/],
    ["a bad mode", "description: x\nmode: batch\n", /mode must be one of headless, interactive, rpc, durable/],
    ["a list where a map belongs", "description: x\nruns: [a]\n", /runs must be a map/],
    ["no description", "mode: headless\n", /description is required/],
  ] as const) {
    it(`refuses ${what}, naming the file and the key`, () => {
      const root = tree({ "agents/x/agent.yml": yml });
      assert.throws(() => loadAgent("x", root), (err: Error) => err.message.startsWith(join(root, "agents", "x", "agent.yml")) && error.test(err.message));
    });
  }

  it("a defaults.yml with an unknown key is refused too, naming it", () => {
    const root = tree({ "agents/g/defaults.yml": "colour: blue\n", "agents/g/x/agent.yml": "description: x\n" });
    assert.throws(() => loadAgent("g/x", root), new RegExp(`${join(root, "agents", "g", "defaults.yml").replace(/[.]/g, "\\.")}: unknown key colour`));
  });

  it("accepts every key of the schema (api, triggers and definitions are parsed only)", () => {
    const doc = checkAgentYml(
      {
        description: "d",
        mode: "durable",
        prompt: "own:SYSTEM.md",
        extends: "x",
        uses: { skills: [], extensions: [], prompts: [] },
        gates: [],
        tools: { enable: ["files", "tool:git", "*"], disable: ["bash"] },
        writes: [],
        areas: { data: { write: true } },
        runs: { may_start: ["*"] },
        api: { listen: "127.0.0.1:8090", token: "env:OPS_API_TOKEN" },
        triggers: [{ on: "job.failed" }],
        definitions: { changes: "propose" },
      },
      "agent.yml",
      { requireDescription: true },
    );
    assert.equal(doc.mode, "durable");
  });
});

/**
 * builder config: the merged machine config and the layer each value came from (instance_get).
 * builder config reload: read the layers again and tell every live run (config_reload). A broken layer changes
 * nothing and exits 1 with the layer and the key (E22).
 */
import { callTool } from "../../ops/core/tool.ts";
import { cliTools, out, usage, type Command } from "../common.ts";

interface Instance {
  instance: string | null;
  version: string | null;
  runsDir: string;
  layers: string[];
  config: Record<string, unknown>;
  sources: Record<string, string>;
}

/** The value at a dotted path. */
const at = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

function human(i: Instance): string {
  const lines = [`instance  ${i.instance ?? "(none)"}`, `version   ${i.version ?? "(unknown)"}`, `runs      ${i.runsDir}`, "layers (lowest first)", ...i.layers.map((l, n) => `  ${n + 1}. ${l}`), "values"];
  const keys = Object.keys(i.sources).sort();
  const width = Math.max(...keys.map((k) => k.length), 0);
  for (const k of keys) lines.push(`  ${k.padEnd(width)}  ${JSON.stringify(at(i.config, k))}   (${i.sources[k]})`);
  return lines.join("\n");
}

const config: Command = async (argv, g) => {
  if (g.help) {
    console.log("usage: builder config            the merged config and the layer of each value\n       builder config reload     read the layers again and tell every live run");
    return 0;
  }
  const [sub, ...extra] = argv;
  if (extra.length || (sub !== undefined && sub !== "reload")) usage("usage: builder config [reload]");
  const ctx = cliTools(g);
  if (sub === "reload") {
    const r = (await callTool("config_reload", {}, ctx)) as { layers: string[]; tools: number; runs: string[] };
    out(g, r, (x: typeof r) => `reloaded ${x.layers.length} layer(s): ${x.tools} tool(s) in the limit; ${x.runs.length} live run(s) told${x.runs.length ? ` (${x.runs.join(", ")})` : ""}`);
    return 0;
  }
  out(g, await callTool("instance_get", {}, ctx), human);
  return 0;
};

export default config;

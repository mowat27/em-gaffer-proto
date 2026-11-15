/**
 * Code layers under the REAL launcher (`node bin/tsf.mjs start`, which registers the tsx loader). vitest's own module
 * loader accepts things tsx does not (it took `extension.ts?t=<stamp>`; tsx answers "Cannot find module"), so the unit
 * tests alone cannot show that a project layer with code loads in production. This starts the launcher on a scratch
 * project and drives the layer routes: an extension.ts with createHandlers and a helper module, an edit of the helper
 * alone, a manifest.ts layer and its edit, and an export that imports back under another name.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appDir } from "../../src/core/paths.ts";
import type { LayerInfo } from "../../src/shared/types.ts";
import { makeProject } from "../helpers/project.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

const children: ChildProcess[] = [];

function startFactory(root: string): Promise<{ url: string; output: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(appDir, "bin", "tsf.mjs"), "start"], {
      cwd: root,
      env: { ...process.env, TSF_PROJECT: root, TSF_MODEL_PROVIDER: "faux", TSF_PORT: "0", TSF_HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "";
    const onData = (chunk: Buffer): void => {
      out += chunk.toString("utf8");
      const m = /TSF running at (http:\/\/\S+)/.exec(out);
      if (m) resolve({ url: m[1]!, output: () => out });
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("exit", (code) => reject(new Error(`factory exited ${code} before listening:\n${out}`)));
    setTimeout(() => reject(new Error(`factory did not start in 60 s:\n${out}`)), 60_000).unref();
  });
}

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  await cleanupTmp();
});

describe("code layers under the real launcher", () => {
  it("loads and reloads extension.ts, helpers, createHandlers and manifest.ts; exports and imports", async () => {
    const { root } = await makeProject();
    const { url } = await startFactory(root);
    const post = async <T>(path: string, body: unknown): Promise<T> => {
      const res = await fetch(`${url}/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) throw new Error(`${path} ${res.status}: ${text}`);
      return JSON.parse(text) as T;
    };
    const write = (name: string, path: string, content: string) => post<{ layer: LayerInfo }>("layers/write-file", { name, path, content });
    const query = async (layer: string): Promise<unknown> => (await fetch(`${url}/api/layers/${layer}/query/get?input=%7B%7D`)).json();

    await post("layers/create", { name: "lotx", title: "Lot X", description: "d" });
    await write("lotx", "helper.ts", "export const helper = (): number => 1;\n");
    const ext = `import { helper } from "./helper.ts";
export function createExtension(ctx) {
  const { defineExtension, defineAppTool, obj } = ctx.pi;
  return defineExtension({ name: "lotx", tools: [defineAppTool({ name: "lotx_ping", description: "ping", parameters: obj({}), replay: "safe", run: async () => ({ ok: helper() }) })] });
}
export function createHandlers() { return { queries: { get: () => ({ v: helper() }) }, actions: {} }; }
`;
    const first = await write("lotx", "extension.ts", ext);
    expect(first.layer).toMatchObject({ status: "loaded", tools: ["lotx_ping"] });
    expect(await query("lotx")).toEqual({ v: 1 });

    // An edit of the helper alone must be picked up (fresh import of the whole folder).
    const second = await write("lotx", "helper.ts", "export const helper = (): number => 2;\n");
    expect(second.layer.status).toBe("loaded");
    expect(await query("lotx")).toEqual({ v: 2 });
    // And an edit of extension.ts itself.
    await write("lotx", "extension.ts", ext.replace("{ v: helper() }", "{ v: helper() * 10 }"));
    expect(await query("lotx")).toEqual({ v: 20 });

    // A layer with manifest.ts: edit it and see the title change.
    const manifest = (title: string) =>
      `export const manifest = { name: "coded", kind: "harness", title: "${title}", description: "d", enabledByDefault: true, env: [], vaultHosts: [], ui: { settingsPanels: [], widgets: [], hotkeys: [] } };\n`;
    await mkdir(join(root, "tsf", "layers", "coded"), { recursive: true });
    await writeFile(join(root, "tsf", "layers", "coded", "extension.ts"), `export function createExtension(ctx) { return ctx.pi.defineExtension({ name: "coded" }); }\n`);
    await writeFile(join(root, "tsf", "layers", "coded", "manifest.ts"), manifest("One"));
    let list = await post<LayerInfo[]>("layers/reload", {});
    expect(list.find((l) => l.name === "coded")).toMatchObject({ status: "loaded", title: "One" });
    const edited = await write("coded", "manifest.ts", manifest("Two"));
    expect(edited.layer).toMatchObject({ status: "loaded", title: "Two" });

    // Export the code layer and import it under its own name after deleting it (code layers cannot be renamed).
    const exported = await post<{ file: string; files: string[] }>("layers/export", { name: "lotx" });
    expect(exported.files).toEqual(["extension.ts", "helper.ts", "manifest.json"]);
    await post("layers/delete", { name: "lotx" });
    const imported = await post<{ layer: LayerInfo }>("layers/import", { source: join(root, "tsf", "data", "exports", exported.file) });
    expect(imported.layer).toMatchObject({ name: "lotx", status: "loaded" });
    expect(await query("lotx")).toEqual({ v: 20 });
    list = await post<LayerInfo[]>("layers/reload", {});
    expect(list.filter((l) => l.status === "failed")).toEqual([]);
  });
});

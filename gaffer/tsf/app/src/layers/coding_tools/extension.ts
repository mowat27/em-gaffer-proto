/**
 * coding_tools (DESIGN 8): pi-durable's `read`, `write`, `edit` and `bash` in an extension named `coding_tools`
 * (pi-durable's own is `coding-tools`; never install both). Path safety is not done here: the harness gives the tools a
 * `RootedEnv` (agent/rooted-env.ts), and `read`, `write` and `edit` resolve every path through it. The library tools do
 * not declare `replay` (pi-durable defaults to "unsafe"); TSF states it, so every tool of the app declares one: a crash
 * mid-call gives the model an `interrupted` result and never a second run.
 *
 * The section key is `coding_tools-scope` (pi-durable 1.5.0 section keys match /^[a-z][a-z0-9_-]*$/, so no dot).
 */
import type { Extension } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { LayerContext } from "../../agent/layer-context.ts";

/** The same tool with `replay` stated. */
function unsafe<T extends object>(tool: T): T & { readonly replay: "unsafe" } {
  return { ...tool, replay: "unsafe" };
}

/** Stable text: no clock, nothing that changes between requests (the prompt cache). */
export function scopeText(projectRoot: string): string {
  return [
    `Your file tools (read, write, edit) work only inside the project: ${projectRoot}. Relative paths start there.`,
    "A path that leaves the project, directly or through a symbolic link, is refused. So are tsf/permissions.json, tsf/.env, everything under tsf/data, everything under tsf/layers and tsf/mod.just: they hold the permissions ceiling, the keys, the factory's own state and the code the factory runs. Project layers are written by the user, not by you.",
    "The factory's pages are Markdown files under tsf/pages. Prefer the page tools for them when you have them, because they keep the page tree and the open page in step.",
    "bash runs in the project root. It is not confined to the project by path, so keep every command inside it, and never read or print keys.",
  ].join("\n");
}

export function createExtension(ctx: LayerContext): Extension {
  const { defineExtension, section } = ctx.pi;
  return defineExtension({
    name: "coding_tools",
    tools: [unsafe(createReadTool()), unsafe(createWriteTool()), unsafe(createEditTool()), unsafe(createBashTool())],
    sections: [section("coding_tools-scope", () => scopeText(ctx.paths.projectRoot))],
  }) as Extension;
}

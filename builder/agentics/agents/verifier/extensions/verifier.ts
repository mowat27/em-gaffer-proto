// The verifier's own tools and its screen. The verifier is an ordinary agent (agentics/agents/verifier): its commands
// are prompt templates in prompts/ (/verify, /list-rules, /change-rules).
//
//   verify      not here: the `verify` tool of the tool core (ops/core/verify.ts, the verify group), registered by the
//               pi adapter because the agent.yml enables it. It runs this directory's run.ts with the current
//               checks.ts in a fresh process, so a rule change applies at once. This extension follows its results to
//               remember the last build verified and to show the verdicts in the TUI.
//   try_rules   the same verification without showing it (`verify`, defaulting to the last build verified), or the
//               RULES catalogue (`list`), through the same core functions.
//   fetch_docs  a page of the TypeSafe docs (https://docs.typesafe.ai/ only).
//
// Only the tools its agent.yml enables reach the model, and the shared:write-scope gate limits edit and write to its
// checks.ts (agent.yml `writes: [own:checks.ts]`). Its paths go into the system prompt (the `verifier` section), so it
// works from any working directory.

import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { verifierRules, verify, type VerifyResult } from "../../../../ops/core/verify.ts";
import { dataPath } from "../../../../runtime/paths.ts";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECKS = join(HERE, "checks.ts");
const GUIDE = join(HERE, "change-rules.md");
const AGENTICS = dirname(dirname(HERE));
const DOCS_HOST = "docs.typesafe.ai";

interface Build {
  workspace: string;
  slice: string;
  base: string;
}
interface Run {
  build: Build;
  at: string;
  ms: number;
  result: VerifyResult;
}

/** A `verify` result as the tool core returned it (its JSON text), or null when the call failed. */
export function verdictOf(result: unknown): VerifyResult | null {
  const content = (result as { content?: { type?: string; text?: string }[] } | null)?.content;
  const text = Array.isArray(content) ? content.find((c) => c?.type === "text")?.text : undefined;
  if (!text) return null;
  try {
    const v = JSON.parse(text) as VerifyResult;
    return v && (v.verdict === "pass" || v.verdict === "fail") && typeof v.workspace === "string" ? v : null;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  const runs: Run[] = [];
  let last: Build | null = null;
  let redraw = () => {};

  /** The build a try_rules call names, with defaults: the last build verified, the workspace's .slice.json, HEAD. */
  const buildOf = (cwd: string, p: { workspace?: string; slice?: string; base?: string }): Build => {
    if (!p.workspace) {
      if (last) return last;
      throw new Error("name the workspace to verify: no build has been verified in this session yet");
    }
    const workspace = resolve(cwd, p.workspace);
    const slice = !p.slice ? join(workspace, ".slice.json") : p.slice.startsWith("data:") ? dataPath(p.slice, { agentDir: HERE }).path : resolve(cwd, p.slice);
    return { workspace, slice, base: p.base || "HEAD" };
  };

  pi.registerTool({
    name: "try_rules",
    label: "Try the rules",
    description: "Run the current checks.ts without showing the verdict as a verification. `verify` checks a build (default: the last build verified) and returns its verdict as JSON. `list` returns the RULES catalogue.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("verify"), Type.Literal("list")]),
      workspace: Type.Optional(Type.String({ description: "The workspace (app directory) the build changed, absolute or relative to the working directory. Default: the last build verified" })),
      slice: Type.Optional(Type.String({ description: "The slice: a slice or dispatch JSON file, or a data: path. Default: the workspace's .slice.json" })),
      base: Type.Optional(Type.String({ description: "The commit the build started from. Default: HEAD (an uncommitted build)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const o = { agentics: AGENTICS, ...(signal ? { signal } : {}) };
      if (params.action === "list") return { content: [{ type: "text", text: JSON.stringify(await verifierRules(o), null, 1) }], details: {} };
      const b = buildOf(ctx.cwd, params);
      return { content: [{ type: "text", text: JSON.stringify(await verify(b.workspace, b.slice, b.base, o), null, 1) }], details: {} };
    },
  });

  pi.registerTool({
    name: "fetch_docs",
    label: "Fetch TypeSafe docs",
    description: `Fetch a page of the TypeSafe docs (https://${DOCS_HOST}/...) as text. Append .md to a page path for Markdown. Start with https://${DOCS_HOST}/llms.txt.`,
    parameters: Type.Object({ url: Type.String({ description: `https://${DOCS_HOST}/ page URL` }) }),
    async execute(_id, params, signal) {
      let url: URL;
      try {
        url = new URL(params.url);
      } catch {
        throw new Error(`not a URL: ${params.url}`);
      }
      if (url.protocol !== "https:" || url.hostname !== DOCS_HOST) throw new Error(`only https://${DOCS_HOST}/ pages can be fetched`);
      const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(30_000), redirect: "follow" });
      if (new URL(res.url).hostname !== DOCS_HOST) throw new Error(`${url} redirected off ${DOCS_HOST}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      return { content: [{ type: "text", text: text.length > 60_000 ? `${text.slice(0, 60_000)}\n[truncated]` : text }], details: {} };
    },
  });

  // The core's verify tool: remember the build and show the verdict.
  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== "verify" || event.isError) return;
    const v = verdictOf(event.result);
    if (!v) return;
    last = { workspace: v.workspace, slice: v.slice, base: v.base };
    runs.unshift({ build: last, at: new Date().toLocaleTimeString(), ms: v.ms, result: v });
    redraw();
  });

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.verifier = [
      `The verifier's directory is ${HERE}.`,
      `- The rules: ${CHECKS} (the only file you may change).`,
      `- How to change them: ${GUIDE}.`,
      last ? `- The last build verified in this session: workspace ${last.workspace}, slice ${last.slice}, base ${last.base}.` : "- No build has been verified in this session yet.",
    ].join("\n");
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setTitle("verifier");
    ctx.ui.setHeader((_tui, theme) => ({ render: () => [theme.bold(theme.fg("accent", " verifier ")) + theme.fg("muted", "checks slice builds with code checks and Jev")], invalidate() {} }));
    ctx.ui.setFooter((_tui, theme) => ({ render: (w: number) => [truncateToWidth(theme.fg("dim", " /verify <workspace> [slice] [base] · /list-rules · /change-rules <change> · /quit"), w)], invalidate() {} }));
    ctx.ui.setWidget("verifier", (tui, theme) => {
      redraw = () => tui.requestRender();
      const mark = { pass: theme.fg("success", "✓"), fail: theme.fg("error", "✗"), check: theme.fg("warning", "?"), info: theme.fg("dim", "·") };
      return {
        render(w: number): string[] {
          const [latest, ...earlier] = runs;
          if (!latest) return [theme.fg("dim", " no builds verified yet")];
          const v = latest.result;
          const badge = v.verdict === "pass" ? theme.bold(theme.fg("success", " PASS ")) : theme.bold(theme.fg("error", " FAIL "));
          const lines = [`${badge} ${theme.bold(relative(ctx.cwd, latest.build.workspace) || ".")} ${theme.fg("dim", `${latest.at}, ${(latest.ms / 1000).toFixed(1)}s`)}`, ` ${v.summary}`, ""];
          const order = { fail: 0, check: 1, pass: 2, info: 3 } as const;
          for (const f of [...v.findings].sort((a, b) => order[a.status] - order[b.status])) {
            lines.push(...wrapTextWithAnsi(`${mark[f.status]} ${f.id} ${theme.fg("dim", f.detail)}`, Math.max(20, w - 3)).map((l, i) => (i ? "     " : "   ") + l));
          }
          if (earlier.length) {
            lines.push("", theme.fg("muted", " earlier"));
            for (const r of earlier.slice(0, 5)) lines.push(`   ${r.result.verdict === "pass" ? mark.pass : mark.fail} ${relative(ctx.cwd, r.build.workspace) || "."} ${theme.fg("dim", `${r.at} · ${r.result.summary}`)}`);
          }
          return lines.map((l) => truncateToWidth(l, w));
        },
        invalidate() {},
      };
    });
  });
}

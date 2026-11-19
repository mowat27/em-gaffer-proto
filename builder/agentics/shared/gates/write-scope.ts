// write-scope: where an agent may write. In order, on write, edit and bash commands that write:
//
//   1. Protected config, always: the machine config layers (the packaged builder/ops/config.yml, $GAFFER_CONFIG and
//      --config files) and ~/.gaffer/. No agent changes the config; only the operator does (design section 10).
//   2. The slice-scope rule, in runs that have a dispatch, on write and edit: a file outside the slice being built and
//      the builder's exceptions (checks.ts sliceScopeReason). The slice being built is the one already changed since
//      base, so the first slice file written sets it. Outside a git work tree there is nothing to scope against.
//   3. The agent.yml's `writes` and writable `areas`, always (E24). A writing shell command is checked on the paths it
//      names: a word that is an existing path, a path whose folder exists, or a redirect target, leaving out the
//      program each command runs. A path built at runtime is not seen: an agent with bash has a full shell, so this is
//      not a hard boundary.
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { builderExceptions, primarySliceOf, sliceRuleBlock, sliceScopeReason } from "../../builders/supabase-api/checks.ts";
import { allow, block, defineGate, redirectTargets, relIn, resolvePath, shellWriteWords, type GateContext } from "../../../engine/gates.ts";

const shownOf = (ctx: GateContext, abs: string) => relIn(ctx.cwd, abs) ?? abs;

const protectedReason = (shown: string, via: string) =>
  `${shown} is machine config: only the operator changes it (the packaged builder/ops/config.yml, ~/.gaffer/, $GAFFER_CONFIG and --config files). Do not change it with ${via}.`;

function writesReason(ctx: GateContext, shown: string, via: string): string {
  const areas = Object.entries(ctx.areas)
    .filter(([, a]) => a.write)
    .map(([name, a]) => `${name} (${a.path})`);
  return `${shown} is outside what this agent may write (writes: ${ctx.writes.join(", ") || "none"}; writable areas: ${areas.join(", ") || "none"}). Do not change it with ${via}.`;
}

/** The slice-scope reason for a path in the workspace, or null. */
function sliceScope(ctx: GateContext, rel: string): string | null {
  let changed: string[];
  try {
    changed = ctx.changedFiles();
  } catch {
    return null; // not a git clone: nothing to scope against
  }
  return sliceScopeReason(rel, primarySliceOf(changed), builderExceptions());
}

export default defineGate({
  tools: ["write", "edit", "bash"],
  check(call, ctx) {
    if (call.tool === "bash") {
      const words = shellWriteWords(call.input.command);
      if (!words) return allow();
      const targets = new Set(redirectTargets(call.input.command));
      const programs = new Set(String(call.input.command).split(/[;&|()\n]+/).map((s) => s.trim().split(/\s+/)[0]));
      for (const word of words) {
        const abs = resolvePath(ctx.cwd, word);
        const shown = shownOf(ctx, abs);
        if (ctx.isProtected(abs)) return block(protectedReason(shown, "bash"), shown);
        if (programs.has(word) && !targets.has(word)) continue;
        const named = targets.has(word) || existsSync(abs) || (word.includes("/") && existsSync(dirname(abs)));
        if (named && !ctx.mayWrite(abs)) return block(writesReason(ctx, shown, "bash"), shown);
      }
      return allow();
    }
    const abs = resolvePath(ctx.cwd, call.input.path);
    const shown = shownOf(ctx, abs);
    if (ctx.isProtected(abs)) return block(protectedReason(shown, call.tool), shown);
    const rel = relIn(ctx.cwd, abs);
    if (ctx.dispatch && rel) {
      const reason = sliceScope(ctx, rel);
      if (reason) return block(sliceRuleBlock(rel, call.tool, reason), rel);
    }
    if (!ctx.mayWrite(abs)) return block(writesReason(ctx, shown, call.tool), shown);
    return allow();
  },
});

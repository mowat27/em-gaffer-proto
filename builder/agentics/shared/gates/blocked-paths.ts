// blocked-paths: a slice build never changes the package manifest, a lockfile or server.ts (BLOCKED in the supabase-api
// builder's checks.ts). Blocks write and edit of one, and bash commands that write and name one, in runs that have a
// dispatch. Paths outside the workspace are not in the patch and are left to write-scope.
import { BLOCKED, sliceRuleBlock } from "../../builders/supabase-api/checks.ts";
import { allow, block, defineGate, relIn, writtenPaths } from "../../../engine/gates.ts";

export default defineGate({
  tools: ["write", "edit", "bash"],
  check(call, ctx) {
    if (!ctx.dispatch) return allow();
    for (const abs of writtenPaths(call, ctx.cwd)) {
      const rel = relIn(ctx.cwd, abs);
      if (!rel) continue;
      const hit = BLOCKED.find((b) => b.pattern.test(rel));
      if (hit) return block(sliceRuleBlock(rel, call.tool, hit.reason), rel);
    }
    return allow();
  },
});

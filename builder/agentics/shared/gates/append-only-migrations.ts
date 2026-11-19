// append-only-migrations: a supabase/migrations/V{n}__*.sql that exists in the base commit is never changed; a fix goes
// in a new migration. Blocks write and edit of one, and bash commands that write and name one, in runs that have a
// dispatch. A new migration is allowed.
import { APPEND_ONLY_REASON, MIGRATION_PATTERN, sliceRuleBlock } from "../../builders/supabase-api/checks.ts";
import { allow, block, defineGate, relIn, writtenPaths } from "../../../engine/gates.ts";

export default defineGate({
  tools: ["write", "edit", "bash"],
  check(call, ctx) {
    if (!ctx.dispatch) return allow();
    for (const abs of writtenPaths(call, ctx.cwd)) {
      const rel = relIn(ctx.cwd, abs);
      if (rel && MIGRATION_PATTERN.test(rel) && ctx.existsAtBase(rel)) return block(sliceRuleBlock(rel, call.tool, APPEND_ONLY_REASON), rel);
    }
    return allow();
  },
});

// The Supabase build kit's slice commit-scope guard (@eventmodelers/cli 2.0.57,
// stacks/supabase/templates/build-kit/lib/check-commit-scope.cjs, lib/checks/*.cjs, and
// shared/build-kit/lib/util/find-slice.cjs), ported for the builder.
//
// Shared by the `done` tool and its tool_call hooks (./index.ts) and by builder/server.ts, which reruns the checks
// before it sends a `done` callback. Plain Node only: server.ts imports this file, so nothing here may import Pi.
//
// Carried over: the eight checks, their order, patterns, heuristics and messages, the "first check to flag a path
// wins" rule, skipIfAlreadyFailing, and the gate that enforces nothing when no change touches a slice.
//
// Differences from the kit:
// - Changes are the working tree against the job's base commit (`git diff <base>` plus untracked files), not
//   against HEAD or the index. The builder commits for the agent, so the patch is everything since base.
// - findSliceJson reads the job's `.slice.json` from the app directory (the checks' working directory) instead of
//   `.build-kit/.slices/<ctx>/<slice>/`, and matches it to a slice folder by its contextName and title, normalized
//   the same way.
// - slice-scope also allows the builder's own files outside a slice: the learnings file capture-learning writes
//   (BuilderExceptions) and the `.scratch/` directory of throwaway scripts. All paths are relative to the app
//   directory, which is where pi runs and where the checks run.
// - The checks are one module instead of a directory the runner loads, so a check is added here, not dropped in.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Change = { status: string; path: string };
export type Violation = { path: string; reason: string };
export type CheckContext = {
  changes: Change[];
  touchesSlice: boolean;
  repoRoot: string;
  SLICE_PATTERN: RegExp;
  /** Builder files outside a slice that slice-scope allows (paths relative to repoRoot). */
  builderExceptions: string[];
};
type Check = { name: string; skipIfAlreadyFailing?: boolean; run(ctx: CheckContext): Violation[] | undefined | null };

export const SLICE_PATTERN = /^src\/slices\/[^/]+\/[^/]+\//;
// A webhook slice is a self-contained edge function with no src/slices/ folder
// of its own — still counts as "this is a slice commit" for the gate below.
export const WEBHOOK_FUNCTION_PATTERN = /^supabase\/functions\/[^/]+\/index\.ts$/;
export const MIGRATION_PATTERN = /^supabase\/migrations\/V\d+__.*\.sql$/;

/** The builder's own files outside a slice: the learnings file (paths relative to the app directory). */
export function builderExceptions(): string[] {
  return ["LEARNINGS.md"];
}

// ---- runner (check-commit-scope.cjs) ----

function parseNameStatus(out: string): Change[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status[0], path: rest.join("\t") };
    });
}

// The kit's allChanges(), against the job's base commit instead of HEAD: working tree vs base covers committed,
// staged and unstaged edits to tracked files; untracked (never-`git add`ed) files need a separate call.
export function allChanges(repoRoot: string, base = "HEAD"): Change[] {
  const tracked = parseNameStatus(
    execFileSync("git", ["diff", base, "--name-status", "--no-renames", "--relative"], { cwd: repoRoot, encoding: "utf8" }),
  );
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((p) => ({ status: "A", path: p }));
  return [...tracked, ...untracked];
}

/** Runs every check, as the kit's main() does, and returns the violations (empty = pass). */
export function runChecks(repoRoot: string, changes: Change[], exceptions = builderExceptions()): Violation[] {
  if (changes.length === 0) return [];

  const touchesSlice = changes.some((c) => SLICE_PATTERN.test(c.path) || WEBHOOK_FUNCTION_PATTERN.test(c.path));
  if (!touchesSlice) return []; // not a slice commit — nothing to enforce

  const ctx: CheckContext = { changes, touchesSlice, repoRoot, SLICE_PATTERN, builderExceptions: exceptions };
  const violations: Violation[] = [];
  const claimedPaths = new Set<string>(); // first check to flag a path wins — avoids repeat noise

  for (const check of CHECKS) {
    if (check.skipIfAlreadyFailing && violations.length > 0) continue;

    let result: Violation[];
    try {
      result = check.run(ctx) || [];
    } catch (err) {
      violations.push({ path: "(check error)", reason: `[${check.name}] threw: ${(err as Error).message}` });
      continue;
    }

    for (const v of result) {
      if (claimedPaths.has(v.path)) continue;
      claimedPaths.add(v.path);
      violations.push({ path: v.path, reason: `[${check.name}] ${v.reason}` });
    }
  }
  return violations;
}

/** The violation list in the kit's output format. */
export function formatViolations(violations: Violation[]): string {
  return violations.map((v) => `  - ${v.path} — ${v.reason}`).join("\n");
}

// ---- util/find-slice.cjs ----

export function normalize(s: unknown): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Name of the slice spec the builder writes at the clone root. */
export const SLICE_FILE = ".slice.json";

// Given the {context}/{SliceName} folder names used under src/slices/, return the job's slice spec when it is that
// slice: its contextName and title match the folder names in normalized (lowercase, alphanumeric-only) form.
// Returns null — never throws — when it is missing, unreadable or another slice; callers treat that as "can't
// verify" and skip rather than block.
export function findSliceJson(repoRoot: string, context: string, sliceName: string): Record<string, unknown> | null {
  const file = join(repoRoot, SLICE_FILE);
  if (!existsSync(file)) return null;
  let slice: Record<string, unknown>;
  try {
    slice = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!slice || typeof slice !== "object") return null;
  const ctxName = slice.contextName ?? slice.context;
  if (normalize(ctxName) !== normalize(context) || normalize(slice.title) !== normalize(sliceName)) return null;
  return slice;
}

// ---- checks/00-blocked-paths.cjs ----

// Rejects a slice commit that touches shared infra which must never change from
// slice work: the package manifest/lockfiles (no new/changed dependencies) and
// server.ts (routes/processors are auto-discovered — never wired there by hand).

export const BLOCKED = [
  {
    pattern: /^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/,
    reason: "dependency/package manifest changes are not allowed from a slice commit",
  },
  {
    pattern: /^server\.ts$/,
    reason: "server.ts is shared infra (routes/processors are auto-discovered) — never touched by slice work",
  },
];

const blockedPaths: Check = {
  name: "blocked-paths",
  run(ctx) {
    const violations: Violation[] = [];
    for (const { path: p } of ctx.changes) {
      const hit = BLOCKED.find((b) => b.pattern.test(p));
      if (hit) violations.push({ path: p, reason: hit.reason });
    }
    return violations;
  },
};

// ---- checks/10-slice-scope.cjs ----

// Everything in a slice commit must be inside the slice's own folder (or
// a webhook's self-contained edge function), or one of the documented
// shared-infra exceptions a slice legitimately registers *into* (never rewrites
// wholesale). Migration files have their own dedicated check
// (append-only-migrations), so they're allowed through here.

export const ALLOWED_EXCEPTIONS = [
  /^src\/slices\/[^/]+\/[A-Za-z0-9]+Events\.ts$/, // per-context event union (append-only)
  /^src\/common\/loadPostgresEventstore\.ts$/, // projection registration / schema.migrate()
  /^supabase\/config\.toml$/, // webhook function registration (verify_jwt entry)
  /^\.scratch\//, // throwaway scripts: the builder keeps this directory out of the patch (.git/info/exclude)
];

// Captures the {context}/{slice} segment so files from two different slices
// in one commit can be told apart — SLICE_PATTERN alone only proves a path is
// *inside some* slice folder, not which one.
export const SLICE_KEY_PATTERN = /^src\/slices\/([^/]+\/[^/]+)\//;

/** The reason slice-scope rejects path `p` given the primary slice, or null when it is in scope. */
export function sliceScopeReason(p: string, primarySlice: string | null, exceptions: string[]): string | null {
  if (WEBHOOK_FUNCTION_PATTERN.test(p)) return null;
  if (MIGRATION_PATTERN.test(p)) return null;
  if (ALLOWED_EXCEPTIONS.some((r) => r.test(p))) return null;
  if (exceptions.includes(p)) return null;

  const m = p.match(SLICE_KEY_PATTERN);
  if (!m) return "outside src/slices/{context}/{slice}/ and not a documented exception";
  if (primarySlice && m[1] !== primarySlice) {
    return `touches slice "${m[1]}" but this commit's scope is "${primarySlice}" — split into separate commits`;
  }
  return null;
}

/** The kit's primary slice: the alphabetically first {context}/{slice} among the changes. */
export function primarySliceOf(paths: string[]): string | null {
  const sliceKeys = new Set<string>();
  for (const p of paths) {
    const m = p.match(SLICE_KEY_PATTERN);
    if (m) sliceKeys.add(m[1]);
  }
  return [...sliceKeys].sort()[0] || null;
}

const sliceScope: Check = {
  name: "slice-scope",
  run(ctx) {
    const violations: Violation[] = [];
    const primarySlice = primarySliceOf(ctx.changes.map((c) => c.path));
    for (const { path: p } of ctx.changes) {
      const reason = sliceScopeReason(p, primarySlice, ctx.builderExceptions);
      if (reason) violations.push({ path: p, reason });
    }
    return violations;
  },
};

// ---- checks/20-append-only-migrations.cjs ----

// supabase/migrations/V{n}__*.sql may only be ADDED, never modified or deleted —
// migrations are append-only; a fix belongs in a new migration, not an edit to
// an old one.

export const APPEND_ONLY_REASON = "existing migrations are append-only; add a new V{n} file instead of editing this one";

const appendOnlyMigrations: Check = {
  name: "append-only-migrations",
  run(ctx) {
    const violations: Violation[] = [];
    for (const { status, path: p } of ctx.changes) {
      if (!MIGRATION_PATTERN.test(p)) continue;
      if (status !== "A") violations.push({ path: p, reason: APPEND_ONLY_REASON });
    }
    return violations;
  },
};

// ---- checks/30-test-file-present.cjs ----

// A slice commit that adds/changes a command handler, projection, or processor
// must also include a *.test.ts for that slice — catches the agent skipping the
// matching build skill's test step.

const IMPLEMENTATION_FILE = /^src\/slices\/([^/]+)\/([^/]+)\/(?:[A-Za-z0-9]+Command|[A-Za-z0-9]+Projection|processor(?:-[A-Za-z0-9]+)?)\.ts$/;

const testFilePresent: Check = {
  name: "test-file-present",
  run(ctx) {
    const sliceDirs = new Set<string>();
    for (const { path: p } of ctx.changes) {
      const m = IMPLEMENTATION_FILE.exec(p);
      if (m) sliceDirs.add(`src/slices/${m[1]}/${m[2]}`);
    }
    if (sliceDirs.size === 0) return [];

    let tracked: string[] = [];
    try {
      tracked = execSync("git ls-files -- src/slices", { cwd: ctx.repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {
      // best-effort — fall through with whatever's changed
    }
    const known = new Set([...tracked, ...ctx.changes.map((c) => c.path)]);

    const violations: Violation[] = [];
    for (const dir of sliceDirs) {
      const hasTest = [...known].some((f) => f.startsWith(`${dir}/`) && f.endsWith(".test.ts"));
      if (!hasTest) {
        violations.push({
          path: dir,
          reason: "no *.test.ts found for this slice — command handlers/projections/processors need test coverage",
        });
      }
    }
    return violations;
  },
};

// ---- checks/40-no-invented-fields.cjs ----

// Heuristic: flags a field name used in a slice's Command/ReadModel type literal
// that doesn't appear anywhere in that slice's own slice.json. Not a real
// TS/schema-aware check (no parser dependency) — it regex-extracts the fields
// declared inside `Command<'Name', { ... }, ...>` and `type XReadModel = { ... }`
// literals, so unusual formatting (nested object/array field types, nonstandard
// generics) can slip past undetected. It only ever adds violations for fields it
// is confident about; when slice.json can't be found/parsed for a slice, that
// slice's files are skipped entirely rather than guessed at.

const COMMON_ALLOWED = new Set(
  ["id", "userId", "correlationId", "causationId", "streamName", "type", "data", "metadata", "createdAt", "updatedAt", "timestamp"].map(normalize),
);

const TYPE_LITERALS = [/(?:Command|Event)<\s*'[^']+'\s*,\s*{([^}]*)}/g, /type\s+[A-Za-z0-9_]+ReadModel\s*=\s*{([^}]*)}/g];

const FIELD_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm;

function collectDeclaredFields(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectDeclaredFields(item, out);
  } else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.name === "string" && ("type" in o || "optional" in o)) {
      out.add(normalize(o.name));
    }
    for (const key of Object.keys(o)) collectDeclaredFields(o[key], out);
  }
}

const noInventedFields: Check = {
  name: "no-invented-fields",
  run(ctx) {
    const bySlice = new Map<string, { context: string; sliceName: string; files: string[] }>();

    for (const { path: p } of ctx.changes) {
      if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
      const m = /^src\/slices\/([^/]+)\/([^/]+)\//.exec(p);
      if (!m) continue;
      const key = `${m[1]}/${m[2]}`;
      if (!bySlice.has(key)) bySlice.set(key, { context: m[1], sliceName: m[2], files: [] });
      bySlice.get(key)!.files.push(p);
    }

    const violations: Violation[] = [];

    for (const { context, sliceName, files } of bySlice.values()) {
      const slice = findSliceJson(ctx.repoRoot, context, sliceName);
      if (!slice) continue; // can't verify — don't block

      const declared = new Set<string>();
      collectDeclaredFields(slice, declared);
      if (declared.size === 0) continue; // slice.json shape not recognized — don't block

      for (const file of files) {
        let content: string;
        try {
          content = readFileSync(join(ctx.repoRoot, file), "utf8");
        } catch {
          continue; // deleted/unreadable — nothing to check
        }

        for (const pattern of TYPE_LITERALS) {
          pattern.lastIndex = 0;
          let typeMatch: RegExpExecArray | null;
          while ((typeMatch = pattern.exec(content))) {
            FIELD_LINE.lastIndex = 0;
            let fieldMatch: RegExpExecArray | null;
            while ((fieldMatch = FIELD_LINE.exec(typeMatch[1]))) {
              const raw = fieldMatch[1];
              const norm = normalize(raw);
              if (COMMON_ALLOWED.has(norm) || declared.has(norm)) continue;
              violations.push({
                path: file,
                reason: `field "${raw}" is not declared anywhere in slice.json for this slice — check for an invented field`,
              });
            }
          }
        }
      }
    }

    return violations;
  },
};

// ---- checks/50-spec-coverage.cjs ----

// Heuristic: a slice's *.test.ts must have at least as many `it(...)` blocks as
// slice.json has `specifications[]` entries. Doesn't verify each spec is
// actually tested (that would need matching scenario content, not just count),
// just that nobody's silently short a test case. Skipped (not blocked) when
// slice.json can't be found or has no specifications[] array.

const TEST_FILE = /^src\/slices\/([^/]+)\/([^/]+)\/[^/]+\.test\.ts$/;
const IT_BLOCK = /\bit(?:\.(?:only|skip))?\s*\(/g;

const specCoverage: Check = {
  name: "spec-coverage",
  run(ctx) {
    const violations: Violation[] = [];

    for (const { path: p } of ctx.changes) {
      TEST_FILE.lastIndex = 0;
      const m = TEST_FILE.exec(p);
      if (!m) continue;
      const [, context, sliceName] = m;

      const slice = findSliceJson(ctx.repoRoot, context, sliceName);
      if (!slice || !Array.isArray(slice.specifications) || slice.specifications.length === 0) continue;

      let content: string;
      try {
        content = readFileSync(join(ctx.repoRoot, p), "utf8");
      } catch {
        continue; // deleted — nothing to check
      }

      const specCount = slice.specifications.length;
      const itCount = (content.match(IT_BLOCK) || []).length;

      if (itCount < specCount) {
        violations.push({
          path: p,
          reason: `slice.json declares ${specCount} specification(s) but this test file only has ${itCount} it(...) block(s)`,
        });
      }
    }

    return violations;
  },
};

// ---- checks/60-openapi-annotation.cjs ----

// Every HTTP handler in a slice's routes.ts must carry an `@openapi` JSDoc block
// directly above it. src/swagger.ts builds the published OpenAPI document by
// scanning ./src/slices/**/routes.ts for those blocks, so a handler without one
// is a working endpoint that never appears in Swagger UI (/api-docs) or in
// /swagger.json.
//
// Heuristic, not an OpenAPI parser: it checks that a block exists between the
// previous handler and this one, and that the block names this handler's own
// path (express `:param` rewritten as `{param}`).

const ROUTES_FILE = /^src\/slices\/[^/]+\/[^/]+\/routes\.ts$/;
const ROUTE_CALL = /\brouter\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2/g;
const OPENAPI_BLOCK = /\/\*\*(?:[\s\S]*?)@openapi(?:[\s\S]*?)\*\//g;

// /api/foo/:id -> /api/foo/{id}
const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

const openapiAnnotation: Check = {
  name: "openapi-annotation",
  run(ctx) {
    const violations: Violation[] = [];

    for (const { path: p } of ctx.changes) {
      if (!ROUTES_FILE.test(p)) continue;

      let content: string;
      try {
        content = readFileSync(join(ctx.repoRoot, p), "utf8");
      } catch {
        continue; // deleted — nothing to check
      }

      ROUTE_CALL.lastIndex = 0;
      let cursor = 0; // start of the text belonging to the handler being checked
      let call: RegExpExecArray | null;
      while ((call = ROUTE_CALL.exec(content))) {
        const [, method, , routePath] = call;
        const preceding = content.slice(cursor, call.index);
        cursor = ROUTE_CALL.lastIndex;

        const blocks = preceding.match(OPENAPI_BLOCK) || [];
        if (blocks.length === 0) {
          violations.push({
            path: p,
            reason: `${method.toUpperCase()} ${routePath} has no @openapi JSDoc block above it — the endpoint would be missing from /api-docs and /swagger.json`,
          });
          continue;
        }

        const documented = toOpenApiPath(routePath);
        if (!blocks[blocks.length - 1].includes(documented)) {
          violations.push({
            path: p,
            reason: `the @openapi block above ${method.toUpperCase()} ${routePath} does not document "${documented}" — the path key must match the registered route, with express ":param" written as "{param}"`,
          });
        }
      }
    }

    return violations;
  },
};

// ---- checks/90-tsc-build.cjs ----

// The project must still typecheck after the slice change. Uses the project's
// own `typescript` devDependency via `npx tsc --noEmit` — no new dependency,
// but it does mean this check needs node_modules already installed.

const tscBuild: Check = {
  name: "tsc-build",
  skipIfAlreadyFailing: true, // slow — don't bother once the commit is rejected already
  run(ctx) {
    try {
      execSync("npx tsc --noEmit", { cwd: ctx.repoRoot, stdio: "pipe" });
      return [];
    } catch (err) {
      const e = err as { stdout?: unknown; message?: string };
      const output = String(e.stdout || e.message || "").trim().split("\n").slice(0, 20).join("\n");
      return [{ path: "(tsc --noEmit)", reason: `TypeScript build failed:\n${output}` }];
    }
  },
};

// Numeric filename prefixes (00-, 10-, ...) controlled the kit's run order; this list keeps it.
const CHECKS: Check[] = [blockedPaths, sliceScope, appendOnlyMigrations, testFilePresent, noInventedFields, specCoverage, openapiAnnotation, tscBuild];

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Hono } from "hono";
import { ServiceError } from "../../core/errors.ts";
import { resolveProjectRoot } from "../../core/paths.ts";

/** The builder's definitions: the agent tree, shared skills, templates and gates, the builders. */
const ROOT = resolve(resolveProjectRoot(), "agentics");
const MAX_FILE_BYTES = 256 * 1024;

export interface BuilderAgentFile {
  readonly path: string;
  readonly size: number;
}

function safeFile(path: string): string {
  if (path === "" || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new ServiceError("invalid", "path must be a relative file path inside builder/agentics");
  }
  const target = resolve(ROOT, path);
  if (relative(ROOT, target).startsWith("..")) throw new ServiceError("forbidden", "path is outside builder/agentics");
  return target;
}

/** Pi's credential files are never shown, not even as names; neither are run state, local data and dependencies. */
const HIDDEN_FILES = new Set(["auth.json"]);
const HIDDEN_DIRS = new Set(["node_modules", ".git", "state", "local", "work", "history", "changesets"]);

function visible(path: string): boolean {
  const parts = path.split("/");
  return !HIDDEN_FILES.has(parts[parts.length - 1]) && !parts.slice(0, -1).some((p) => HIDDEN_DIRS.has(p));
}

function list(dir: string, prefix = ""): BuilderAgentFile[] {
  if (!existsSync(dir)) return [];
  const out: BuilderAgentFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const target = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!HIDDEN_DIRS.has(entry.name)) out.push(...list(target, path));
    } else if (entry.isFile() && visible(path)) out.push({ path, size: statSync(target).size });
  }
  return out;
}

/**
 * Read-only browser access to the builder's definitions (builder/agentics). They are changed through the builder's
 * definitions tools, which validate and version every change (design section 9), not by writing files from here.
 */
export function builderAgentRoutes(): Hono {
  const app = new Hono();

  app.get("/builder-agent/files", (c) => c.json({ root: "builder/agentics", files: list(ROOT) }));

  app.get("/builder-agent/read", (c) => {
    const path = c.req.query("path");
    if (path === undefined) throw new ServiceError("invalid", "path is required");
    if (!visible(path)) throw new ServiceError("not_found", "file not found");
    const target = safeFile(path);
    if (!existsSync(target) || !statSync(target).isFile()) throw new ServiceError("not_found", "file not found");
    const size = statSync(target).size;
    if (size > MAX_FILE_BYTES) throw new ServiceError("too_large", `file is larger than ${MAX_FILE_BYTES} bytes`);
    return c.json({ path, content: readFileSync(target, "utf8"), size });
  });

  return app;
}

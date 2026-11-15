import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import { resolveProjectRoot } from "../../core/paths.ts";
import { listSessions, readSession } from "../../../../../builder/pi-session-files.ts";

const ROOT = resolve(resolveProjectRoot(), "builder", "pi-agent");
const MAX_FILE_BYTES = 256 * 1024;

export interface BuilderAgentFile {
  readonly path: string;
  readonly size: number;
}

function safeFile(path: string): string {
  if (path === "" || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new ServiceError("invalid", "path must be a relative file path inside builder/pi-agent");
  }
  const target = resolve(ROOT, path);
  if (relative(ROOT, target).startsWith("..")) throw new ServiceError("forbidden", "path is outside builder/pi-agent");
  return target;
}

function visible(path: string): boolean {
  // Pi's credential file must never be exposed in the browser, even as a filename.
  return path !== "auth.json";
}

function list(dir: string, prefix = ""): BuilderAgentFile[] {
  if (!existsSync(dir)) return [];
  const out: BuilderAgentFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (!visible(path)) continue;
    const target = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...list(target, path));
    else if (entry.isFile()) out.push({ path, size: statSync(target).size });
  }
  return out;
}

const SESSIONS = resolve(ROOT, "sessions");

/** Read-only browser access to Pi's actual agent directory. auth.json is intentionally excluded. */
export function builderAgentRoutes(): Hono {
  const app = new Hono();

  app.get("/builder-agent/sessions", (c) => c.json({ sessions: listSessions(SESSIONS) }));

  app.get("/builder-agent/session", (c) => {
    const r = readSession(SESSIONS, c.req.query("id"));
    if (!r.ok) throw new ServiceError(r.code, r.message);
    return c.json({ id: r.id, content: r.content, size: r.size });
  });

  app.get("/builder-agent/files", (c) => c.json({ root: "builder/pi-agent", files: list(ROOT) }));

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

  app.post("/builder-agent/write", async (c) => {
    const body: unknown = await jsonBody(c.req.raw);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ServiceError("invalid", "the body must be a JSON object");
    const { path, content } = body as Record<string, unknown>;
    if (typeof path !== "string" || typeof content !== "string") throw new ServiceError("invalid", "path and content must be strings");
    if (!visible(path)) throw new ServiceError("not_found", "file not found");
    const target = safeFile(path);
    if (!existsSync(target) || !statSync(target).isFile()) throw new ServiceError("not_found", "file not found");
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new ServiceError("too_large", `file is larger than ${MAX_FILE_BYTES} bytes`);
    writeFileSync(target, content, "utf8");
    return c.json({ path, content, size: Buffer.byteLength(content, "utf8") });
  });

  return app;
}

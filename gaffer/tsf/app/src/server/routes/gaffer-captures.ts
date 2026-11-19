import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { ServiceError } from "../../core/errors.ts";
import { projectPaths, resolveProjectRoot } from "../../core/paths.ts";
import { renderDiffPage } from "./diff-page.ts";

/** Where gaffer.ts writes one folder per turn (kit/templates/build-kit/capture.ts). */
const ROOT = join(projectPaths(resolveProjectRoot()).dataDir, "layers", "gaffer", "captures");

function turnDir(id: string | undefined): string {
  if (!id || !/^[\w-]+$/.test(id)) throw new ServiceError("invalid", "turn must be a capture folder name");
  const dir = join(ROOT, id);
  if (!existsSync(join(dir, "turn.json"))) throw new ServiceError("not_found", `no captured turn ${id}`);
  return dir;
}

function blobFile(dir: string, file: string | undefined): string {
  if (!file || !/^[\w.-]+$/.test(file) || file.startsWith(".")) throw new ServiceError("invalid", "file must be a blob file name");
  const path = join(dir, "blobs", file);
  if (!existsSync(path)) throw new ServiceError("not_found", `no blob ${file}`);
  return path;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Read-only browser access to the gaffer's turn captures. */
export function gafferCaptureRoutes(): Hono {
  const app = new Hono();

  app.get("/gaffer-captures/turns", (c) => {
    if (!existsSync(ROOT)) return c.json({ root: ROOT, turns: [] });
    const turns = readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, "turn.json")))
      .map((d) => readJson(join(ROOT, d.name, "turn.json")))
      .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
      .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
    return c.json({ root: ROOT, turns });
  });

  app.get("/gaffer-captures/turn", (c) => {
    const dir = turnDir(c.req.query("id"));
    const file = join(dir, "entries.jsonl");
    const entries = existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l) as unknown;
            } catch {
              return null;
            }
          })
          .filter((e) => e !== null)
      : [];
    return c.json({ summary: readJson(join(dir, "turn.json")), entries });
  });

  app.get("/gaffer-captures/blob", (c) => {
    const path = blobFile(turnDir(c.req.query("turn")), c.req.query("file"));
    const type = path.endsWith(".json") ? "application/json" : "text/plain";
    return new Response(readFileSync(path), {
      headers: { "content-type": `${type}; charset=utf-8`, "content-length": String(statSync(path).size), "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  });

  app.get("/gaffer-captures/diff", (c) => {
    const turn = c.req.query("turn");
    const dir = turnDir(turn);
    const file = c.req.query("file");
    const path = blobFile(dir, file);
    const summary = readJson(join(dir, "turn.json")) as Record<string, unknown> | null;
    const html = renderDiffPage(readFileSync(path, "utf8"), {
      title: `${String(summary?.slice ?? "Patch")} · ${file}`,
      subtitle: `${String(summary?.context ?? "")}${summary?.context ? "/" : ""}${String(summary?.slice ?? "")} · turn ${turn} · job ${String(summary?.jobId ?? "?")}`,
      rawUrl: `/api/gaffer-captures/blob?turn=${encodeURIComponent(String(turn))}&file=${encodeURIComponent(String(file))}`,
    });
    return c.html(html);
  });

  return app;
}

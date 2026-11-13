import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import type { FactoryService } from "../../core/service-api.ts";
import type { PageEdit } from "../../shared/types.ts";

function record(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ServiceError("invalid", "the body must be a JSON object");
  return v as Record<string, unknown>;
}

function reqString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string") throw new ServiceError("invalid", `${key} must be a string`);
  return v;
}

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ServiceError("invalid", `${key} must be a string`);
  return v;
}

function optEdits(body: Record<string, unknown>): PageEdit[] | undefined {
  const v = body.edits;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new ServiceError("invalid", "edits must be a list of { oldText, newText }");
  return v.map((e, i) => {
    const o = record(e);
    if (typeof o.oldText !== "string" || typeof o.newText !== "string") {
      throw new ServiceError("invalid", `edit ${i + 1}: oldText and newText must be strings`);
    }
    return { oldText: o.oldText, newText: o.newText };
  });
}

/**
 * The page routes (DESIGN 5.1). Mounted at `/api/pages`. GET `/` the tree, GET `/read?path=`, and POST `/create`,
 * `/update`, `/move`, `/delete`, `/create-folder`, `/select`, `/unselect`. Every command is a POST with a JSON body;
 * the Service validates the paths.
 */
export function pageRoutes(service: FactoryService): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json(service.listPages()));

  app.get("/read", async (c) => {
    const path = c.req.query("path");
    if (path === undefined || path === "") throw new ServiceError("invalid", "path is required");
    return c.json(await service.readPage({ path }));
  });

  app.post("/create", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const content = optString(body, "content");
    return c.json(await service.createPage({ path: reqString(body, "path"), ...(content !== undefined ? { content } : {}) }, { by: "ui" }));
  });

  app.post("/update", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const content = optString(body, "content");
    const edits = optEdits(body);
    const baseVersion = optString(body, "baseVersion");
    return c.json(
      await service.updatePage(
        {
          path: reqString(body, "path"),
          ...(content !== undefined ? { content } : {}),
          ...(edits !== undefined ? { edits } : {}),
          ...(baseVersion !== undefined ? { baseVersion } : {}),
        },
        { by: "ui" },
      ),
    );
  });

  app.post("/move", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.movePage({ from: reqString(body, "from"), to: reqString(body, "to") }, { by: "ui" }));
  });

  app.post("/delete", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const recursive = body.recursive;
    if (recursive !== undefined && typeof recursive !== "boolean") throw new ServiceError("invalid", "recursive must be a boolean");
    return c.json(await service.deletePage({ path: reqString(body, "path"), ...(recursive !== undefined ? { recursive } : {}) }, { by: "ui" }));
  });

  app.post("/create-folder", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.createFolder({ path: reqString(body, "path") }, { by: "ui" }));
  });

  app.post("/select", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.selectPage({ path: reqString(body, "path") }, { by: "ui" }));
  });

  app.post("/unselect", async (c) => {
    // The body is `{}` by convention and ignored.
    return c.json(await service.unselectPage({ by: "ui" }));
  });

  return app;
}

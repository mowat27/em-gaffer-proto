import { Hono } from "hono";
import { ServiceError } from "../../core/errors.ts";
import type { FactoryService } from "../../core/service-api.ts";
import { MAX_UPLOAD_BYTES } from "../../core/uploads.ts";

/** The one route that takes a raw body (guard.ts lets `application/octet-stream` through here, app.ts lifts the body limit). */
export const UPLOAD_PATH = "/api/uploads";

/**
 * POST `/api/uploads?name=<file name>` with the file's bytes as an `application/octet-stream` body: saves it in
 * `tsf/uploads/` and answers `{ name, path, bytes }` (DESIGN 5.1). An infrastructure route.
 */
export function uploadRoutes(service: FactoryService): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    const length = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_UPLOAD_BYTES) {
      throw new ServiceError("too_large", `the file is larger than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`);
    }
    return c.json(await service.saveUpload({ name: c.req.query("name"), body: c.req.raw.body }, { by: "ui" }));
  });
  return app;
}

import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import type { FactoryService } from "../../core/service-api.ts";
import type { ScreenshotInput } from "../../shared/types.ts";
import { optInt, optString, record } from "./body.ts";

/**
 * The factory's own source and process (P9 "Liquid core", DESIGN 5.1): POST `/factory/rebuild-web`, `/factory/restart`
 * `{ reason? }`, `/factory/screenshot` `{ page?, selector?, width?, height?, mode?, fullPage? }`, and GET
 * `/screenshots/:file` (an infrastructure route: a PNG from `tsf/data/screenshots`, by plain file name).
 */
export function factoryRoutes(service: FactoryService): Hono {
  const app = new Hono();

  app.post("/factory/rebuild-web", async (c) => {
    record(await jsonBody(c.req.raw));
    return c.json(await service.rebuildWeb());
  });

  app.post("/factory/restart", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const reason = optString(body, "reason");
    return c.json(await service.restart(reason !== undefined ? { reason } : {}, { by: "ui" }));
  });

  app.post("/factory/screenshot", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const mode = optString(body, "mode");
    if (mode !== undefined && mode !== "light" && mode !== "dark") throw new ServiceError("invalid", 'mode must be "light" or "dark"');
    if (body.fullPage !== undefined && typeof body.fullPage !== "boolean") throw new ServiceError("invalid", "fullPage must be true or false");
    const page = optString(body, "page");
    const selector = optString(body, "selector");
    const width = optInt(body, "width");
    const height = optInt(body, "height");
    const input: ScreenshotInput = {
      ...(page !== undefined ? { page } : {}),
      ...(selector !== undefined ? { selector } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(body.fullPage === true ? { fullPage: true } : {}),
    };
    return c.json(await service.screenshot(input));
  });

  app.get("/screenshots/:file", async (c) => {
    const { bytes } = await service.readScreenshot({ file: c.req.param("file") });
    return new Response(bytes as BodyInit, {
      headers: { "content-type": "image/png", "content-length": String(bytes.length), "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  });

  return app;
}

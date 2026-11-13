import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import type { FactoryService } from "../../core/service-api.ts";
import { optString, record, reqString } from "./body.ts";

/** POST `/api/ui/open` `{ target: "settings" | "cron", section? }`: the Service publishes `ui.open` (spec 8.4, DESIGN 11). */
export function uiRoutes(service: FactoryService): Hono {
  const app = new Hono();
  app.post("/open", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const target = reqString(body, "target");
    if (target !== "settings" && target !== "cron") throw new ServiceError("invalid", "target must be settings or cron");
    const section = optString(body, "section");
    return c.json(await service.openPanel({ target, ...(section !== undefined ? { section } : {}) }, { by: "ui" }));
  });
  return app;
}

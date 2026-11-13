import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import type { FactoryService } from "../../core/service-api.ts";
import type { ThinkingLevel } from "../../shared/types.ts";
import { record, reqString } from "./body.ts";

/** GET `/api/models` and POST `/api/models/refresh` (mounted at `/api/models`). */
export function modelRoutes(service: FactoryService): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json(service.listModels()));
  app.post("/refresh", async (c) => {
    record(await jsonBody(c.req.raw));
    return c.json(await service.refreshModels({ by: "ui" }));
  });
  return app;
}

/**
 * POST `/api/model/set` `{ provider, modelId }` and POST `/api/thinking/set` `{ level }` (P5), mounted at `/api`.
 * Both are applied with `conversation.configure`.
 */
export function modelSelectionRoutes(service: FactoryService): Hono {
  const app = new Hono();
  app.post("/model/set", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.setModel({ provider: reqString(body, "provider"), modelId: reqString(body, "modelId") }, { by: "ui" }));
  });
  app.post("/thinking/set", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    if (typeof body.level !== "string") throw new ServiceError("invalid", "level must be a string");
    return c.json(await service.setThinkingLevel(body.level as ThinkingLevel, { by: "ui" }));
  });
  return app;
}

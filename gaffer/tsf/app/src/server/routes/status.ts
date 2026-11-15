import { Hono } from "hono";
import type { FactoryService } from "../../core/service-api.ts";

/** GET /api/status (infrastructure route) and GET /api/settings (capability settings.get, P9; DESIGN 5.1). */
export function statusRoutes(service: FactoryService): Hono {
  const app = new Hono();
  app.get("/status", (c) => c.json(service.status()));
  app.get("/settings", (c) => c.json(service.getSettings()));
  return app;
}

import { Hono } from "hono";
import { ServiceError } from "../../core/errors.ts";
import type { FactoryService, RunListInput } from "../../core/service-api.ts";

/** A decimal integer query value (`limit`, `before`), or undefined when absent. */
function intParam(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d{1,15}$/.test(raw)) throw new ServiceError("invalid", `${name} must be a non-negative integer`);
  return Number(raw);
}

/**
 * GET `/api/runs?limit=20&before=` (newest first) and GET `/api/runs/:id` (DESIGN 5.1, P2). Read-only views of the
 * recorder's rows. Mounted at `/api` (`api.route("/", runRoutes(service))`).
 */
export function runRoutes(service: FactoryService): Hono {
  const app = new Hono();
  app.get("/runs", (c) => {
    const limit = intParam(c.req.query("limit"), "limit");
    const before = intParam(c.req.query("before"), "before");
    const input: RunListInput = { ...(limit !== undefined ? { limit } : {}), ...(before !== undefined ? { before } : {}) };
    return c.json(service.listRuns(input));
  });
  app.get("/runs/:id", (c) => {
    const id = intParam(c.req.param("id"), "id");
    if (id === undefined) throw new ServiceError("invalid", "id must be a non-negative integer");
    return c.json(service.getRun(id));
  });
  return app;
}

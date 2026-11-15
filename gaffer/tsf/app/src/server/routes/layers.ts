import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import type { FactoryService } from "../../core/service-api.ts";
import { record, reqString } from "./body.ts";

/**
 * GET /api/layers, /api/tools, /api/ceiling (DESIGN 5.1, P2): read-only views of the layer registry and the frozen
 * permissions ceiling. P5 adds GET /api/tools/describe?name=&syntax=, POST /api/tools/set-enabled and POST
 * /api/layers/set-enabled. Mounted at `/api` (`api.route("/", layerRoutes(service))`). No route writes the ceiling.
 */
export function layerRoutes(service: FactoryService): Hono {
  const app = new Hono();
  app.get("/layers", (c) => c.json(service.listLayers()));
  app.get("/tools", (c) => c.json(service.listTools()));
  app.get("/ceiling", (c) => c.json(service.getCeiling()));

  app.get("/tools/describe", (c) => {
    const name = c.req.query("name");
    if (name === undefined || name === "") throw new ServiceError("invalid", "name is required");
    const syntax = c.req.query("syntax");
    if (syntax !== undefined && syntax !== "" && syntax !== "json" && syntax !== "typescript") {
      throw new ServiceError("invalid", "syntax must be json or typescript");
    }
    return c.json(service.describeTool({ name, ...(syntax === "json" || syntax === "typescript" ? { syntax } : {}) }));
  });

  const toggle = (what: "tools" | "layers") =>
    async (c: { req: { raw: Request }; json: (v: object) => Response }) => {
      const body = record(await jsonBody(c.req.raw));
      if (typeof body.enabled !== "boolean") throw new ServiceError("invalid", "enabled must be true or false");
      const input = { name: reqString(body, "name"), enabled: body.enabled };
      return c.json(what === "tools" ? await service.setToolEnabled(input, { by: "ui" }) : await service.setLayerEnabled(input, { by: "ui" }));
    };
  app.post("/tools/set-enabled", toggle("tools"));
  app.post("/layers/set-enabled", toggle("layers"));
  return app;
}

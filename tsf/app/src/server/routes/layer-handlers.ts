import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import type { FactoryService } from "../../core/service-api.ts";
import type { Json } from "../../shared/types.ts";

const MAX_QUERY_INPUT = 8_000;

/**
 * The generic layer handler routes (DESIGN 8, "Layer handlers and UI"). Mounted at `/api/layers`:
 * GET `/:layer/query/:name?input=<url-encoded JSON>` and POST `/:layer/action/:name` with `{ input }`. Both call the
 * Service's `layerQuery` / `layerAction`, which check that the layer is loaded and enabled and the handler exists.
 */
export function layerHandlerRoutes(service: FactoryService): Hono {
  const app = new Hono();

  app.get("/:layer/query/:name", async (c) => {
    const raw = c.req.query("input");
    let input: Json = {};
    if (raw !== undefined && raw !== "") {
      if (raw.length > MAX_QUERY_INPUT) throw new ServiceError("too_large", `the input query is larger than ${MAX_QUERY_INPUT} characters`);
      try {
        input = JSON.parse(raw) as Json;
      } catch {
        throw new ServiceError("invalid", "input must be URL-encoded JSON");
      }
    }
    const out: unknown = await service.layerQuery({ layer: c.req.param("layer"), name: c.req.param("name"), input });
    return c.json(out as object | null);
  });

  app.post("/:layer/action/:name", async (c) => {
    const body = await jsonBody(c.req.raw);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ServiceError("invalid", "the body must be a JSON object { input }");
    const input = (body as { input?: Json }).input;
    const out: unknown = await service.layerAction(
      { layer: c.req.param("layer"), name: c.req.param("name"), ...(input !== undefined ? { input } : {}) },
      { by: "ui" },
    );
    return c.json(out as object | null);
  });

  return app;
}

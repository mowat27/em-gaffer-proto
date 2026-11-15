import { Hono } from "hono";
import { jsonBody } from "../../core/errors.ts";
import type { FactoryService } from "../../core/service-api.ts";
import type { JevInput } from "../../shared/types.ts";

/** POST `/api/jev/judge` `{ kind, question, state, criteria? | options | levels }` -> JevVerdict (DESIGN 5.2, P7). Mounted at `/api/jev`. */
export function jevRoutes(service: FactoryService): Hono {
  const app = new Hono();
  // The Service validates the shape (parseJevInput) and answers `invalid`, `unavailable` or `upstream`.
  app.post("/judge", async (c) => c.json(await service.jevJudge((await jsonBody(c.req.raw)) as JevInput)));
  return app;
}

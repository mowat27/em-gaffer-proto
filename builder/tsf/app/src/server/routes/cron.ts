import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import type { FactoryService, UpdateCronInput } from "../../core/service-api.ts";
import { optString, record, reqString } from "./body.ts";

function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new ServiceError("invalid", `${key} must be a boolean`);
  return v;
}

/**
 * GET `/api/cron`, POST `/api/cron/create` `{ name, expr, prompt, enabled? }`, `/update` `{ id, name?, expr?, prompt?,
 * enabled? }`, `/delete` `{ id }`, `/run-now` `{ id }` (DESIGN 5.2, P6). Mounted at `/api/cron`.
 */
export function cronRoutes(service: FactoryService): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json(service.listCrons()));
  app.post("/create", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const enabled = optBool(body, "enabled");
    return c.json(
      await service.createCron(
        { name: reqString(body, "name"), expr: reqString(body, "expr"), prompt: reqString(body, "prompt"), ...(enabled !== undefined ? { enabled } : {}) },
        { by: "ui" },
      ),
    );
  });
  app.post("/update", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const name = optString(body, "name");
    const expr = optString(body, "expr");
    const prompt = optString(body, "prompt");
    const enabled = optBool(body, "enabled");
    const input: UpdateCronInput = {
      id: reqString(body, "id"),
      ...(name !== undefined ? { name } : {}),
      ...(expr !== undefined ? { expr } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };
    return c.json(await service.updateCron(input, { by: "ui" }));
  });
  app.post("/delete", async (c) => c.json(await service.deleteCron({ id: reqString(record(await jsonBody(c.req.raw)), "id") }, { by: "ui" })));
  app.post("/run-now", async (c) => c.json(await service.runCronNow({ id: reqString(record(await jsonBody(c.req.raw)), "id") }, { by: "ui" })));
  return app;
}

import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import type { CompactionPoints } from "../../shared/types.ts";
import type { FactoryService } from "../../core/service-api.ts";
import { optString, record, reqString } from "./body.ts";

/**
 * The Core 4 routes that belong to no older route family (DESIGN 5.2, P5), mounted at `/api`:
 * context and compaction (GET `/context`, POST `/compaction/set`, POST `/compact`) and the four prompt layers
 * (GET `/prompts`, GET `/prompts/get?id=`, POST `/prompts/system`, `/prompts/custom/{create,update,delete}`,
 * `/prompts/toggle`, `/prompts/runtime/{append,remove,clear}`). The model, tool and layer commands sit next to their
 * GET routes in `models.ts` and `layers.ts`. Every command is a thin call of the Service with `{ by: "ui" }`.
 */
export function core4Routes(service: FactoryService): Hono {
  const app = new Hono();

  app.get("/context", (c) => c.json(service.getContext()));

  app.post("/compaction/set", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.setCompaction(body as Partial<CompactionPoints>, { by: "ui" }));
  });

  app.post("/compact", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const instructions = optString(body, "instructions");
    return c.json(await service.compact({ ...(instructions !== undefined ? { instructions } : {}) }, { by: "ui" }));
  });

  app.get("/prompts", async (c) => c.json(await service.listPrompts()));

  app.get("/prompts/get", async (c) => {
    const id = c.req.query("id");
    if (id === undefined || id === "") throw new ServiceError("invalid", "id is required");
    return c.json(await service.getPrompt({ id }));
  });

  app.post("/prompts/system", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const text = body.text;
    if (text !== null && typeof text !== "string") throw new ServiceError("invalid", "text must be a string, or null for the default");
    return c.json(await service.setSystemPrompt({ text }, { by: "ui" }));
  });

  app.post("/prompts/custom/create", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const enabled = body.enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") throw new ServiceError("invalid", "enabled must be true or false");
    return c.json(
      await service.createCustomPrompt(
        { name: reqString(body, "name"), text: reqString(body, "text"), ...(enabled !== undefined ? { enabled } : {}) },
        { by: "ui" },
      ),
    );
  });

  app.post("/prompts/custom/update", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const name = optString(body, "name");
    const text = optString(body, "text");
    return c.json(
      await service.updateCustomPrompt(
        { id: reqString(body, "id"), ...(name !== undefined ? { name } : {}), ...(text !== undefined ? { text } : {}) },
        { by: "ui" },
      ),
    );
  });

  app.post("/prompts/custom/delete", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.deleteCustomPrompt({ id: reqString(body, "id") }, { by: "ui" }));
  });

  app.post("/prompts/toggle", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    if (typeof body.enabled !== "boolean") throw new ServiceError("invalid", "enabled must be true or false");
    return c.json(await service.togglePrompt({ id: reqString(body, "id"), enabled: body.enabled }, { by: "ui" }));
  });

  app.post("/prompts/runtime/append", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.appendRuntimePrompt({ text: reqString(body, "text") }, { by: "ui" }));
  });

  app.post("/prompts/runtime/remove", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.removeRuntimePrompt({ id: reqString(body, "id") }, { by: "ui" }));
  });

  app.post("/prompts/runtime/clear", async (c) => {
    record(await jsonBody(c.req.raw));
    return c.json(await service.clearRuntimePrompts({ by: "ui" }));
  });

  return app;
}

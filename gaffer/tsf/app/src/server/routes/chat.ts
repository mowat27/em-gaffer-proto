import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import type { FactoryService } from "../../core/service-api.ts";

const MAX_TEXT = 100_000;
const MAX_REQUEST_ID = 128;

function record(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ServiceError("invalid", "the body must be a JSON object");
  return v as Record<string, unknown>;
}

function intParam(raw: string | undefined, name: string, min: number, max: number): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) throw new ServiceError("invalid", `${name} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max) throw new ServiceError("invalid", `${name} must be ${min}..${max}`);
  return n;
}

/** GET /api/chat, GET /api/chat/earlier, POST /api/chat/send, /stop and /cancel (infrastructure routes). */
export function chatRoutes(service: FactoryService): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json(service.chatView()));

  app.get("/earlier", async (c) => {
    const before = intParam(c.req.query("before"), "before", 1, Number.MAX_SAFE_INTEGER);
    if (before === undefined) throw new ServiceError("invalid", "before is required");
    const limit = intParam(c.req.query("limit"), "limit", 1, 200);
    return c.json(await service.loadEarlier({ before, ...(limit !== undefined ? { limit } : {}) }));
  });

  app.post("/send", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const { text, requestId, mode } = body;
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT) {
      throw new ServiceError("invalid", `text must be a non-empty string of at most ${MAX_TEXT} characters`);
    }
    if (typeof requestId !== "string" || requestId === "" || requestId.length > MAX_REQUEST_ID) {
      throw new ServiceError("invalid", `requestId must be a string of 1..${MAX_REQUEST_ID} characters`);
    }
    if (mode !== undefined && mode !== "followUp" && mode !== "steer") {
      throw new ServiceError("invalid", "mode must be followUp or steer");
    }
    const result = await service.sendMessage({ text, requestId, ...(mode !== undefined ? { mode } : {}) }, { by: "ui" });
    return c.json(result, 202);
  });

  app.post("/stop", async (c) => {
    // The body is `{}` by convention and ignored.
    return c.json(await service.stopRun({ by: "ui" }));
  });

  app.post("/cancel", async (c) => {
    const { id } = record(await jsonBody(c.req.raw));
    if (typeof id !== "string") throw new ServiceError("invalid", "id must be the id of a queued message");
    return c.json(await service.cancelQueued(id, { by: "ui" }));
  });

  return app;
}

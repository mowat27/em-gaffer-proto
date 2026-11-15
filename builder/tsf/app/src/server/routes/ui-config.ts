import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import type { FactoryService } from "../../core/service-api.ts";
import type { Json, NavbarId, NavbarSlot, UiConfigPatch, WidgetOptions } from "../../shared/types.ts";
import { optInt, optObject, optString, record, reqString } from "./body.ts";

/**
 * The UI config routes (DESIGN 5.1). Mounted at `/api/ui-config`: GET `/` the document, POST `/update` with
 * `{ patch, baseVersion? }` (a JSON Merge Patch; the Service validates the merged document).
 */
export function uiConfigRoutes(service: FactoryService): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json(service.getUiConfig()));

  app.post("/update", async (c) => {
    const body = await jsonBody(c.req.raw);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ServiceError("invalid", "the body must be a JSON object { patch, baseVersion? }");
    }
    const { patch, baseVersion } = body as { patch?: unknown; baseVersion?: unknown };
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new ServiceError("invalid", "patch must be a JSON object");
    if (baseVersion !== undefined && !Number.isInteger(baseVersion)) throw new ServiceError("invalid", "baseVersion must be an integer");
    return c.json(
      await service.updateUiConfig(
        { patch: patch as UiConfigPatch, ...(baseVersion !== undefined ? { baseVersion: baseVersion as number } : {}) },
        { by: "ui" },
      ),
    );
  });

  return app;
}

/**
 * The widget routes (DESIGN 5.2). Mounted at `/api/widgets`: GET `/` the available widget types and the placements,
 * POST `/add`, `/remove`, `/move`, `/options`. The Service validates navbar, slot, ids and the merged document.
 */
export function widgetRoutes(service: FactoryService): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json(service.listWidgets()));

  app.post("/add", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const index = optInt(body, "index");
    const options = optObject(body, "options");
    return c.json(
      await service.addWidget(
        {
          navbar: reqString(body, "navbar") as NavbarId,
          widget: reqString(body, "widget"),
          slot: reqString(body, "slot") as NavbarSlot,
          ...(index !== undefined ? { index } : {}),
          ...(options !== undefined ? { options: options as WidgetOptions } : {}),
        },
        { by: "ui" },
      ),
    );
  });

  app.post("/remove", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.removeWidget({ id: reqString(body, "id") }, { by: "ui" }));
  });

  app.post("/move", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const navbar = optString(body, "navbar");
    const slot = optString(body, "slot");
    const index = optInt(body, "index");
    if (index === undefined) throw new ServiceError("invalid", "index must be an integer");
    return c.json(
      await service.moveWidget(
        {
          id: reqString(body, "id"),
          index,
          ...(navbar !== undefined ? { navbar: navbar as NavbarId } : {}),
          ...(slot !== undefined ? { slot: slot as NavbarSlot } : {}),
        },
        { by: "ui" },
      ),
    );
  });

  app.post("/options", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const options = optObject(body, "options");
    if (options === undefined) throw new ServiceError("invalid", "options must be an object");
    return c.json(await service.setWidgetOptions({ id: reqString(body, "id"), options: options as { [k: string]: Json } }, { by: "ui" }));
  });

  return app;
}

/** The hotkey routes (DESIGN 5.2). Mounted at `/api/hotkeys`: GET `/`, POST `/set` with `{ action, key }`. */
export function hotkeyRoutes(service: FactoryService): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json(service.listHotkeys()));
  app.post("/set", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.setHotkey({ action: reqString(body, "action"), key: reqString(body, "key") }, { by: "ui" }));
  });
  return app;
}

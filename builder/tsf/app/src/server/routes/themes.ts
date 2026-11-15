import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import type { CreateThemeInput, FactoryService, SetThemeValuesInput } from "../../core/service-api.ts";
import { optObject, optString, record, reqString } from "./body.ts";

/**
 * The theme routes (DESIGN 5.2). Mounted at `/api/themes`: GET `/` the theme list (PW, then custom; the active theme is
 * `uiConfig.theme.name`), POST `/set`, `/create`, `/values`, `/check`, `/fix`, `/delete`. The theme CSS has no route: it
 * is in the snapshot and in `theme.applied`.
 */
export function themeRoutes(service: FactoryService): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json(service.listThemes()));

  app.post("/set", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const mode = optString(body, "mode");
    if (mode !== undefined && mode !== "light" && mode !== "dark" && mode !== "system") {
      throw new ServiceError("invalid", "mode must be light, dark or system");
    }
    return c.json(await service.setTheme({ name: reqString(body, "name"), ...(mode !== undefined ? { mode } : {}) }, { by: "ui" }));
  });

  app.post("/create", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const title = optString(body, "title");
    const seeds = optObject(body, "seeds");
    const tokens = optObject(body, "tokens");
    return c.json(
      await service.createTheme(
        {
          name: reqString(body, "name"),
          base: reqString(body, "base"),
          ...(title !== undefined ? { title } : {}),
          ...(seeds !== undefined ? { seeds: seeds as CreateThemeInput["seeds"] } : {}),
          ...(tokens !== undefined ? { tokens: tokens as CreateThemeInput["tokens"] } : {}),
        } as CreateThemeInput,
        { by: "ui" },
      ),
    );
  });

  app.post("/values", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const title = optString(body, "title");
    const seeds = optObject(body, "seeds");
    const tokens = optObject(body, "tokens");
    return c.json(
      await service.setThemeValues(
        {
          name: reqString(body, "name"),
          ...(title !== undefined ? { title } : {}),
          ...(seeds !== undefined ? { seeds: seeds as SetThemeValuesInput["seeds"] } : {}),
          ...(tokens !== undefined ? { tokens: tokens as SetThemeValuesInput["tokens"] } : {}),
        } as SetThemeValuesInput,
        { by: "ui" },
      ),
    );
  });

  app.post("/check", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(service.checkTheme({ name: reqString(body, "name") }));
  });

  app.post("/fix", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.fixTheme({ name: reqString(body, "name") }, { by: "ui" }));
  });

  app.post("/delete", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.deleteTheme({ name: reqString(body, "name") }, { by: "ui" }));
  });

  return app;
}

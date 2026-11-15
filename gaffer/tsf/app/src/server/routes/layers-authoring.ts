import { Hono } from "hono";
import { jsonBody, ServiceError } from "../../core/errors.ts";
import type { FactoryService } from "../../core/service-api.ts";
import type { WidgetContribution } from "../../shared/types.ts";
import { optObject, optString, record, reqString } from "./body.ts";

const query = (value: string | undefined, key: string): string => {
  if (value === undefined || value === "") throw new ServiceError("invalid", `${key} is required`);
  return value;
};

/**
 * Layer authoring routes (P9, DESIGN 5.1 and 8). Mounted at `/api`: GET `/layers/files?name=`, GET
 * `/layers/read-file?name=&path=`, POST `/layers/create`, `/layers/delete`, `/layers/write-file`,
 * `/layers/delete-file`, `/layers/reload`, `/layers/export`, `/layers/import`, GET `/layers/export-file?file=` (the
 * download of an archive in `tsf/data/exports`; an infrastructure route), POST `/widgets/define` and `/widgets/undefine`. Every write goes through
 * the Service, which holds the `layers` mutex and reloads.
 */
export function layerAuthoringRoutes(service: FactoryService): Hono {
  const app = new Hono();

  app.get("/layers/files", async (c) => c.json(await service.listLayerFiles({ name: query(c.req.query("name"), "name") })));
  app.get("/layers/read-file", async (c) =>
    c.json(await service.readLayerFile({ name: query(c.req.query("name"), "name"), path: query(c.req.query("path"), "path") })),
  );

  app.post("/layers/create", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    if (body.enabledByDefault !== undefined && typeof body.enabledByDefault !== "boolean") {
      throw new ServiceError("invalid", "enabledByDefault must be true or false");
    }
    return c.json(
      await service.createLayer(
        {
          name: reqString(body, "name"),
          title: reqString(body, "title"),
          description: reqString(body, "description"),
          ...(typeof body.enabledByDefault === "boolean" ? { enabledByDefault: body.enabledByDefault } : {}),
        },
        { by: "ui" },
      ),
    );
  });
  app.post("/layers/delete", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.deleteLayer({ name: reqString(body, "name") }, { by: "ui" }));
  });
  app.post("/layers/write-file", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(
      await service.writeLayerFile({ name: reqString(body, "name"), path: reqString(body, "path"), content: reqString(body, "content") }, { by: "ui" }),
    );
  });
  app.post("/layers/delete-file", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.deleteLayerFile({ name: reqString(body, "name"), path: reqString(body, "path") }, { by: "ui" }));
  });
  app.post("/layers/reload", async (c) => {
    record(await jsonBody(c.req.raw));
    return c.json(await service.reloadLayers({ by: "ui" }));
  });

  app.post("/layers/export", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const to = optString(body, "to");
    return c.json(await service.exportLayer({ name: reqString(body, "name"), ...(to !== undefined ? { to } : {}) }, { by: "ui" }));
  });
  app.post("/layers/import", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const name = optString(body, "name");
    if (body.replace !== undefined && typeof body.replace !== "boolean") throw new ServiceError("invalid", "replace must be true or false");
    return c.json(
      await service.importLayer(
        { source: reqString(body, "source"), ...(name !== undefined && name !== "" ? { name } : {}), ...(body.replace === true ? { replace: true } : {}) },
        { by: "ui" },
      ),
    );
  });
  app.get("/layers/export-file", async (c) => {
    const { file, bytes } = await service.readExportFile({ file: query(c.req.query("file"), "file") });
    return new Response(bytes as BodyInit, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${file}"`,
        "content-length": String(bytes.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.post("/widgets/define", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    const widget = optObject(body, "widget");
    if (widget === undefined) throw new ServiceError("invalid", "widget must be an object");
    return c.json(await service.defineWidget({ layer: reqString(body, "layer"), widget: widget as unknown as WidgetContribution }, { by: "ui" }));
  });
  app.post("/widgets/undefine", async (c) => {
    const body = record(await jsonBody(c.req.raw));
    return c.json(await service.removeWidgetType({ layer: reqString(body, "layer"), id: reqString(body, "id") }, { by: "ui" }));
  });

  return app;
}

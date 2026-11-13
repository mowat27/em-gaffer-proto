/**
 * The Hono app (DESIGN 5): /api routes, the SSE stream, the error mapping, and the web app (static, dev proxy, or a
 * one-line 503 page). Later lots only add `api.route(...)` lines below.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { toHttp } from "../core/errors.ts";
import type { Logger } from "../core/log.ts";
import type { FactoryService } from "../core/service-api.ts";
import { chatRoutes } from "./routes/chat.ts";
import { core4Routes } from "./routes/core4.ts";
import { cronRoutes } from "./routes/cron.ts";
import { factoryRoutes } from "./routes/factory.ts";
import { jevRoutes } from "./routes/jev.ts";
import { layerHandlerRoutes } from "./routes/layer-handlers.ts";
import { layerRoutes } from "./routes/layers.ts";
import { layerAuthoringRoutes } from "./routes/layers-authoring.ts";
import { modelRoutes, modelSelectionRoutes } from "./routes/models.ts";
import { pageRoutes } from "./routes/pages.ts";
import { runRoutes } from "./routes/runs.ts";
import { statusRoutes } from "./routes/status.ts";
import { themeRoutes } from "./routes/themes.ts";
import { hotkeyRoutes, uiConfigRoutes, widgetRoutes } from "./routes/ui-config.ts";
import { uiRoutes } from "./routes/ui.ts";
import { allowedHostsFromEnv, apiGuard } from "./guard.ts";
import type { SseHub } from "./sse.ts";
import { devProxy, staticHandler } from "./static.ts";

export type WebMode =
  | {
      kind: "static";
      /** A directory, or a function that answers the current one (a rebuild swaps it); undefined: not built yet. */
      root: string | (() => string | undefined);
      /** The served build's hash, injected into index.html as `<meta name="tsf-web-hash">`. */
      hash?: () => string | null;
      /** Why there is no build yet (the 503 page). */
      reason?: () => string;
    }
  | { kind: "proxy"; url: string }
  | { kind: "none"; reason: string };

const MAX_BODY = 1024 * 1024;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseLastEventId(raw: string | undefined | null): number | undefined {
  if (raw === undefined || raw === null || !/^\d{1,16}$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/** `hosts`: host names allowed besides the local ones and `TSF_ALLOWED_HOSTS` (the listen host; see `guard.ts`). */
export function createApp(deps: { service: FactoryService; hub: SseHub; log: Logger; web: WebMode; hosts?: readonly string[] }): Hono {
  const { service, hub, log, web } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    const { status, body } = toHttp(err);
    if (status >= 500) log.error("http.error", { method: c.req.method, path: c.req.path, error: err });
    return c.json(body, status as 400 | 403 | 404 | 409 | 413 | 500 | 503);
  });

  // Before the body is read: Host, Origin and Content-Type (no CSRF or DNS rebinding without in-app auth).
  app.use("/api/*", apiGuard([...(deps.hosts ?? []), ...allowedHostsFromEnv()]));

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY,
      onError: (c) =>
        c.json({ error: { code: "too_large", message: `the request body is larger than ${MAX_BODY} bytes` } }, 413),
    }),
  );

  app.get("/api/events", (c) => {
    const lastEventId = parseLastEventId(c.req.header("last-event-id") ?? c.req.query("lastEventId"));
    return hub.connect(c.req.raw.signal, lastEventId);
  });

  const api = new Hono();
  api.route("/", statusRoutes(service));
  api.route("/chat", chatRoutes(service));
  api.route("/models", modelRoutes(service));
  api.route("/", modelSelectionRoutes(service));
  api.route("/", core4Routes(service));
  api.route("/", layerRoutes(service));
  api.route("/", layerAuthoringRoutes(service));
  api.route("/", runRoutes(service));
  api.route("/pages", pageRoutes(service));
  api.route("/ui-config", uiConfigRoutes(service));
  api.route("/widgets", widgetRoutes(service));
  api.route("/hotkeys", hotkeyRoutes(service));
  api.route("/themes", themeRoutes(service));
  api.route("/cron", cronRoutes(service));
  api.route("/jev", jevRoutes(service));
  api.route("/ui", uiRoutes(service));
  api.route("/layers", layerHandlerRoutes(service));
  api.route("/", factoryRoutes(service));
  app.route("/api", api);

  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: `no such route: ${c.req.method} ${c.req.path}` } }, 404));

  const themeCss = (): string => service.getThemeCss();
  if (web.kind === "static") {
    const rootNow = (): string | undefined => (typeof web.root === "function" ? web.root() : web.root);
    const serve = staticHandler(() => rootNow() ?? "", themeCss, web.hash);
    app.get("*", (c) =>
      rootNow() === undefined
        ? c.html(`<!doctype html><meta charset="utf-8"><title>TSF</title><p>The web app is not available: ${escapeHtml(web.reason?.() ?? "it is not built")}</p>`, 503)
        : serve(c),
    );
  } else if (web.kind === "proxy") {
    const proxy = devProxy(web.url, themeCss);
    app.get("*", (c) => proxy(c));
  } else {
    app.get("*", (c) =>
      c.html(`<!doctype html><meta charset="utf-8"><title>TSF</title><p>The web app is not available: ${escapeHtml(web.reason)}</p>`, 503),
    );
  }

  return app;
}

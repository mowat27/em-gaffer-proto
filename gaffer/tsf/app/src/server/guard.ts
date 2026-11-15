/**
 * The request guard for `/api/*` (DESIGN 5, "Request guard"): there is no in-app auth, so a web page the user visits
 * must not be able to drive the factory. Three checks, in order:
 *
 * 1. Host: the request's host name is `localhost`, a `*.localhost` name, an IP literal, the listen host, or a name in
 *    `TSF_ALLOWED_HOSTS` (comma-separated). This stops DNS rebinding, where an attacker's name resolves to 127.0.0.1
 *    and the browser treats the factory as the attacker's own origin.
 * 2. Origin: when the browser sends one, it is the request's own host (or an allowed extra name). `null` is refused.
 * 3. Content-Type: every method other than GET, HEAD and OPTIONS needs `application/json`, so a cross-site form post
 *    or `no-cors` fetch (a "simple" request with no preflight) cannot reach a command; a JSON request from another
 *    origin needs a preflight, which the API never answers with CORS headers. The one exception is POST
 *    `/api/uploads`, which also takes `application/octet-stream` (a file's bytes): that type is not one a simple
 *    request may carry, so it needs the same preflight.
 */
import { isIP } from "node:net";
import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/** The extra host names from `TSF_ALLOWED_HOSTS` (comma-separated; ports and schemes are not part of a name). */
export function allowedHostsFromEnv(raw: string | undefined = process.env.TSF_ALLOWED_HOSTS): string[] {
  return (raw ?? "")
    .split(",")
    .map(normalise)
    .filter((h) => h !== "");
}

function bare(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLocalName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || isIP(bare(hostname)) !== 0;
}

function refuse(status: 403 | 415, code: "forbidden" | "invalid", message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

/** `extraHosts`: names allowed besides the local ones (the listen host, `TSF_ALLOWED_HOSTS`). */
export function apiGuard(extraHosts: readonly string[]): MiddlewareHandler {
  const extra = new Set(extraHosts.map(normalise).filter((h) => h !== "" && h !== "0.0.0.0" && h !== "::"));
  return async (c, next) => {
    // The Host header when there is one (an absolute request line could otherwise name a different host).
    let url: URL;
    try {
      url = new URL(`http://${c.req.header("host") ?? new URL(c.req.url).host}`);
    } catch {
      return refuse(403, "forbidden", "the request has no valid host");
    }
    const hostname = normalise(url.hostname);
    if (!isLocalName(hostname) && !extra.has(hostname)) {
      return refuse(403, "forbidden", `host ${hostname} is not allowed; add it to TSF_ALLOWED_HOSTS to serve the factory under that name`);
    }

    const origin = c.req.header("origin");
    if (origin !== undefined) {
      let ok = false;
      try {
        const o = new URL(origin);
        ok = o.host.toLowerCase() === url.host.toLowerCase() || extra.has(normalise(o.hostname));
      } catch {
        ok = false; // `null` (sandboxed frames, file:) and anything unparsable.
      }
      if (!ok) return refuse(403, "forbidden", `cross-origin requests are not allowed (origin ${origin})`);
    }

    if (!SAFE_METHODS.has(c.req.method)) {
      const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const raw = type === "application/octet-stream" && c.req.method === "POST" && c.req.path === "/api/uploads";
      if (type !== "application/json" && !raw) return refuse(415, "invalid", "commands need content-type: application/json");
    }
    await next();
  };
}

import { request as httpRequest } from "node:http";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowedHostsFromEnv, apiGuard } from "../../src/server/guard.ts";
import { createTestServer, type TestServer } from "../helpers/factory.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

let server: TestServer;
let port: number;

beforeAll(async () => {
  server = await createTestServer();
  port = Number(new URL(server.url).port);
});

afterAll(async () => {
  await server.close();
  await cleanupTmp();
});

/** A raw HTTP request, so the Host header is exactly what a browser (or a rebinding attacker) would send. */
function raw(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const self = (): string => `127.0.0.1:${port}`;
const send = (requestId: string): string => JSON.stringify({ text: "ping", requestId });

describe("cross-site requests (CSRF)", () => {
  it("refuses a command with a non-JSON content type (a simple request needs no preflight)", async () => {
    const res = await raw("POST", "/api/chat/send", { host: self(), "content-type": "text/plain" }, send("csrf-1"));
    expect(res.status).toBe(415);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "invalid" } });
    const page = await raw("POST", "/api/pages/create", { host: self(), "content-type": "text/plain" }, JSON.stringify({ path: "Evil" }));
    expect(page.status).toBe(415);
    expect((await raw("GET", "/api/pages", { host: self() })).body).not.toContain("Evil");
  });

  it("refuses a bodiless command without a content type", async () => {
    expect((await raw("POST", "/api/chat/stop", { host: self() })).status).toBe(415);
    expect((await raw("POST", "/api/pages/unselect", { host: self(), "content-type": "application/x-www-form-urlencoded" }, "a=1")).status).toBe(415);
  });

  it("refuses another origin, and the null origin, even with a JSON body", async () => {
    for (const origin of ["http://evil.example", "null", `http://localhost:${port + 1}`]) {
      const res = await raw("POST", "/api/chat/send", { host: self(), origin, "content-type": "application/json" }, send(`csrf-${origin}`));
      expect(res.status, origin).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: "forbidden" } });
    }
    const page = await raw(
      "POST",
      "/api/pages/create",
      { host: self(), origin: "http://evil.example", "content-type": "application/json" },
      JSON.stringify({ path: "Evil2" }),
    );
    expect(page.status).toBe(403);
  });

  it("accepts a same-origin JSON command", async () => {
    const res = await raw(
      "POST",
      "/api/chat/send",
      { host: self(), origin: `http://${self()}`, "content-type": "application/json; charset=utf-8" },
      send("same-origin"),
    );
    expect(res.status).toBe(202);
  });
});

describe("DNS rebinding (Host)", () => {
  it("refuses a host name that is not local or allowed, on reads and on the event stream", async () => {
    for (const path of ["/api/status", "/api/chat", "/api/events"]) {
      const res = await raw("GET", path, { host: `evil.example:${port}` });
      expect(res.status, path).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: "forbidden", message: expect.stringContaining("TSF_ALLOWED_HOSTS") } });
    }
  });

  it("accepts localhost, *.localhost and IP literals", async () => {
    for (const host of [`localhost:${port}`, `tsf.localhost:${port}`, self(), `[::1]:${port}`]) {
      expect((await raw("GET", "/api/status", { host })).status, host).toBe(200);
    }
  });

  it("does not guard the web app's own GETs", async () => {
    expect((await raw("GET", "/", { host: `evil.example:${port}` })).status).toBe(503);
  });
});

describe("apiGuard with extra host names", () => {
  const app = new Hono();
  app.use("/api/*", apiGuard(["factory.example", "0.0.0.0"]));
  app.get("/api/x", (c) => c.text("ok"));
  app.post("/api/x", (c) => c.text("ok"));
  const call = (init: RequestInit & { headers: Record<string, string> }): Promise<Response> =>
    Promise.resolve(app.request("http://localhost/api/x", init));

  it("accepts an allowed name as host and as origin (a TLS proxy in front)", async () => {
    expect((await call({ headers: { host: "factory.example" } })).status).toBe(200);
    expect((await call({ headers: { host: "FACTORY.example." } })).status).toBe(200);
    const viaProxy = await call({
      method: "POST",
      headers: { host: "127.0.0.1:8000", origin: "https://factory.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(viaProxy.status).toBe(200);
  });

  it("never treats a wildcard bind address as a name", async () => {
    expect((await call({ headers: { host: "other.example" } })).status).toBe(403);
  });

  it("parses TSF_ALLOWED_HOSTS", () => {
    expect(allowedHostsFromEnv(undefined)).toEqual([]);
    expect(allowedHostsFromEnv(" A.example , ,b.example. ")).toEqual(["a.example", "b.example"]);
  });
});

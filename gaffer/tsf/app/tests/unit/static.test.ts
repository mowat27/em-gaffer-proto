import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/core/log.ts";
import { devProxy, ensureWebBuilt, injectTheme, staticHandler, webHash } from "../../src/server/static.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

afterEach(cleanupTmp);

const CSS = ":root { --pw-ai-glow: 1; } /* $& $1 */";

async function webDir(): Promise<string> {
  const root = await tmpDir("tsf-web");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><html><head><title>t</title></head><body><div id=root></div></body></html>");
  await writeFile(join(root, "assets", "app-abc123.js"), "console.log(1)");
  await writeFile(join(root, "assets", "app-abc123.css"), "body{}");
  await writeFile(join(root, "robots.txt"), "x");
  return root;
}

function appFor(root: string): Hono {
  const handler = staticHandler(root, () => CSS);
  const app = new Hono();
  app.get("*", (c) => handler(c));
  return app;
}

describe("injectTheme", () => {
  it("puts the style element immediately before </head>, copying css literally", () => {
    const out = injectTheme("<html><head><title>t</title></head><body></body></html>", CSS);
    expect(out).toBe(`<html><head><title>t</title><style id="tsf-theme">${CSS}</style></head><body></body></html>`);
  });
  it("prefixes the style when there is no head, and escapes a closing style tag", () => {
    expect(injectTheme("<p>x</p>", "a")).toBe('<style id="tsf-theme">a</style><p>x</p>');
    expect(injectTheme("<head></head>", "a</style><script>")).not.toContain("a</style><script>");
  });
});

describe("staticHandler", () => {
  it("serves index.html no-cache with the theme before </head>, for / and for SPA routes", async () => {
    const app = appFor(await webDir());
    for (const path of ["/", "/index.html", "/some/deep/route", "/pages/Start%20Here"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
      expect(res.headers.get("content-type"), path).toContain("text/html");
      const html = await res.text();
      expect(html, path).toContain(`<style id="tsf-theme">${CSS}</style></head>`);
      expect(html.indexOf('id="tsf-theme"'), path).toBeLessThan(html.indexOf("</head>"));
    }
  });

  it("serves /assets/* immutable with the right type, and other files no-cache", async () => {
    const app = appFor(await webDir());
    const js = await app.request("/assets/app-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toBe("console.log(1)");
    const css = await app.request("/assets/app-abc123.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    const txt = await app.request("/robots.txt");
    expect(txt.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers 404 for a missing file-like path instead of the SPA page", async () => {
    const app = appFor(await webDir());
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect((await app.request("/favicon.ico")).status).toBe(404);
  });

  it("refuses a path that leaves the web dir", async () => {
    const root = await webDir();
    await writeFile(join(root, "..", "secret.txt"), "secret");
    const app = appFor(root);
    for (const path of ["/%2e%2e/secret.txt", "/..%2fsecret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("secret");
    }
  });

  it("is 404 when the dir has no index.html", async () => {
    const app = appFor(await tmpDir("tsf-empty-web"));
    expect((await app.request("/")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------

async function fakeApp(): Promise<{ appDir: string; fallbackDir: string }> {
  const appDir = await tmpDir("tsf-app");
  await mkdir(join(appDir, "src", "web"), { recursive: true });
  await mkdir(join(appDir, "src", "shared"), { recursive: true });
  await writeFile(join(appDir, "src", "web", "index.html"), "<html><head></head></html>");
  await writeFile(join(appDir, "src", "web", "main.tsx"), "export {}");
  await writeFile(join(appDir, "src", "shared", "types.ts"), "export type A = 1;");
  await writeFile(join(appDir, "vite.config.ts"), "export default {}");
  await writeFile(join(appDir, "package-lock.json"), "{}");
  return { appDir, fallbackDir: join(await tmpDir("tsf-fallback"), "web") };
}

/** A stand-in for `vite build`: writes index.html into the out dir after a pause and counts its runs. */
function stubBuild(delayMs = 80): { build: (out: string) => Promise<void>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    build: async (out) => {
      calls.push(out);
      await new Promise((r) => setTimeout(r, delayMs));
      await mkdir(join(out, "assets"), { recursive: true });
      await writeFile(join(out, "index.html"), "<html><head></head></html>");
    },
  };
}

describe("webHash", () => {
  it("is 12 hex chars, stable, and changes with a source file under src/web, src/shared, vite.config.ts or the lockfile", async () => {
    const { appDir } = await fakeApp();
    const h0 = await webHash(appDir);
    expect(h0).toMatch(/^[0-9a-f]{12}$/);
    expect(await webHash(appDir)).toBe(h0);
    const seen = new Set([h0]);
    for (const [file, content] of [
      ["src/web/main.tsx", "export const a = 1"],
      ["src/shared/types.ts", "export type A = 2;"],
      ["vite.config.ts", "export default { a: 1 }"],
      ["package-lock.json", '{"a":1}'],
      ["src/web/new.css", "body{}"],
    ] as const) {
      await writeFile(join(appDir, file), content);
      const h = await webHash(appDir);
      expect(seen.has(h), file).toBe(false);
      seen.add(h);
    }
  });

  it("ignores files outside the listed sources", async () => {
    const { appDir } = await fakeApp();
    const h0 = await webHash(appDir);
    await mkdir(join(appDir, "src", "core"), { recursive: true });
    await writeFile(join(appDir, "src", "core", "x.ts"), "export {}");
    expect(await webHash(appDir)).toBe(h0);
  });
});

describe("ensureWebBuilt", () => {
  it("returns skipped when there is no src/web/index.html", async () => {
    const appDir = await tmpDir("tsf-app-noweb");
    const stub = stubBuild();
    const r = await ensureWebBuilt({ appDir, fallbackDir: join(appDir, "fb"), log: silentLogger, build: stub.build });
    expect(r).toEqual({ skipped: "no-web-source" });
    expect(stub.calls).toHaveLength(0);
  });

  it("builds into dist/web-<hash>, stamps .tsf-build, and reuses a fresh dir", async () => {
    const { appDir, fallbackDir } = await fakeApp();
    const stub = stubBuild(10);
    const hash = await webHash(appDir);
    const first = await ensureWebBuilt({ appDir, fallbackDir, log: silentLogger, build: stub.build });
    expect(first).toEqual({ root: join(appDir, "dist", `web-${hash}`), hash });
    expect((await readFile(join(appDir, "dist", `web-${hash}`, ".tsf-build"), "utf8")).trim()).toBe(hash);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toContain(".tmp-");
    expect(await ensureWebBuilt({ appDir, fallbackDir, log: silentLogger, build: stub.build })).toEqual(first);
    expect(stub.calls).toHaveLength(1);
    // The lock and the tmp dir are gone.
    expect((await readdir(join(appDir, "dist"))).sort()).toEqual([`web-${hash}`]);
  });

  it("builds again after a source change", async () => {
    const { appDir, fallbackDir } = await fakeApp();
    const stub = stubBuild(10);
    const a = await ensureWebBuilt({ appDir, fallbackDir, log: silentLogger, build: stub.build });
    await writeFile(join(appDir, "src", "web", "main.tsx"), "export const changed = true");
    const b = await ensureWebBuilt({ appDir, fallbackDir, log: silentLogger, build: stub.build });
    expect(stub.calls).toHaveLength(2);
    expect(a).not.toEqual(b);
  });

  it("runs one build for two concurrent calls", async () => {
    const { appDir, fallbackDir } = await fakeApp();
    const stub = stubBuild(150);
    const opts = { appDir, fallbackDir, log: silentLogger, build: stub.build };
    const [a, b] = await Promise.all([ensureWebBuilt(opts), ensureWebBuilt(opts)]);
    expect(stub.calls).toHaveLength(1);
    expect(a).toEqual(b);
    expect("root" in a).toBe(true);
  });

  it("takes over the lock of a dead process", async () => {
    const { appDir, fallbackDir } = await fakeApp();
    await mkdir(join(appDir, "dist"), { recursive: true });
    await writeFile(join(appDir, "dist", ".build.lock"), "999999999\n");
    const stub = stubBuild(10);
    const r = await ensureWebBuilt({ appDir, fallbackDir, log: silentLogger, build: stub.build });
    expect("root" in r).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });

  it("reports a failed build as an error and releases the lock", async () => {
    const { appDir, fallbackDir } = await fakeApp();
    const r = await ensureWebBuilt({
      appDir,
      fallbackDir,
      log: silentLogger,
      build: async () => {
        throw new Error("vite exploded");
      },
    });
    expect(r).toEqual({ error: "vite exploded" });
    await expect(stat(join(appDir, "dist", ".build.lock"))).rejects.toThrow();
    // A later call can build.
    const stub = stubBuild(10);
    expect("root" in (await ensureWebBuilt({ appDir, fallbackDir, log: silentLogger, build: stub.build }))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("builds under the fallback dir when dist is not writable", async () => {
    const { appDir, fallbackDir } = await fakeApp();
    await mkdir(join(appDir, "dist"), { recursive: true });
    await chmod(join(appDir, "dist"), 0o500);
    try {
      const stub = stubBuild(10);
      const hash = await webHash(appDir);
      const r = await ensureWebBuilt({ appDir, fallbackDir, log: silentLogger, build: stub.build });
      expect(r).toEqual({ root: join(fallbackDir, `web-${hash}`), hash });
    } finally {
      await chmod(join(appDir, "dist"), 0o700);
    }
  });
});

describe("devProxy", () => {
  let upstream: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    upstream = undefined;
  });

  async function startUpstream(): Promise<string> {
    upstream = createServer((req, res) => {
      if (req.url?.startsWith("/@vite/client")) {
        res.setHeader("content-type", "text/javascript");
        res.end("export {}");
      } else {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<html><head></head><body>${req.url}</body></html>`);
      }
    });
    await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  }

  it("inlines the theme into HTML and passes other responses through", async () => {
    const url = await startUpstream();
    const proxy = devProxy(url, () => CSS);
    const app = new Hono();
    app.get("*", (c) => proxy(c));
    const html = await app.request("/page?x=1");
    expect(html.status).toBe(200);
    const body = await html.text();
    expect(body).toContain(`<style id="tsf-theme">${CSS}</style></head>`);
    expect(body).toContain("/page?x=1");
    const js = await app.request("/@vite/client");
    expect(js.headers.get("content-type")).toBe("text/javascript");
    expect(await js.text()).toBe("export {}");
  });

  it("answers 502 when Vite is not running", async () => {
    const proxy = devProxy("http://127.0.0.1:1", () => CSS);
    const app = new Hono();
    app.get("*", (c) => proxy(c));
    expect((await app.request("/")).status).toBe(502);
  });
});

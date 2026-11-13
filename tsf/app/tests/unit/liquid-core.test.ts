/**
 * The liquid core (P9): a project's own app copy (paths), the live web rebuild with its fallback (WebHost), the restart
 * capability (no loop on a replayed call), screenshots (playwright mocked) and the web client's handling of the events.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineAppTool } from "../../src/agent/tools.ts";
import { protectedPaths, RootedEnv } from "../../src/agent/rooted-env.ts";
import { isProjectApp, ownAppDir, projectAppDir, projectPaths, readAppBase, resolveAppDir } from "../../src/core/paths.ts";
import { silentLogger } from "../../src/core/log.ts";
import { pngSize, readScreenshotFile, screenshotPath, takeScreenshot, type PlaywrightLike } from "../../src/core/screenshot.ts";
import type { AppEvent } from "../../src/shared/events.ts";
import { staticHandler, trimBuildText } from "../../src/server/static.ts";
import { WebHost } from "../../src/server/web-host.ts";
import { Hono } from "hono";
import { needsReload } from "../../src/web/App.tsx";
import { initialState, reduce, withConnection } from "../../src/web/state/reducer.ts";
import { API_VERSION, DEFAULT_UI_CONFIG, type Snapshot } from "../../src/shared/types.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTmp();
});

// ---------------------------------------------------------------------------------------------------------------
describe("appDir resolution", () => {
  it("is always the app this process runs from; a project copy is only reported", async () => {
    const root = await tmpDir("liquid-paths");
    await mkdir(join(root, "tsf"), { recursive: true });
    expect(resolveAppDir(root)).toBe(ownAppDir);
    expect(projectPaths(root).appDir).toBe(ownAppDir);
    expect(projectAppDir(root)).toBeUndefined();
    await mkdir(join(root, "tsf", "app"), { recursive: true });
    // A folder without package.json is not an app.
    expect(projectAppDir(root)).toBeUndefined();
    await writeFile(join(root, "tsf", "app", "package.json"), "{}");
    expect(projectAppDir(root)).toBe(join(root, "tsf", "app"));
    const p = projectPaths(root);
    expect(p.appDir).toBe(ownAppDir);
    expect(p.builtinLayersDir).toBe(join(ownAppDir, "src", "layers"));
    expect(p.webSrc).toBe(join(ownAppDir, "src", "web"));
    expect(p.distDir).toBe(join(ownAppDir, "dist"));
  });

  it("knows a project copy by its place, and reads .tsf-base", async () => {
    const root = await tmpDir("liquid-base");
    await mkdir(join(root, "tsf", "app"), { recursive: true });
    expect(isProjectApp(join(root, "tsf", "app"))).toBe(false); // no tsf/mod.just yet
    await writeFile(join(root, "tsf", "mod.just"), "# mod\n");
    expect(isProjectApp(join(root, "tsf", "app"))).toBe(true);
    expect(isProjectApp(ownAppDir)).toBe(false);
    expect(readAppBase(join(root, "tsf", "app"))).toBeUndefined();
    await writeFile(join(root, "tsf", "app", ".tsf-base"), JSON.stringify({ appVersion: "0.9.0", skillDir: "/s" }));
    expect(readAppBase(join(root, "tsf", "app"))).toMatchObject({ appVersion: "0.9.0", skillDir: "/s" });
  });
});

describe("file tools and tsf/app", () => {
  it("deny node_modules and .tsf-base, allow the rest of the source", async () => {
    const root = await tmpDir("liquid-rooted");
    for (const d of ["tsf/app/node_modules/x", "tsf/app/src/web", "tsf/app/bin", "tsf/data", "tsf/layers"]) await mkdir(join(root, d), { recursive: true });
    await writeFile(join(root, "tsf", "app", ".tsf-base"), "{}");
    await writeFile(join(root, "tsf", "app", "package.json"), "{}");
    const env = new RootedEnv(root, { protectedPaths: protectedPaths(root, "/elsewhere/skill") });
    const ctx = BACKGROUND_CONTEXT;
    for (const p of ["tsf/app/node_modules/x/index.js", "tsf/app/node_modules", "tsf/app/.tsf-base"]) {
      const r = await env.absolutePath(p, ctx);
      expect(r.ok, p).toBe(false);
    }
    for (const p of ["tsf/app/src/web/App.tsx", "tsf/app/package.json", "tsf/app/bin/tsf.mjs", "tsf/app/src/server/main.ts"]) {
      expect((await env.absolutePath(p, ctx)).ok, p).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
async function fakeApp(): Promise<{ appDir: string; fallbackDir: string }> {
  const appDir = await tmpDir("liquid-app");
  await mkdir(join(appDir, "src", "web"), { recursive: true });
  await mkdir(join(appDir, "src", "shared"), { recursive: true });
  await writeFile(join(appDir, "src", "web", "index.html"), "<html><head></head><body>x</body></html>");
  await writeFile(join(appDir, "src", "web", "main.tsx"), "export const v = 1");
  return { appDir, fallbackDir: join(await tmpDir("liquid-fb"), "web") };
}

/** A build that fails while `src/web/main.tsx` contains BROKEN, like vite on a syntax error. */
function fakeVite(appDir: string): (out: string) => Promise<void> {
  return async (out) => {
    const src = await readFile(join(appDir, "src", "web", "main.tsx"), "utf8");
    if (src.includes("BROKEN")) throw new Error("vite build exited with 1: [PARSE_ERROR] Unexpected token in main.tsx");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "index.html"), `<html><head></head><body>${src}</body></html>`);
  };
}

describe("WebHost: live rebuild with fallback", () => {
  it("swaps to the new build on success, keeps the old one on failure, and says so", async () => {
    const { appDir, fallbackDir } = await fakeApp();
    const events: AppEvent[] = [];
    const host = new WebHost({ appDir, fallbackDir, log: silentLogger, publish: (e) => events.push(e), build: fakeVite(appDir) });
    expect(host.status()).toEqual({ hash: null, building: false, lastError: null });
    expect(host.root()).toBeUndefined();
    const first = await host.init();
    expect("root" in first).toBe(true);
    const h1 = host.status().hash!;
    const root1 = host.root()!;
    expect(h1).toMatch(/^[0-9a-f]{12}$/);

    // Good edit: new hash, new root, one web.rebuilt.
    await writeFile(join(appDir, "src", "web", "main.tsx"), "export const v = 2");
    const ok = await host.rebuild();
    expect(ok).toMatchObject({ ok: true });
    expect(ok.hash).not.toBe(h1);
    expect(host.root()).not.toBe(root1);
    expect(events).toEqual([{ type: "web.rebuilt", hash: ok.hash }]);
    const h2 = ok.hash!;
    const root2 = host.root()!;

    // Broken edit: the previous good build keeps serving, the error is reported and published.
    await writeFile(join(appDir, "src", "web", "main.tsx"), "export const v = BROKEN");
    const bad = await host.rebuild();
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("PARSE_ERROR");
    expect(bad.hash).toBe(h2);
    expect(host.root()).toBe(root2);
    expect(host.status()).toEqual({ hash: h2, building: false, lastError: expect.stringContaining("PARSE_ERROR") });
    expect(events.at(-1)).toMatchObject({ type: "web.build_failed", error: expect.stringContaining("PARSE_ERROR") });
    expect(await readFile(join(root2, "index.html"), "utf8")).toContain("v = 2");

    // The served handler still answers from the old build, with its hash in the index.
    const app = new Hono();
    const serve = staticHandler(() => host.root()!, () => "", host.servedHash);
    app.get("*", (c) => serve(c));
    const page = await (await app.request("/")).text();
    expect(page).toContain("v = 2");
    expect(page).toContain(`<meta name="tsf-web-hash" content="${h2}">`);

    // Fixing it back to the served content recovers: lastError clears and web.rebuilt is published (same hash).
    await writeFile(join(appDir, "src", "web", "main.tsx"), "export const v = 2");
    const fixed = await host.rebuild();
    expect(fixed).toMatchObject({ ok: true, hash: h2 });
    expect(host.status().lastError).toBeNull();
    expect(events.at(-1)).toEqual({ type: "web.rebuilt", hash: h2 });
    host.close();
  });

  it("serves nothing when the first build fails, and recovers on a later good build", async () => {
    const { appDir, fallbackDir } = await fakeApp();
    await writeFile(join(appDir, "src", "web", "main.tsx"), "BROKEN");
    const host = new WebHost({ appDir, fallbackDir, log: silentLogger, publish: () => undefined, build: fakeVite(appDir) });
    expect("error" in (await host.init())).toBe(true);
    expect(host.serving()).toBe(false);
    expect(host.status().lastError).toContain("PARSE_ERROR");
    await writeFile(join(appDir, "src", "web", "main.tsx"), "export {}");
    expect((await host.rebuild()).ok).toBe(true);
    expect(host.serving()).toBe(true);
  });

  it("rebuilds by itself, debounced, when a file under src/web changes", async () => {
    const { appDir, fallbackDir } = await fakeApp();
    const events: AppEvent[] = [];
    const build = vi.fn(fakeVite(appDir));
    const host = new WebHost({ appDir, fallbackDir, log: silentLogger, publish: (e) => events.push(e), build, debounceMs: 60 });
    await host.init();
    expect(build).toHaveBeenCalledTimes(1);
    host.watch();
    // fs.watch on macOS needs a moment before it reports.
    await new Promise((r) => setTimeout(r, 300));
    // Three quick writes make one rebuild.
    for (const n of [3, 4, 5]) await writeFile(join(appDir, "src", "web", "main.tsx"), `export const v = ${n}`);
    await vi.waitFor(() => expect(events.some((e) => e.type === "web.rebuilt")).toBe(true), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(build.mock.calls.length).toBeLessThanOrEqual(3);
    expect(await readFile(join(host.root()!, "index.html"), "utf8")).toContain("v = 5");
    // src/shared is watched too.
    const before = host.status().hash;
    await writeFile(join(appDir, "src", "shared", "t.ts"), "export type T = 1;");
    await vi.waitFor(() => expect(host.status().hash).not.toBe(before), { timeout: 5000 });
    host.close();
  });

  it("serialises overlapping rebuilds and runs one follow-up", async () => {
    const { appDir, fallbackDir } = await fakeApp();
    let running = 0;
    let max = 0;
    const host = new WebHost({
      appDir,
      fallbackDir,
      log: silentLogger,
      publish: () => undefined,
      build: async (out) => {
        running++;
        max = Math.max(max, running);
        await new Promise((r) => setTimeout(r, 80));
        await mkdir(out, { recursive: true });
        await writeFile(join(out, "index.html"), "<html></html>");
        running--;
      },
    });
    await host.init();
    await writeFile(join(appDir, "src", "web", "main.tsx"), "export const v = 9");
    const results = await Promise.all([host.rebuild(), host.rebuild(), host.rebuild()]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(max).toBe(1);
  });
});

describe("trimBuildText", () => {
  it("drops colour codes and stack frames and keeps the head", () => {
    const raw = "\u001b[31merror during build:\u001b[39m\n[PARSE_ERROR] bad token\n  at foo (file:///x.js:1:1)\n    at bar (file:///y.js:2:2)\n";
    expect(trimBuildText(raw)).toBe("error during build:\n[PARSE_ERROR] bad token");
    expect(trimBuildText("x".repeat(5000)).length).toBeLessThan(1600);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Service.restart and the rebuild_web / screenshot guards", () => {
  it("answers conflict when the process cannot restart itself, and for web calls without a served app", async () => {
    const f = await createTestFactory();
    try {
      await expect(f.service.restart({}, { by: "ui" })).rejects.toMatchObject({ code: "conflict" });
      await expect(f.service.rebuildWeb()).rejects.toMatchObject({ code: "conflict" });
      await expect(f.service.screenshot({})).rejects.toMatchObject({ code: "conflict" });
      expect(f.service.status().web).toEqual({ hash: null, building: false, lastError: null });
      for (const [path, body] of [
        ["/api/factory/restart", "{}"],
        ["/api/factory/rebuild-web", "{}"],
        ["/api/factory/screenshot", "{}"],
      ] as const) {
        const res = await f.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body });
        expect(res.status, path).toBe(409);
      }
    } finally {
      await f.close();
    }
  });

  it("replies at once, publishes factory.restarting, begins once, and never restarts twice for one call id", async () => {
    const { createService } = await import("../../src/core/service.ts");
    // A factory whose Service has a restart hook: build one on the same agent through createFactory's option.
    const { createFactory } = await import("../../src/server/main.ts");
    const { makeProject } = await import("../helpers/project.ts");
    const { root } = await makeProject();
    void createService;
    const begins: (string | undefined)[] = [];
    const mk = async () => {
      process.env.TSF_MODEL_PROVIDER = "faux";
      return createFactory({
        projectRoot: root,
        web: false,
        log: silentLogger,
        restart: { mode: "respawn", begin: (r) => begins.push(r) },
      });
    };
    let f = await mk();
    const events: AppEvent[] = [];
    const publish = f.hub.publish.bind(f.hub);
    vi.spyOn(f.hub, "publish").mockImplementation((d) => {
      if ("type" in d) events.push(d as AppEvent);
      return publish(d);
    });
    const r = await f.service.restart({ reason: "edited core" }, { by: "agent", callId: "call-1" });
    expect(r).toEqual({ restartingInMs: 1500, mode: "respawn" });
    expect(events.find((e) => e.type === "factory.restarting")).toMatchObject({ inMs: 1500, reason: "edited core", by: "agent" });
    expect(begins).toEqual([]);
    // A second request while one is pending does not schedule another.
    const again = await f.service.restart({}, { by: "ui" });
    expect(again.restartingInMs).toBe(1500);
    // The same agent call id again (a replay after a crash) does nothing.
    const replay = await f.service.restart({}, { by: "agent", callId: "call-1" });
    expect(replay).toEqual({ restartingInMs: 0, mode: "respawn", alreadyRestarted: true });
    await f.close(); // closing cancels the pending timer in this test
    expect(begins).toEqual([]);

    // The new process (same project database) still knows the call id: no restart loop.
    f = await mk();
    const afterRestart = await f.service.restart({}, { by: "agent", callId: "call-1" });
    expect(afterRestart.alreadyRestarted).toBe(true);
    await f.close();
  });

  it("begins the restart after the delay, once, with the reason", async () => {
    const { createFactory } = await import("../../src/server/main.ts");
    const { makeProject } = await import("../helpers/project.ts");
    const { root } = await makeProject();
    process.env.TSF_MODEL_PROVIDER = "faux";
    const begins: (string | undefined)[] = [];
    const f = await createFactory({ projectRoot: root, web: false, log: silentLogger, restartDelayMs: 40, restart: { mode: "systemd", begin: (r) => begins.push(r) } });
    try {
      expect(await f.service.restart({ reason: "why" }, { by: "ui" })).toEqual({ restartingInMs: 40, mode: "systemd" });
      await f.service.restart({}, { by: "ui" });
      await vi.waitFor(() => expect(begins).toEqual(["why"]), { timeout: 2000 });
      await new Promise((r) => setTimeout(r, 100));
      expect(begins).toEqual(["why"]);
    } finally {
      await f.close();
    }
  });

  it("restart rejects a reason that is not a short string", async () => {
    const f = await createTestFactory();
    try {
      await expect(f.service.restart({ reason: "x".repeat(201) }, { by: "ui" })).rejects.toMatchObject({ code: "invalid" });
    } finally {
      await f.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
  Buffer.from([0, 0, 0x02, 0x80, 0, 0, 0x01, 0xe0]), // 640 x 480
  Buffer.alloc(20),
]);

function fakePlaywright(log: string[], over: { launchError?: Error } = {}): PlaywrightLike {
  return {
    chromium: {
      launch: async () => {
        if (over.launchError) throw over.launchError;
        log.push("launch");
        return {
          newContext: async (o) => {
            log.push(`context ${JSON.stringify(o)}`);
            return {
              newPage: async () => ({
                goto: async (url: string) => void log.push(`goto ${url}`),
                emulateMedia: async (o2: Record<string, unknown>) => void log.push(`media ${JSON.stringify(o2)}`),
                evaluate: async () => undefined,
                waitForLoadState: async () => undefined,
                waitForSelector: async () => undefined,
                locator: (sel: string) => ({
                  first: () => ({ waitFor: async () => void log.push(`wait ${sel}`) }),
                  screenshot: async () => {
                    log.push(`element ${sel}`);
                    return PNG;
                  },
                }),
                screenshot: async (o3: Record<string, unknown>) => {
                  log.push(`page ${JSON.stringify(o3)}`);
                  return PNG;
                },
                viewportSize: () => ({ width: 1280, height: 800 }),
              }),
              close: async () => void log.push("context closed"),
            };
          },
          close: async () => void log.push("closed"),
        };
      },
    },
  };
}

describe("screenshot", () => {
  it("opens the factory's own URL, sets the mode, and writes a PNG into the screenshots folder", async () => {
    const dir = join(await tmpDir("liquid-shots"), "screenshots");
    const log: string[] = [];
    const r = await takeScreenshot(
      { page: "/?x=1", mode: "dark", width: 900, height: 700, fullPage: true },
      { baseUrl: "http://127.0.0.1:8123", dir, playwright: async () => fakePlaywright(log), now: () => new Date("2026-11-03T10:00:00.123Z") },
    );
    expect(r).toEqual({
      path: join(dir, "2026-11-03T10-00-00-123Z.png"),
      file: "2026-11-03T10-00-00-123Z.png",
      url: "/api/screenshots/2026-11-03T10-00-00-123Z.png",
      width: 640,
      height: 480,
    });
    expect(await readdir(dir)).toEqual(["2026-11-03T10-00-00-123Z.png"]);
    expect(log).toContain("goto http://127.0.0.1:8123/?x=1");
    expect(log.some((l) => l.startsWith("context") && l.includes('"colorScheme":"dark"') && l.includes('"width":900'))).toBe(true);
    expect(log).toContain('page {"type":"png","fullPage":true}');
    expect(log.at(-1)).toBe("closed");
    // A second shot in the same millisecond gets its own name.
    const r2 = await takeScreenshot({}, { baseUrl: "http://127.0.0.1:8123", dir, playwright: async () => fakePlaywright([]), now: () => new Date("2026-11-03T10:00:00.123Z") });
    expect(r2.file).toBe("2026-11-03T10-00-00-123Z-2.png");
    expect(pngSize(PNG)).toEqual({ width: 640, height: 480 });
  });

  it("captures one element when a selector is given", async () => {
    const dir = await tmpDir("liquid-shots2");
    const log: string[] = [];
    await takeScreenshot({ selector: '[data-testid="connection"]' }, { baseUrl: "http://127.0.0.1:1", dir, playwright: async () => fakePlaywright(log) });
    expect(log).toContain('element [data-testid="connection"]');
  });

  it("names the install command when the browser is missing, and never tries to install", async () => {
    const dir = await tmpDir("liquid-shots3");
    const err = new Error("browserType.launch: Executable doesn't exist at /x/chromium\nRun playwright install");
    await expect(takeScreenshot({}, { baseUrl: "http://127.0.0.1:1", dir, playwright: async () => fakePlaywright([], { launchError: err }) })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("npx playwright install chromium"),
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it("says playwright is unavailable when it cannot be imported", async () => {
    const dir = await tmpDir("liquid-shots4");
    await expect(
      takeScreenshot({}, {
        baseUrl: "http://127.0.0.1:1",
        dir,
        playwright: async () => {
          throw new Error("Cannot find package 'playwright'");
        },
      }),
    ).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/playwright package cannot be imported/) });
  });

  it("rejects a page that could leave the factory's origin, and bad sizes", async () => {
    for (const bad of ["http://evil.test/", "//evil.test/", "x", "/a\\b"]) expect(() => screenshotPath(bad)).toThrow();
    expect(screenshotPath(undefined)).toBe("/");
    expect(screenshotPath("/pages?x=1")).toBe("/pages?x=1");
    const dir = await tmpDir("liquid-shots5");
    await expect(takeScreenshot({ width: 5 }, { baseUrl: "http://127.0.0.1:1", dir, playwright: async () => fakePlaywright([]) })).rejects.toMatchObject({ code: "invalid" });
  });

  it("serves only plain png names from the folder (GET /api/screenshots/:file)", async () => {
    const f = await createTestFactory();
    try {
      const dir = join(f.paths.dataDir, "screenshots");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "a.png"), PNG);
      await writeFile(join(f.paths.dataDir, "secret.png"), "secret");
      const ok = await f.app.request("/api/screenshots/a.png");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await ok.arrayBuffer())).toEqual(PNG);
      expect((await f.app.request("/api/screenshots/missing.png")).status).toBe(404);
      expect((await f.app.request("/api/screenshots/..%2Fsecret.png")).status).toBeGreaterThanOrEqual(400);
      expect((await f.app.request("/api/screenshots/a.txt")).status).toBe(400);
      await expect(readScreenshotFile(dir, "../secret.png")).rejects.toMatchObject({ code: "invalid" });
    } finally {
      await f.close();
    }
  });
});

describe("tool results with an image", () => {
  it("defineAppTool attaches images after the JSON text", async () => {
    const tool = defineAppTool({
      name: "shot",
      description: "d",
      parameters: { type: "object", properties: {}, additionalProperties: false } as never,
      replay: "safe",
      run: async () => ({ ok: true }),
      attach: async () => [{ data: "QUJD", mimeType: "image/png" }],
    });
    const result = await (tool as unknown as { execute(a: unknown, b: unknown, c: unknown): Promise<{ output: { type: string }[] }> }).execute({}, {}, {});
    expect(result.output.map((o) => o.type)).toEqual(["text", "image"]);
    expect(result.output[1]).toMatchObject({ data: "QUJD", mimeType: "image/png" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
const snap = (web: { hash: string | null; building: boolean; lastError: string | null } | undefined): Snapshot =>
  ({
    apiVersion: API_VERSION,
    bootId: 5,
    serverTime: 5,
    status: { name: "demo", ...(web ? { web } : {}) },
    chat: { items: [], hasEarlier: false, live: {} as never, meta: {} as never },
    pages: { root: [] } as never,
    selection: { path: null, by: "system", at: 1 },
    focus: null,
    settings: {} as never,
    uiConfig: DEFAULT_UI_CONFIG,
    layers: [],
    tools: [],
    ceiling: {} as never,
    runs: [],
    themes: [],
    themeCss: "",
    cron: [],
  }) as unknown as Snapshot;

describe("web client state", () => {
  it("holds the build error from web.build_failed and clears it on web.rebuilt", () => {
    let s = reduce(initialState, { type: "snapshot", id: 5001, snapshot: snap({ hash: "h1", building: false, lastError: "old error" }) });
    expect(s.webError).toBe("old error");
    s = reduce(s, { type: "delta", id: 5002, delta: { type: "web.rebuilt", hash: "h2" } });
    expect(s.webError).toBeNull();
    s = reduce(s, { type: "delta", id: 5003, delta: { type: "web.build_failed", error: "[PARSE_ERROR] x" } });
    expect(s.webError).toBe("[PARSE_ERROR] x");
    expect(s.connection).toBe("live");
  });

  it("shows restarting from factory.restarting until the next snapshot, through errors, retries and pings", () => {
    let s = reduce(initialState, { type: "snapshot", id: 5001, snapshot: snap(undefined) });
    expect(s.webError).toBeNull();
    s = reduce(s, { type: "delta", id: 5002, delta: { type: "factory.restarting", inMs: 1500, by: "agent" } });
    expect(s.connection).toBe("restarting");
    for (const c of ["offline", "connecting"] as const) s = withConnection(s, c);
    expect(s.connection).toBe("restarting");
    s = reduce(s, { type: "ping" } as never);
    expect(s.connection).toBe("restarting");
    s = reduce(s, { type: "snapshot", id: 6001, snapshot: { ...snap(undefined), bootId: 6 } });
    expect(s.connection).toBe("live");
  });

  it("reloads only when the served build differs from the loaded one", () => {
    expect(needsReload("a", "b")).toBe(true);
    expect(needsReload("a", "a")).toBe(false);
    expect(needsReload(null, "b")).toBe(false); // dev proxy: no hash in the page, Vite does HMR
    expect(needsReload("a", null)).toBe(false);
    expect(needsReload("a", undefined)).toBe(false);
  });
});

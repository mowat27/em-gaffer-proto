/**
 * The web app's delivery (DESIGN 3 "Web build"): a hash-named build dir shared by every project that uses this skill,
 * a build lock, a static handler with an SPA fallback and the theme inlined, and the `--dev` proxy to Vite.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { Context } from "hono";
import { isInside } from "../core/fsutil.ts";
import { isAlive, readLockPid } from "../core/lock.ts";
import type { Logger } from "../core/log.ts";

// ---------------------------------------------------------------------------------------------------------------
// Web build

async function listFiles(dir: string, out: string[], base: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, out, base);
    else if (e.isFile()) out.push(relative(base, full).split(sep).join("/"));
  }
}

/** sha256 over the sorted relative paths and contents of `src/web/**`, `src/shared/**`, `vite.config.ts` and `package-lock.json`; first 12 hex chars. */
export async function webHash(appDir: string): Promise<string> {
  const files: string[] = [];
  await listFiles(join(appDir, "src", "web"), files, appDir);
  await listFiles(join(appDir, "src", "shared"), files, appDir);
  for (const single of ["vite.config.ts", "package-lock.json"]) {
    try {
      if ((await stat(join(appDir, single))).isFile()) files.push(single);
    } catch {
      // Absent files do not contribute.
    }
  }
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(join(appDir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

export type EnsureWebResult = { root: string; hash: string } | { error: string } | { skipped: "no-web-source" };

export interface EnsureWebOptions {
  appDir: string;
  /** Where to build when `<appDir>/dist` is not writable (a read-only skill dir): `<project>/tsf/data/web`. */
  fallbackDir: string;
  log: Logger;
  /** Replaces the `vite build` child (tests). Receives the directory to build into. */
  build?: (outDir: string) => Promise<void>;
}

const LOCK_POLL_MS = 500;
const LOCK_WAIT_MS = 5 * 60_000;
const STALE_DIR_MS = 10 * 60_000;

async function isFresh(dir: string, hash: string): Promise<boolean> {
  try {
    const stamp = await readFile(join(dir, ".tsf-build"), "utf8");
    if (stamp.trim() !== hash) return false;
    return (await stat(join(dir, "index.html"))).isFile();
  } catch {
    return false;
  }
}

async function writable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Take `<base>/.build.lock` (flag wx, pid inside); a dead owner's lock is taken over, a live one is waited on. Returns release, or undefined when `fresh()` became true while waiting. */
async function takeBuildLock(base: string, fresh: () => Promise<boolean>): Promise<(() => Promise<void>) | undefined> {
  const lock = join(base, ".build.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await open(lock, "wx");
      try {
        await fh.writeFile(`${process.pid}\n`);
      } finally {
        await fh.close();
      }
      return async () => {
        if (readLockPid(lock) === process.pid) await rm(lock, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const owner = readLockPid(lock);
    if (owner === undefined) {
      // Created a moment ago and the pid is not written yet, or left empty by a crash.
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => Infinity);
      if (age > 2000) await rm(lock, { force: true });
      else await sleep(20);
      continue;
    }
    if (!isAlive(owner)) {
      await rm(lock, { force: true });
      continue;
    }
    if (await fresh()) return undefined;
    if (Date.now() > deadline) throw new Error(`timed out waiting for the web build lock held by process ${owner}`);
    await sleep(LOCK_POLL_MS);
  }
}

/**
 * Vite's output as the agent and the banner see it: no colour codes, no stack frames (`at ...` lines), no path noise
 * from node_modules, the first 1500 characters (the message and the code frame come first).
 */
export function trimBuildText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
  const lines = plain.split("\n").filter((l) => !/^\s+at\s/.test(l) && !/^\s*errors: \[Getter/.test(l) && l.trim() !== "");
  const out = lines.join("\n").trim();
  return out.length > 1500 ? `${out.slice(0, 1500)}...` : out;
}

function viteBuild(appDir: string, outDir: string, log: Logger): Promise<void> {
  return new Promise((resolveBuild, reject) => {
    const child = spawn(
      process.execPath,
      [join(appDir, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", outDir, "--emptyOutDir"],
      { cwd: appDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let tail = "";
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-30_000);
      for (const line of text.split("\n")) if (line.trim() !== "") log.info("web.build", { line: line.trimEnd() });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveBuild();
      else reject(new Error(`vite build exited with ${code}: ${trimBuildText(tail)}`));
    });
  });
}

async function removeOldDirs(base: string, keep: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith("web-") || join(base, name) === keep) continue;
    try {
      const s = await stat(join(base, name));
      if (now - s.mtimeMs > STALE_DIR_MS) await rm(join(base, name), { recursive: true, force: true });
    } catch {
      // Another server may be removing it too.
    }
  }
}

/**
 * Make sure a built web app exists for the current sources and return its directory (DESIGN 3 "Web build").
 * `skipped` when there is no `src/web/index.html` (P1 and P2).
 */
export async function ensureWebBuilt(opts: EnsureWebOptions): Promise<EnsureWebResult> {
  const { appDir, fallbackDir, log } = opts;
  try {
    if (!(await stat(join(appDir, "src", "web", "index.html"))).isFile()) return { skipped: "no-web-source" };
  } catch {
    return { skipped: "no-web-source" };
  }
  try {
    const hash = await webHash(appDir);
    const primary = join(appDir, "dist");
    const primaryDir = join(primary, `web-${hash}`);
    if (await isFresh(primaryDir, hash)) return { root: primaryDir, hash };
    const base = (await writable(primary)) ? primary : fallbackDir;
    const dir = join(base, `web-${hash}`);
    if (base !== primary && (await isFresh(dir, hash))) return { root: dir, hash };
    await mkdir(base, { recursive: true });

    const release = await takeBuildLock(base, () => isFresh(dir, hash));
    if (!release) return { root: dir, hash };
    try {
      // Another server may have built it while this one waited for the lock.
      if (await isFresh(dir, hash)) return { root: dir, hash };
      const tmp = `${dir}.tmp-${process.pid}`;
      await rm(tmp, { recursive: true, force: true });
      log.info("web.build_start", { hash, dir });
      const started = Date.now();
      await (opts.build ? opts.build(tmp) : viteBuild(appDir, tmp, log));
      await mkdir(tmp, { recursive: true });
      await writeFile(join(tmp, ".tsf-build"), `${hash}\n`);
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
      log.info("web.build_done", { hash, ms: Date.now() - started });
      await removeOldDirs(base, dir);
      return { root: dir, hash };
    } finally {
      await release();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("web.build_failed", { error: err });
    return { error: message };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Serving

/** Insert `<style id="tsf-theme">css</style>` immediately before `</head>` (at the start when there is none). */
export function injectTheme(html: string, css: string): string {
  const tag = `<style id="tsf-theme">${css.replace(/<\/style/gi, "<\\/style")}</style>`;
  const at = html.search(/<\/head>/i);
  if (at === -1) return tag + html;
  return html.slice(0, at) + tag + html.slice(at);
}

/** `<meta name="tsf-web-hash">` before `</head>`: the build the page loaded, so it reloads only for a different `web.rebuilt` hash. */
export function injectWebHash(html: string, hash: string | null): string {
  if (hash === null) return html;
  const tag = `<meta name="tsf-web-hash" content="${hash}">`;
  const at = html.search(/<\/head>/i);
  return at === -1 ? tag + html : html.slice(0, at) + tag + html.slice(at);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

const IMMUTABLE = "public, max-age=31536000, immutable";

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" } });
}

/** Static files from `root` with an SPA fallback: `index.html` no-cache with the theme inlined, `/assets/*` immutable. */
export function staticHandler(
  rootOf: string | (() => string),
  themeCss: () => string,
  webHash: () => string | null = () => null,
): (c: Context) => Response | Promise<Response> {
  const current = (): string => resolve(typeof rootOf === "function" ? rootOf() : rootOf);

  const indexResponse = async (base: string): Promise<Response> => {
    let html: string;
    try {
      html = await readFile(join(base, "index.html"), "utf8");
    } catch {
      return text(404, "The web app is not built.");
    }
    return new Response(injectWebHash(injectTheme(html, themeCss()), webHash()), {
      status: 200,
      headers: { "content-type": MIME[".html"]!, "cache-control": "no-cache" },
    });
  };

  return async (c) => {
    // One root per request: a rebuild swaps it between requests, never inside one.
    const base = current();
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return text(400, "bad request path");
    }
    if (pathname.includes("\0")) return text(400, "bad request path");
    const file = resolve(base, `.${pathname}`);
    if (!isInside(base, file)) return text(404, "not found");

    let target = file;
    try {
      const s = await stat(file);
      if (s.isDirectory()) target = join(file, "index.html");
    } catch {
      // Missing: handled below.
    }

    let body: Buffer | undefined;
    try {
      body = await readFile(target);
    } catch {
      body = undefined;
    }
    if (body === undefined) {
      const ext = extname(pathname);
      // A missing file-like request is a 404; a route-like path is the SPA's.
      if (pathname.startsWith("/assets/") || (ext !== "" && ext !== ".html")) return text(404, "not found");
      return await indexResponse(base);
    }

    const ext = extname(target).toLowerCase();
    if (target === join(base, "index.html")) return await indexResponse(base);
    const immutable = pathname.startsWith("/assets/");
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": immutable ? IMMUTABLE : "no-cache",
      },
    });
  };
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "content-encoding"]);

/** `--dev`: forward non-API requests to Vite with global fetch; HTML responses get the theme inlined. */
export function devProxy(viteUrl: string, themeCss: () => string): (c: Context) => Promise<Response> {
  return async (c) => {
    const incoming = new URL(c.req.url);
    const target = new URL(`${incoming.pathname}${incoming.search}`, viteUrl);
    const headers = new Headers();
    for (const [k, v] of c.req.raw.headers) {
      const key = k.toLowerCase();
      if (key === "host" || key === "connection" || key === "content-length") continue;
      headers.set(k, v);
    }
    headers.set("accept-encoding", "identity");
    let upstream: Response;
    try {
      upstream = await fetch(target, { method: c.req.method, headers, redirect: "manual" });
    } catch {
      return text(502, `The Vite dev server is not reachable at ${viteUrl}. Start it with: npm run dev:web`);
    }
    const out = new Headers();
    for (const [k, v] of upstream.headers) if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
    const type = upstream.headers.get("content-type") ?? "";
    if (type.includes("text/html")) {
      out.set("cache-control", "no-cache");
      return new Response(injectTheme(await upstream.text(), themeCss()), { status: upstream.status, headers: out });
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}

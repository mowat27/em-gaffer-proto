/**
 * The screenshot capability (`ui.screenshot`, P9 "Liquid core"): headless Chromium through `playwright` opens the
 * factory's own URL and writes a PNG under `tsf/data/screenshots`. The browser is installed separately and never by
 * this code: a launch that finds none answers with the command to run. `playwright` is imported lazily so the factory
 * starts without it; an import failure is the "unavailable" answer.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ServiceError } from "./errors.ts";
import type { ScreenshotInput, ScreenshotResult } from "../shared/types.ts";

/** The slice of playwright this module uses (the unit test fakes it). */
export interface PlaywrightLike {
  chromium: {
    launch(opts?: Record<string, unknown>): Promise<BrowserLike>;
  };
}
export interface BrowserLike {
  newContext(opts?: Record<string, unknown>): Promise<ContextLike>;
  close(): Promise<void>;
}
export interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export interface PageLike {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  emulateMedia(opts: Record<string, unknown>): Promise<void>;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  waitForLoadState(state: string, opts?: Record<string, unknown>): Promise<void>;
  waitForSelector(selector: string, opts?: Record<string, unknown>): Promise<unknown>;
  locator(selector: string): { screenshot(opts?: Record<string, unknown>): Promise<Uint8Array>; first(): { waitFor(opts?: Record<string, unknown>): Promise<void> } };
  screenshot(opts?: Record<string, unknown>): Promise<Uint8Array>;
  viewportSize(): { width: number; height: number } | null;
}

export type PlaywrightLoader = () => Promise<PlaywrightLike>;

const defaultLoader: PlaywrightLoader = async () => (await import("playwright")) as unknown as PlaywrightLike;

export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 800;
const MAX_DIM = 4000;
const INSTALL_HINT = "run `npx playwright install chromium` inside tsf/app (the factory never installs a browser itself), then try again";

/** The page to open: `/` or an app path on the factory's own origin; anything that could leave it is `invalid`. */
export function screenshotPath(page: string | undefined): string {
  const p = page === undefined || page === "" ? "/" : page;
  if (typeof p !== "string" || !p.startsWith("/") || p.startsWith("//") || p.includes("\\") || /[\u0000-\u001f]/.test(p)) {
    throw new ServiceError("invalid", "page must be an app path starting with a single /, for example / or /?x=1");
  }
  return p;
}

function dimension(v: number | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 100 || v > MAX_DIM) throw new ServiceError("invalid", `${name} must be an integer 100..${MAX_DIM}`);
  return v;
}

export interface ScreenshotOptions {
  /** The factory's own URL (the listening address on loopback). */
  baseUrl: string;
  /** `tsf/data/screenshots` */
  dir: string;
  playwright?: PlaywrightLoader;
  now?: () => Date;
}

function launchError(err: unknown): ServiceError {
  const message = err instanceof Error ? err.message : String(err);
  if (/Executable doesn't exist|playwright install|browserType\.launch.*not found|download new browsers/i.test(message)) {
    return new ServiceError("unavailable", `Chromium is not installed for playwright: ${INSTALL_HINT}.`);
  }
  return new ServiceError("unavailable", `could not start headless Chromium: ${message.split("\n")[0]}. If no browser is installed, ${INSTALL_HINT}.`);
}

export async function takeScreenshot(input: ScreenshotInput, opts: ScreenshotOptions): Promise<ScreenshotResult> {
  const path = screenshotPath(input.page);
  const width = dimension(input.width, DEFAULT_WIDTH, "width");
  const height = dimension(input.height, DEFAULT_HEIGHT, "height");
  if (input.mode !== undefined && input.mode !== "light" && input.mode !== "dark") throw new ServiceError("invalid", 'mode must be "light" or "dark"');
  if (input.selector !== undefined && (typeof input.selector !== "string" || input.selector === "" || input.selector.length > 500)) {
    throw new ServiceError("invalid", "selector must be a non-empty CSS selector");
  }

  let pw: PlaywrightLike;
  try {
    pw = await (opts.playwright ?? defaultLoader)();
  } catch (err) {
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new ServiceError("unavailable", `screenshots are unavailable: the playwright package cannot be imported (${why}). Run npm install inside tsf/app, then ${INSTALL_HINT}.`);
  }

  let browser: BrowserLike;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (err) {
    throw launchError(err);
  }
  let bytes: Uint8Array;
  try {
    const context = await browser.newContext({ viewport: { width, height }, ...(input.mode ? { colorScheme: input.mode } : {}) });
    const page = await context.newPage();
    await page.goto(new URL(path, opts.baseUrl).href, { waitUntil: "load", timeout: 30_000 });
    // The live event stream never goes idle, so idle is best effort; then the connection badge says the snapshot arrived.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await page.waitForSelector('[data-testid="connection"][data-state="live"]', { timeout: 5_000 }).catch(() => undefined);
    if (input.mode) {
      await page.emulateMedia({ colorScheme: input.mode });
      await page.evaluate((m: string) => document.documentElement.setAttribute("data-theme", m), input.mode);
    }
    if (input.selector) {
      const target = page.locator(input.selector);
      try {
        await target.first().waitFor({ timeout: 5_000 });
      } catch {
        throw new ServiceError("not_found", `no element matches ${input.selector} on ${path}`);
      }
      bytes = await target.screenshot({ type: "png" });
    } else {
      bytes = await page.screenshot({ type: "png", fullPage: input.fullPage === true });
    }
    await context.close().catch(() => undefined);
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw new ServiceError("upstream", `the screenshot failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
  } finally {
    await browser.close().catch(() => undefined);
  }

  await mkdir(opts.dir, { recursive: true });
  const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  let file = `${stamp}.png`;
  for (let n = 2; ; n++) {
    try {
      await writeFile(join(opts.dir, file), bytes, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      file = `${stamp}-${n}.png`;
    }
  }
  const dims = pngSize(bytes);
  return { path: join(opts.dir, file), file, url: `/api/screenshots/${file}`, width: dims?.width ?? width, height: dims?.height ?? height };
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const FILE = /^[A-Za-z0-9._-]+\.png$/;

/** The bytes of a screenshot by file name; only from `dir`, only a plain `*.png` name. */
export async function readScreenshotFile(dir: string, file: unknown): Promise<{ file: string; bytes: Uint8Array }> {
  if (typeof file !== "string" || !FILE.test(file) || file.includes("..") || basename(file) !== file) {
    throw new ServiceError("invalid", "file must be a screenshot file name such as 2026-11-03T10-00-00-000Z.png");
  }
  try {
    return { file, bytes: new Uint8Array(await readFile(join(dir, file))) };
  } catch {
    throw new ServiceError("not_found", `no screenshot ${file}`);
  }
}

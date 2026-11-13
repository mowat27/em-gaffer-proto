/** Helpers every e2e spec shares. The factory is the one `global-setup.ts` started; its address is in `test-results/factory.json`. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface FactoryFile {
  url: string;
  pid: number;
  root: string;
}

function factoryFile(): FactoryFile {
  return JSON.parse(readFileSync(join(appDir, "test-results", "factory.json"), "utf8")) as FactoryFile;
}

/** `http://127.0.0.1:48731` (no trailing slash). */
export function factoryUrl(): string {
  return factoryFile().url.replace(/\/+$/, "");
}

/** The temp project the factory runs in (the folder that holds `tsf/`). */
export function projectRoot(): string {
  return factoryFile().root;
}

/**
 * Call the factory's HTTP API from the test process. `path` is the route (`/api/pages/read?path=x`; `/api` is added
 * when missing). With a `body` it is a JSON POST, else a GET. Returns the parsed JSON; throws on a non-2xx status with
 * the server's error text.
 */
export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const route = path.startsWith("/api/") ? path : `/api${path.startsWith("/") ? "" : "/"}${path}`;
  const res = await fetch(`${factoryUrl()}${route}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${body === undefined ? "GET" : "POST"} ${route} -> ${res.status}: ${text}`);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/** Type `text` in the agent composer and send it with Enter; resolves once the server accepted it (HTTP 202). */
export async function send(page: Page, text: string): Promise<void> {
  const box = page.getByTestId("composer").locator("textarea");
  await box.fill(text);
  const accepted = page.waitForResponse((r) => r.url().endsWith("/api/chat/send") && r.request().method() === "POST");
  await box.press("Enter");
  const res = await accepted;
  expect(res.status(), await res.text()).toBe(202);
}

/**
 * Wait until the factory is not running a turn: `/api/status` reports `busy: false` on three reads 150 ms apart (a turn
 * that was just accepted may not have started yet). Pass `page` to also wait for the connection indicator to be live.
 */
export async function waitForIdle(page?: Page, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        for (let i = 0; i < 3; i++) {
          const status = await api<{ busy: boolean }>("/api/status");
          if (status.busy) return "busy";
          if (i < 2) await new Promise((r) => setTimeout(r, 150));
        }
        return "idle";
      },
      { timeout: timeoutMs, intervals: [100, 200, 400] },
    )
    .toBe("idle");
  if (page) await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
}

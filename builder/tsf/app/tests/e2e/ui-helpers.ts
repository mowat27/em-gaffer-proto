/** Helpers for the P4 specs: open the app, put the UI config back, read the theme the page shows. */
import { expect, type Page } from "@playwright/test";
import { DEFAULT_UI_CONFIG } from "../../src/shared/types.ts";
import { api, waitForIdle } from "./helpers.ts";

/** The neon theme every spec starts from. */
export const NEON = "precision-weave-neon";

/** Load the app, wait for the live stream and an idle agent, and plant a marker that a reload would remove. */
export async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("agent-pane")).toBeVisible();
  await waitForIdle(page);
  await page.evaluate(() => {
    (window as unknown as { __tsfMarker: number }).__tsfMarker = 1;
  });
}

/** True while the page that `openApp` loaded is still the same document (nothing reloaded). */
export function stillLoaded(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __tsfMarker?: number }).__tsfMarker === 1);
}

/** Put the navbars, hotkeys, animations, panes and the theme back to the defaults. */
export async function resetUi(): Promise<void> {
  const d = DEFAULT_UI_CONFIG;
  await api("/api/ui-config/update", { patch: { navbars: d.navbars, hotkeys: d.hotkeys, animations: d.animations, panes: d.panes } });
  const themes = await api<{ name: string; kind: string }[]>("/api/themes");
  await api("/api/themes/set", { name: NEON, mode: "system" });
  for (const t of themes.filter((x) => x.kind === "custom")) await api("/api/themes/delete", { name: t.name });
}

/** The text of `<style id="tsf-theme">`. */
export function themeCss(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById("tsf-theme")?.textContent ?? "");
}

/** The value of a custom property on the root, "" when unset. */
export function rootVar(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
}

/** Placement ids of a widget type in a navbar, from the API. */
export async function placements(navbar: "global" | "agent", widget: string): Promise<string[]> {
  const list = await api<{ placements: { id: string; widget: string; navbar: string }[] }>("/api/widgets");
  return list.placements.filter((p) => p.navbar === navbar && p.widget === widget).map((p) => p.id);
}

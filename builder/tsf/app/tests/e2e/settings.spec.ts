/**
 * P4 settings modal (spec 8.3, 8.4; acceptance 6 theme half and 8): the hotkey opens it and is ignored while typing,
 * the theme picker, mode, custom theme editor and contrast panel work live, and so do the layout, hotkey and animation
 * panels. Every change is checked on the page that made it with no reload. The factory is shared, so each test puts the
 * UI config and the theme back.
 */
import { expect, test, type Page } from "@playwright/test";
import { api, send, waitForIdle } from "./helpers.ts";
import { NEON, openApp, placements, resetUi, rootVar, stillLoaded, themeCss } from "./ui-helpers.ts";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await resetUi();
  await openApp(page);
});
test.afterEach(async () => {
  await resetUi();
});

const modal = (page: Page) => page.getByTestId("settings-modal");

test("S opens settings, Escape closes it", async ({ page }) => {
  await page.keyboard.press("s");
  await expect(modal(page)).toBeVisible();
  await expect(modal(page)).toHaveAttribute("data-section", "essentials");
  await page.keyboard.press("Escape");
  await expect(modal(page)).toHaveCount(0);
});

test("hotkeys are ignored while typing in a text field", async ({ page }) => {
  const box = page.getByTestId("composer").locator("textarea");
  await box.click();
  await page.keyboard.type("so");
  await expect(box).toHaveValue("so");
  await expect(modal(page)).toHaveCount(0);
  await box.fill("");

  // The same holds in a plain input, such as the new page dialog's path field.
  await page.getByTestId("new-page").click();
  const path = page.getByRole("dialog").locator("input").first();
  await path.fill("");
  await path.press("s");
  await expect(path).toHaveValue("s");
  await expect(modal(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("the Settings button opens the same modal as the hotkey", async ({ page }) => {
  await page.getByTestId("open-settings").click();
  await expect(modal(page)).toBeVisible();
  for (const tab of ["theme", "layout", "hotkeys", "animations"]) {
    await page.getByTestId(`tab-${tab}`).click();
    await expect(page.getByTestId(`panel-${tab}`)).toBeVisible();
  }
});

test("theme and mode change live from the picker", async ({ page }) => {
  await page.keyboard.press("s");
  await expect(page.getByTestId("panel-theme")).toBeVisible();
  const before = await themeCss(page);
  expect(await rootVar(page, "--pw-ai-glow"), "Neon is a glass theme").not.toBe("");

  await page.getByTestId("theme-mode").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByTestId("theme-select").selectOption("precision-weave");
  await expect.poll(() => themeCss(page)).not.toBe(before);
  await expect.poll(() => rootVar(page, "--pw-ai-glow")).toBe("");
  await expect(page.getByTestId("theme-select")).toHaveValue("precision-weave");

  await page.getByTestId("theme-select").selectOption(NEON);
  await expect.poll(() => themeCss(page)).toBe(before);
  expect(await stillLoaded(page)).toBe(true);
  expect((await api<{ theme: { name: string; mode: string } }>("/api/ui-config")).theme).toEqual({ name: NEON, mode: "dark" });
});

test("acceptance 8: a custom theme is created, edited, checked and deleted", async ({ page }) => {
  await page.keyboard.press("s");
  await expect(page.getByTestId("panel-theme")).toBeVisible();
  // A built-in theme cannot be edited.
  await expect(page.getByTestId("theme-edit")).toContainText("built-in");
  // Its values are shown, read-only.
  await expect(page.getByTestId("theme-seed-ai-light")).not.toHaveValue("");
  await expect(page.getByTestId("theme-seed-ai-light")).toBeDisabled();
  await expect(page.getByTestId("theme-contrast")).toBeVisible();

  const before = await themeCss(page);
  await page.getByTestId("theme-create-name").fill("warm-ai");
  await page.getByTestId("theme-create-title").fill("Warm AI");
  await page.getByTestId("theme-create-base").selectOption(NEON);
  await page.getByTestId("theme-create-submit").click();

  // It is active, in the list, and the editor is open for it.
  await expect(page.getByTestId("theme-select")).toHaveValue("warm-ai");
  await expect(page.getByTestId("theme-select").locator("option", { hasText: "Warm AI" })).toHaveCount(1);
  await expect(page.getByTestId("theme-seed-ai-light")).toBeVisible();

  // An untouched seed shows the inherited colour (not empty), painted on its swatch, with no Override mark.
  const inherited = await api<{ name: string; resolved?: { seeds: { ai?: { light?: string } } } }[]>("/api/themes");
  const neonAi = inherited.find((t) => t.name === NEON)?.resolved?.seeds.ai?.light ?? "";
  expect(neonAi).toMatch(/^#[0-9A-F]{6}$/i);
  await expect(page.getByTestId("theme-seed-ai-light")).toHaveValue(neonAi);
  await expect(page.getByTestId("theme-seed-ai-light-override")).toHaveCount(0);
  await expect(page.getByTestId("theme-seed-ai-light-picker")).toHaveValue(neonAi.toLowerCase());
  await expect(page.getByTestId("theme-seed-ai-light-swatch")).not.toHaveCSS("background-color", "rgb(0, 0, 0)");

  // The native picker sets a hex value, which is then marked as an override and can be reset.
  await page.getByTestId("theme-seed-accent-dark-picker").fill("#336699");
  await expect(page.getByTestId("theme-seed-accent-dark-override")).toBeVisible();
  await expect(page.getByTestId("theme-seed-accent-dark")).toHaveValue("#336699");
  await page.getByTestId("theme-seed-accent-dark-reset").click();
  await expect(page.getByTestId("theme-seed-accent-dark-override")).toHaveCount(0);
  await expect(page.getByTestId("theme-seed-accent-dark")).not.toHaveValue("#336699");

  // A warmer AI accent applies as it is typed.
  const warm = "hsl(24 90% 55%)";
  await page.getByTestId("theme-seed-ai-light").fill(warm);
  await expect.poll(() => themeCss(page)).not.toBe(before);
  const aiLight = async () =>
    (await api<{ name: string; definition?: { seeds: { ai?: { light?: string } } } }[]>("/api/themes")).find((t) => t.name === "warm-ai")?.definition?.seeds.ai?.light;
  await expect.poll(aiLight).toBe(warm);
  await expect(page.getByTestId("theme-seed-ai-light-override")).toBeVisible();

  // A colour that is not a colour is flagged and not sent.
  await page.getByTestId("theme-seed-brand-light").fill("not a colour");
  await expect(page.getByText("Use a hex, rgb() or hsl() colour.")).toBeVisible();
  await page.getByTestId("theme-seed-brand-light").fill("");

  // Contrast: a check runs on demand and its result is shown, warnings or not.
  await page.getByTestId("theme-check").click();
  await expect(page.getByTestId("theme-contrast")).toContainText(/No contrast problems|contrast warning/);

  expect(await stillLoaded(page)).toBe(true);

  // Delete falls back to Neon.
  await page.getByTestId("theme-delete").click();
  await page.getByRole("dialog").filter({ hasText: "Delete Warm AI?" }).getByRole("button", { name: "Delete theme" }).click();
  await expect(page.getByTestId("theme-select")).toHaveValue(NEON);
  await expect(page.getByTestId("theme-select").locator("option", { hasText: "Warm AI" })).toHaveCount(0);
  await expect.poll(() => themeCss(page)).toBe(before);
});

test("acceptance 8 through the agent: create_theme applies live and shows in the list", async ({ page }) => {
  const before = await themeCss(page);
  const args = { name: "agent-warm", base: NEON, title: "Agent warm", seeds: { ai: { light: "hsl(20 90% 55%)", dark: "hsl(20 85% 60%)" } } };
  const done = page.getByTestId("chat-log").getByText("probe done", { exact: true });
  const n = await done.count();
  await send(page, `probe create_theme ${JSON.stringify(args)}`);
  await expect(done).toHaveCount(n + 1);
  await waitForIdle(page);
  await expect.poll(() => themeCss(page)).not.toBe(before);

  // The composer still has focus after the send, so a hotkey would be typed into it: use the button.
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("theme-select")).toHaveValue("agent-warm");
  await expect(page.getByTestId("theme-select").locator("option", { hasText: "Agent warm" })).toHaveCount(1);
  await expect(page.getByTestId("theme-contrast")).toBeVisible();
  expect(await stillLoaded(page)).toBe(true);
});

test("Settings follows a custom theme's surface in both modes and when the theme changes", async ({ page }) => {
  // The modal paints with surface-overlay, which the themes below never set: it must follow their surface.
  const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("settings-modal") });
  const paint = () => dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
  const overlay = () =>
    page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--pw-surface-overlay)";
      document.body.append(probe);
      const c = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return c;
    });
  await api("/api/themes/set", { name: "precision-weave", mode: "light" });
  await page.keyboard.press("s");
  await expect(dialog).toBeVisible();
  const base = { light: await paint(), dark: "" };
  await page.getByTestId("theme-mode").selectOption("dark");
  await expect.poll(paint).not.toBe(base.light);
  base.dark = await paint();

  await api("/api/themes/create", { name: "sand", base: "precision-weave", tokens: { surface: { light: "#FFF4E0", dark: "#2B2010" } } });
  await api("/api/themes/create", { name: "sea", base: "precision-weave", tokens: { surface: { light: "#E6F4FF", dark: "#0E2233" } } });
  const seen: string[] = [];
  for (const name of ["sand", "sea"]) {
    for (const mode of ["light", "dark"] as const) {
      await api("/api/themes/set", { name, mode });
      await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
      await expect.poll(paint, `${name} ${mode}`).not.toBe(base[mode]);
      expect(await paint(), `${name} ${mode}`).toBe(await overlay());
      seen.push(await paint());
    }
  }
  expect(new Set(seen).size, "each theme and mode paints its own surface").toBe(4);
});

test("layout and widgets: panes, navbars and widgets change live", async ({ page }) => {
  await page.keyboard.press("s");
  await page.getByTestId("tab-layout").click();

  // Add a context bar to the agent navbar, make it full width, move it, remove it.
  await page.getByTestId("layout-add-navbar").selectOption("agent");
  await page.getByTestId("layout-add-widget").selectOption("context_bar");
  await page.getByTestId("layout-add-slot").selectOption("left");
  await page.getByTestId("layout-add-submit").click();
  // One default context bar is there already; the new one is the newest placement.
  await expect.poll(() => placements("agent", "context_bar")).toHaveLength(2);
  const id = (await placements("agent", "context_bar")).at(-1)!;
  const item = page.getByTestId(`widget-${id}`);
  await expect(item).toBeVisible();

  await page.getByTestId(`layout-full-${id}`).click();
  await expect(item).toHaveAttribute("data-full", "true");
  await page.getByTestId(`layout-slot-${id}`).selectOption("right");
  await expect(item).toHaveAttribute("data-slot", "right");

  await page.getByTestId(`layout-remove-${id}`).click();
  await expect(item).toHaveCount(0);

  // A navbar can be hidden, a pane can be hidden.
  await page.getByTestId("layout-navbar-visible-global").click();
  await expect(page.getByTestId("navbar-global")).toHaveCount(0);
  await expect(page.getByTestId("connection")).toBeVisible();
  await page.getByTestId("layout-navbar-visible-global").click();
  await expect(page.getByTestId("navbar-global")).toBeVisible();

  await page.getByTestId("layout-pane-left").click();
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-left", "closed");
  await page.getByTestId("layout-pane-left").click();
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-left", "open");
  expect(await stillLoaded(page)).toBe(true);
});

test("hotkeys: a key is changed, the new key works, a duplicate is refused", async ({ page }) => {
  await page.keyboard.press("s");
  await page.getByTestId("tab-hotkeys").click();
  const input = page.getByTestId("hotkey-input-settings.open");
  await expect(input).toHaveValue("s");

  // A key another action holds is refused with the server's reason.
  await input.fill("r");
  await page.getByTestId("hotkey-set-settings.open").click();
  await expect(page.getByTestId("hotkey-settings.open")).toContainText(/duplicate hotkey/i);
  expect((await api<{ hotkeys: Record<string, string> }>("/api/ui-config")).hotkeys["settings.open"]).toBe("s");

  await input.fill("x");
  await page.getByTestId("hotkey-set-settings.open").click();
  await expect(page.getByTestId("hotkey-settings.open")).toContainText("Saved");
  await page.keyboard.press("Escape");
  await expect(modal(page)).toHaveCount(0);

  await page.keyboard.press("s");
  await expect(modal(page)).toHaveCount(0);
  await page.keyboard.press("x");
  await expect(modal(page)).toBeVisible();
  expect(await stillLoaded(page)).toBe(true);
});

test("hotkeys toggle the panes", async ({ page }) => {
  await page.keyboard.press("[");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-left", "closed");
  await page.keyboard.press("[");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-left", "open");
  await page.keyboard.press("m");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-maximised", "true");
  await page.keyboard.press("m");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-maximised", "false");
  await page.keyboard.press("/");
  await expect(page.getByTestId("composer").locator("textarea")).toBeFocused();
});

test("animations are saved and survive a reload", async ({ page }) => {
  await page.keyboard.press("s");
  await page.getByTestId("tab-animations").click();
  await page.getByTestId("anim-working").selectOption("pulse");
  await page.getByTestId("anim-idle").selectOption("breathe");
  await expect.poll(async () => (await api<{ animations: Record<string, string> }>("/api/ui-config")).animations).toMatchObject({
    agentWorking: "pulse",
    agentIdle: "breathe",
  });
  await expect(page.getByTestId("nav-status")).toHaveAttribute("data-working-anim", "pulse");
  await page.reload();
  await expect(page.getByTestId("nav-status")).toHaveAttribute("data-idle-anim", "breathe");
});

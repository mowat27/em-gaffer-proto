/**
 * Model controls: the Model panel (favourites, search, vendor groups, thinking as applied), the model_controls layer's
 * top-bar pickers and keys (p, 1 to 3, e and shift+e), and the agent bar's context meter, cost and Compact. The faux
 * catalog has one model, faux/faux-1. The factory is shared, so each test puts favourites, model, thinking and the
 * layer's placements back.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { FavouriteModel, Settings, UiConfig } from "../../src/shared/types.ts";
import { api } from "./helpers.ts";
import { openApp, resetUi } from "./ui-helpers.ts";

test.describe.configure({ mode: "serial" });

const FAUX = { provider: "faux", modelId: "faux-1" };
const modal = (page: Page) => page.getByTestId("settings-modal");
const settings = () => api<Settings>("/api/settings");
const LAYER_WIDGETS = [
  { navbar: "global", widget: "model_controls.favourite", slot: "right" },
  { navbar: "global", widget: "model_controls.thinking", slot: "right" },
  { navbar: "agent", widget: "context_bar", slot: "right" },
  { navbar: "agent", widget: "model_controls.compact", slot: "right" },
] as const;

/** Favourites, thinking and placements as a fresh factory has them (resetUi puts the navbars back to the bare defaults). */
async function reset(): Promise<void> {
  for (const f of await api<FavouriteModel[]>("/api/models/favourites")) {
    if (f.favourite) await api("/api/model/favourite", { provider: f.provider, modelId: f.modelId, favourite: false });
  }
  await api("/api/thinking/set", { level: "low" });
  await resetUi();
  const config = await api<UiConfig>("/api/ui-config");
  for (const w of LAYER_WIDGETS) {
    if (!config.navbars[w.navbar].items.some((p) => p.widget === w.widget)) await api("/api/widgets/add", w);
  }
}

test.beforeEach(async ({ page }) => {
  await reset();
  await openApp(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
});
test.afterEach(reset);

const topModel = (page: Page) => page.getByTestId("navbar-global").getByLabel("Model", { exact: true });
const topThinking = (page: Page) => page.getByTestId("navbar-global").getByLabel("Thinking", { exact: true });

async function openModelPanel(page: Page): Promise<void> {
  await page.keyboard.press("p");
  await expect(modal(page)).toBeVisible();
  await expect(page.getByTestId("panel-model")).toBeVisible();
}

test("the top bar has the Model and Thinking pickers, labelled inline, and they follow the settings", async ({ page }) => {
  await expect(topModel(page)).toHaveValue("faux-1");
  await expect(topModel(page).locator("option:checked")).toHaveText("Faux (current)");
  await expect(topThinking(page)).toHaveValue("low");
  // Label and select share a line: the bar keeps one control height.
  const label = page.getByTestId("navbar-global").getByText("Thinking", { exact: true });
  const [lb, sb] = [await label.boundingBox(), await topThinking(page).boundingBox()];
  expect(Math.abs(lb!.y + lb!.height / 2 - (sb!.y + sb!.height / 2))).toBeLessThan(4);

  await topThinking(page).selectOption("high");
  await expect.poll(async () => (await settings()).thinkingLevel).toBe("high");
  await api("/api/thinking/set", { level: "minimal" });
  await expect(topThinking(page)).toHaveValue("minimal");
  // A selection shows no transient "Done" line that would move the bar.
  await expect(page.getByTestId("navbar-global").getByText("Done")).toHaveCount(0);
});

test("p opens the Model panel; starring the model makes it favourite 1, everywhere at once", async ({ page }) => {
  await openModelPanel(page);
  await expect(page.getByTestId("model-current-name")).toHaveText("Faux");
  await expect(page.getByTestId("model-favourites-empty")).toBeVisible();

  const row = page.getByTestId("model-row").filter({ hasText: "faux-1" });
  await expect(row).toHaveAttribute("data-current", "true");
  await row.getByRole("button", { name: "Add Faux to the favourites" }).click();
  await expect(row).toHaveAttribute("data-favourite", "true");
  await expect(page.getByTestId("model-favourite")).toHaveCount(1);
  await expect(page.getByTestId("model-favourite").first()).toContainText("1");
  await expect(page.getByTestId("model-current-star")).toHaveAttribute("aria-pressed", "true");
  expect((await settings()).favouriteModels).toEqual([FAUX]);
  // The top bar's picker lists it as a favourite now, not as "(current)".
  await expect(topModel(page).locator("option:checked")).toHaveText("Faux");

  // Remove from the favourites list.
  await page.getByRole("button", { name: "Remove Faux from the favourites" }).first().click();
  await expect(page.getByTestId("model-favourites-empty")).toBeVisible();
  await expect.poll(async () => (await settings()).favouriteModels).toEqual([]);
});

test("search, favourites only and the vendor groups", async ({ page }) => {
  await openModelPanel(page);
  // The search box has focus on open, so typing filters at once.
  await expect(page.getByLabel("Search models")).toBeFocused();
  await page.keyboard.type("faux");
  await expect(page.getByTestId("model-count")).toHaveText("1 of 1 models match");
  await expect(page.getByTestId("model-group")).toHaveCount(1);
  await expect(page.getByTestId("model-group").first()).toContainText("faux");
  const search = page.getByLabel("Search models");
  await search.fill("nothing like this");
  await expect(page.getByTestId("model-picker").getByText("No model matches", { exact: true })).toBeVisible();
  await expect(page.getByTestId("model-count")).toHaveText("0 of 1 models match");
  await search.fill("faux 1");
  await expect(page.getByTestId("model-row")).toHaveCount(1);
  await search.fill("");

  await page.getByRole("button", { name: "Favourites only" }).click();
  await expect(page.getByTestId("model-picker").getByText("No favourites yet", { exact: true })).toBeVisible();
  await api("/api/model/favourite", { ...FAUX, favourite: true });
  await expect(page.getByTestId("model-row")).toHaveCount(1);
});

test("the thinking level names the level the model gets", async ({ page }) => {
  await openModelPanel(page);
  await page.getByTestId("thinking-select").selectOption("max");
  await expect(page.getByTestId("thinking-current")).toHaveAttribute("data-level", "max");
  // The faux model supports every level, so nothing is clamped.
  await expect(page.getByTestId("thinking-current")).toHaveAttribute("data-applied", "max");
  await expect(page.getByTestId("thinking-current")).toHaveText("Thinking is max.");
});

test("e and shift+e step the thinking level and wrap", async ({ page }) => {
  await page.keyboard.press("e");
  await expect(topThinking(page)).toHaveValue("medium");
  await page.keyboard.press("Shift+E");
  await page.keyboard.press("Shift+E");
  await expect(topThinking(page)).toHaveValue("minimal");
  await api("/api/thinking/set", { level: "max" });
  await expect(topThinking(page)).toHaveValue("max");
  await page.keyboard.press("e");
  await expect(topThinking(page)).toHaveValue("off");
  expect((await settings()).thinkingLevel).toBe("off");
});

test("1 picks favourite 1; a key with no favourite says why", async ({ page }) => {
  await page.keyboard.press("2");
  const toast = page.getByText(/No favourite model 2: there are no favourites yet/);
  await expect(toast).toBeVisible();
  await api("/api/model/favourite", { ...FAUX, favourite: true });
  await page.keyboard.press("1");
  await expect.poll(async () => (await settings()).model).toEqual(FAUX);
});

test("the agent bar shows the context meter with the cost, and Compact asks first", async ({ page }) => {
  const bar = page.getByTestId("navbar-agent");
  await expect(bar.getByRole("meter", { name: "Context used" })).toBeVisible();
  await expect(bar.getByTestId("context-cost")).toHaveText(/^\$\d+\.\d{2,4}$/);
  await bar.getByRole("button", { name: "Compact" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Summarise the older turns");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("switching model_controls off removes its controls from the bars, and switching it on brings them back", async ({ page }) => {
  const global = page.getByTestId("navbar-global");
  const agent = page.getByTestId("navbar-agent");
  await expect(topModel(page)).toBeVisible();
  try {
    await api("/api/layers/set-enabled", { name: "model_controls", enabled: false });
    await expect(global.locator('[data-widget^="model_controls."]')).toHaveCount(0);
    await expect(agent.locator('[data-widget^="model_controls."]')).toHaveCount(0);
    await expect(page.getByText(/unavailable/)).toHaveCount(0);
    // The context bar stays, so the agent bar still has its meter.
    await expect(agent.getByRole("meter", { name: "Context used" })).toBeVisible();
  } finally {
    await api("/api/layers/set-enabled", { name: "model_controls", enabled: true });
  }
  await expect(topModel(page)).toBeVisible();
  await expect(agent.getByRole("button", { name: "Compact" })).toBeVisible();
});

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
}

test("the context meter grows in a wide pane and takes its own line in a narrow one, never covering Compact", async ({ page }) => {
  const bar = page.getByTestId("navbar-agent");
  const track = bar.locator(".tsf-context-track");
  const compact = bar.getByRole("button", { name: "Compact" });

  await api("/api/ui-config/update", { patch: { panes: { right: { width: 720 } } } });
  await expect.poll(async () => (await box(page.getByTestId("pane-right"))).width).toBe(720);
  const wide = await box(track);
  expect(wide.width).toBeGreaterThan(240);

  await api("/api/ui-config/update", { patch: { panes: { right: { width: 320 } } } });
  await expect.poll(async () => (await box(page.getByTestId("pane-right"))).width).toBe(320);
  const [t, c] = [await box(track), await box(compact)];
  // The meter sits below the button row and they do not overlap.
  expect(t.y).toBeGreaterThanOrEqual(c.y + c.height - 1);
  expect(t.width).toBeGreaterThanOrEqual(64);
  await expect(bar.getByTestId("context-cost")).toBeVisible();
});

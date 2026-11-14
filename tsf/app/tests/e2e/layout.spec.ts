/**
 * The workbench layout (DESIGN 11, Layout; Lot H): both sidebars, the inlined theme, resize, collapse with rails,
 * maximise and back, each kept in the UI config across a reload.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { DEFAULT_UI_CONFIG, type UiConfig } from "../../src/shared/types.ts";
import { api, factoryUrl } from "./helpers.ts";

async function resetPanes(): Promise<void> {
  await api<UiConfig>("/api/ui-config/update", { patch: { panes: DEFAULT_UI_CONFIG.panes } });
}

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
}

async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not visible");
  return Math.round(box.width);
}

/** Resolves once the next UI config save has been answered. */
function nextSave(page: Page) {
  return page.waitForResponse((r) => r.url().endsWith("/api/ui-config/update") && r.request().method() === "POST");
}

test.beforeEach(async () => {
  await resetPanes();
});

test.afterAll(async () => {
  await resetPanes();
});

test("both sidebars and the centre are visible on load", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("pane-left")).toBeVisible();
  await expect(page.getByTestId("pane-center")).toBeVisible();
  await expect(page.getByTestId("pane-right")).toBeVisible();
  await expect(page.getByTestId("page-tree")).toBeVisible();
  await expect(page.getByTestId("agent-pane")).toBeVisible();
  expect(await widthOf(page.getByTestId("pane-left"))).toBe(DEFAULT_UI_CONFIG.panes.left.width);
  expect(await widthOf(page.getByTestId("pane-right"))).toBe(DEFAULT_UI_CONFIG.panes.right.width);
  await expect(page.getByTestId("rail-left")).toHaveCount(0);
  await expect(page.getByTestId("rail-right")).toHaveCount(0);
});

test("the theme is inlined in the HTML: --pw-ai-glow is set on :root with JavaScript off", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    const res = await page.goto(`${factoryUrl()}/`);
    expect(res?.status()).toBe(200);
    expect(await res!.text()).toContain('<style id="tsf-theme">');
    const glow = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--pw-ai-glow").trim());
    expect(glow).not.toBe("");
    // The app did not run: the theme came from the server's HTML alone.
    await expect(page.getByTestId("workbench")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("dragging the left handle resizes the pane, and the width survives a reload", async ({ page }) => {
  await open(page);
  const pane = page.getByTestId("pane-left");
  const handle = page.getByTestId("resize-left");
  const before = await widthOf(pane);
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const saved = nextSave(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 4 });
  await page.mouse.move(x + 121, y, { steps: 4 });
  await page.mouse.up();
  const expected = before + 120;
  expect(await widthOf(pane)).toBe(expected);
  expect((await saved).status()).toBe(200);
  const config = await api<UiConfig>("/api/ui-config");
  expect(config.panes.left.width).toBe(expected);

  await page.reload();
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
  await expect.poll(() => widthOf(pane)).toBe(expected);
  await expect(handle).toHaveAttribute("aria-valuenow", String(expected));
});

test("keyboard: Home makes the pane its narrowest, End widens it, arrows step by 16", async ({ page }) => {
  await open(page);
  const pane = page.getByTestId("pane-left");
  const handle = page.getByTestId("resize-left");
  await handle.focus();
  let saved = nextSave(page);
  await handle.press("Home");
  expect(await widthOf(pane)).toBe(160);
  await saved;
  await expect.poll(async () => (await api<UiConfig>("/api/ui-config")).panes.left.width).toBe(160);

  saved = nextSave(page);
  await handle.press("ArrowRight");
  expect(await widthOf(pane)).toBe(176);
  await handle.press("Shift+ArrowRight");
  expect(await widthOf(pane)).toBe(240);
  await saved;
  await expect.poll(async () => (await api<UiConfig>("/api/ui-config")).panes.left.width).toBe(240);

  await page.reload();
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
  await expect.poll(() => widthOf(pane)).toBe(240);

  await handle.focus();
  await handle.press("End");
  const widest = await widthOf(pane);
  expect(widest).toBeGreaterThan(240);
  expect(widest % 4).toBe(0);
  // The centre keeps its room.
  expect(await widthOf(page.getByTestId("pane-center"))).toBeGreaterThanOrEqual(300);
});

test("collapsing the agent leaves a rail; it stays collapsed after a reload and the rail restores it", async ({ page }) => {
  await open(page);
  let saved = nextSave(page);
  await page.getByTestId("collapse-right").click();
  await saved;
  await expect(page.getByTestId("pane-right")).toBeHidden();
  const rail = page.getByTestId("rail-right");
  await expect(rail).toBeVisible();
  // A 32px rail above 1800px; at 1800px and below the collapsed agent is a 48px popover button.
  const wide = (page.viewportSize()?.width ?? 0) > 1800;
  expect(await widthOf(rail)).toBe(wide ? 32 : 48);
  await expect(page.getByTestId("resize-right")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("pane-right")).toBeHidden();
  await expect(rail).toBeVisible();

  saved = nextSave(page);
  await rail.getByRole("button", { name: "Show agent" }).click();
  await saved;
  await expect(page.getByTestId("pane-right")).toBeVisible();
  await expect(rail).toHaveCount(0);
  expect(await widthOf(page.getByTestId("pane-right"))).toBe(DEFAULT_UI_CONFIG.panes.right.width);
});

test("collapsing the pages pane leaves a rail that restores it", async ({ page }) => {
  await open(page);
  let saved = nextSave(page);
  await page.getByTestId("collapse-left").click();
  await saved;
  await expect(page.getByTestId("pane-left")).toBeHidden();
  await expect(page.getByTestId("rail-left")).toBeVisible();
  await expect(page.getByTestId("resize-left")).toHaveCount(0);
  saved = nextSave(page);
  await page.getByTestId("rail-left").getByRole("button", { name: "Show pages" }).click();
  await saved;
  await expect(page.getByTestId("pane-left")).toBeVisible();
});

test("maximising the agent hides the centre, survives a reload, and back restores the page", async ({ page }) => {
  await open(page);
  const right = page.getByTestId("pane-right");
  const center = page.getByTestId("pane-center");
  const toggle = page.getByTestId("toggle-agent-max");
  await expect(toggle).toHaveAttribute("aria-label", "Expand agent over the page");

  let saved = nextSave(page);
  await toggle.click();
  await saved;
  await expect(center).toBeHidden();
  await expect(page.getByTestId("resize-right")).toHaveCount(0);
  const leftWidth = await widthOf(page.getByTestId("pane-left"));
  expect(await widthOf(right)).toBeGreaterThan(1440 - leftWidth - 20);
  await expect(toggle).toHaveAttribute("aria-label", "Back to the page");

  await page.reload();
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
  await expect(center).toBeHidden();
  expect(await widthOf(right)).toBeGreaterThan(1440 - leftWidth - 20);

  saved = nextSave(page);
  await toggle.click();
  await saved;
  await expect(center).toBeVisible();
  expect(await widthOf(right)).toBe(DEFAULT_UI_CONFIG.panes.right.width);
});

test("selecting a page while maximised brings the page forward", async ({ page }) => {
  await open(page);
  const saved = nextSave(page);
  await page.getByTestId("toggle-agent-max").click();
  await saved;
  await expect(page.getByTestId("pane-center")).toBeHidden();
  // As the agent's select_page would: the Service un-maximises and the event reaches the page.
  await api("/api/pages/select", { path: "Start Here.md" });
  await expect(page.getByTestId("pane-center")).toBeVisible();
  await expect(page.getByTestId("toggle-agent-max")).toHaveAttribute("aria-label", "Expand agent over the page");
});

test("a layout change in another tab shows here without a reload", async ({ page }) => {
  await open(page);
  await api("/api/ui-config/update", { patch: { panes: { left: { width: 360 } } } });
  await expect.poll(() => widthOf(page.getByTestId("pane-left"))).toBe(360);
});

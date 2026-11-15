/**
 * P4 navbars (spec 8.2, acceptance 6 navbar half and 7): the widgets render from the UI config, and the agent's
 * widget tools (`probe <tool> <json>` calls any tool) change them live, with no reload. The factory is shared by every
 * spec, so each test puts the UI config back when it is done.
 */
import { expect, test, type Page } from "@playwright/test";
import { send, waitForIdle } from "./helpers.ts";
import { openApp, placements, resetUi, stillLoaded } from "./ui-helpers.ts";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await resetUi();
  await openApp(page);
});
test.afterEach(async () => {
  await resetUi();
});

const globalBar = (page: Page) => page.getByTestId("navbar-global");
const agentBar = (page: Page) => page.getByTestId("navbar-agent");

async function probe(page: Page, tool: string, args: object): Promise<void> {
  const done = page.getByTestId("chat-log").getByText("probe done", { exact: true });
  const before = await done.count();
  await send(page, `probe ${tool} ${JSON.stringify(args)}`);
  await expect(done).toHaveCount(before + 1);
  await waitForIdle(page);
}

test("the default navbars show the factory name, cron and the agent status on top, the context bar beside the chat", async ({ page }) => {
  await expect(globalBar(page).getByTestId("factory-name")).toBeVisible();
  await expect(globalBar(page).getByTestId("open-cron")).toBeVisible();
  await expect(globalBar(page).getByTestId("nav-status")).toHaveText("Idle");
  await expect(agentBar(page).locator('[data-widget="context_bar"]').getByRole("meter")).toBeVisible();
  await expect(agentBar(page).locator('[data-widget="agent_status"]')).toHaveCount(0);
  // Stop is only there while the agent works.
  await expect(page.getByTestId("chat-stop")).toHaveCount(0);
});

test("the status and Stop follow the agent, and the collapsed rail shows busy or idle", async ({ page }) => {
  await page.getByTestId("collapse-right").click();
  await expect(page.getByTestId("rail-agent-state")).toHaveAttribute("data-state", "idle");
  await page.getByTestId("rail-right").getByRole("button").click();
  await expect(page.getByTestId("pane-right")).toBeVisible();

  await send(page, "long turn");
  await expect(page.getByTestId("nav-status")).toHaveText(/^Working(?: · (?:waiting|thinking|writing|tools))?$/);
  await expect(page.getByTestId("chat-stop")).toBeVisible();
  await page.getByTestId("collapse-right").click();
  await expect(page.getByTestId("rail-agent-state")).not.toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("rail-agent-state")).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
  await page.getByTestId("rail-right").getByRole("button").click();
  await expect(page.getByTestId("chat-stop")).toHaveCount(0);
  await waitForIdle(page);
});

test("acceptance 6: the agent switches to another dark theme and adds widgets, live", async ({ page }) => {
  const root = page.locator("html");
  const cssBefore = await page.evaluate(() => document.getElementById("tsf-theme")?.textContent ?? "");

  await probe(page, "set_theme", { name: "precision-weave-glass", mode: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(() => document.getElementById("tsf-theme")?.textContent ?? "")).not.toBe(cssBefore);

  await probe(page, "add_widget", { navbar: "agent", widget: "context_bar", slot: "left" });
  // The agent bar has a context bar by default; the one the agent added is in the left slot.
  const added = agentBar(page).locator('[data-widget="context_bar"][data-slot="left"]');
  await expect(added).toBeVisible();
  await expect(added.getByRole("meter")).toBeVisible();

  await probe(page, "add_widget", { navbar: "global", widget: "agent_status", slot: "left" });
  // The top bar has a status by default; the agent's is the second one.
  const status = globalBar(page).locator('[data-widget="agent_status"]').last();
  await expect(globalBar(page).locator('[data-widget="agent_status"]')).toHaveCount(2);
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute("data-slot", "left");
  await expect(status.getByTestId("nav-status")).toHaveText("Idle");

  expect(await stillLoaded(page), "the page was not reloaded").toBe(true);
});

test("acceptance 7: full width, then remove, both live", async ({ page }) => {
  await probe(page, "add_widget", { navbar: "agent", widget: "context_bar", slot: "left" });
  // The newest placement (context_bar-1 is a default one).
  const id = (await placements("agent", "context_bar")).at(-1);
  expect(id).toBeTruthy();
  const item = page.getByTestId(`widget-${id}`);
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("data-full", "false");
  const narrow = (await item.boundingBox())!.width;

  await probe(page, "set_widget_options", { id, options: { fullWidth: true } });
  await expect(item).toHaveAttribute("data-full", "true");
  const bar = (await agentBar(page).boundingBox())!.width;
  const wide = (await item.boundingBox())!.width;
  // A context bar in the agent bar already grows with the free space, so full width is at least as wide.
  expect(wide).toBeGreaterThanOrEqual(narrow);
  expect(wide).toBeGreaterThan(bar * 0.9);

  await probe(page, "remove_widget", { id });
  await expect(page.getByTestId(`widget-${id}`)).toHaveCount(0);
  expect(await stillLoaded(page)).toBe(true);
});

test("the agent opens the settings panel", async ({ page }) => {
  await probe(page, "open_panel", { target: "settings" });
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  expect(await stillLoaded(page)).toBe(true);
});

test("the context bar shows the context in use", async ({ page }) => {
  await probe(page, "add_widget", { navbar: "agent", widget: "context_bar", slot: "left" });
  const meter = agentBar(page).locator('[data-slot="left"]').getByRole("meter");
  await expect(meter).toBeVisible();
  await expect(meter).toHaveAttribute("aria-valuetext", /tokens|no context window/);
});

test("the global navbar's Settings and Cron buttons open their panels", async ({ page }) => {
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-modal")).toHaveCount(0);
  await globalBar(page).getByTestId("open-cron").click();
  await expect(page.getByTestId("cron-modal")).toBeVisible();
});

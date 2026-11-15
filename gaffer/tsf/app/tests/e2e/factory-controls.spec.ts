/**
 * Liquid core controls (P9): Settings > Advanced > Factory has the three controls of the agent's tools rebuild_web,
 * restart_factory and screenshot. Rebuild answers with the served build; Screenshot shows the captured image inline
 * (or, when Chromium is not installed for playwright, the install command); Restart asks first. The shared factory is
 * not restarted here (the global teardown stops it by pid).
 */
import { expect, test, type Page } from "@playwright/test";
import { openApp, resetUi } from "./ui-helpers.ts";

const modal = (page: Page) => page.getByTestId("settings-modal");

test.afterEach(resetUi);

test("Settings > Advanced > Factory: rebuild, screenshot and a restart that asks first", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("s");
  await expect(modal(page)).toBeVisible();
  await page.getByTestId("tab-advanced").click();
  await page.getByTestId("tab-factory").click();
  await expect(page.getByTestId("panel-factory")).toBeVisible();
  await expect(page.getByTestId("factory-web-hash")).toHaveText(/^[0-9a-f]{12}$/);

  await page.locator('[data-cap="factory.rebuild_web"]').click();
  const rebuilt = page.getByTestId("factory-rebuild-result");
  await expect(rebuilt).toBeVisible();
  await expect(rebuilt).toHaveAttribute("data-ok", "true");

  await page.locator('[data-cap="ui.screenshot"]').click();
  const image = page.getByTestId("factory-screenshot-result");
  const failed = page.getByTestId("factory-screenshot-error");
  await expect(image.or(failed)).toBeVisible({ timeout: 60_000 });
  if (await image.isVisible()) {
    const img = image.locator("img");
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(100);
  } else {
    await expect(failed).toContainText("npx playwright install chromium");
  }

  // Restart asks first; cancelling leaves the factory running.
  await page.locator('[data-cap="factory.restart"]').click();
  await expect(page.getByRole("alertdialog").or(page.getByRole("dialog").last())).toContainText("Restart factory");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("factory-restart-result")).toHaveCount(0);
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
});

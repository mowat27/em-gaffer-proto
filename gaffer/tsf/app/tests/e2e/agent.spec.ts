/**
 * Lot J: the agent pane against the real factory on faux. The factory and its chat are shared by every spec in the run,
 * so each test counts what is there before it acts and waits for the factory to be idle before it starts a turn.
 */
import { expect, test, type Page } from "@playwright/test";
import { send, waitForIdle } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("agent-pane")).toBeVisible();
  await waitForIdle(page);
}

const log = (page: Page) => page.getByTestId("chat-log");
const scroller = (page: Page) => log(page).locator('[role="log"]');

/** Pixels between the end of the content and the bottom of the visible log. */
function distanceFromBottom(page: Page): Promise<number> {
  return scroller(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/**
 * The same, read after two frames: a streamed delta that React has committed is followed by the ResizeObserver at the
 * next frame, so a read in between sees a line or two of gap even while the log is stuck to the end.
 */
function settledDistanceFromBottom(page: Page): Promise<number> {
  return scroller(page).evaluate(async (el) => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
}

test("ping shows the message and pong, and the composer clears", async ({ page }) => {
  await open(page);
  const pings = await log(page).getByText("ping", { exact: true }).count();
  const pongs = await log(page).getByText("pong", { exact: true }).count();

  await send(page, "ping");

  await expect(log(page).getByText("ping", { exact: true })).toHaveCount(pings + 1);
  await expect(log(page).getByText("pong", { exact: true })).toHaveCount(pongs + 1);
  await expect(page.getByTestId("composer").locator("textarea")).toHaveValue("");
  await waitForIdle(page);
});

test("a typed, unsent message survives a reload", async ({ page }) => {
  await open(page);
  const box = page.getByTestId("composer").locator("textarea");
  await box.fill("half a thought");
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("composer").locator("textarea")).toHaveValue("half a thought");
  await page.getByTestId("composer").locator("textarea").fill("");
});

test("tool demo shows one activity log with steps", async ({ page }) => {
  await open(page);
  const groups = log(page).getByTestId("tool-group");
  const before = await groups.count();

  await send(page, "tool demo");

  await expect(groups).toHaveCount(before + 1);
  const group = groups.last();
  await expect(group).toHaveAttribute("data-status", "done");
  const steps = group.locator(".pw-activity-step");
  await expect(steps).toHaveCount(1);
  await expect(steps.first()).toContainText("List pages");
  await expect(steps.first().locator("code").first()).toHaveText("list_pages");
  await expect(log(page).getByText("listed", { exact: true })).not.toHaveCount(0);
  await waitForIdle(page);
});

test("the header shows Working, then Idle", async ({ page }) => {
  await open(page);
  const status = page.getByTestId("nav-status");
  await expect(status).toHaveText("Idle");
  // Stop is only there while the agent works.
  await expect(page.getByTestId("chat-stop")).toHaveCount(0);

  await send(page, "long turn");

  await expect(status).toHaveText(/^Working(?: · (?:waiting|thinking|writing|tools))?$/);
  await expect(status).toHaveAttribute("data-state", "working");
  await expect(page.getByTestId("chat-stop")).toBeVisible();
  await expect(status).toHaveText("Idle", { timeout: 30_000 });
  await expect(page.getByTestId("chat-stop")).toHaveCount(0);
  await expect(log(page).locator(".pw-stream-cursor")).toHaveCount(0);
});

test("scrolling up during a long turn is not pulled back to the bottom", async ({ page }) => {
  await open(page);
  await send(page, "long turn");
  await expect(log(page).locator(".pw-stream-cursor")).toBeVisible();

  // Sending follows the end: while the reader has not scrolled, new text keeps them at the bottom.
  // A released stick never comes back while the stream grows, so polling still catches a log that stopped following.
  await page.waitForTimeout(1_000);
  await expect.poll(() => settledDistanceFromBottom(page), { timeout: 3_000 }).toBeLessThanOrEqual(24);

  // The stream is long enough to scroll before the reader acts.
  await expect.poll(() => scroller(page).evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(300);
  await log(page).hover();
  await page.mouse.wheel(0, -4_000);
  await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(100);
  const heightThen = await scroller(page).evaluate((el) => el.scrollHeight);
  const topThen = await scroller(page).evaluate((el) => el.scrollTop);

  // More text arrives; the log stays where the reader left it.
  await page.waitForTimeout(2_000);
  await expect(log(page).locator(".pw-stream-cursor")).toBeVisible();
  expect(await scroller(page).evaluate((el) => el.scrollHeight)).toBeGreaterThan(heightThen);
  expect(await scroller(page).evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(topThen + 24);
  expect(await distanceFromBottom(page)).toBeGreaterThan(100);

  await waitForIdle(page, 30_000);
});

test("Stop during a long turn ends the run and the header returns to Idle", async ({ page }) => {
  await open(page);
  const status = page.getByTestId("nav-status");

  await send(page, "long turn");
  await expect(status).toHaveText(/^Working(?: · (?:waiting|thinking|writing|tools))?$/);
  await expect(log(page).locator(".pw-stream-cursor")).toBeVisible();

  await page.getByTestId("chat-stop").click();

  await expect(status).toHaveText("Idle", { timeout: 10_000 });
  await expect(page.getByTestId("chat-stop")).toHaveCount(0);
  await expect(log(page).locator(".pw-stream-cursor")).toHaveCount(0);
  await waitForIdle(page);

  // The pane still works after a stop.
  const pongs = await log(page).getByText("pong", { exact: true }).count();
  await send(page, "ping");
  await expect(log(page).getByText("pong", { exact: true })).toHaveCount(pongs + 1);
});

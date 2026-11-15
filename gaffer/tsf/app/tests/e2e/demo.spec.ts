/**
 * Acceptance demo, steps 1 to 3 (spec 12): the empty factory loads in PW Neon, `ping` is answered, the page prompt fills
 * the tree and opens a page, and a reload rebuilds all of it from the snapshot. The four steps share one factory and
 * build on each other, so they run serially.
 */
import { expect, test, type Page } from "@playwright/test";
import { EXPLAIN_PROMPT } from "../fixtures/faux-demo.ts";
import { send, waitForIdle } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

/** The tree and the focus view as the demo expects them after the explain prompt. */
async function expectDemoPages(): Promise<void> {
  const tree = page.getByTestId("page-tree");
  for (const name of ["Languages", "Python", "TypeScript", "Rust"]) {
    await expect(tree.getByText(name, { exact: true }).first()).toBeVisible();
  }
  await expect(tree.getByText("Basics", { exact: true })).toHaveCount(3);
  await expect(page.getByTestId("focus-view").getByRole("heading", { name: "Python basics" })).toBeVisible();
}

test("1. load: neon theme, both panes, Start Here selected", async () => {
  await page.goto("/");
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
  const glow = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--pw-ai-glow").trim());
  expect(glow, "--pw-ai-glow is set on :root by the inlined Neon glass theme").not.toBe("");
  await expect(page.getByTestId("pane-left")).toBeVisible();
  await expect(page.getByTestId("pane-right")).toBeVisible();
  await expect(page.getByTestId("page-tree").getByText("Start Here")).toBeVisible();
  await expect(page.getByTestId("focus-view").getByRole("heading", { name: "Start Here" })).toBeVisible();
});

test("2. ping: the agent answers pong", async () => {
  const replies = page.getByTestId("chat-log").getByText("pong", { exact: true });
  await waitForIdle(page);
  const before = await replies.count();
  await send(page, "ping");
  await expect(replies).toHaveCount(before + 1);
  await expect(replies.last()).toBeVisible();
  await waitForIdle(page);
});

test("3. explain prompt: folders, three pages, Python page in focus", async () => {
  await send(page, EXPLAIN_PROMPT);
  await expectDemoPages();
  await waitForIdle(page);
  await expect(page.getByTestId("chat-log").getByText(/opened the Python one/)).toBeVisible();
});

test("4. reload: chat, tree and focus come back from the snapshot", async () => {
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
  const log = page.getByTestId("chat-log");
  // agent.spec shares the factory and may have sent `ping` too, so look for at least one reply.
  await expect(log.getByText("pong", { exact: true }).last()).toBeVisible();
  // Earlier specs may leave `create_page` in closed argument/result details (hidden), so match the step's visible tool label.
  await expect(log.locator(".pw-activity-name code", { hasText: /^create_page$/ }).first()).toBeVisible();
  await expectDemoPages();
});

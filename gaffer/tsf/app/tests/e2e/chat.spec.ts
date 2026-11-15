/**
 * The chat features imported from the chat feature package: status words in the top bar, Stop on the collapsed rail,
 * the browser tab, Copy on code blocks, tool steps and answers, the model line, Jump to latest, find, history, Escape,
 * queued messages with cancel, and the tidy tool card. All on faux.
 */
import { expect, test, type Page } from "@playwright/test";
import { api, send, waitForIdle } from "./helpers.ts";
import { openApp, resetUi } from "./ui-helpers.ts";

const WORKING = /^Working · (?:waiting|thinking|writing|tools)$/;
const log = (page: Page) => page.getByTestId("chat-log");
const box = (page: Page) => page.getByTestId("composer").locator("textarea");

async function clipboard(page: Page): Promise<string> {
  return await page.evaluate(() => navigator.clipboard.readText());
}

async function stopAndIdle(page: Page): Promise<void> {
  await api("/api/chat/stop", {});
  await waitForIdle(page);
}

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await resetUi();
  await openApp(page);
});

test.afterEach(async () => {
  await api("/api/chat/stop", {});
  await waitForIdle();
  await resetUi();
});

test("the top bar status names what the agent does; the tab leads with it and names the page and factory", async ({ page }) => {
  const status = page.getByTestId("navbar-global").getByTestId("nav-status");
  await expect(status).toHaveText("Idle");
  await api("/api/pages/select", { path: "Start Here.md" });
  await expect(page).toHaveTitle(/^Start Here · \S/);

  await send(page, "long turn");
  await expect(status).toHaveText(WORKING);
  await expect(status).toHaveAttribute("data-state", "working");
  await expect(status).toHaveAttribute("title", /^The agent is /);
  await expect(page).toHaveTitle(/^Working · (?:waiting|thinking|writing|tools) — Start Here · /);

  await page.getByTestId("chat-stop").click();
  await expect(status).toHaveText("Idle", { timeout: 10_000 });
  await expect(page).toHaveTitle(/^Start Here · /);
});

test("Stop takes the Send button's place while the agent works, then Send comes back", async ({ page }) => {
  const composer = page.getByTestId("composer");
  const sendButton = composer.getByRole("button", { name: "Send" });
  await expect(sendButton).toBeVisible();
  await expect(page.getByTestId("chat-stop")).toHaveCount(0);

  await send(page, "long turn");
  const stop = composer.getByTestId("chat-stop");
  await expect(stop).toBeVisible();
  await expect(sendButton).toBeHidden();
  await expect(page.getByTestId("agent-header").getByTestId("chat-stop")).toHaveCount(0);
  // The button lines up with the text of a one-line message box.
  const mid = async (sel: string) => composer.locator(sel).evaluate((e) => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; });
  expect(Math.abs((await mid(".pw-composer-input")) - (await mid('[data-testid="chat-stop"]')))).toBeLessThanOrEqual(1);

  await stop.click();
  await waitForIdle(page);
  await expect(page.getByTestId("chat-stop")).toHaveCount(0);
  await expect(sendButton).toBeVisible();
  expect(Math.abs((await mid(".pw-composer-input")) - (await mid('button[type="submit"]')))).toBeLessThanOrEqual(1);
});

test("the collapsed rail says what the agent does and can stop it", async ({ page }) => {
  await page.getByTestId("collapse-right").click();
  await expect(page.getByTestId("rail-stop")).toHaveCount(0);
  await expect(page.getByTestId("rail-agent-state")).toHaveAttribute("aria-label", "The agent is idle");

  // The composer is in the hidden pane, so the turn is sent through the API.
  await api("/api/chat/send", { text: "long turn", requestId: `rail-${Date.now()}` });
  await expect(page.getByTestId("rail-agent-state")).toHaveAttribute("aria-label", /^The agent is (?:waiting|thinking|writing|running)/);
  await page.getByTestId("rail-stop").click();
  await expect(page.getByTestId("rail-agent-state")).toHaveAttribute("data-state", "idle", { timeout: 10_000 });
  await expect(page.getByTestId("rail-stop")).toHaveCount(0);
});

test("an answer shows its model and time, and copies as Markdown", async ({ page }) => {
  await send(page, "ping");
  await waitForIdle(page);
  const meta = log(page).getByTestId("answer-meta").last();
  await expect(meta).toContainText(/faux/);
  await expect(meta).toHaveAttribute("title", /^faux: .*tokens in/);
  await meta.getByTestId("copy-answer").click();
  await expect(meta.getByTestId("copy-answer")).toHaveText("Copied");
  expect(await clipboard(page)).toBe("pong");
});

test("a code block in a page copies its code from a button shown on hover", async ({ page }) => {
  const path = `Copy test ${Date.now()}.md`;
  await api("/api/pages/create", { path, content: "# Copy\n\n```sh\nnpm test\necho done\n```\n" });
  await api("/api/pages/select", { path });
  const block = page.getByTestId("page-content").locator(".tsf-copy-block");
  const button = block.getByTestId("copy-block");
  await expect(button).toHaveCSS("opacity", "0");
  await block.hover();
  await expect(button).toHaveCSS("opacity", "1");
  await button.click();
  expect(await clipboard(page)).toBe("npm test\necho done");
  await api("/api/pages/delete", { path });
});

test("a tool step drops a leading cd from its note and copies its whole command and result", async ({ page }) => {
  await send(page, 'probe bash {"command":"cd . && echo copied-result"}');
  await waitForIdle(page);
  const step = log(page).locator(".pw-activity-step").last();
  await expect(step.locator(".pw-activity-status")).toHaveText("echo copied-result");
  await step.locator("summary").click();
  await step.getByTestId("copy-tool-args").click();
  expect(await clipboard(page)).toBe("cd . && echo copied-result");
  await step.getByTestId("copy-tool-result").click();
  expect(await clipboard(page)).toContain("copied-result");
});

test("Jump to latest appears when scrolled away and follows the agent again", async ({ page }) => {
  await send(page, "long turn");
  const scroller = log(page).locator('[role="log"]');
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(300);
  await expect(page.getByTestId("chat-jump")).toHaveCount(0);
  await log(page).hover();
  await page.mouse.wheel(0, -4_000);
  const jump = page.getByTestId("chat-jump");
  await expect(jump).toBeVisible();
  await expect(jump).toHaveText(/^Jump to latest/);
  await jump.click();
  await expect(jump).toHaveCount(0);
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(24);
  await stopAndIdle(page);
});

test("the find box narrows the transcript to matches, counts them, and Escape clears it", async ({ page }) => {
  await send(page, "ping");
  await waitForIdle(page);
  const find = page.getByLabel("Find in the conversation");
  await find.fill("PONG");
  await expect(page.getByTestId("chat-find-count")).toHaveText(/^\d+ of \d+ (?:loaded )?entr(?:y|ies) match(?:es)?\.$/);
  await expect(log(page).locator(".pw-msg-user")).toHaveCount(0);
  await expect(log(page).locator(".pw-msg-assistant").last()).toContainText("pong");

  await find.fill("no-such-words-anywhere");
  await expect(page.getByTestId("chat-find-count")).toHaveText(/^No (?:loaded )?entry holds "no-such-words-anywhere"\./);
  await expect(page.getByTestId("chat-empty")).toHaveCount(0);

  await find.press("Escape");
  await expect(find).toHaveValue("");
  await expect(page.getByTestId("chat-find-count")).toHaveCount(0);
});

test("↑ and ↓ recall sent messages and keep the draft; Escape leaves the box so hotkeys work", async ({ page }) => {
  await send(page, "ping");
  await waitForIdle(page);
  await box(page).fill("my draft");
  await expect(page.getByTestId("composer-history")).toHaveCount(0);
  await box(page).press("ArrowUp");
  await expect(box(page)).toHaveValue("ping");
  await expect(page.getByTestId("composer-history")).toHaveText(/^Earlier message \d+ of \d+/);
  await box(page).press("ArrowDown");
  await expect(box(page)).toHaveValue("my draft");
  await box(page).fill("");
  await expect(page.getByTestId("composer-history")).toHaveText("↑ recalls your last message");

  await box(page).focus();
  await box(page).press("Escape");
  await expect(box(page)).not.toBeFocused();
  await page.keyboard.press("]");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-right", "closed");
});

test("Escape leaves the page editor only while the draft is untouched", async ({ page }) => {
  await api("/api/pages/select", { path: "Start Here.md" });
  await page.getByTestId("page-edit").click();
  const editor = page.getByTestId("page-editor");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);

  await page.getByTestId("page-edit").click();
  await editor.press("End");
  await editor.pressSequentially(" changed");
  await editor.press("Escape");
  await expect(editor).toBeVisible();
  await page.getByTestId("page-cancel").click();
});

test("queued messages show above the composer and one can be taken back", async ({ page }) => {
  await send(page, "long turn");
  await expect(page.getByTestId("nav-status")).toHaveText(WORKING);
  await send(page, "first queued\nsecond line");
  await send(page, "ping");
  const rows = page.getByTestId("queued-item");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Queued");
  await expect(rows.first().locator(".tsf-queued-text")).toHaveText("first queued");
  await expect(rows.first().locator(".tsf-queued-text")).toHaveAttribute("title", "first queued\nsecond line");
  await expect(page.getByTestId("queued-note")).toHaveText("2 messages wait for the agent to finish its turn.");
  // Queued messages are no longer duplicated in the transcript.
  await expect(log(page).getByText("first queued", { exact: true })).toHaveCount(0);

  await rows.first().getByTestId("queued-cancel").click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("ping");
  await expect(page.getByTestId("nav-status")).toHaveText(WORKING);
  await stopAndIdle(page);
  await expect(page.getByTestId("chat-queued")).toHaveCount(0);
});

test("the agent pane stays inside its width when narrow", async ({ page }) => {
  await api("/api/ui-config/update", { patch: { panes: { right: { width: 240 } } } });
  await send(page, "long turn");
  await send(page, "a queued message that is long enough to need cutting in a narrow pane for sure");
  await expect(page.getByTestId("queued-item")).toHaveCount(1);
  await log(page).hover();
  await page.mouse.wheel(0, -4_000);
  await expect(page.getByTestId("chat-jump")).toBeVisible();
  const pane = page.getByTestId("agent-pane");
  const overflow = await pane.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const paneBox = (await pane.boundingBox())!;
  for (const id of ["chat-jump", "chat-queued", "chat-find"]) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.x, id).toBeGreaterThanOrEqual(paneBox.x - 1);
    expect(b.x + b.width, id).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
  }
  await stopAndIdle(page);
});

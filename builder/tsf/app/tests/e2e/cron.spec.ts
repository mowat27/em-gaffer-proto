/**
 * P6 cron panel (spec 8.6; acceptance 9): R opens the panel, a cron created there fires on its own while no browser is
 * open (the one real slot wait in the suite), and the reopened page shows the new pages and the "Cron: <name>" chat
 * item. Edit, enable switch, run now, delete with confirm and the agent's tools (`probe create_cron`, `probe list_crons`)
 * are checked on one page with no reload. Crons that are not under test use a schedule that never fires (1 January).
 */
import { expect, test, type Page } from "@playwright/test";
import { CRON_PROMPT } from "../fixtures/faux-demo.ts";
import { LANGUAGES } from "../fixtures/faux-pages.ts";
import type { CronEntry, FolderNode, PageTree } from "../../src/shared/types.ts";
import { api, send, waitForIdle } from "./helpers.ts";
import { openApp, resetUi, stillLoaded } from "./ui-helpers.ts";

test.describe.configure({ mode: "serial" });

const NEVER = "0 0 1 1 *";
const modal = (page: Page) => page.getByTestId("cron-modal");
const row = (page: Page, name: string) => page.locator('[data-testid="cron-row"]', { has: page.locator(`[data-testid="cron-row-name"]`, { hasText: name }) });

async function removeAllCrons(): Promise<void> {
  for (const c of await api<CronEntry[]>("/api/cron")) await api("/api/cron/delete", { id: c.id });
}

/** Pages under Languages/<folder> for every language. */
async function languagePages(): Promise<Record<string, string[]>> {
  const tree = await api<PageTree>("/api/pages");
  const languages = tree.children.find((n): n is FolderNode => n.kind === "folder" && n.path === "Languages");
  const out: Record<string, string[]> = {};
  for (const l of LANGUAGES) {
    const f = languages?.children.find((n): n is FolderNode => n.kind === "folder" && n.path === `Languages/${l.folder}`);
    out[l.folder] = (f?.children ?? []).filter((n) => n.kind === "page").map((n) => n.path);
  }
  return out;
}

async function createViaUi(page: Page, name: string, expr: string, prompt: string): Promise<void> {
  await modal(page).getByTestId("cron-new").click();
  await page.getByTestId("cron-name").fill(name);
  await page.getByTestId("cron-expr").fill(expr);
  await page.getByTestId("cron-prompt").fill(prompt);
  await page.getByTestId("cron-save").click();
  await expect(row(page, name)).toBeVisible();
}

test.beforeAll(async () => {
  await removeAllCrons();
  for (const p of ["Languages", ...LANGUAGES.map((l) => `Languages/${l.folder}`)]) await api("/api/pages/create-folder", { path: p }).catch(() => undefined);
});
test.afterAll(async () => {
  await removeAllCrons();
  await resetUi();
});

test("9. R, a per-minute cron fires with the browser closed, reopen shows the pages and the cron item", async ({ browser }) => {
  test.setTimeout(180_000);
  const name = "Concept adder";
  let page = await browser.newPage();
  await openApp(page);
  await page.keyboard.press("r");
  await expect(modal(page)).toBeVisible();
  await expect(modal(page).getByText("No cron prompts")).toBeVisible();
  const before = await languagePages();
  await createViaUi(page, name, "* * * * *", CRON_PROMPT);
  await expect(row(page, name).getByTestId("cron-next")).not.toHaveText("paused");
  await expect(page.getByTestId("open-cron")).toContainText("(1)");
  await page.keyboard.press("Escape");
  await expect(modal(page)).toHaveCount(0);

  // Close the browser: the slot fires on the server alone.
  await page.close();
  await expect
    .poll(
      async () => {
        const now = await languagePages();
        return LANGUAGES.every((l) => now[l.folder]!.length > before[l.folder]!.length);
      },
      { timeout: 75_000, intervals: [1000] },
    )
    .toBe(true);
  // Stop it firing again before anything else runs.
  const [entry] = await api<CronEntry[]>("/api/cron");
  await api("/api/cron/update", { id: entry!.id, enabled: false });
  await waitForIdle();

  page = await browser.newPage();
  await openApp(page);
  const item = page.getByTestId("chat-log").getByText(`Cron: ${name}`).first();
  await expect(item).toBeVisible();
  await page.getByTestId("open-cron").click();
  await expect(row(page, name).getByTestId("cron-last")).not.toHaveText("never");
  await page.close();
});

test.describe("panel actions on one page", () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    await removeAllCrons();
    page = await browser.newPage();
    await openApp(page);
  });
  test.afterAll(async () => {
    await page.close();
  });

  test("the cron_status button opens the panel, Escape closes it, R is ignored while typing", async () => {
    await page.getByTestId("open-cron").click();
    await expect(modal(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal(page)).toHaveCount(0);
    const box = page.getByTestId("composer").locator("textarea");
    await box.click();
    await page.keyboard.type("r");
    await expect(modal(page)).toHaveCount(0);
    await box.fill("");
    await page.getByTestId("agent-pane").click({ position: { x: 4, y: 4 } });
  });

  test("create validates, then lists name, expression, prompt, next and last run", async () => {
    await page.getByTestId("open-cron").click();
    await modal(page).getByTestId("cron-new").click();
    await page.getByTestId("cron-save").click();
    await expect(page.getByTestId("cron-form").getByText(/required/)).toBeVisible();
    await page.getByTestId("cron-name").fill("Nightly");
    await page.getByTestId("cron-expr").fill("not a cron");
    await page.getByTestId("cron-prompt").fill("ping");
    await page.getByTestId("cron-save").click();
    await expect(page.getByTestId("cron-form").getByRole("alert")).toBeVisible();
    await page.getByTestId("cron-expr").fill(NEVER);
    await page.getByTestId("cron-save").click();
    const r = row(page, "Nightly");
    await expect(r).toBeVisible();
    await expect(r.getByTestId("cron-row-expr")).toHaveText(NEVER);
    await expect(r.getByTestId("cron-row-prompt")).toHaveText("ping");
    await expect(r.getByTestId("cron-next")).not.toHaveText("paused");
    await expect(r.getByTestId("cron-last")).toHaveText("never");
    await expect(page.getByTestId("open-cron")).toContainText("(1)");
    expect(await stillLoaded(page)).toBe(true);
  });

  test("edit changes the prompt in the list", async () => {
    await row(page, "Nightly").getByTestId("cron-edit").click();
    await page.getByTestId("cron-prompt").fill("tool demo");
    await page.getByTestId("cron-save").click();
    await expect(row(page, "Nightly").getByTestId("cron-row-prompt")).toHaveText("tool demo");
    const [e] = await api<CronEntry[]>("/api/cron");
    expect(e!.prompt).toBe("tool demo");
  });

  test("the switch disables and enables; the widget count follows", async () => {
    const r = row(page, "Nightly");
    await r.getByTestId("cron-enabled").click();
    await expect(r).toHaveAttribute("data-enabled", "false");
    await expect(r.getByTestId("cron-next")).toHaveText("paused");
    expect((await api<CronEntry[]>("/api/cron"))[0]!.enabled).toBe(false);
    await r.getByTestId("cron-enabled").click();
    await expect(r).toHaveAttribute("data-enabled", "true");
  });

  test("run now puts a Cron item in the chat and the agent answers", async () => {
    await row(page, "Nightly").getByTestId("cron-run-now").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-log").getByText("Cron: Nightly").first()).toBeVisible();
    await expect(page.getByTestId("chat-log").getByText("listed", { exact: true }).last()).toBeVisible();
    await waitForIdle(page);
    await page.getByTestId("open-cron").click();
    await expect(row(page, "Nightly").getByTestId("cron-last")).not.toHaveText("never");
  });

  test("the agent creates and lists crons through its tools, and the open panel updates", async () => {
    // The panel is still open from the last test; it is modal, so the composer is reached after closing it. The agent
    // adds the entry while the panel is closed, and the list shows it when reopened (the state is live either way).
    await page.keyboard.press("Escape");
    await expect(modal(page)).toHaveCount(0);
    await send(page, 'probe create_cron {"name":"Agent made","expr":"0 0 1 1 *","prompt":"ping"}');
    await waitForIdle(page);
    await page.getByTestId("open-cron").click();
    await expect(row(page, "Agent made")).toBeVisible();
    await page.keyboard.press("Escape");
    await send(page, "probe list_crons {}");
    await waitForIdle(page);
    await expect(page.getByTestId("chat-log").locator(".pw-activity-name code", { hasText: /^list_crons$/ }).last()).toBeVisible();
    // The panel open while the agent changes the list shows the change at once.
    await page.getByTestId("open-cron").click();
    await api("/api/cron/create", { name: "Live add", expr: NEVER, prompt: "ping" });
    await expect(row(page, "Live add")).toBeVisible();
    await api("/api/cron/delete", { id: (await api<CronEntry[]>("/api/cron")).find((c) => c.name === "Live add")!.id });
    await expect(row(page, "Live add")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("delete asks first; cancel keeps it, confirm removes it", async () => {
    await page.getByTestId("open-cron").click();
    const r = row(page, "Agent made");
    await r.getByTestId("cron-delete").click();
    await expect(page.getByRole("alertdialog").or(page.getByRole("dialog")).getByText(/Delete cron prompt "Agent made"/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(r).toBeVisible();
    await r.getByTestId("cron-delete").click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.locator('[data-testid="cron-row"][data-name="Agent made"]')).toHaveCount(0);
    expect((await api<CronEntry[]>("/api/cron")).map((c) => c.name)).toEqual(["Nightly"]);
    await expect(page.getByTestId("open-cron")).toContainText("(1)");
    expect(await stillLoaded(page)).toBe(true);
  });
});

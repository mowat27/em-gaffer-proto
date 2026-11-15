/**
 * Lot I: the page tree (left) and the focus view (centre), against the real factory on faux. Every test works inside
 * its own folder `e2e-pages-<n>` and removes it afterwards; the shared factory ends each test with Start Here open.
 */
import { expect, test, type Locator, type Page as BrowserPage } from "@playwright/test";
import { api } from "./helpers.ts";

interface ApiPage {
  path: string;
  content: string;
  version: string;
}

let counter = 0;
let dir = "";

test.beforeEach(() => {
  counter += 1;
  dir = `e2e-pages-${Date.now()}-${counter}`;
});

test.afterEach(async () => {
  await api("/api/pages/delete", { path: dir, recursive: true }).catch(() => undefined);
  await api("/api/pages/select", { path: "Start Here.md" }).catch(() => undefined);
});

async function open(page: BrowserPage): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("page-tree")).toBeVisible();
}

const pageRow = (page: BrowserPage, path: string): Locator => page.locator(`li[data-kind="page"][data-path="${path}"]`);
const folderRow = (page: BrowserPage, path: string): Locator => page.locator(`li[data-kind="folder"][data-path="${path}"]`);

test("create a folder and a page from the tree: it appears and is focused", async ({ page }) => {
  await open(page);

  await page.getByTestId("new-folder").click();
  await page.getByTestId("dialog-new-folder-input").fill(dir);
  await page.getByTestId("dialog-new-folder-submit").click();
  await expect(folderRow(page, dir)).toBeVisible();

  // The tree opens the new page dialog inside the folder that was just made.
  await page.getByTestId("new-page").click();
  await expect(page.getByTestId("dialog-new-page-input")).toHaveValue(`${dir}/`);
  await page.getByTestId("dialog-new-page-input").fill(`${dir}/Hello`);
  await page.getByTestId("dialog-new-page-submit").click();

  const path = `${dir}/Hello.md`;
  await expect(pageRow(page, path)).toBeVisible();
  await expect(pageRow(page, path).getByTestId("tree-page")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("focus-view")).toHaveAttribute("data-path", path);
  await expect(page.getByTestId("page-content").getByRole("heading", { name: "Hello" })).toBeVisible();
});

test("a name the server refuses stays in the dialog with its message", async ({ page }) => {
  await open(page);
  await page.getByTestId("new-page").click();
  await page.getByTestId("dialog-new-page-input").fill("Start Here");
  await page.getByTestId("dialog-new-page-submit").click();
  await expect(page.getByTestId("dialog-new-page").getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("dialog-new-page-input")).toBeVisible();
});

test("edit and save: the focus updates", async ({ page }) => {
  const path = `${dir}/Edit.md`;
  await api("/api/pages/create", { path, content: "# Before\n\nold words\n" });
  await api("/api/pages/select", { path });
  await open(page);
  await expect(page.getByTestId("page-content")).toContainText("old words");

  await page.getByTestId("page-edit").click();
  await expect(page.getByTestId("page-editor")).toHaveValue("# Before\n\nold words\n");
  await page.getByTestId("page-editor").fill("# After\n\nnew words\n");
  await page.getByTestId("page-save").click();

  await expect(page.getByTestId("page-editor")).toHaveCount(0);
  await expect(page.getByTestId("page-content").getByRole("heading", { name: "After" })).toBeVisible();
  await expect(page.getByTestId("page-content")).toContainText("new words");
  const saved = await api<ApiPage>(`/api/pages/read?path=${encodeURIComponent(path)}`);
  expect(saved.content).toBe("# After\n\nnew words\n");
});

test("an unsaved edit survives a reload", async ({ page }) => {
  const path = `${dir}/Draft.md`;
  await api("/api/pages/create", { path, content: "# Draft\n" });
  await api("/api/pages/select", { path });
  await open(page);

  await page.getByTestId("page-edit").click();
  await page.getByTestId("page-editor").fill("# Draft\n\nnot saved yet");
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");

  await expect(page.getByTestId("page-editor")).toHaveValue("# Draft\n\nnot saved yet");
  // The file itself did not change.
  const onDisk = await api<ApiPage>(`/api/pages/read?path=${encodeURIComponent(path)}`);
  expect(onDisk.content).toBe("# Draft\n");

  await page.getByTestId("page-cancel").click();
  await expect(page.getByTestId("page-editor")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("page-content")).toBeVisible();
  await expect(page.getByTestId("page-editor")).toHaveCount(0);
});

test("a change made by someone else while editing offers the newer version", async ({ page }) => {
  const path = `${dir}/Race.md`;
  await api("/api/pages/create", { path, content: "# Race\n\nfirst\n" });
  await api("/api/pages/select", { path });
  await open(page);

  await page.getByTestId("page-edit").click();
  await page.getByTestId("page-editor").fill("# Race\n\nmine\n");
  await api("/api/pages/update", { path, content: "# Race\n\nagent version\n" });

  const stale = page.getByTestId("page-stale");
  await expect(stale).toBeVisible();
  await expect(stale).toContainText("changed while you were editing");
  await stale.getByRole("button", { name: "Load the newer version" }).click();
  await expect(page.getByTestId("page-editor")).toHaveValue("# Race\n\nagent version\n");
  await expect(stale).toHaveCount(0);
});

test("a save from a stale draft is refused; keeping my version then saves", async ({ page }) => {
  const path = `${dir}/Stale.md`;
  await api("/api/pages/create", { path, content: "# Stale\n\none\n" });
  await api("/api/pages/select", { path });
  await open(page);

  await page.getByTestId("page-edit").click();
  await page.getByTestId("page-editor").fill("# Stale\n\nmine\n");
  await page.reload();
  await expect(page.getByTestId("page-editor")).toHaveValue("# Stale\n\nmine\n");
  await api("/api/pages/update", { path, content: "# Stale\n\ntheirs\n" });
  await expect(page.getByTestId("page-stale")).toBeVisible();

  // Saving as is sends the old baseVersion: the server refuses it and the file keeps the newer text.
  await page.getByTestId("page-save").click();
  await expect(page.getByTestId("focus-view").getByText("the page changed since you read it")).toBeVisible();
  const refused = await api<ApiPage>(`/api/pages/read?path=${encodeURIComponent(path)}`);
  expect(refused.content).toBe("# Stale\n\ntheirs\n");
  await expect(page.getByTestId("page-editor")).toHaveValue("# Stale\n\nmine\n");

  // Keep my version: the draft is rebased on the newer page, and saving then succeeds.
  await page.getByTestId("page-stale").getByRole("button", { name: "Keep my version" }).click();
  await page.getByTestId("page-save").click();
  await expect(page.getByTestId("page-editor")).toHaveCount(0);
  const saved = await api<ApiPage>(`/api/pages/read?path=${encodeURIComponent(path)}`);
  expect(saved.content).toBe("# Stale\n\nmine\n");
});

test("a page created through the API appears with no reload", async ({ page }) => {
  await open(page);
  const path = `${dir}/FromApi.md`;
  await expect(pageRow(page, path)).toHaveCount(0);
  await api("/api/pages/create", { path, content: "# From the API\n" });
  await expect(pageRow(page, path)).toBeVisible();
});

test("selecting from the API moves the focus", async ({ page }) => {
  const a = `${dir}/A.md`;
  const b = `${dir}/B.md`;
  await api("/api/pages/create", { path: a, content: "# Alpha page\n" });
  await api("/api/pages/create", { path: b, content: "# Bravo page\n" });
  await api("/api/pages/select", { path: a });
  await open(page);
  await expect(page.getByTestId("page-content").getByRole("heading", { name: "Alpha page" })).toBeVisible();

  await api("/api/pages/select", { path: b });
  await expect(page.getByTestId("focus-view")).toHaveAttribute("data-path", b);
  await expect(page.getByTestId("page-content").getByRole("heading", { name: "Bravo page" })).toBeVisible();
  await expect(pageRow(page, b).getByTestId("tree-page")).toHaveAttribute("aria-current", "page");
  await expect(pageRow(page, a).getByTestId("tree-page")).not.toHaveAttribute("aria-current", "page");
});

test("clicking a page in the tree focuses it", async ({ page }) => {
  const a = `${dir}/Click.md`;
  await api("/api/pages/create", { path: a, content: "# Click me\n" });
  await open(page);
  await pageRow(page, a).getByTestId("tree-page").click();
  await expect(page.getByTestId("focus-view")).toHaveAttribute("data-path", a);
  await expect(page.getByTestId("page-content").getByRole("heading", { name: "Click me" })).toBeVisible();
  const selection = await api<{ path: string; by: string }>("/api/pages/select", { path: a });
  expect(selection.path).toBe(a);
});

test("move a page: the selection follows", async ({ page }) => {
  const from = `${dir}/Old name.md`;
  const to = `${dir}/Sub/New name.md`;
  await api("/api/pages/create", { path: from, content: "# Moving\n" });
  await api("/api/pages/select", { path: from });
  await open(page);
  await expect(page.getByTestId("focus-view")).toHaveAttribute("data-path", from);

  await pageRow(page, from).getByRole("button", { name: "Rename or move Old name" }).click();
  await expect(page.getByTestId("dialog-move-input")).toHaveValue(`${dir}/Old name`);
  await page.getByTestId("dialog-move-input").fill(`${dir}/Sub/New name`);
  await page.getByTestId("dialog-move-submit").click();

  await expect(pageRow(page, to)).toBeVisible();
  await expect(pageRow(page, from)).toHaveCount(0);
  await expect(page.getByTestId("focus-view")).toHaveAttribute("data-path", to);
  await expect(page.getByTestId("page-content").getByRole("heading", { name: "Moving" })).toBeVisible();
});

test("delete with confirm clears the focus and shows the empty state", async ({ page }) => {
  const path = `${dir}/Doomed.md`;
  await api("/api/pages/create", { path, content: "# Doomed\n" });
  await api("/api/pages/select", { path });
  await open(page);
  await expect(page.getByTestId("focus-view")).toHaveAttribute("data-path", path);

  // Cancel first: nothing is deleted.
  await pageRow(page, path).getByRole("button", { name: "Delete Doomed" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText('Delete page "Doomed"?');
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(pageRow(page, path)).toBeVisible();

  await pageRow(page, path).getByRole("button", { name: "Delete Doomed" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete page" }).click();

  await expect(pageRow(page, path)).toHaveCount(0);
  await expect(page.getByTestId("focus-empty")).toBeVisible();
  await expect(page.getByTestId("focus-empty")).toContainText("No page open");
  await expect(page.getByTestId("focus-empty")).toContainText("Pick a page on the left, or ask the agent to open one.");
});

test("deleting a folder removes the pages inside it", async ({ page }) => {
  const path = `${dir}/Inner.md`;
  await api("/api/pages/create", { path, content: "# Inner\n" });
  await open(page);
  await expect(folderRow(page, dir)).toBeVisible();

  await folderRow(page, dir).getByRole("button", { name: `Delete ${dir}` }).click();
  await expect(page.getByRole("dialog")).toContainText("1 page");
  await page.getByRole("dialog").getByRole("button", { name: "Delete folder" }).click();
  await expect(folderRow(page, dir)).toHaveCount(0);
});

test("Open Start Here selects it", async ({ page }) => {
  await api("/api/pages/unselect", {});
  await open(page);
  await expect(page.getByTestId("focus-empty")).toBeVisible();

  await page.getByRole("button", { name: "Open Start Here" }).click();
  await expect(page.getByTestId("focus-view")).toHaveAttribute("data-path", "Start Here.md");
  await expect(page.getByTestId("focus-empty")).toHaveCount(0);
  await expect(page.getByTestId("page-content")).toBeVisible();
});

test("close returns to the empty state; a collapsed folder stays collapsed after a reload", async ({ page }) => {
  const path = `${dir}/Fold.md`;
  await api("/api/pages/create", { path, content: "# Fold\n" });
  await api("/api/pages/select", { path });
  await open(page);
  await expect(pageRow(page, path)).toBeVisible();

  await page.getByTestId("focus-close").click();
  await expect(page.getByTestId("focus-empty")).toBeVisible();

  await folderRow(page, dir).getByTestId("tree-folder").click();
  await expect(pageRow(page, path)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
  await expect(folderRow(page, dir)).toBeVisible();
  await expect(pageRow(page, path)).toHaveCount(0);

  // Selecting a page inside a collapsed folder opens the folder again.
  await api("/api/pages/select", { path });
  await expect(pageRow(page, path)).toBeVisible();
});

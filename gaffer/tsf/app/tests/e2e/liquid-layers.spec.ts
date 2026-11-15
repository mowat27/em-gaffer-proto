/**
 * Liquid layers (P9, spec 8.4 and 8.7; DESIGN 8 and 11): from Settings alone, create a project layer, define the model
 * picker widget from the example button, place it in the agent navbar, use it, write a prompt section with the file
 * editor, then delete the layer and find no widget, section or placement left. Nothing reloads the page. The factory
 * is shared, so the layer is deleted at the end even when the test fails.
 */
import { expect, test, type Page } from "@playwright/test";
import type { LayerInfo } from "../../src/shared/types.ts";
import { api } from "./helpers.ts";
import { openApp, resetUi, stillLoaded } from "./ui-helpers.ts";

test.describe.configure({ mode: "serial" });

const LAYER = "extras";
const COPY = "extras_copy";
const modal = (page: Page) => page.getByTestId("settings-modal");

async function cleanup(): Promise<void> {
  const layers = await api<LayerInfo[]>("/api/layers");
  for (const name of [LAYER, COPY]) if (layers.some((l) => l.name === name)) await api("/api/layers/delete", { name });
  await resetUi();
}

test.beforeEach(cleanup);
test.afterEach(cleanup);

async function openSettings(page: Page, section: "essentials" | "core4" | "advanced", tab: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("s");
  await expect(modal(page)).toBeVisible();
  await page.getByTestId(`tab-${section}`).click();
  await page.getByTestId(`tab-${tab}`).click();
}

test("liquid layers: create a layer, a model picker and a prompt section from Settings, then delete the layer", async ({ page }) => {
  await openApp(page);
  const models = await api<{ id: string; name: string }[]>("/api/models");
  expect(models.length).toBeGreaterThan(0);

  // Create the layer in Advanced > Layers.
  await openSettings(page, "advanced", "layers");
  await expect(page.getByTestId("settings-block")).toContainText("Factory name");
  await expect(page.getByTestId("settings-model")).not.toBeEmpty();
  await page.getByTestId("layer-new").click();
  await page.getByTestId("layer-new-name").fill(LAYER);
  await page.getByTestId("layer-new-title").fill("Extras");
  await page.getByTestId("layer-new-description").fill("Widgets and prompt text added from the settings.");
  await page.getByTestId("layer-new-submit").click();
  await expect(page.getByTestId(`layer-${LAYER}`)).toBeVisible();
  await expect(page.getByTestId(`layer-${LAYER}`)).toHaveAttribute("data-status", "loaded");

  // Define the model picker with the example button, in the layer just made.
  await page.getByTestId("tab-essentials").click();
  await page.getByTestId("tab-layout").click();
  await page.getByTestId("widget-define-layer").selectOption(LAYER);
  await page.getByTestId("widget-define-example").click();
  await expect(page.getByTestId("widget-define-suffix")).toHaveValue("model_picker");
  // The example sorts by label and groups by the id prefix before "/"; the faux ids have none, so group by provider.
  await expect(page.getByTestId("widget-define-oq-group")).toHaveValue("prefix:/");
  await page.getByTestId("widget-define-oq-group").fill("field:provider");
  await page.getByTestId("widget-define-submit").click();
  await expect(page.getByTestId("widget-define-note")).toContainText(`${LAYER}.model_picker`);
  await expect(page.getByTestId(`widget-type-${LAYER}.model_picker`)).toBeVisible();

  // Add it to the agent navbar.
  await page.getByTestId("layout-add-navbar").selectOption("agent");
  await page.getByTestId("layout-add-widget").selectOption(`${LAYER}.model_picker`);
  await page.getByTestId("layout-add-submit").click();
  const widget = page.getByTestId("navbar-agent").locator(`[data-layer="${LAYER}"]`);
  await expect(widget).toHaveCount(1);
  const select = widget.locator("select");
  await expect(select).toBeVisible();
  // The options are the models list; "Choose" shows while no model is stored (the settings model is null by default).
  for (const m of models) await expect(select.locator("option", { hasText: m.name })).toHaveCount(1);
  // Grouping renders <optgroup> elements, one per provider.
  await expect(select.locator("optgroup")).toHaveCount(new Set(models.map((m) => (m as unknown as { provider: string }).provider)).size);
  await expect(select.locator("optgroup").first()).toHaveAttribute("label", "faux");

  // Choose a model: the select, the Core 4 model panel and the status route agree.
  await select.selectOption(models[models.length - 1]!.id);
  await expect(select).toHaveValue(models[models.length - 1]!.id);
  await expect.poll(async () => (await api<{ model: { modelId: string } }>("/api/status")).model.modelId).toBe(models[models.length - 1]!.id);
  await page.getByTestId("tab-core4").click();
  await page.getByTestId("tab-model").click();
  await expect(page.locator(`[data-testid="model-row"][data-model="${models[models.length - 1]!.id}"]`)).toHaveAttribute("data-current", "true");

  // Write a prompt section with the file editor.
  await page.getByTestId("tab-advanced").click();
  await page.getByTestId("tab-layers").click();
  await page.getByTestId(`author-files-toggle-${LAYER}`).click();
  await page.getByTestId(`author-newfile-path-${LAYER}`).fill("prompts/house_style.md");
  await page.getByTestId(`author-newfile-create-${LAYER}`).click();
  const read = page.waitForResponse((r) => r.url().includes("/api/layers/read-file") && r.ok());
  await page.getByTestId(`author-file-${LAYER}-prompts/house_style.md`).click();
  await read;
  await expect(page.getByTestId(`author-editor-text-${LAYER}`)).toBeVisible();
  await page.getByTestId(`author-editor-text-${LAYER}`).fill("Write in short plain sentences.\n");
  await page.getByTestId(`author-file-save-${LAYER}`).click();
  await expect(page.getByTestId(`author-files-note-${LAYER}`)).toContainText("Saved");

  // The layer row shows its version and origin.
  await page.getByTestId("tab-advanced").click();
  await page.getByTestId("tab-layers").click();
  await expect(page.getByTestId(`layer-version-${LAYER}`)).toHaveText("v0.1.0");
  await expect(page.getByTestId(`layer-origin-${LAYER}`)).toHaveText("local");

  // Export the layer: the archive is reported and downloadable.
  await page.getByTestId(`author-export-${LAYER}`).click();
  const exported = page.getByTestId(`author-exported-${LAYER}`);
  await expect(exported).toContainText(`${LAYER}-0.1.0.tgz`);
  const download = page.waitForEvent("download");
  await page.getByTestId(`author-export-download-${LAYER}`).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${LAYER}-0.1.0.tgz`);
  const res = await fetch(new URL(`/api/layers/export-file?file=${LAYER}-0.1.0.tgz`, page.url()));
  expect(res.status).toBe(200);
  expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
  const path = (await exported.locator("code").textContent())!;

  // Import it back: under its own name is refused (taken); under another name it loads with renamed widget ids.
  await page.getByTestId("layer-import").click();
  await page.getByTestId("layer-import-source").fill(path);
  await page.getByTestId("layer-import-submit").click();
  await expect(page.getByTestId("layer-import-error")).toContainText("already exists");
  await page.getByTestId("layer-import-name").fill(COPY);
  await page.getByTestId("layer-import-submit").click();
  await expect(page.getByTestId("layer-import-note")).toContainText(`Imported ${COPY} 0.1.0`);
  await expect(page.getByTestId(`layer-${COPY}`)).toHaveAttribute("data-status", "loaded");
  // Importing the same name again needs replace.
  await page.getByTestId("layer-import-source").fill(path);
  await page.getByTestId("layer-import-name").fill(COPY);
  await page.getByTestId("layer-import-submit").click();
  await expect(page.getByTestId("layer-import-error")).toContainText("replace");
  await page.getByTestId("layer-import-replace").click();
  await page.getByTestId("layer-import-submit").click();
  await expect(page.getByTestId("layer-import-note")).toContainText(`Imported ${COPY}`);
  const widgets = await api<{ available: { widget: string }[] }>("/api/widgets");
  expect(widgets.available.map((w) => w.widget)).toContain(`${COPY}.model_picker`);

  // The section lists in Core 4 > Prompts with no page reload.
  await page.getByTestId("tab-core4").click();
  await page.getByTestId("tab-prompts").click();
  await expect(page.getByTestId("prompt-sections")).toContainText(`${LAYER}-house_style`);
  expect(await stillLoaded(page)).toBe(true);

  // Delete the layer: widget type, placement, navbar widget and section all go.
  await page.getByTestId("tab-advanced").click();
  await page.getByTestId("tab-layers").click();
  await page.getByTestId(`author-delete-${LAYER}`).click();
  await page.getByRole("button", { name: "Delete layer" }).last().click();
  await expect(page.getByTestId(`layer-${LAYER}`)).toHaveCount(0);
  await expect(widget).toHaveCount(0);
  await page.getByTestId("tab-core4").click();
  await page.getByTestId("tab-prompts").click();
  await expect(page.getByTestId("prompt-sections")).not.toContainText(`${LAYER}-house_style`);
  const list = await api<{ placements: { widget: string }[]; types?: { id: string }[] }>("/api/widgets");
  expect(JSON.stringify(list)).not.toContain(`${LAYER}.model_picker`);
  expect(await stillLoaded(page)).toBe(true);
});

/**
 * Uploads: the Pages pane's Upload button and the pane itself as a drop target save any file into tsf/uploads, and the
 * Import layer form uploads an archive and fills its path. All on faux.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { LayerInfo } from "../../src/shared/types.ts";
import { api, projectRoot } from "./helpers.ts";
import { openApp, resetUi } from "./ui-helpers.ts";

const LAYER = "upload_src";
const COPY = "upload_copy";
const uploaded = (name: string): string => join(projectRoot(), "tsf", "uploads", name);
const unique = (base: string): string => `${base}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function cleanupLayers(): Promise<void> {
  const layers = await api<LayerInfo[]>("/api/layers");
  for (const name of [LAYER, COPY]) if (layers.some((l) => l.name === name)) await api("/api/layers/delete", { name });
}

/** Drag files onto `target` the way a browser does: dragenter and dragover, then (unless `drop` is false) drop. */
async function dragFiles(page: Page, target: Locator, files: { name: string; text: string }[], drop = true): Promise<void> {
  const data = await page.evaluateHandle((list) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([f.text], f.name));
    return dt;
  }, files);
  await target.dispatchEvent("dragenter", { dataTransfer: data });
  await target.dispatchEvent("dragover", { dataTransfer: data });
  if (drop) await target.dispatchEvent("drop", { dataTransfer: data });
}

test.beforeEach(async ({ page }) => {
  await resetUi();
  await cleanupLayers();
  await openApp(page);
});
test.afterEach(async () => {
  await cleanupLayers();
  await resetUi();
});

test("the Upload button saves any file into tsf/uploads and numbers a taken name", async ({ page }) => {
  const name = `${unique("photo")}.png`;
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 1]);
  const button = page.getByTestId("upload-file");
  await expect(button).toBeVisible();
  await expect(button).toHaveAccessibleName("Upload files to tsf/uploads");
  await page.getByTestId("upload-file-input").setInputFiles({ name, mimeType: "image/png", buffer: bytes });
  await expect(page.getByText(`Uploaded ${name}`)).toBeVisible();
  await expect(page.getByText(`Saved as tsf/uploads/${name}.`)).toBeVisible();
  expect(readFileSync(uploaded(name))).toEqual(bytes);

  // The same name again is kept beside the first, never over it.
  await page.getByTestId("upload-file-input").setInputFiles({ name, mimeType: "image/png", buffer: Buffer.from("second") });
  const second = name.replace(/\.png$/, " (2).png");
  await expect(page.getByText(`Uploaded ${second}`)).toBeVisible();
  expect(readFileSync(uploaded(name))).toEqual(bytes);
  expect(readFileSync(uploaded(second), "utf8")).toBe("second");
});

test("files dropped on the Pages pane are uploaded, with words while they hover", async ({ page }) => {
  const tree = page.getByTestId("page-tree");
  const [a, b] = [`${unique("notes")}.txt`, `${unique("data")}.csv`];
  await dragFiles(page, tree, [{ name: a, text: "x" }], false);
  await expect(tree).toHaveAttribute("data-dragging", "true");
  await expect(tree.locator(".tsf-drop-overlay")).toHaveText("Drop files to upload them to tsf/uploads");
  await tree.dispatchEvent("dragleave", { dataTransfer: await page.evaluateHandle(() => { const dt = new DataTransfer(); dt.items.add(new File(["x"], "x")); return dt; }) });
  await expect(tree).toHaveAttribute("data-dragging", "false");

  await dragFiles(page, tree, [{ name: a, text: "alpha" }, { name: b, text: "1,2\n" }]);
  await expect(page.getByText("Uploaded 2 files")).toBeVisible();
  await expect(tree.locator(".tsf-drop-overlay")).toHaveCount(0);
  expect(readFileSync(uploaded(a), "utf8")).toBe("alpha");
  expect(readFileSync(uploaded(b), "utf8")).toBe("1,2\n");
});

test("the Upload button is a drop target too", async ({ page }) => {
  const name = `${unique("dropped")}.bin`;
  const target = page.locator(".tsf-upload").filter({ has: page.getByTestId("upload-file") });
  await dragFiles(page, target, [{ name, text: "z" }], false);
  await expect(target).toHaveAttribute("data-dragging", "true");
  await expect(target).toHaveCSS("outline-style", "dashed");
  // Only the button lights up, not the pane it sits above.
  await expect(page.getByTestId("page-tree")).toHaveAttribute("data-dragging", "false");
  await target.dispatchEvent("drop", { dataTransfer: await page.evaluateHandle((n) => { const dt = new DataTransfer(); dt.items.add(new File(["z"], n)); return dt; }, name) });
  await expect(page.getByText(`Uploaded ${name}`)).toBeVisible();
  expect(existsSync(uploaded(name))).toBe(true);
  // The pane underneath did not take the same drop again.
  expect(existsSync(uploaded(name.replace(/\.bin$/, " (2).bin")))).toBe(false);
});

test("Import layer takes an uploaded archive: Upload file fills the path, and a drop on the form does the same", async ({ page }) => {
  await api("/api/layers/create", { name: LAYER, title: "Upload source", description: "A layer to export and import back." });
  const exported = await api<{ file: string }>("/api/layers/export", { name: LAYER });
  const archive = Buffer.from(await (await fetch(new URL(`/api/layers/export-file?file=${exported.file}`, page.url()))).arrayBuffer());
  const name = `${unique("layer")}.tgz`;

  await page.keyboard.press("s");
  await page.getByTestId("tab-advanced").click();
  await page.getByTestId("tab-layers").click();
  await page.getByTestId("layer-import").click();
  const form = page.getByTestId("layer-import-form");
  await expect(form.getByTestId("layer-import-upload")).toHaveText("Upload file");
  await form.getByTestId("layer-import-upload-input").setInputFiles({ name, mimeType: "application/gzip", buffer: archive });
  await expect(page.getByTestId("layer-import-source")).toHaveValue(`tsf/uploads/${name}`);
  await expect(page.getByTestId("layer-import-note")).toHaveText(`Uploaded to tsf/uploads/${name}. Choose Import to install it.`);
  await page.getByTestId("layer-import-name").fill(COPY);
  await page.getByTestId("layer-import-submit").click();
  await expect(page.getByTestId("layer-import-note")).toContainText(`Imported ${COPY} 0.1.0`);
  await expect(page.getByTestId(`layer-${COPY}`)).toHaveAttribute("data-status", "loaded");

  // A drop on the form uploads too and fills the path.
  const dropped = `${unique("dropped-layer")}.tgz`;
  const data = await page.evaluateHandle(
    ({ n, bytes }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], n, { type: "application/gzip" }));
      return dt;
    },
    { n: dropped, bytes: [...archive] },
  );
  await form.dispatchEvent("dragenter", { dataTransfer: data });
  await expect(form.locator(".tsf-drop-overlay")).toHaveText("Drop a layer archive to upload it");
  await form.dispatchEvent("drop", { dataTransfer: data });
  await expect(page.getByTestId("layer-import-source")).toHaveValue(`tsf/uploads/${dropped}`);
  expect(readFileSync(uploaded(dropped))).toEqual(archive);
});

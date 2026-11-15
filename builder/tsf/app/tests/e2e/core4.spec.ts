/**
 * P5 Core 4 and Advanced (spec 8.4, 8.5; acceptance 4, 5 and the UI half of 10): the settings modal's Context, Model,
 * Prompts and Tools panels, the quick view, and the Advanced layer stack, ceiling and runs. Agent actions are scripted
 * with the faux `probe <tool> <json>` rule. Every change is checked on the page that made it with no reload. The factory
 * is shared, so each test puts tools, thinking, prompts and compaction back.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { CeilingInfo, LayerInfo, Settings, ToolInfo } from "../../src/shared/types.ts";
import { makeProject } from "../helpers/project.ts";
import { api, send, waitForIdle } from "./helpers.ts";
import { openApp, resetUi, stillLoaded } from "./ui-helpers.ts";

test.describe.configure({ mode: "serial" });

const CODING = ["read", "write", "edit", "bash"] as const;
const modal = (page: Page) => page.getByTestId("settings-modal");
const log = (page: Page) => page.getByTestId("chat-log");

/** Put everything this file changes back to the defaults. */
async function reset(): Promise<void> {
  const tools = await api<ToolInfo[]>("/api/tools");
  for (const t of tools.filter((x) => !x.enabled)) await api("/api/tools/set-enabled", { name: t.name, enabled: true });
  for (const l of await api<LayerInfo[]>("/api/layers")) if (!l.enabled) await api("/api/layers/set-enabled", { name: l.name, enabled: true });
  await api("/api/thinking/set", { level: "low" });
  await api("/api/compaction/set", { enabled: true, background: 200_000, forced: 500_000, keepRecentTokens: 20_000 });
  await api("/api/prompts/runtime/clear", {});
  await api("/api/prompts/system", { text: null });
  const prompts = await api<{ custom?: { id: string }[] }>("/api/prompts");
  for (const c of prompts.custom ?? []) await api("/api/prompts/custom/delete", { id: c.id });
}

test.beforeEach(async ({ page }) => {
  await reset();
  await resetUi();
  await openApp(page);
});
test.afterEach(async () => {
  await reset();
});

/** Run one scripted agent call and wait for the turn to finish. */
async function probe(page: Page, tool: string, args: unknown): Promise<void> {
  const done = log(page).getByText("probe done", { exact: true });
  const n = await done.count();
  await send(page, `probe ${tool} ${JSON.stringify(args)}`);
  await expect(done).toHaveCount(n + 1);
  await waitForIdle(page);
}

/** Open settings with the hotkey (the composer keeps focus after a send, so blur it first) and pick a tab. */
async function openSettings(page: Page, section: "core4" | "advanced", tab: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("s");
  await expect(modal(page)).toBeVisible();
  await page.getByTestId(`tab-${section}`).click();
  await page.getByTestId(`tab-${tab}`).click();
  await expect(page.getByTestId(`panel-${tab}`)).toBeVisible();
}

const toggle = (page: Page, name: string) => page.getByTestId(`tool-toggle-${name}`);

test("acceptance 4: the agent lists its tools", async ({ page }) => {
  const steps = log(page).locator(".pw-activity-step").filter({ has: page.locator("code", { hasText: /^list_tools$/ }) });
  const n = await steps.count();
  await probe(page, "list_tools", {});
  await expect(steps).toHaveCount(n + 1);
  await expect(steps.last()).toContainText("List tools");
  // The tool ran: a call to a tool that is not registered would show as failed.
  await expect(steps.last()).toHaveAttribute("data-status", "done");
});

test("acceptance 5 through the agent: four tools off and thinking max show in settings", async ({ page }) => {
  for (const name of CODING) await probe(page, "set_tool_enabled", { name, enabled: false });
  await probe(page, "set_thinking_level", { level: "max" });

  await openSettings(page, "core4", "tools");
  for (const name of CODING) await expect(toggle(page, name)).toHaveAttribute("data-state", "unchecked");
  await expect(toggle(page, "list_pages")).toHaveAttribute("data-state", "checked");
  await page.getByTestId("tab-model").click();
  await expect(page.getByTestId("thinking-select")).toHaveValue("max");
  await expect(page.getByTestId("thinking-current")).toHaveAttribute("data-level", "max");
  expect(await stillLoaded(page)).toBe(true);
});

test("acceptance 5 through the UI: toggles and the thinking select", async ({ page }) => {
  await openSettings(page, "core4", "tools");
  for (const name of CODING) {
    await toggle(page, name).click();
    await expect(toggle(page, name)).toHaveAttribute("data-state", "unchecked");
  }
  await expect
    .poll(async () => (await api<ToolInfo[]>("/api/tools")).filter((t) => CODING.includes(t.name as never) && !t.enabled).length)
    .toBe(4);
  await expect(page.getByTestId("tool-read")).toHaveAttribute("data-offered", "false");

  await page.getByTestId("tab-model").click();
  await page.getByTestId("thinking-select").selectOption("max");
  await expect.poll(async () => (await api<Settings>("/api/settings")).thinkingLevel).toBe("max");
  await expect(page.getByTestId("thinking-current")).toHaveAttribute("data-level", "max");

  // The agent changes it back while the modal is open: the page follows with no reload.
  await api("/api/thinking/set", { level: "low" });
  await expect(page.getByTestId("thinking-select")).toHaveValue("low");
  await page.getByTestId("tab-tools").click();
  await api("/api/tools/set-enabled", { name: "read", enabled: true });
  await expect(toggle(page, "read")).toHaveAttribute("data-state", "checked");
  expect(await stillLoaded(page)).toBe(true);
});

test("tools: the matrix is grouped by layer and the quick view switches syntax", async ({ page }) => {
  await openSettings(page, "core4", "tools");
  await expect(page.getByTestId("tool-group-coding_tools")).toBeVisible();
  await expect(page.getByTestId("tool-group-page_harness")).toBeVisible();
  await expect(page.getByTestId("tool-group-factory_controls")).toBeVisible();

  await page.getByTestId("tool-view-read").click();
  const quick = page.getByTestId("tool-quickview");
  await expect(quick).toHaveAttribute("data-tool", "read");
  await expect(page.getByTestId("tool-description")).not.toBeEmpty();
  await expect(quick).toHaveAttribute("data-syntax", "json");
  const code = page.getByTestId("tool-code");
  await expect(code).toContainText('"properties"');
  await expect(code).toContainText("path");
  const json = await code.innerText();

  await page.getByTestId("tab-typescript").click();
  await expect(quick).toHaveAttribute("data-syntax", "typescript");
  await expect(code).toContainText("path");
  await expect(code).not.toContainText('"properties"');
  expect(await code.innerText()).not.toBe(json);

  await page.getByTestId("tab-json").click();
  await expect(code).toContainText('"properties"');
  // Another tool replaces the view.
  await page.getByTestId("tool-view-list_pages").click();
  await expect(quick).toHaveAttribute("data-tool", "list_pages");
});

test("prompts: a runtime prompt is appended and removed", async ({ page }) => {
  await openSettings(page, "core4", "prompts");
  await expect(page.getByTestId("runtime-empty")).toBeVisible();
  await page.getByTestId("runtime-text").fill("Answer in one sentence.");
  await page.getByTestId("runtime-append").click();
  const items = page.getByTestId("runtime-item");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Answer in one sentence.");
  await expect(page.getByTestId("runtime-text")).toHaveValue("");

  // The agent appends one too: the open list follows.
  await api("/api/prompts/runtime/append", { text: "Prefer short names." });
  await expect(items).toHaveCount(2);

  await items.first().getByTestId("runtime-remove").click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Prefer short names.");
  await page.getByTestId("runtime-clear").click();
  await expect(page.getByTestId("runtime-empty")).toBeVisible();
  expect(await stillLoaded(page)).toBe(true);
});

test("prompts: a custom prompt is created, toggled, edited and deleted", async ({ page }) => {
  await openSettings(page, "core4", "prompts");
  await page.getByTestId("custom-new-name").fill("tone");
  await page.getByTestId("custom-new-text").fill("Be brief.");
  await page.getByTestId("custom-new-submit").click();
  const row = page.getByTestId("custom-tone");
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-enabled", "true");
  await expect(page.getByTestId("custom-new-name")).toHaveValue("");

  await page.getByTestId("custom-toggle-tone").click();
  await expect(row).toHaveAttribute("data-enabled", "false");
  await page.getByTestId("custom-toggle-tone").click();
  await expect(row).toHaveAttribute("data-enabled", "true");

  await page.getByTestId("custom-text-tone").fill("Be very brief.");
  await page.getByTestId("custom-save-tone").click();
  await expect(page.getByTestId("custom-save-tone")).toBeDisabled();
  await expect
    .poll(async () => ((await api<{ custom?: { title: string; text: string | null }[] }>("/api/prompts")).custom ?? []).find((c) => c.title === "tone")?.text)
    .toBe("Be very brief.");

  await page.getByTestId("custom-delete-tone").click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId("custom-empty")).toBeVisible();
});

test("prompts: the system prompt is overridden and restored, and an extension section is switched", async ({ page }) => {
  await openSettings(page, "core4", "prompts");
  const text = page.getByTestId("system-text");
  const original = await text.inputValue();
  expect(original.length).toBeGreaterThan(20);
  await text.fill("You are a terse factory agent.");
  await page.getByTestId("system-save").click();
  await expect(page.getByTestId("prompt-system")).toContainText("Override");
  await page.getByTestId("system-reset").click();
  await expect(page.getByTestId("prompt-system")).toContainText("Default");
  await expect(text).toHaveValue(original);

  // Extension sections: read-only text on demand, on or off per section.
  const sections = page.getByTestId("prompt-sections").locator("[data-testid^=section-toggle-]");
  expect(await sections.count()).toBeGreaterThan(0);
  const first = sections.first();
  await expect(first).toHaveAttribute("data-state", "checked");
  await first.click();
  await expect(first).toHaveAttribute("data-state", "unchecked");
  await first.click();
  await expect(first).toHaveAttribute("data-state", "checked");
  await page.getByTestId("prompt-sections").locator("[data-testid^=section-view-]").first().click();
  await expect(page.getByTestId("prompt-sections").locator("pre").first()).not.toBeEmpty();
});

test("context: the bar shows the readings and the thresholds are saved", async ({ page }) => {
  await send(page, "ping");
  await waitForIdle(page);
  await openSettings(page, "core4", "context");
  await expect(page.getByTestId("context-bar")).toBeVisible();
  await expect(page.getByTestId("context-used")).not.toHaveText("0");
  await expect(page.getByTestId("context-window")).not.toHaveText("unknown");
  await expect(page.getByTestId("context-background")).toHaveText(/\d/);
  await expect(page.getByTestId("context-forced")).toHaveText(/\d/);

  await page.getByTestId("compaction-background").fill("100000");
  await page.getByTestId("compaction-forced").fill("400000");
  await page.getByTestId("compaction-save").click();
  await expect.poll(async () => (await api<Settings>("/api/settings")).compaction).toMatchObject({ background: 100_000, forced: 400_000 });
  await expect(page.getByTestId("compaction-save")).toBeDisabled();

  // A forced point below the background point is refused before it is sent.
  await page.getByTestId("compaction-background").fill("450000");
  await page.getByTestId("compaction-save").click();
  await expect(page.getByText("Background compaction must start below the forced point.")).toBeVisible();

  await page.getByTestId("compaction-enabled").click();
  await expect.poll(async () => (await api<Settings>("/api/settings")).compaction.enabled).toBe(false);
  expect(await stillLoaded(page)).toBe(true);
});

test("context: manual compaction with instructions is accepted", async ({ page }) => {
  await send(page, "ping");
  await waitForIdle(page);
  await openSettings(page, "core4", "context");
  await page.getByTestId("compact-instructions").fill("Keep the page names.");
  const accepted = page.waitForResponse((r) => r.url().endsWith("/api/compact") && r.request().method() === "POST");
  await page.getByTestId("compact-now").click();
  expect((await accepted).status()).toBe(200);
  await expect(page.getByText("Compaction started")).toBeVisible();
});

test("model: the picker shows the current model and the list can be refreshed", async ({ page }) => {
  await openSettings(page, "core4", "model");
  const status = await api<{ model: { provider: string; modelId: string } }>("/api/status");
  const row = page.locator(`[data-testid="model-row"][data-model="${status.model.modelId}"]`);
  await expect(row).toHaveAttribute("data-current", "true");
  await expect(page.getByTestId("model-current")).toContainText(`${status.model.modelId} · ${status.model.provider}`);
  await page.getByTestId("models-refresh").click();
  await expect(page.getByTestId("models-refresh")).toBeEnabled();
  await expect(row).toHaveAttribute("data-current", "true");
});

test("advanced: layers bottom-up, toggled live, ceiling read-only, runs listed", async ({ page }) => {
  await probe(page, "list_tools", {});
  await openSettings(page, "advanced", "layers");
  const layers = await api<LayerInfo[]>("/api/layers");
  const ordered = [...layers].sort((a, b) => b.order - a.order).map((l) => l.name);
  await expect(page.getByTestId("layer-stack").locator("[data-testid^=layer-]:not([data-testid^=layer-toggle-])")).toHaveCount(ordered.length);
  expect(await page.getByTestId("layer-stack").locator("li").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))).toEqual(ordered.map((n) => `layer-${n}`));

  // A required layer cannot be switched off.
  await expect(page.getByTestId("layer-toggle-factory_harness")).toBeDisabled();
  // An optional one can, and its tools stop being offered.
  await page.getByTestId("layer-toggle-coding_tools").click();
  await expect(page.getByTestId("layer-coding_tools")).toHaveAttribute("data-enabled", "false");
  await page.getByTestId("tab-providers").click();
  await expect(page.getByTestId("provider-provider_openrouter")).toBeVisible();
  await page.getByTestId("tab-layers").click();
  await page.getByTestId("layer-toggle-coding_tools").click();
  await expect(page.getByTestId("layer-coding_tools")).toHaveAttribute("data-enabled", "true");

  await page.getByTestId("tab-ceiling").click();
  const ceiling = await api<CeilingInfo>("/api/ceiling");
  await expect(page.getByTestId("ceiling-allow")).toContainText(ceiling.allow[0]!);
  await expect(page.getByTestId("ceiling-allowed")).toContainText("coding_tools.read");
  await expect(page.getByTestId("panel-ceiling").getByRole("switch")).toHaveCount(0);

  await page.getByTestId("tab-runs").click();
  await expect(page.getByTestId("runs-table")).toBeVisible();
  const run = page.getByTestId("runs-table").locator("tbody tr").first();
  await run.getByRole("button").click();
  await expect(page.getByTestId("run-detail")).toBeVisible();
  await expect(page.getByTestId("run-tools")).toContainText("list_tools");
  expect(await stillLoaded(page)).toBe(true);
});

// --- Acceptance 10, UI half: a second factory whose permissions.json denies coding_tools.* --------------------------

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test.describe("acceptance 10: the ceiling denies coding_tools.*", () => {
  let child: ChildProcess | undefined;
  let base = "";

  test.beforeAll(async () => {
    const port = (Number(process.env.TSF_E2E_PORT) || 48731) + 1;
    const { root } = await makeProject({ permissions: { allow: ["*"], deny: ["coding_tools.*"] } });
    const resultsDir = join(appDir, "test-results");
    mkdirSync(resultsDir, { recursive: true });
    const logFile = join(resultsDir, "factory-denied.log");
    const fd = openSync(logFile, "w");
    child = spawn(process.execPath, [join(appDir, "bin", "tsf.mjs"), "start"], {
      cwd: root,
      env: { ...process.env, TSF_PROJECT: root, TSF_MODEL_PROVIDER: "faux", TSF_FAUX_RULES: join(appDir, "tests", "fixtures", "faux-demo.ts"), TSF_PORT: String(port) },
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    const deadline = Date.now() + 120_000;
    for (;;) {
      let text = "";
      try {
        text = readFileSync(logFile, "utf8");
      } catch {
        // Not written yet.
      }
      const m = /TSF running at (\S+)/.exec(text);
      if (m) {
        base = m[1]!.replace(/\/+$/, "");
        break;
      }
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the denied factory did not start\n${text.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  test.afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    rmSync(join(appDir, "test-results", "factory-denied.log"), { force: true });
  });

  const call = async <T>(path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as T };
  };

  test("the matrix has no coding tool, the agent cannot enable one and a direct call is blocked", async ({ page }) => {
    await page.goto(base);
    await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "live");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("s");
    await page.getByTestId("tab-core4").click();
    await page.getByTestId("tab-tools").click();
    await expect(page.getByTestId("tool-group-page_harness")).toBeVisible();
    await expect(page.getByTestId("tool-group-coding_tools")).toHaveCount(0);
    for (const name of CODING) await expect(page.getByTestId(`tool-${name}`)).toHaveCount(0);

    // Advanced > Ceiling lists them as denied.
    await page.getByTestId("tab-advanced").click();
    await page.getByTestId("tab-ceiling").click();
    await expect(page.getByTestId("ceiling-deny")).toContainText("coding_tools.*");
    await expect(page.getByTestId("ceiling-denied")).toContainText("coding_tools.bash");
    await page.keyboard.press("Escape");

    // The API refuses to enable a tool outside the ceiling.
    const enable = await call<{ error: { code: string } }>("/api/tools/set-enabled", { name: "bash", enabled: true });
    expect(enable.status).toBeGreaterThanOrEqual(400);
    expect(enable.status).toBeLessThan(500);
    expect((await call<ToolInfo[]>("/api/tools")).body.some((t) => t.layer === "coding_tools")).toBe(false);

    // An injected direct call is answered "blocked", naming the ceiling.
    const done = page.getByTestId("chat-log").getByText("probe done", { exact: true });
    const box = page.getByTestId("composer").locator("textarea");
    await box.fill('probe bash {"command":"echo hi"}');
    await box.press("Enter");
    const step = page.getByTestId("chat-log").locator(".pw-activity-step").filter({ has: page.locator("code", { hasText: /^bash$/ }) });
    await expect(step).toHaveCount(1);
    await expect(page.getByTestId("chat-log")).toContainText(/ceiling|blocked/i);
    await expect(done).toHaveCount(1);
  });
});

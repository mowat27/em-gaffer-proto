/**
 * Acceptance map (spec 12, DESIGN 13). The twelve acceptance steps are covered by the specs and tests below, not
 * re-run here. `ACCEPTANCE` names, for each step, the test that proves it; the first test checks that every named
 * test still exists (the file is there and holds a test with that title), so a renamed or deleted test breaks this
 * file instead of silently leaving a step uncovered. The second test is the one thing no earlier spec covered: the
 * Settings > Advanced > jev tab, answered by the `TSF_JEV_PROVIDER=faux` stub that `global-setup.ts` puts in the
 * factory's environment.
 *
 * Run all three levels with `npm run test:acceptance` (typecheck, lint:ui, unit, integration, e2e).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { api, waitForIdle } from "./helpers.ts";
import { openApp, resetUi } from "./ui-helpers.ts";

const testsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Proof {
  /** Path under `tests/`. */
  file: string;
  /** Text that must appear in a `test(`, `it(` or `describe(` title of that file. */
  title: string;
}

interface Step {
  step: number;
  level: "e2e" | "integration" | "unit";
  proofs: Proof[];
  /** What the step asks for and the test does not do literally (empty when it is literal). */
  note?: string;
}

export const ACCEPTANCE: Step[] = [
  { step: 1, level: "e2e", proofs: [{ file: "e2e/demo.spec.ts", title: "1. load" }, { file: "unit/install.test.ts", title: "prints the target first" }], note: "the harness starts the CLI directly (`node bin/tsf.mjs start`, what `just tsf start` runs); install.test.ts covers install.sh and the mod's variables" },
  { step: 2, level: "e2e", proofs: [{ file: "e2e/demo.spec.ts", title: "2. ping" }] },
  { step: 3, level: "e2e", proofs: [{ file: "e2e/demo.spec.ts", title: "3. explain prompt" }] },
  { step: 4, level: "e2e", proofs: [{ file: "e2e/core4.spec.ts", title: "acceptance 4" }] },
  { step: 5, level: "e2e", proofs: [{ file: "e2e/core4.spec.ts", title: "acceptance 5 through the agent" }, { file: "e2e/core4.spec.ts", title: "acceptance 5 through the UI" }] },
  { step: 6, level: "e2e", proofs: [{ file: "e2e/navbar.spec.ts", title: "acceptance 6" }, { file: "e2e/settings.spec.ts", title: "theme and mode change live" }] },
  { step: 7, level: "e2e", proofs: [{ file: "e2e/navbar.spec.ts", title: "acceptance 7" }] },
  { step: 8, level: "e2e", proofs: [{ file: "e2e/settings.spec.ts", title: "acceptance 8:" }, { file: "e2e/settings.spec.ts", title: "acceptance 8 through the agent" }] },
  { step: 9, level: "e2e", proofs: [{ file: "e2e/cron.spec.ts", title: "9. R, a per-minute cron fires" }] },
  { step: 10, level: "e2e", proofs: [{ file: "e2e/core4.spec.ts", title: "acceptance 10" }, { file: "unit/ceiling-guard.test.ts", title: "an injected call is blocked by afterTool" }], note: "the call is made by the faux model (`probe bash`), not injected over HTTP; ceiling-guard.test.ts also proves beforeTool through the skipCeilingFilter seam" },
  { step: 11, level: "integration", proofs: [{ file: "integration/durability.test.ts", title: "a turn killed mid-stream with SIGKILL" }, { file: "integration/durability.test.ts", title: "a bash effect killed mid-call with SIGKILL runs once" }], note: "headless: spawns the server, SIGKILLs it mid-turn, restarts it; there is no browser step" },
  { step: 12, level: "unit", proofs: [{ file: "unit/parity.test.ts", title: "every capability through phase" }], note: "headless: the parity unit test" },
];

/** The text of every `test(`, `it(` and `describe(` title (first string argument) in a source file. */
function titles(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\b(?:test|it|describe)(?:\.\w+)*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) out.push(m[2]!);
  return out;
}

test("the twelve acceptance steps each name tests that exist", () => {
  expect(ACCEPTANCE.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const problems: string[] = [];
  for (const s of ACCEPTANCE) {
    expect(s.proofs.length, `step ${s.step} has a proof`).toBeGreaterThan(0);
    for (const p of s.proofs) {
      const file = join(testsDir, p.file);
      if (!existsSync(file)) {
        problems.push(`step ${s.step}: ${p.file} does not exist`);
        continue;
      }
      if (!titles(readFileSync(file, "utf8")).some((t) => t.includes(p.title))) problems.push(`step ${s.step}: no test titled "${p.title}" in ${p.file}`);
    }
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test("Settings > Advanced > jev: one yes/no question is answered by the faux provider", async ({ page }) => {
  await resetUi();
  await openApp(page);
  // The factory was started with TSF_JEV_PROVIDER=faux, so the route answers with no key and no network.
  const direct = await api<{ kind: string; probability: number; model: string }>("/api/jev/judge", { kind: "noul", question: "Is this text polite?", state: "Thank you." });
  expect(direct).toMatchObject({ kind: "noul", model: "jev-faux" });

  await page.keyboard.press("s");
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.getByTestId("tab-advanced").click();
  await page.getByTestId("tab-jev").click();
  await expect(page.getByTestId("panel-jev")).toBeVisible();
  const judge = page.getByTestId("jev-judge");
  await expect(judge, "no text yet").toBeDisabled();
  await page.getByTestId("jev-text").fill("Thank you for your help.");
  await expect(judge).toBeEnabled();
  await judge.click();
  await expect(page.getByTestId("jev-result")).toContainText("90.0%");
  await expect(page.getByTestId("jev-result")).toContainText("jev-faux");
  await expect(page.getByTestId("jev-error")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await waitForIdle(page);
});

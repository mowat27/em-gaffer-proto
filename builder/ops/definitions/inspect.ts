#!/usr/bin/env node
/**
 * Loads a definition's code in a process of its own and prints what it found as one JSON line, so validating a change
 * never runs new code in the caller's process (an agent's pi, the CLI) and never caches a staged module there.
 *
 *   node ops/definitions/inspect.ts '<request json>'
 *
 *   { op: "builder", file }      the module's default export through validateBuilder: name, provides, steps, sidecars
 *   { op: "gate", file }         the default export is a gate (defineGate) or a list of gates
 *   { op: "listener", file }     the default export is a listener (defineListener)
 *   { op: "render", set, builderDir, partials, dispatches }
 *                                render the template set against every sample dispatch whose kind (classify) is the
 *                                set's name, with the builder's view model (view-model.ts exporting viewModelInput and
 *                                modelFor), each into an empty folder. Without a view model, every .hbs is parsed only.
 *
 * Output: `{ ok: true, ... }` or `{ ok: false, error }`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import Handlebars from "handlebars";
import { isGate } from "../../engine/gates.ts";
import { isListener } from "../../engine/listeners.ts";
import { validateBuilder } from "../../engine/load.ts";
import { classifyDispatch, type Classification } from "../../engine/steps/classify.ts";
import { renderSet } from "../../engine/templates.ts";
import type { Dispatch } from "../../engine/types.ts";

interface Request {
  op: "builder" | "gate" | "listener" | "render";
  file?: string;
  set?: string;
  builderDir?: string;
  partials?: string[];
  dispatches?: string[];
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function load(file: string): Promise<unknown> {
  return ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
}

function hbsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".hbs")) out.push(p);
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  return out.sort();
}

async function render(r: Request): Promise<Record<string, unknown>> {
  const set = r.set!;
  const kind = basename(set);
  const files = hbsFiles(set);
  // Syntax first: a template that does not parse is wrong whatever it renders.
  const parseErrors: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
    try {
      Handlebars.parse(src);
    } catch (err) {
      parseErrors.push(`${f.slice(set.length + 1)}: ${messageOf(err).split("\n")[0]}`);
    }
  }
  if (parseErrors.length) return { ok: false, error: parseErrors.join("; ") };
  const vmFile = r.builderDir ? join(r.builderDir, "view-model.ts") : "";
  const vm = vmFile && existsSync(vmFile) ? ((await import(pathToFileURL(vmFile).href)) as Record<string, unknown>) : null;
  if (!vm || typeof vm.viewModelInput !== "function" || typeof vm.modelFor !== "function") return { ok: true, templates: files.length, rendered: [], note: "no view model (view-model.ts with viewModelInput and modelFor): templates parsed only" };
  const viewModelInput = vm.viewModelInput as (c: Classification, d: Dispatch, dir: string) => unknown;
  const modelFor = vm.modelFor as (c: Classification, input: unknown) => unknown;
  const rendered: { dispatch: string; verdict: string; files: number; tasks: number }[] = [];
  const failures: string[] = [];
  for (const file of r.dispatches ?? []) {
    let d: Dispatch;
    let c: Classification;
    try {
      d = JSON.parse(readFileSync(file, "utf8")) as Dispatch;
      c = classifyDispatch(d);
    } catch {
      continue; // not a dispatch, or nothing to build
    }
    if (c.kind !== kind) continue;
    const out = mkdtempSync(join(tmpdir(), "builder-render-"));
    try {
      const data = modelFor(c, viewModelInput(c, d, out));
      const report = renderSet(set, data, { dir: out, verdict: c.verdict, ...(r.partials ? { partials: r.partials } : {}) });
      if (report.skipped) failures.push(`${basename(file)}: ${report.skipped.reason}`);
      else rendered.push({ dispatch: basename(file), verdict: c.verdict, files: report.files.length, tasks: report.tasks.length });
    } catch (err) {
      failures.push(`${basename(file)}: ${messageOf(err)}`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
  if (failures.length) return { ok: false, error: `does not render: ${failures.join("; ")}` };
  return { ok: true, templates: files.length, rendered };
}

async function main(r: Request): Promise<Record<string, unknown>> {
  switch (r.op) {
    case "builder": {
      const b = validateBuilder(await load(r.file!));
      return {
        ok: true,
        name: b.name,
        provides: b.provides,
        ...(b.budgetMinutes !== undefined ? { budgetMinutes: b.budgetMinutes } : {}),
        steps: b.steps.map((s) => ({ kind: s.kind, name: s.name, ...(s.kind === "agent" ? { agent: s.agent } : {}), ...(s.kind === "workflow" ? { builder: s.builder } : {}) })),
        listeners: b.listeners?.length ?? 0,
        sidecars: (b.sidecars ?? []).map((x) => ({ name: x.name, agent: x.agent })),
      };
    }
    case "gate": {
      const g = await load(r.file!);
      const gates = Array.isArray(g) ? g : [g];
      if (!gates.length || !gates.every(isGate)) return { ok: false, error: "its default export is not a gate (defineGate) or a list of gates" };
      return { ok: true, gates: gates.length };
    }
    case "listener": {
      const l = await load(r.file!);
      if (!isListener(l)) return { ok: false, error: "its default export is not a listener (defineListener: on and handle)" };
      return { ok: true };
    }
    case "render":
      return render(r);
  }
}

try {
  console.log(JSON.stringify(await main(JSON.parse(process.argv[2] ?? "{}") as Request)));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: messageOf(err) }));
}
process.exit(0);

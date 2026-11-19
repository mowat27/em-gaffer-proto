/**
 * Loading a builder definition: an id names agentics/builders/<id>/builder.ts, anything that looks like a path names
 * a module directly. The module's default export must be a valid Builder. A changed module is loaded afresh (its
 * modification time is part of the import URL); the modules it imports stay cached for the life of the process.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BUILDER_ROOT } from "../runtime/root.ts";
import { isListener } from "./listeners.ts";
import { isSidecar } from "./sidecars.ts";
import type { Builder } from "./types.ts";

const STEP_KINDS = ["code", "template", "agent", "workflow"];

/** True when `idOrPath` names a module file rather than a builder id. */
function isPath(idOrPath: string): boolean {
  return isAbsolute(idOrPath) || idOrPath.startsWith("./") || idOrPath.startsWith("../") || /\.(m?ts|m?js)$/.test(idOrPath);
}

export function builderModulePath(idOrPath: string): string {
  return isPath(idOrPath) ? resolve(idOrPath) : join(BUILDER_ROOT, "agentics", "builders", idOrPath, "builder.ts");
}

/** Throws with what is wrong unless `b` is a valid Builder. */
export function validateBuilder(b: unknown): Builder {
  if (!b || typeof b !== "object") throw new Error("the module's default export is not a builder object");
  const d = b as Record<string, unknown>;
  if (typeof d.name !== "string" || !d.name.trim()) throw new Error("name must be a non-empty string");
  if (!Array.isArray(d.provides) || !d.provides.every((p) => typeof p === "string")) throw new Error("provides must be a string array");
  if (d.budgetMinutes !== undefined && !(typeof d.budgetMinutes === "number" && d.budgetMinutes > 0)) throw new Error("budgetMinutes must be a positive number");
  if (!Array.isArray(d.steps) || d.steps.length === 0) throw new Error("steps must be a non-empty array");
  const names = new Set<string>();
  d.steps.forEach((s: unknown, i: number) => {
    const step = (s ?? {}) as Record<string, unknown>;
    const where = `steps[${i}]`;
    if (typeof step.kind !== "string" || !STEP_KINDS.includes(step.kind)) throw new Error(`${where}.kind must be one of ${STEP_KINDS.join(", ")}`);
    if (typeof step.name !== "string" || !/^[\w.-]+$/.test(step.name)) throw new Error(`${where}.name must be a step name (letters, digits, _ . -)`);
    if (names.has(step.name)) throw new Error(`${where}.name ${step.name} is used twice`);
    names.add(step.name);
    if (step.budgetMinutes !== undefined && !(typeof step.budgetMinutes === "number" && step.budgetMinutes > 0)) throw new Error(`${where}.budgetMinutes must be a positive number`);
    if (step.kind === "code" && typeof step.run !== "function") throw new Error(`${where} (${step.name}): a code step needs a run function`);
    if (step.kind === "template") {
      if (typeof step.set !== "function") throw new Error(`${where} (${step.name}): a template step needs a set function`);
      if (typeof step.data !== "function") throw new Error(`${where} (${step.name}): a template step needs a data function (its view model)`);
      if (step.dir !== undefined && typeof step.dir !== "function") throw new Error(`${where} (${step.name}): a template step's dir is a function that returns where it renders`);
    }
    if (step.kind === "agent") {
      if (typeof step.agent !== "string" || !step.agent) throw new Error(`${where} (${step.name}): an agent step needs an agent`);
      if (step.prompt !== undefined && typeof step.prompt !== "string" && typeof step.prompt !== "function") throw new Error(`${where} (${step.name}): an agent step's prompt is a message or a function that makes one`);
      if (step.args !== undefined && typeof step.args !== "function") throw new Error(`${where} (${step.name}): an agent step's args is a function that returns the prompt template's arguments`);
    }
    if (step.kind === "workflow" && (typeof step.builder !== "string" || !step.builder)) throw new Error(`${where} (${step.name}): a workflow step needs a builder`);
  });
  if (d.listeners !== undefined) {
    if (!Array.isArray(d.listeners)) throw new Error("listeners must be an array of listeners (defineListener)");
    d.listeners.forEach((l: unknown, i: number) => {
      if (!isListener(l)) throw new Error(`listeners[${i}] is not a listener: it needs on (an event kind) and handle (a function)`);
    });
  }
  if (d.sidecars !== undefined) {
    if (!Array.isArray(d.sidecars)) throw new Error("sidecars must be an array of sidecars (sidecar(agent, { on, every }))");
    const seen = new Set<string>();
    d.sidecars.forEach((s: unknown, i: number) => {
      if (!isSidecar(s)) throw new Error(`sidecars[${i}] is not a sidecar: make it with sidecar(agent, { on, every })`);
      if (seen.has(s.name)) throw new Error(`sidecars[${i}]: the name ${s.name} is used twice (give one a name)`);
      seen.add(s.name);
    });
  }
  return d as unknown as Builder;
}

/** Load and validate a builder. Throws with the reason when it cannot. */
export async function loadBuilder(idOrPath: string): Promise<Builder> {
  const file = builderModulePath(idOrPath);
  if (!existsSync(file)) throw new Error(`no builder module at ${file}`);
  const url = `${pathToFileURL(file).href}?mtime=${statSync(file).mtimeMs}`;
  const mod = (await import(url)) as { default?: unknown };
  return validateBuilder(mod.default);
}

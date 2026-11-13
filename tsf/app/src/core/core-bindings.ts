/**
 * Core bindings (DESIGN 8, "Core bindings"): `core:<capabilityId>` as a layer control's query or action. The Service's
 * layerQuery / layerAction hand such a name here; this runs the named capability's own Service method, so a
 * declarative layer reaches exactly what the UI and the agent already reach (principle 2) and nothing else: only
 * the `core:` names the layer's manifest declares are allowed.
 */
import { CAPABILITIES } from "../shared/capabilities.ts";
import type { Json, Origin } from "../shared/types.ts";
import { coreBindingProblem, coreId } from "../agent/layer-manifest.ts";
import { ServiceError } from "./errors.ts";
import type { FactoryService } from "./service-api.ts";

type Method = (...args: unknown[]) => unknown;

/** Mutating methods whose only argument is the origin. */
const ORIGIN_ONLY: ReadonlySet<string> = new Set(["unselectPage", "refreshModels", "clearRuntimePrompts"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function methodOf(service: FactoryService, name: string, kind: "query" | "action"): { method: Method; service: string } {
  const problem = coreBindingProblem(name, kind);
  if (problem !== null) throw new ServiceError("invalid", problem);
  const cap = CAPABILITIES.find((c) => c.id === coreId(name))!;
  const method = (service as unknown as Record<string, Method | undefined>)[cap.service];
  if (typeof method !== "function") throw new ServiceError("internal", `core capability ${cap.id} has no Service method`);
  return { method: method.bind(service), service: cap.service };
}

/** A model picker sends the model id only; the provider is found from the catalog when the id is unambiguous. */
function withProvider(service: FactoryService, input: unknown): unknown {
  if (!isRecord(input) || typeof input.provider === "string" || typeof input.modelId !== "string") return input;
  const hits = service.listModels().filter((m) => m.id === input.modelId);
  if (hits.length === 0) throw new ServiceError("not_found", `no such model: ${input.modelId}; core:models.list shows the models`);
  if (hits.length > 1) throw new ServiceError("invalid", `model id ${input.modelId} exists under several providers; send provider too`);
  return { ...input, provider: hits[0]!.provider };
}

/** Run a core query binding with `input` (the layer route's `input`, `{}` when absent). */
export async function runCoreQuery(service: FactoryService, name: string, input: Json): Promise<Json> {
  const { method, service: id } = methodOf(service, name, "query");
  const arg = id === "getRun" ? (isRecord(input) ? input.id : undefined) : input;
  return (await method(arg)) as Json;
}

/** Run a core action binding with `input` (already templated) and the caller's origin. */
export async function runCoreAction(service: FactoryService, name: string, input: Json, origin: Origin): Promise<Json> {
  const { method, service: id } = methodOf(service, name, "action");
  if (ORIGIN_ONLY.has(id)) return (await method(origin)) as Json;
  if (id === "setThinkingLevel") return (await method(isRecord(input) ? input.level : undefined, origin)) as Json;
  const arg = id === "setModel" ? withProvider(service, input) : input;
  return (await method(arg, origin)) as Json;
}

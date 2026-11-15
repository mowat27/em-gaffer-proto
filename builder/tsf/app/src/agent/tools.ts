/**
 * Tool helpers (DESIGN 7 "Tools, memo and tasks", D13). Every TSF tool is built with `defineAppTool`, which requires
 * `replay` (pi-durable defaults it to "unsafe" silently; TSF makes the author decide). Results carry the value as JSON
 * text for the model and as `details` for UIs; a `ServiceError` becomes an `isError` result the model can act on.
 * Port of the reference tools.ts to pi-durable 1.5.0 (`output` instead of `content`, pi-schema `Static`,
 * `checkpointWhen` on `defineDoc`).
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineDoc,
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionMode,
  type ToolExecutionResult,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Static } from "@earendil-works/pi-schema";
import { ServiceError } from "../core/errors.ts";

export interface AppToolSpec<P extends object, D extends JsonValue> {
  readonly name: string;
  readonly description: string;
  /** A pi-schema object (closed by default). */
  readonly parameters: P;
  /** Required: "safe" reruns after a crash (the call must be idempotent), "unsafe" runs at most once. */
  readonly replay: "safe" | "unsafe";
  readonly executionMode?: ToolExecutionMode;
  /** Returns the value; throw `ServiceError` for a failure the model can fix. */
  run(args: Static<P>, api: ToolExecutionApi<D>, ctx: Context): Promise<D>;
  /** Images to send to the model with the result (base64 `data` and a `mimeType`), for example a screenshot. */
  attach?(value: D): Promise<readonly { readonly data: string; readonly mimeType: string }[]>;
}

/** A successful result: the value as JSON text for the model and as details for the UI. */
export function toolOk<D extends JsonValue>(value: D): ToolExecutionResult<D> {
  return { output: [{ type: "text", text: JSON.stringify(value) ?? "null" }], details: value };
}

/** A failed call the model can fix: returned, not thrown, so work the call owns survives. */
export function toolErr<D extends JsonValue = JsonValue>(message: string): ToolExecutionResult<D> {
  return { isError: true, output: [{ type: "text", text: message }] };
}

export function defineAppTool<P extends object, D extends JsonValue = JsonValue>(
  spec: AppToolSpec<P, D>,
): ToolRegistration<P, D> {
  if (spec.replay !== "safe" && spec.replay !== "unsafe") {
    throw new Error(`tool ${String(spec.name)} must declare replay: "safe" or "unsafe"`);
  }
  const { run, ...rest } = spec;
  return defineTool<P, D>({
    name: rest.name,
    description: rest.description,
    parameters: rest.parameters,
    replay: rest.replay,
    ...(rest.executionMode ? { executionMode: rest.executionMode } : {}),
    async execute(args, api, ctx) {
      try {
        const value = await run(args as Static<P>, api, ctx);
        const result = toolOk(value);
        if (!rest.attach) return result;
        let images: Awaited<ReturnType<NonNullable<typeof rest.attach>>> = [];
        try {
          images = await rest.attach(value);
        } catch {
          // The JSON result stands without the image.
        }
        return { ...result, output: [...(result.output ?? []), ...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))] };
      } catch (err) {
        if (err instanceof ServiceError) return toolErr<D>(err.message);
        throw err;
      }
    },
  });
}

/**
 * Run `fn` once per tool call and key across replays: the result is kept in the call's durable task memo. A crash
 * between the effect and the memo repeats the effect, so the effect must also be idempotent (a unique key).
 */
export async function once<T extends JsonValue>(
  api: Pick<ToolExecutionApi, "memo">,
  key: string,
  ctx: Context,
  fn: () => Promise<T>,
): Promise<T> {
  const done = await api.memo<T>(key, ctx);
  if (done !== undefined) return done;
  return api.memo<T>(key, await fn(), ctx);
}

/** Task-scoped receipt: the effect and its record commit together. */
export const TaskReceipt = defineDoc<{ value: JsonValue }>({
  kind: "tsf.receipt",
  version: 1,
  scope: "task",
  initial: () => ({ value: null }),
  checkpointWhen: () => false,
});

/**
 * Run `fn` inside one commit at most once per tool task, for effects that are themselves commits (an entry, a task, a
 * document). A replay after a crash returns the stored value instead of committing again.
 */
export async function onceInCommit<T extends JsonValue>(
  api: Pick<ToolExecutionApi, "commit" | "taskId">,
  ctx: Context,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return api.commit(async (tx) => {
    const receipt = await tx.doc(TaskReceipt, api.taskId);
    if (receipt.value !== null) return receipt.value as T;
    const value = await fn(tx);
    receipt.value = value;
    return value;
  }, ctx);
}

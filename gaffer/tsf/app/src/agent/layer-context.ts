/**
 * What a layer's factories receive (DESIGN 8, D5). `service`, `settings` and `ceiling` are getters: their values exist
 * only after the factories ran (T26). Factories only capture them; tools and hooks call them at execute time.
 * `pi` re-exports the pi-durable and pi-schema builders, so a project layer needs only `import type` and resolves no
 * packages from the host project (T15).
 */
import type { Context } from "@earendil-works/chord";
import type { Provider } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  hook,
  section,
  ToolTask,
  wrapSection,
  type Extension,
} from "@earendil-works/pi-durable";
import * as schema from "@earendil-works/pi-schema";
import { ServiceError } from "../core/errors.ts";
import type { Logger } from "../core/log.ts";
import type { ProjectPaths } from "../core/paths.ts";
import type { PromptReader } from "../core/prompts.ts";
import type { FactoryService } from "../core/service-api.ts";
import type { AppBus } from "../shared/events.ts";
import type { JevInput, JevVerdict, Json, ModelInfo, Origin, Settings } from "../shared/types.ts";
import type { ModelCacheStore } from "./models.ts";
import { defineAppTool, toolErr, toolOk } from "./tools.ts";

/** The permissions ceiling as the guard and the Service read it (agent/ceiling.ts implements it from P2). */
export interface CeilingView {
  /** `layer.tool` is inside the ceiling. */
  allows(layer: string, tool: string): boolean;
  /** The tool name (looked up in the tool map) is inside the ceiling. */
  allowsName(tool: string): boolean;
  layerOf(tool: string): string | undefined;
  /** The tool map knows the name and the verdict is deny (the guard's `afterTool` uses it). */
  isDenied(tool: string): boolean;
}

/** P1: everything is allowed (no permissions.json is read before P2). */
export const ALLOW_ALL: CeilingView = Object.freeze({
  allows: () => true,
  allowsName: () => true,
  layerOf: () => undefined,
  isDenied: () => false,
});

/** The builders a layer may use without importing packages (T15). */
export interface PiKit {
  readonly defineExtension: typeof defineExtension;
  readonly defineTool: typeof defineTool;
  readonly section: typeof section;
  readonly hook: typeof hook;
  readonly wrapSection: typeof wrapSection;
  readonly ToolTask: typeof ToolTask;
  readonly defineAppTool: typeof defineAppTool;
  readonly toolOk: typeof toolOk;
  readonly toolErr: typeof toolErr;
  /** pi-schema builders. */
  readonly obj: typeof schema.obj;
  readonly str: typeof schema.str;
  readonly num: typeof schema.num;
  readonly int: typeof schema.int;
  readonly bool: typeof schema.bool;
  readonly arr: typeof schema.arr;
  readonly opt: typeof schema.opt;
  readonly oneOf: typeof schema.oneOf;
  readonly lit: typeof schema.lit;
  readonly union: typeof schema.union;
  readonly nullable: typeof schema.nullable;
  readonly nul: typeof schema.nul;
  readonly map: typeof schema.map;
  readonly tuple: typeof schema.tuple;
  readonly bytes: typeof schema.bytes;
  readonly unknown: typeof schema.unknown;
}

export const PI_KIT: PiKit = Object.freeze({
  defineExtension,
  defineTool,
  section,
  hook,
  wrapSection,
  ToolTask,
  defineAppTool,
  toolOk,
  toolErr,
  obj: schema.obj,
  str: schema.str,
  num: schema.num,
  int: schema.int,
  bool: schema.bool,
  arr: schema.arr,
  opt: schema.opt,
  oneOf: schema.oneOf,
  lit: schema.lit,
  union: schema.union,
  nullable: schema.nullable,
  nul: schema.nul,
  map: schema.map,
  tuple: schema.tuple,
  bytes: schema.bytes,
  unknown: schema.unknown,
});

export interface LayerContext {
  /** Bound after createService (DESIGN 3 step 10); throws ServiceError("unavailable") before. */
  readonly service: () => FactoryService;
  readonly paths: ProjectPaths;
  readonly log: Logger;
  readonly bus: AppBus;
  /** Defined once the layers are loaded (DESIGN 3 step 6). */
  readonly settings: () => Settings;
  /** The registry's frozen ceiling; ALLOW_ALL in P1. */
  readonly ceiling: () => CeilingView;
  readonly modelCache: ModelCacheStore;
  /** The custom prompts (prompt layer 2) as `factory_harness` renders them; read at render time (P5). */
  readonly prompts: () => PromptReader;
  /** spec 7.4; wired in P7, throws ServiceError("unavailable") before. */
  readonly jev: (input: JevInput, ctx: Context) => Promise<JevVerdict>;
  readonly pi: PiKit;
}

/** A layer's own queries and actions (DESIGN 8 "Layer handlers and UI"); unused before P4. */
export interface LayerHandlers {
  readonly queries?: Record<string, (input: Json, ctx: Context) => Promise<Json> | Json>;
  readonly actions?: Record<
    string,
    { readonly replay: "safe" | "unsafe"; run(input: Json, origin: Origin, ctx: Context): Promise<Json> }
  >;
}

/** A provider layer's model source (D2). */
export interface ProviderLayer {
  readonly provider: Provider;
  /** Fetch the live list; never rejects (a failure keeps the cached or shipped list). */
  refresh(signal: AbortSignal): Promise<void>;
  models(): ModelInfo[];
}

/** What `layers/<name>/extension.ts` exports. */
export interface LayerModule {
  createExtension(ctx: LayerContext): Extension;
  createProvider?(ctx: LayerContext): ProviderLayer;
  createHandlers?(ctx: LayerContext): LayerHandlers;
}

/** The `jev` stub (kept for tests that build a LayerContext by hand; the app wires `jevJudge`, P7). */
export const jevUnavailable = async (_input: JevInput, _ctx: Context): Promise<JevVerdict> => {
  throw new ServiceError("unavailable", "jev is not wired in this context");
};

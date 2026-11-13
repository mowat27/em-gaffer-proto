/**
 * The web client for the factory's HTTP API (DESIGN 5). Every command is a POST with `content-type: application/json`
 * (the API's request guard refuses anything else); reads are GET. Non-2xx answers throw `ApiError` with the server's
 * `{ error: { code, message } }`. State does not come back through these calls: the SSE stream carries every change
 * (state/store.ts), so callers only need the result for errors and ids.
 */
import type { DeleteResult, EarlierPage, MoveResult, SendResult, UpdatePageInput } from "../../core/service-api.ts";
import type {
  ApiError as ApiErrorBody,
  CronEntry,
  CompactionPoints,
  CreateLayerInput,
  ExportLayerResult,
  RebuildWebResult,
  RestartResult,
  ScreenshotInput,
  ScreenshotResult,
  ImportLayerInput,
  ImportLayerResult,
  DefineWidgetResult,
  DeleteLayerFileResult,
  DeleteLayerResult,
  LayerFileContent,
  LayerFileList,
  LayerInfo,
  Settings,
  UndefineWidgetResult,
  WidgetContribution,
  WriteLayerFileResult,
  JevInput,
  JevVerdict,
  FolderNode,
  Json,
  ModelInfo,
  ModelRef,
  ModeValues,
  NavbarId,
  NavbarSlot,
  Page,
  PagePath,
  RunDetail,
  RunSummary,
  Selection,
  ThemeCheck,
  ThinkingLevel,
  UiConfig,
  UiConfigPatch,
  WidgetOptions,
} from "../../shared/types.ts";

export type ApiErrorCode = ApiErrorBody["error"]["code"];

export class ApiError extends Error {
  /** HTTP status; 0 when the factory could not be reached. */
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const CODES: readonly ApiErrorCode[] = ["invalid", "not_found", "conflict", "busy", "forbidden", "too_large", "unavailable", "upstream", "internal"];

function codeFor(status: number): ApiErrorCode {
  if (status === 400 || status === 415) return "invalid";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 503) return "unavailable";
  if (status === 502) return "upstream";
  return "internal";
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: method === "POST" ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch {
    throw new ApiError(0, "unavailable", "The factory is not reachable. Check that it is running.");
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const err = (parsed as Partial<ApiErrorBody> | undefined)?.error;
    const code = err && CODES.includes(err.code) ? err.code : codeFor(res.status);
    const message = err && typeof err.message === "string" && err.message !== "" ? err.message : `The request failed (HTTP ${res.status}).`;
    throw new ApiError(res.status, code, message);
  }
  return parsed as T;
}

const get = <T>(path: string): Promise<T> => request<T>("GET", path);
const post = <T>(path: string, body?: unknown): Promise<T> => request<T>("POST", path, body);

/** A request id for chat sends. `crypto.randomUUID` needs a secure context, so plain http on a LAN address falls back. */
export function newRequestId(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Not a secure context.
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A seed or token value as the theme routes take it: one colour, or one per mode. */
export type ThemeValues = { readonly [name: string]: ModeValues<string> | string | number | null };

export const api = {
  chat: {
    /** POST /api/chat/send. Pass the same `requestId` to retry a send without submitting it twice. */
    send(text: string, mode?: "followUp" | "steer", requestId: string = newRequestId()): Promise<SendResult> {
      return post<SendResult>("/api/chat/send", { text, requestId, ...(mode ? { mode } : {}) });
    },
    /** POST /api/chat/stop. */
    stop(): Promise<{ stopped: boolean }> {
      return post<{ stopped: boolean }>("/api/chat/stop", {});
    },
    /** GET /api/chat/earlier: items with entry ids below `before`. */
    earlier(before: number, limit = 50): Promise<EarlierPage> {
      return get<EarlierPage>(`/api/chat/earlier?before=${encodeURIComponent(String(before))}&limit=${limit}`);
    },
  },
  pages: {
    read(path: PagePath): Promise<Page> {
      return get<Page>(`/api/pages/read?path=${encodeURIComponent(path)}`);
    },
    create(path: PagePath, content?: string): Promise<Page> {
      return post<Page>("/api/pages/create", { path, ...(content !== undefined ? { content } : {}) });
    },
    update(input: UpdatePageInput): Promise<Page> {
      return post<Page>("/api/pages/update", input);
    },
    move(from: PagePath, to: PagePath): Promise<MoveResult> {
      return post<MoveResult>("/api/pages/move", { from, to });
    },
    remove(path: PagePath, recursive?: boolean): Promise<DeleteResult> {
      return post<DeleteResult>("/api/pages/delete", { path, ...(recursive !== undefined ? { recursive } : {}) });
    },
    mkdir(path: PagePath): Promise<FolderNode> {
      return post<FolderNode>("/api/pages/create-folder", { path });
    },
    select(path: PagePath): Promise<Selection> {
      return post<Selection>("/api/pages/select", { path });
    },
    unselect(): Promise<Selection> {
      return post<Selection>("/api/pages/unselect", {});
    },
  },
  uiConfig: {
    /** POST /api/ui-config/update: a JSON Merge Patch. Without `baseVersion` the last writer wins (pane drags). */
    update(patch: UiConfigPatch, baseVersion?: number): Promise<UiConfig> {
      return post<UiConfig>("/api/ui-config/update", { patch, ...(baseVersion !== undefined ? { baseVersion } : {}) });
    },
  },
  /** P4. Each mutation answers with the new UI config; the SSE `ui_config.changed` carries it to every page too. */
  widgets: {
    add(input: { navbar: NavbarId; widget: string; slot: NavbarSlot; index?: number; options?: WidgetOptions }): Promise<unknown> {
      return post("/api/widgets/add", input);
    },
    remove(id: string): Promise<unknown> {
      return post("/api/widgets/remove", { id });
    },
    move(input: { id: string; navbar?: NavbarId; slot?: NavbarSlot; index: number }): Promise<unknown> {
      return post("/api/widgets/move", input);
    },
    options(id: string, options: WidgetOptions): Promise<unknown> {
      return post("/api/widgets/options", { id, options });
    },
  },
  hotkeys: {
    set(action: string, key: string): Promise<unknown> {
      return post("/api/hotkeys/set", { action, key });
    },
  },
  themes: {
    set(name: string, mode?: "light" | "dark" | "system"): Promise<unknown> {
      return post("/api/themes/set", { name, ...(mode ? { mode } : {}) });
    },
    create(input: { name: string; title?: string; base: string; seeds?: ThemeValues; tokens?: ThemeValues }): Promise<unknown> {
      return post("/api/themes/create", input);
    },
    values(input: { name: string; seeds?: ThemeValues; tokens?: ThemeValues }): Promise<unknown> {
      return post("/api/themes/values", input);
    },
    check(name: string): Promise<ThemeCheck> {
      return post<ThemeCheck>("/api/themes/check", { name });
    },
    fix(name: string): Promise<unknown> {
      return post("/api/themes/fix", { name });
    },
    remove(name: string): Promise<unknown> {
      return post("/api/themes/delete", { name });
    },
  },
  /** P6: cron prompts. The list comes with `cron.changed` over SSE; each call answers with the entry. */
  cron: {
    list(): Promise<CronEntry[]> {
      return get<CronEntry[]>("/api/cron");
    },
    create(input: { name: string; expr: string; prompt: string; enabled?: boolean }): Promise<CronEntry> {
      return post<CronEntry>("/api/cron/create", input);
    },
    update(input: { id: string; name?: string; expr?: string; prompt?: string; enabled?: boolean }): Promise<CronEntry> {
      return post<CronEntry>("/api/cron/update", input);
    },
    remove(id: string): Promise<unknown> {
      return post("/api/cron/delete", { id });
    },
    runNow(id: string): Promise<unknown> {
      return post("/api/cron/run-now", { id });
    },
  },
  /** P7: jev (TypeSafe System One), one question per call. */
  jev: {
    judge(input: JevInput): Promise<JevVerdict> {
      return post<JevVerdict>("/api/jev/judge", input);
    },
  },
  ui: {
    /** POST /api/ui/open: every open page opens the panel when the `ui.open` event arrives. */
    open(target: "settings" | "cron", section?: string): Promise<unknown> {
      return post("/api/ui/open", { target, ...(section ? { section } : {}) });
    },
  },
  /** P5: context and compaction. The readings themselves come with `chat.meta` over SSE. */
  context: {
    get(): Promise<unknown> {
      return get<unknown>("/api/context");
    },
    setCompaction(points: Partial<CompactionPoints>): Promise<unknown> {
      return post("/api/compaction/set", points);
    },
    compact(instructions?: string): Promise<unknown> {
      return post("/api/compact", instructions !== undefined && instructions !== "" ? { instructions } : {});
    },
  },
  /** P5: models and thinking. */
  models: {
    list(): Promise<ModelInfo[]> {
      return get<ModelInfo[]>("/api/models");
    },
    refresh(): Promise<unknown> {
      return post("/api/models/refresh", {});
    },
    set(ref: ModelRef): Promise<unknown> {
      return post("/api/model/set", ref);
    },
    setThinking(level: ThinkingLevel): Promise<unknown> {
      return post("/api/thinking/set", { level });
    },
  },
  /** P5: the four prompt layers. The list shape is normalised in settings/p5-types.ts. */
  prompts: {
    list(): Promise<unknown> {
      return get<unknown>("/api/prompts");
    },
    get(id: string): Promise<unknown> {
      return get<unknown>(`/api/prompts/get?id=${encodeURIComponent(id)}`);
    },
    setSystem(text: string | null): Promise<unknown> {
      return post("/api/prompts/system", { text });
    },
    createCustom(input: { name: string; text: string; enabled?: boolean }): Promise<unknown> {
      return post("/api/prompts/custom/create", input);
    },
    updateCustom(input: { id: string; name?: string; text?: string }): Promise<unknown> {
      return post("/api/prompts/custom/update", input);
    },
    deleteCustom(id: string): Promise<unknown> {
      return post("/api/prompts/custom/delete", { id });
    },
    toggle(id: string, enabled: boolean): Promise<unknown> {
      return post("/api/prompts/toggle", { id, enabled });
    },
    appendRuntime(text: string): Promise<unknown> {
      return post("/api/prompts/runtime/append", { text });
    },
    removeRuntime(id: string): Promise<unknown> {
      return post("/api/prompts/runtime/remove", { id });
    },
    clearRuntime(): Promise<unknown> {
      return post("/api/prompts/runtime/clear", {});
    },
  },
  /** P5: tools. `GET /api/tools` is the snapshot's `tools`, kept current by `tools.changed`. */
  tools: {
    describe(name: string, syntax: "json" | "typescript"): Promise<unknown> {
      return get<unknown>(`/api/tools/describe?name=${encodeURIComponent(name)}&syntax=${syntax}`);
    },
    setEnabled(name: string, enabled: boolean): Promise<unknown> {
      return post("/api/tools/set-enabled", { name, enabled });
    },
  },
  /** P5: layer stack (the list is in the snapshot) and the runs list. */
  layerStack: {
    setEnabled(name: string, enabled: boolean): Promise<unknown> {
      return post("/api/layers/set-enabled", { name, enabled });
    },
  },
  runs: {
    list(before?: number, limit = 20): Promise<RunSummary[]> {
      return get<RunSummary[]>(`/api/runs?limit=${limit}${before !== undefined ? `&before=${before}` : ""}`);
    },
    get(id: number): Promise<RunDetail> {
      return get<RunDetail>(`/api/runs/${id}`);
    },
  },
  layers: {
    query(layer: string, name: string, input: Json = {}): Promise<Json> {
      return get<Json>(`/api/layers/${encodeURIComponent(layer)}/query/${encodeURIComponent(name)}?input=${encodeURIComponent(JSON.stringify(input))}`);
    },
    action(layer: string, name: string, input: Json = {}): Promise<Json> {
      return post<Json>(`/api/layers/${encodeURIComponent(layer)}/action/${encodeURIComponent(name)}`, { input });
    },
    /** P9 authoring. POST /api/layers/create. */
    create(input: CreateLayerInput): Promise<LayerInfo> {
      return post<LayerInfo>("/api/layers/create", input);
    },
    /** POST /api/layers/delete. */
    delete(name: string): Promise<DeleteLayerResult> {
      return post<DeleteLayerResult>("/api/layers/delete", { name });
    },
    /** GET /api/layers/files. */
    files(name: string): Promise<LayerFileList> {
      return get<LayerFileList>(`/api/layers/files?name=${encodeURIComponent(name)}`);
    },
    /** GET /api/layers/read-file. */
    readFile(name: string, path: string): Promise<LayerFileContent> {
      return get<LayerFileContent>(`/api/layers/read-file?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`);
    },
    /** POST /api/layers/write-file. */
    writeFile(name: string, path: string, content: string): Promise<WriteLayerFileResult> {
      return post<WriteLayerFileResult>("/api/layers/write-file", { name, path, content });
    },
    /** POST /api/layers/delete-file. */
    deleteFile(name: string, path: string): Promise<DeleteLayerFileResult> {
      return post<DeleteLayerFileResult>("/api/layers/delete-file", { name, path });
    },
    /** POST /api/layers/export. */
    export(name: string): Promise<ExportLayerResult> {
      return post<ExportLayerResult>("/api/layers/export", { name });
    },
    /** POST /api/layers/import. */
    import(input: ImportLayerInput): Promise<ImportLayerResult> {
      return post<ImportLayerResult>("/api/layers/import", input);
    },
    /** The URL that downloads an archive written by export (GET /api/layers/export-file). */
    exportFileUrl(file: string): string {
      return `/api/layers/export-file?file=${encodeURIComponent(file)}`;
    },
    /** POST /api/layers/reload. */
    reload(): Promise<readonly LayerInfo[]> {
      return post<readonly LayerInfo[]>("/api/layers/reload", {});
    },
  },
  /** Liquid core (P9): the factory's own web build, process and rendered UI. */
  factory: {
    /** POST /api/factory/rebuild-web. */
    rebuildWeb(): Promise<RebuildWebResult> {
      return post<RebuildWebResult>("/api/factory/rebuild-web", {});
    },
    /** POST /api/factory/restart. */
    restart(reason?: string): Promise<RestartResult> {
      return post<RestartResult>("/api/factory/restart", reason !== undefined ? { reason } : {});
    },
    /** POST /api/factory/screenshot. */
    screenshot(input: ScreenshotInput = {}): Promise<ScreenshotResult> {
      return post<ScreenshotResult>("/api/factory/screenshot", input);
    },
  },
  /** P9: custom widget types and the settings document. */
  widgetTypes: {
    /** POST /api/widgets/define. */
    define(layer: string, widget: WidgetContribution): Promise<DefineWidgetResult> {
      return post<DefineWidgetResult>("/api/widgets/define", { layer, widget });
    },
    /** POST /api/widgets/undefine. */
    undefine(layer: string, id: string): Promise<UndefineWidgetResult> {
      return post<UndefineWidgetResult>("/api/widgets/undefine", { layer, id });
    },
  },
  settings: {
    /** GET /api/settings. */
    get(): Promise<Settings> {
      return get<Settings>("/api/settings");
    },
  },
};

/** A sentence to show the person for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message !== "") return err.message;
  return "Something went wrong. Try again.";
}

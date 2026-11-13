/**
 * openFactoryAgent (DESIGN 3 steps 5-9, DESIGN 7): layers, settings getter, model catalog, the one pi-durable Harness
 * on tsf/data/agent.sqlite, the root conversation configured from settings, and the started ChatFeed. It never resumes
 * and never submits: `resume()` (auto-continue, then `harness.resume()`) is called by createFactory after createService
 * binds the Service (step 11), so a resumed tool always finds it. The caller holds the PID lock and owns the AppDb.
 * The signature is final from P1. P2 body: the registry reads the permissions ceiling and installs ceiling-filtered
 * extensions; the layer context's `ceiling()` getter returns the registry's frozen Ceiling (read at call time by the
 * factory_harness guard); every execution env is a RootedEnv on the project root; `applySettings` builds the extension
 * edit and the disabled tools from the registry (DESIGN 7 "Settings to configure", DESIGN 8).
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type AgentChange,
  type Conversation,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AppDb } from "../core/db.ts";
import { ServiceError } from "../core/errors.ts";
import type { Logger } from "../core/log.ts";
import type { ProjectPaths } from "../core/paths.ts";
import { PromptStore } from "../core/prompts.ts";
import type { FactoryService } from "../core/service-api.ts";
import { mergeSettings, settingsDefaults } from "../core/settings.ts";
import type { AppBus } from "../shared/events.ts";
import type { ModelRef, Settings } from "../shared/types.ts";
import { toPolicy } from "./compaction.ts";
import { startAutoContinue } from "./continue.ts";
import { installFaux, type FauxRule } from "./faux.ts";
import { loadFauxRules } from "./faux-rules.ts";
import { ChatFeed } from "./feed.ts";
import { jevJudge } from "../core/jev.ts";
import { PI_KIT, type CeilingView, type LayerContext } from "./layer-context.ts";
import { createModelCatalog, type ModelCatalog } from "./models.ts";
import { loadLayers, type LayerRegistry, type ReloadResult } from "./registry.ts";
import { protectedPaths, RootedEnv } from "./rooted-env.ts";

export interface OpenAgentOptions {
  paths: ProjectPaths;
  log: Logger;
  bus: AppBus;
  db: AppDb;
  /** Late-bound: throws ServiceError("unavailable") until createFactory binds it (DESIGN 3 steps 10-11). */
  service: () => FactoryService;
  /** `--tools` patterns, or null. */
  tools: readonly string[] | null;
  testing?: { skipCeilingFilter?: boolean; rules?: readonly FauxRule[] };
}

export interface FactoryAgent {
  harness: Harness;
  main: Conversation;
  catalog: ModelCatalog;
  registry: LayerRegistry;
  feed: ChatFeed;
  /** Defaults from the manifests with the stored keys over them; cached, dropped on every settings write. */
  settings(): Settings;
  /** `main.configure()` with the whole AgentChange built from settings (DESIGN 7 "Settings to configure"). */
  applySettings(): Promise<void>;
  /**
   * Rescan the project layers (`registry.reload()`), install the new and changed extensions in pi-durable's registry,
   * uninstall the removed ones, drop the settings cache and re-apply the selection with `configure` (D3).
   */
  reloadLayers(): Promise<ReloadResult>;
  /** Start auto-continue, then `harness.resume()`. Idempotent. */
  resume(): void;
  /** Stop auto-continue and the feed, then close the Harness. Idempotent. Does not close the AppDb. */
  close(): Promise<void>;
}

export async function openFactoryAgent(opts: OpenAgentOptions): Promise<FactoryAgent> {
  const { paths, log, db } = opts;
  const ctx: Context = BACKGROUND_CONTEXT;
  const root = paths.projectRoot;

  // Steps 5-6: ceiling file and layers. `settings` and `ceiling` are defined right after they load; factories only
  // capture the getters (T26).
  let settingsGetter: (() => Settings) | undefined;
  let registryRef: LayerRegistry | undefined;
  // Custom prompts render in factory_harness-custom and runtime prompts join `instructions` (P5): both read the db at use.
  const prompts = new PromptStore(db.db);
  const layerCtx: LayerContext = {
    service: opts.service,
    paths,
    log,
    bus: opts.bus,
    settings: () => {
      if (!settingsGetter) throw new ServiceError("unavailable", "settings are not loaded yet");
      return settingsGetter();
    },
    // Read through the registry at call time: a reload rebuilds the ceiling over the new tool map (same patterns).
    ceiling: () => {
      if (!registryRef) throw new ServiceError("unavailable", "the permissions ceiling is not loaded yet");
      return registryRef.ceiling();
    },
    modelCache: db.modelCache,
    prompts: () => prompts,
    jev: (input) => jevJudge(input),
    pi: PI_KIT,
  };
  const registry = await loadLayers({
    ctx: layerCtx,
    builtinDir: paths.builtinLayersDir,
    projectDir: paths.layersDir,
    cliTools: opts.tools,
    ...(opts.testing ? { testing: { skipCeilingFilter: opts.testing.skipCeilingFilter ?? false } } : {}),
  });
  registryRef = registry;
  const ceiling = registry.ceiling();
  const ceilingInfo = ceiling.info();
  log.info("agent.layers", { layers: registry.manifests().map((m) => m.name) });
  log.info("ceiling.read", {
    source: ceilingInfo.source,
    file: ceilingInfo.file,
    sha256: ceiling.sha256,
    cli: ceilingInfo.cliPatterns,
    denied: ceilingInfo.denied,
  });
  // bash can rewrite permissions.json for the next start (DESIGN 14, spec 2.5): the file's hash is compared with the
  // previous start's and a change is logged. The running process's ceiling never changes.
  const shaKey = "ceilingSha256";
  const shaNow = JSON.stringify(ceiling.sha256);
  const shaBefore = db.settings.getRaw(shaKey);
  if (shaBefore !== shaNow) {
    if (shaBefore !== undefined) log.warn("ceiling.changed_on_disk", { file: ceilingInfo.file, before: JSON.parse(shaBefore), now: ceiling.sha256 });
    db.settings.setRaw(shaKey, shaNow);
  }

  let cached: Settings | undefined;
  const unsubscribeSettings = db.settings.onChange(() => {
    cached = undefined;
  });
  const settings = (): Settings => {
    cached ??= mergeSettings(settingsDefaults(root, registry.manifests()), db.settings.stored(), registry.manifests());
    return cached;
  };
  settingsGetter = settings;

  // Step 7: models.
  const faux = process.env.TSF_MODEL_PROVIDER === "faux";
  const enabled = new Set(settings().layersEnabled);
  const providers = registry
    .layers()
    .filter((l) => l.provider !== undefined && enabled.has(l.manifest.name))
    .map((l) => l.provider!);
  const catalog = await createModelCatalog({ faux, providers, log });
  if (faux) installFaux(catalog.models, { rules: [...(opts.testing?.rules ?? []), ...(await loadFauxRules())] });
  log.info("agent.models", { source: catalog.source, models: catalog.list().length });

  // Step 8: the Harness. Every loaded extension is installed; the host default is the enabled-by-default set.
  const pdRegistry = createRegistry();
  for (const extension of registry.extensions()) pdRegistry.install(extension);
  const harnessSettings = (): HarnessSettings => {
    const s = settings();
    return {
      extensions: registry.defaultSelection(),
      compaction: toPolicy(catalog.window(s.model), s.compaction),
      retry: { maxRetries: 4 },
      restartLimit: 5,
      afterFailedRun: "keep",
      progress: { persistWithinMs: 1_000 },
    };
  };
  let rootedEnv: RootedEnv | undefined;
  const storage = await openNodeSqliteStorage(paths.agentDb);
  let harness: Harness;
  try {
    harness = await Harness.open(
      storage,
      {
        // Global fetch and pi-ai's own provider config only: no fetch, env or baseUrl options (DESIGN 12).
        models: () => catalog.models,
        registry: pdRegistry,
        settings: harnessSettings,
        // read/write/edit resolve every path through RootedEnv.absolutePath (D4, T12); bash runs with cwd = project.
        // The skill folder (the server's own code) is protected too, when the project contains it.
        env: () => (rootedEnv ??= new RootedEnv(root, { shellEnv: process.env, protectedPaths: protectedPaths(root, paths.skillDir) })),
        onReport: (report) =>
          log.error("durable.report", {
            kind: report.kind,
            error: report.error instanceof Error ? report.error.message : String(report.error),
          }),
      },
      ctx,
    );
  } catch (err) {
    await storage.close(ctx).catch(() => undefined);
    throw err;
  }

  // A failed Harness (harness.closed resolving { kind: "failed" }) is handled by runServer in server/main.ts: it logs,
  // runs the graceful shutdown (server.json removed, lock released) and exits 1 (DESIGN 3 "Shutdown"). The agent does
  // not exit the process itself, so an in-process test factory is never killed by it.
  let closing = false;

  const effectiveModel = (s: Settings): ModelRef => catalog.resolve(s.model);
  const thinkingFor = (ref: ModelRef, s: Settings) => {
    const model = catalog.model(ref);
    return model ? clampThinkingLevel(model, s.thinkingLevel) : s.thinkingLevel;
  };

  const agentChange = (): AgentChange => {
    const s = settings();
    const model = effectiveModel(s);
    // Recomputed whole against the static host default every time (T1); never removes a required layer (D7).
    const { add, remove } = registry.selection(s);
    // Tools outside the ceiling are not registered, so they cannot be named here.
    const disabledTools = registry.toolObjects(s.toolsDisabled);
    return {
      model,
      thinkingLevel: thinkingFor(model, s),
      extensions: add.length || remove.length ? { add, remove } : null,
      tools: disabledTools.length ? { remove: disabledTools } : null,
      // Runtime prompts (P5, prompt layer 4): the reserved `instructions` section, rendered last, from the next request.
      instructions: prompts.runtimeText(),
      maxTurns: s.maxTurns,
      cwd: root,
    };
  };

  // The root conversation; `agent` applies only on creation, configure() below converges an existing one.
  const s0 = settings();
  const model0 = effectiveModel(s0);
  const main = await harness.root(ctx, { agent: { model: model0, thinkingLevel: thinkingFor(model0, s0), cwd: root } });
  const applySettings = async (): Promise<void> => {
    if (closing) return;
    await main.configure(agentChange(), ctx);
  };
  await applySettings();
  const reloadLayers = async (): Promise<ReloadResult> => {
    const result = await registry.reload();
    // pi-durable's registry keys extensions by name; `uninstall` takes the installed object, so look it up.
    const installed = pdRegistry.snapshot().installed();
    for (const name of result.removed) {
      const old = installed.find((e) => e.name === name);
      if (old) pdRegistry.uninstall(old);
    }
    for (const name of [...result.added, ...result.changed]) {
      const extension = registry.extension(name);
      if (extension) pdRegistry.install(extension);
    }
    cached = undefined;
    await applySettings();
    return result;
  };
  const unsubscribeCatalog = catalog.onChange(() => {
    void applySettings().catch((err: unknown) => log.error("agent.configure_failed", { error: err }));
  });

  // Step 9: the feed.
  const feed = new ChatFeed(main, { catalog, settings, toolLayer: (n) => registry.toolLayer(n), log });
  await feed.start();
  log.info("agent.ready", { model: `${model0.provider}/${model0.modelId}` });

  let resumed = false;
  let stopContinue: (() => void) | undefined;
  let closed: Promise<void> | undefined;

  return {
    harness,
    main,
    catalog,
    registry,
    feed,
    settings,
    applySettings,
    reloadLayers,
    resume() {
      if (resumed || closing) return;
      resumed = true;
      stopContinue = startAutoContinue(feed, main, log);
      harness.resume();
    },
    close() {
      closed ??= (async () => {
        closing = true;
        stopContinue?.();
        unsubscribeCatalog();
        unsubscribeSettings();
        await feed.stop().catch((err: unknown) => log.warn("feed.stop_failed", { error: err }));
        await harness.close(ctx);
      })();
      return closed;
    },
  };
}

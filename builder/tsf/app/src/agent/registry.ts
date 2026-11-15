/**
 * LayerRegistry (DESIGN 8 "Registry"). `loadLayers` keeps its P1 signature; from P2 the body:
 * 1. discovers the built-ins in fixed order, then `tsf/layers/*` sorted by folder name (a missing folder is none);
 * 2. imports each `manifest.ts` and `extension.ts` (a built-in that fails is fatal; a project layer that fails is
 *    recorded `status: "failed"` and skipped);
 * 3. validates names, the extension name, section prefixes (`<layer>-`) and widget ids (`<layer>.`);
 * 4. builds the tool map (a tool name defined by two layers fails startup naming both, D8);
 * 5. reads `tsf/permissions.json` (+ `--tools`), builds the frozen `Ceiling` and filters each extension's tools by it
 *    (unless `testing.skipCeilingFilter`); a layer that defines tools but keeps none loses its sections too;
 * 6. exposes the host default selection and the per-settings selection edit.
 *
 * Declarative layers and reload (DESIGN 8): a project layer folder may hold `manifest.json` (validated strictly by
 * layer-manifest.ts) instead of `manifest.ts`; its `extension.ts` is optional, and without it the registry synthesises
 * an extension with no tools whose prompt sections are the folder's `prompts/*.md`. `registry.reload()` rescans
 * `tsf/layers/*`, re-imports changed modules (from a fresh stamped copy of the layer folder, see `freshCopy`), validates again and swaps the registry's
 * state in place (a project tool name that clashes with another layer fails that layer, never the process). Built-ins
 * and provider layers are never reloaded.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Json, LayerInfo, LayerManifest, Settings, ToolInfo } from "../shared/types.ts";
import { buildCeiling, readCeiling, type Ceiling } from "./ceiling.ts";
import { gateExtension } from "./prompt-sections.ts";
import type { LayerContext, LayerHandlers, LayerModule, ProviderLayer } from "./layer-context.ts";
import { appVersion } from "../core/app-version.ts";
import {
  coreBindingProblems,
  crossCheckJsonLayer,
  HANDLER_NAME,
  LAYER_NAME,
  metadataProblems,
  parseJsonManifest,
  unmetRequirement,
} from "./layer-manifest.ts";

export interface LoadedLayer {
  readonly manifest: LayerManifest;
  readonly source: "builtin" | "project";
  /** Load order index (0 = first). */
  readonly order: number;
  /** The extension as installed: tools filtered by the ceiling (unless the test seam skips the filter). */
  readonly extension: Extension;
  readonly provider?: ProviderLayer;
  /** The layer's own queries and actions (`createHandlers`), when it has any (P4). */
  readonly handlers?: LayerHandlers;
  /** Section key to title, for synthesised prompt sections (a json layer's `prompts/*.md`). */
  readonly sectionTitles?: Readonly<Record<string, string>>;
  /** Changes whenever the layer was (re)built; reload compares it to tell changed layers from untouched ones. */
  readonly revision: object;
  /** Every tool name the layer's extension defines, inside the ceiling or not. */
  readonly defined: readonly string[];
  /** Tool names the layer defines that the ceiling removed. */
  readonly outsideCeiling: readonly string[];
}

/** A project layer that failed to import or validate (DESIGN 8 step 2). */
export interface FailedLayer {
  readonly folder: string;
  readonly order: number;
  readonly manifest?: LayerManifest;
  readonly error: string;
}

/** What `reload()` changed, by layer name. A loaded layer that now fails counts as removed, a failed one that now loads as added. */
export interface ReloadResult {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  /** Folders that failed validation in this scan. */
  readonly failed: readonly string[];
}

export interface LayerRegistry {
  /** Rescan `tsf/layers/*` and swap the state in place; see the file header. Calls are serialised by the caller (Service `layers` mutex). */
  reload(): Promise<ReloadResult>;
  /** The title of a synthesised prompt section, or undefined. */
  sectionTitle(key: string): string | undefined;
  /** Loaded layers, load order. */
  layers(): readonly LoadedLayer[];
  manifests(): readonly LayerManifest[];
  /** Every loaded layer's extension, in load order (all are installed, enabled or not). */
  extensions(): readonly Extension[];
  /** Extensions of layers with `enabledByDefault`: the Harness's host default selection. */
  defaultSelection(): readonly Extension[];
  /** Provider layers' providers, in load order. */
  providers(): readonly ProviderLayer[];
  /** A loaded layer's handlers (queries and actions), when it exports `createHandlers`. */
  handlers(name: string): LayerHandlers | undefined;
  /** The layer that defines a tool name (inside the ceiling or not). */
  toolLayer(name: string): string | undefined;
  infos(settings: Settings): LayerInfo[];
  /** Registered tools inside the ceiling, load order. */
  toolInfos(settings: Settings, offered: ReadonlySet<string>): ToolInfo[];
  /** The frozen permissions ceiling. */
  ceiling(): Ceiling;
  /** A loaded layer's installed extension. */
  extension(name: string): Extension | undefined;
  /** The extension edit against the host default for `settings.layersEnabled` (never removes a required layer). */
  selection(settings: Settings): { add: Extension[]; remove: Extension[] };
  /** The registered tool objects with these names (unknown names are skipped). */
  toolObjects(names: readonly string[]): ToolRegistration[];
}

/** Built-ins in load order (DESIGN 8 step 1). A folder not built yet (factory_controls before P4) is skipped. */
export const BUILTIN_LAYERS = ["factory_harness", "provider_openrouter", "coding_tools", "page_harness", "factory_controls", "model_controls"] as const;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SECTION_FILE = /^[a-z][a-z0-9_-]{0,40}$/;
const MAX_PROMPT_BYTES = 256 * 1024;

/**
 * Section keys are `<layer>-<key>`: pi-durable 1.5.0 rejects keys outside /^[a-z][a-z0-9_-]*$/ (harness/registry.js
 * SECTION_KEY), so DESIGN's original `<layer>.<key>` cannot be installed. Layer names have no `-`, so the prefix is
 * unambiguous.
 */
export const sectionPrefix = (layer: string): string => `${layer}-`;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

function hasLayerFiles(dir: string): boolean {
  return isFile(join(dir, "manifest.ts"));
}

/** Project layer folders, sorted by name; a missing `tsf/layers/` is empty. Dot folders and files are ignored. */
function projectFolders(projectDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(projectDir, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter((n) => {
    try {
      return statSync(join(projectDir, n)).isDirectory();
    } catch {
      return false;
    }
  }).sort();
}

/** `mtime_size` of a file, or "-" when it is missing: a change signature. */
function stamp(file: string): string {
  try {
    const st = statSync(file);
    return `${String(st.mtimeMs).replace(".", "_")}_${st.size}`;
  } catch {
    return "-";
  }
}

/** The `prompts/*.md` file names of a layer folder, sorted; a missing folder is none. */
function promptFiles(dir: string): string[] {
  try {
    return readdirSync(join(dir, "prompts"), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md") && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** `path:stamp` of every file below `dir` (dot entries and node_modules skipped), sorted: the layer's change signature. */
function treeStamps(dir: string, rel = ""): string[] {
  let entries;
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const path = rel === "" ? e.name : `${rel}/${e.name}`;
    let isDir = e.isDirectory();
    let isF = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const st = statSync(join(dir, path));
        isDir = st.isDirectory();
        isF = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) out.push(...treeStamps(dir, path));
    else if (isF) out.push(`${path}:${stamp(join(dir, path))}`);
  }
  return out;
}

/** Everything a project layer is built from, as one string: equal strings mean the layer need not be rebuilt. */
function signature(dir: string): string {
  return treeStamps(dir).join("|");
}

/**
 * Where a layer's code is imported from. Node (and the tsx loader the real launcher registers) caches modules by URL
 * and tsx rejects a cache-busting query on a `.ts` URL ("Cannot find module '...extension.ts?t=...'"), so an edited
 * layer is imported from a fresh copy of its whole folder at `<cacheRoot>/<layer>/<hash of its file stamps>/`:
 * every import inside the layer (extension, manifest, helpers) gets a new URL and relative imports keep working.
 * The two newest copies of a layer are kept, older ones removed.
 */
function freshCopy(cacheRoot: string, folder: string, dir: string): string {
  const hash = createHash("sha256").update(treeStamps(dir).join("|")).digest("hex").slice(0, 16);
  const layerRoot = join(cacheRoot, folder);
  const target = join(layerRoot, hash);
  try {
    statSync(target);
  } catch {
    mkdirSync(layerRoot, { recursive: true });
    cpSync(dir, target, {
      recursive: true,
      dereference: true,
      filter: (src) => {
        const name = basename(src);
        return src === dir || !(name.startsWith(".") || name === "node_modules");
      },
    });
  }
  try {
    const others = readdirSync(layerRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== hash)
      .map((d) => ({ name: d.name, at: statSync(join(layerRoot, d.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of others.slice(1)) rmSync(join(layerRoot, old.name), { recursive: true, force: true });
  } catch {
    // pruning is best effort
  }
  return target;
}

/** `import()` of a file path (a built-in in place, a project layer from its fresh copy). */
const importFile = (file: string): Promise<unknown> => import(pathToFileURL(file).href);

/** `codeDir` is where the code is read from (a fresh copy for project layers); `dir` names the layer in messages. */
async function importManifest(dir: string, codeDir: string = dir): Promise<LayerManifest> {
  const mod = (await importFile(join(codeDir, "manifest.ts"))) as { manifest?: LayerManifest };
  if (!mod.manifest || typeof mod.manifest !== "object") throw new Error(`${dir}/manifest.ts does not export manifest`);
  return mod.manifest;
}

async function importModule(dir: string, codeDir: string = dir): Promise<LayerModule> {
  const mod = (await importFile(join(codeDir, "extension.ts"))) as Partial<LayerModule>;
  if (typeof mod.createExtension !== "function") throw new Error(`${dir}/extension.ts does not export createExtension`);
  return mod as LayerModule;
}

function validateManifest(folder: string, manifest: LayerManifest): void {
  const meta = metadataProblems(manifest, false);
  if (meta.length > 0) throw new Error(`layer ${folder}: invalid manifest metadata:\n- ${meta.join("\n- ")}`);
  if (manifest.name !== folder) throw new Error(`layer ${folder}: manifest.name is ${String(manifest.name)}, not ${folder}`);
  if (!LAYER_NAME.test(manifest.name)) throw new Error(`layer ${folder}: invalid name (must match ${LAYER_NAME})`);
  for (const w of manifest.ui?.widgets ?? []) {
    if (!w.id.startsWith(`${manifest.name}.`)) throw new Error(`layer ${folder}: widget id ${w.id} must start with ${manifest.name}.`);
  }
}

function validateExtension(folder: string, manifest: LayerManifest, extension: Extension): void {
  if (!extension || typeof extension !== "object") throw new Error(`layer ${folder}: createExtension returned no extension`);
  if (extension.name !== manifest.name) throw new Error(`layer ${folder}: extension name is ${extension.name}`);
  for (const s of extension.sections ?? []) {
    if (!s.key.startsWith(sectionPrefix(manifest.name))) {
      throw new Error(`layer ${folder}: section ${s.key} must start with ${sectionPrefix(manifest.name)}`);
    }
  }
  const seen = new Set<string>();
  for (const t of extension.tools ?? []) {
    if (!TOOL_NAME.test(t.name)) throw new Error(`layer ${folder}: invalid tool name ${t.name}`);
    if (seen.has(t.name)) throw new Error(`layer ${folder}: tool ${t.name} is defined twice`);
    seen.add(t.name);
  }
}

interface Candidate {
  readonly folder: string;
  readonly source: "builtin" | "project";
  readonly manifest: LayerManifest;
  readonly extension: Extension;
  readonly provider?: ProviderLayer;
  readonly handlers?: LayerHandlers;
  readonly sectionTitles?: Readonly<Record<string, string>>;
  /** Identity of this build (see LoadedLayer.revision). */
  readonly revision: object;
}

const HANDLER_KINDS = ["queries", "actions"] as const;

function validateHandlers(folder: string, handlers: LayerHandlers | undefined): void {
  if (handlers === undefined) return;
  for (const kind of HANDLER_KINDS) {
    for (const [name, h] of Object.entries(handlers[kind] ?? {})) {
      if (!HANDLER_NAME.test(name)) throw new Error(`layer ${folder}: invalid ${kind.slice(0, -1)} handler name ${name}`);
      if (kind === "queries" && typeof h !== "function") throw new Error(`layer ${folder}: query ${name} is not a function`);
      if (kind === "actions") {
        const a = h as { replay?: unknown; run?: unknown };
        if (a.replay !== "safe" && a.replay !== "unsafe") throw new Error(`layer ${folder}: action ${name} must declare replay`);
        if (typeof a.run !== "function") throw new Error(`layer ${folder}: action ${name} has no run()`);
      }
    }
  }
}

const handlerNames = (handlers: LayerHandlers | undefined) => ({
  queries: new Set(Object.keys(handlers?.queries ?? {})),
  actions: new Set(Object.keys(handlers?.actions ?? {})),
});

/** `# Title` of a prompt file, else the file name without `.md`. */
function promptTitle(text: string, file: string): string {
  const m = /^#[ \t]+(.+?)[ \t]*$/m.exec(text);
  return m?.[1] ?? basename(file, ".md");
}

/**
 * The extension of a json layer with no extension.ts (D1): name `<layer>`, no tools, one section `<layer>-<file>` per
 * `prompts/<file>.md` (title from its first `# ` heading), text read now, so a reload picks up an edit.
 */
function synthesiseExtension(ctx: LayerContext, name: string, dir: string): { extension: Extension; titles: Record<string, string> } {
  const { defineExtension, section } = ctx.pi;
  const titles: Record<string, string> = {};
  const sections = promptFiles(dir).flatMap((file) => {
    const stem = basename(file, ".md");
    if (!SECTION_FILE.test(stem)) {
      throw new Error(`layer ${name}: prompts/${file}: the file name must match ${SECTION_FILE} (lowercase letters, digits, - and _)`);
    }
    const full = join(dir, "prompts", file);
    if (statSync(full).size > MAX_PROMPT_BYTES) throw new Error(`layer ${name}: prompts/${file} is larger than ${MAX_PROMPT_BYTES} bytes`);
    const text = readFileSync(full, "utf8").trim();
    const key = `${sectionPrefix(name)}${stem}`;
    titles[key] = promptTitle(text, file);
    return [section(key, () => (text === "" ? undefined : text))];
  });
  return { extension: defineExtension({ name, sections }) as Extension, titles };
}

/** Build a built-in candidate: any failure is fatal to the caller. */
async function buildBuiltin(ctx: LayerContext, dir: string, folder: string): Promise<Candidate> {
  const manifest = await importManifest(dir);
  validateManifest(folder, manifest);
  const module = await importModule(dir);
  const extension = module.createExtension(ctx);
  validateExtension(folder, manifest, extension);
  const provider = manifest.kind === "provider" ? module.createProvider?.(ctx) : undefined;
  const handlers = module.createHandlers?.(ctx);
  validateHandlers(folder, handlers);
  return {
    folder,
    source: "builtin",
    manifest,
    // Every section can be switched off (D6, spec 8.5).
    extension: gateExtension(extension),
    ...(provider ? { provider } : {}),
    ...(handlers ? { handlers } : {}),
    revision: {},
  };
}

/** Build a project candidate (ts or json layer). Throws a message naming the layer on any problem. */
async function buildProject(ctx: LayerContext, projectDir: string, folder: string, allowProvider: boolean): Promise<Candidate> {
  const dir = join(projectDir, folder);
  const hasTs = isFile(join(dir, "manifest.ts"));
  const hasJson = isFile(join(dir, "manifest.json"));
  if (hasTs && hasJson) throw new Error(`layer ${folder}: both manifest.ts and manifest.json exist; keep one (delete one of them)`);
  if (!hasTs && !hasJson) throw new Error(`layer ${folder}: no manifest.ts or manifest.json`);
  const hasExtension = isFile(join(dir, "extension.ts"));
  const codeDir = hasTs || hasExtension ? freshCopy(join(ctx.paths.dataDir, "layer-cache"), folder, dir) : dir;
  let manifest: LayerManifest;
  if (hasJson) {
    manifest = parseJsonManifest(folder, readFileSync(join(dir, "manifest.json"), "utf8"));
  } else {
    manifest = await importManifest(dir, codeDir);
    validateManifest(folder, manifest);
  }
  if (manifest.kind === "provider" && !allowProvider) {
    throw new Error(`layer ${folder}: provider layers load at startup; restart the factory to add one`);
  }
  let extension: Extension;
  let provider: ProviderLayer | undefined;
  let handlers: LayerHandlers | undefined;
  let titles: Record<string, string> | undefined;
  if (hasExtension) {
    const module = await importModule(dir, codeDir);
    extension = module.createExtension(ctx);
    validateExtension(folder, manifest, extension);
    provider = manifest.kind === "provider" ? module.createProvider?.(ctx) : undefined;
    handlers = module.createHandlers?.(ctx);
    validateHandlers(folder, handlers);
  } else if (hasJson) {
    const made = synthesiseExtension(ctx, manifest.name, dir);
    extension = made.extension;
    titles = made.titles;
    validateExtension(folder, manifest, extension);
  } else {
    await importModule(dir, codeDir); // throws the usual "Cannot find module" for a ts layer without extension.ts
    throw new Error(`layer ${folder}: extension.ts is missing`);
  }
  // Bindings: json layers check every control reference and capability tool; code layers only their core: bindings.
  const names = handlerNames(handlers);
  if (hasJson) crossCheckJsonLayer(folder, manifest, (extension.tools ?? []).map((t) => t.name), names);
  else {
    const problems = coreBindingProblems(manifest);
    if (problems.length > 0) throw new Error(`layer ${folder}: invalid core bindings:\n- ${problems.join("\n- ")}`);
  }
  return {
    folder,
    source: "project",
    manifest,
    extension: gateExtension(extension),
    ...(provider ? { provider } : {}),
    ...(handlers ? { handlers } : {}),
    ...(titles ? { sectionTitles: titles } : {}),
    revision: {},
  };
}

export async function loadLayers(opts: {
  ctx: LayerContext;
  builtinDir: string;
  projectDir: string;
  cliTools: readonly string[] | null;
  testing?: { skipCeilingFilter?: boolean };
  /** The app version `requires.core` is checked against (tests); the app's package.json version by default. */
  coreVersion?: string;
}): Promise<LayerRegistry> {
  const { ctx } = opts;
  // Copies of earlier runs are no longer imported by anyone.
  rmSync(join(ctx.paths.dataDir, "layer-cache"), { recursive: true, force: true });
  const read = readCeiling(ctx.paths.permissionsFile, opts.cliTools);
  const skipFilter = opts.testing?.skipCeilingFilter === true;

  // Steps 1-3, built-ins: any failure is fatal. Built once and kept: they are never reloaded.
  const builtins: Candidate[] = [];
  for (const folder of BUILTIN_LAYERS) {
    const dir = join(opts.builtinDir, folder);
    if (!hasLayerFiles(dir)) continue;
    builtins.push(await buildBuiltin(ctx, dir, folder));
  }

  /** Successfully built project layers by folder, with the signature they were built from. */
  const cache = new Map<string, { sig: string; candidate: Candidate }>();

  /**
   * One scan of `tsf/layers/*` and assembly of the registry state. `strict` (startup): a tool name defined by two
   * layers throws naming both (D8). Reload (not strict): the later project layer fails instead.
   */
  async function build(strict: boolean): Promise<RegistryState> {
    const candidates: Candidate[] = [...builtins];
    const orders = new Map<Candidate, number>(candidates.map((c, i) => [c, i]));
    const failed: FailedLayer[] = [];
    const names = new Set(builtins.map((c) => c.manifest.name));
    let order = builtins.length;
    const seenFolders = new Set<string>();

    // Steps 1-3, project layers: a failure is recorded and the layer skipped.
    for (const folder of projectFolders(opts.projectDir)) {
      seenFolders.add(folder);
      const at = order++;
      let manifest: LayerManifest | undefined;
      try {
        const sig = signature(join(opts.projectDir, folder));
        const hit = cache.get(folder);
        // Provider layers never reload: their provider is already in the model catalog.
        const reuse = hit !== undefined && (hit.sig === sig || hit.candidate.manifest.kind === "provider") ? hit.candidate : undefined;
        const candidate = reuse ?? (await buildProject(ctx, opts.projectDir, folder, strict));
        manifest = candidate.manifest;
        if (names.has(manifest.name)) throw new Error(`layer ${folder}: the name ${manifest.name} is already loaded`);
        if (reuse === undefined) cache.set(folder, { sig, candidate });
        names.add(manifest.name);
        orders.set(candidate, at);
        candidates.push(candidate);
      } catch (error) {
        cache.delete(folder);
        ctx.log.error("layer.failed", { layer: folder, error: errorText(error) });
        failed.push({ folder, order: at, ...(manifest && typeof manifest === "object" ? { manifest } : {}), error: errorText(error) });
      }
    }
    for (const folder of [...cache.keys()]) if (!seenFolders.has(folder)) cache.delete(folder);

    // `requires`: an unmet core range or a layer that is not loaded fails the layer (never the process). Repeated until
    // stable, because a layer that fails may be required by another.
    const core = opts.coreVersion ?? appVersion();
    for (let again = true; again; ) {
      again = false;
      const loadedNames = new Set(candidates.map((c) => c.manifest.name));
      for (const c of [...candidates]) {
        if (c.source === "builtin") continue;
        const why = unmetRequirement(c.manifest, core, loadedNames);
        if (why === null) continue;
        candidates.splice(candidates.indexOf(c), 1);
        cache.delete(c.folder);
        const error = `layer ${c.folder}: ${why}`;
        ctx.log.error("layer.failed", { layer: c.folder, error });
        failed.push({ folder: c.folder, order: orders.get(c)!, manifest: c.manifest, error });
        again = true;
      }
    }

    // Step 4: the tool map. A duplicate name fails startup naming both layers (D8); on reload the later layer fails.
    const toolMap = new Map<string, string>();
    const kept: Candidate[] = [];
    for (const c of candidates) {
      const clash = (c.extension.tools ?? []).find((t) => toolMap.has(t.name));
      if (clash !== undefined) {
        const other = toolMap.get(clash.name)!;
        const message = `tool ${clash.name} is defined by layers ${other} and ${c.manifest.name}`;
        if (strict || c.source === "builtin") throw new Error(message);
        ctx.log.error("layer.failed", { layer: c.folder, error: message });
        failed.push({ folder: c.folder, order: orders.get(c)!, manifest: c.manifest, error: `layer ${c.folder}: ${message}` });
        continue;
      }
      for (const t of c.extension.tools ?? []) toolMap.set(t.name, c.manifest.name);
      kept.push(c);
    }

    // Step 5: the ceiling and the filter. The permissions file was read once at startup; a reload re-applies the same
    // patterns to the new tool map.
    const ceiling = buildCeiling(read, toolMap);
    const loaded: LoadedLayer[] = kept.map((c) => {
      const tools = c.extension.tools ?? [];
      const keptTools = tools.filter((t) => ceiling.allows(c.manifest.name, t.name));
      const outside = tools.filter((t) => !ceiling.allows(c.manifest.name, t.name)).map((t) => t.name);
      let extension = c.extension;
      if (!skipFilter && outside.length > 0) {
        extension = defineExtension({
          ...c.extension,
          tools: keptTools,
          // A layer that defines tools but keeps none drops its sections: they would describe tools the model lacks.
          ...(keptTools.length === 0 ? { sections: [] } : {}),
        });
      }
      return {
        manifest: c.manifest,
        source: c.source,
        order: orders.get(c)!,
        extension,
        revision: c.revision,
        ...(c.provider ? { provider: c.provider } : {}),
        ...(c.handlers ? { handlers: c.handlers } : {}),
        ...(c.sectionTitles ? { sectionTitles: c.sectionTitles } : {}),
        defined: tools.map((t) => t.name),
        outsideCeiling: outside,
      };
    });
    return { loaded, failed, toolMap, ceiling };
  }

  const initial = await build(true);
  return createLayerRegistry(initial, async () => build(false));
}

function toolInfo(tool: ToolRegistration, layer: string, settings: Settings, offered: ReadonlySet<string>): ToolInfo {
  return {
    name: tool.name,
    layer,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters ?? {})) as Json,
    replay: tool.replay ?? "unsafe",
    inCeiling: true,
    enabled: !settings.toolsDisabled.includes(tool.name),
    offered: offered.has(tool.name),
  };
}

function envInfo(manifest: LayerManifest): LayerInfo["env"] {
  return (manifest.env ?? []).map((e) => ({
    name: e.name,
    required: e.required,
    present: (process.env[e.name] ?? "").trim() !== "",
  }));
}

/** `version`, `origin` and `requires` of a manifest, for LayerInfo (only those present). */
const metaInfo = (m: LayerManifest): Pick<LayerInfo, "version" | "origin" | "requires"> => ({
  ...(typeof m.version === "string" ? { version: m.version } : {}),
  ...(typeof m.origin === "string" ? { origin: m.origin } : {}),
  ...(m.requires && typeof m.requires === "object" ? { requires: m.requires } : {}),
});

const EMPTY_UI: LayerManifest["ui"] = { settingsPanels: [], widgets: [], hotkeys: [] };

/** Everything a scan produces; the registry swaps it whole on reload. */
interface RegistryState {
  readonly loaded: readonly LoadedLayer[];
  readonly failed: readonly FailedLayer[];
  readonly toolMap: ReadonlyMap<string, string>;
  readonly ceiling: Ceiling;
}

function createLayerRegistry(initial: RegistryState, rebuild: () => Promise<RegistryState>): LayerRegistry {
  let { loaded, failed, toolMap, ceiling } = initial;
  let byName = new Map(loaded.map((l) => [l.manifest.name, l]));
  let toolByName = new Map<string, ToolRegistration>();
  const index = (): void => {
    byName = new Map(loaded.map((l) => [l.manifest.name, l]));
    toolByName = new Map<string, ToolRegistration>();
    for (const l of loaded) for (const t of l.extension.tools ?? []) toolByName.set(t.name, t);
  };
  index();
  const registered = (l: LoadedLayer) => (l.extension.tools ?? []).filter((t) => ceiling.allowsName(t.name));

  const loadedInfo = (l: LoadedLayer, settings: Settings): LayerInfo => ({
    name: l.manifest.name,
    kind: l.manifest.kind,
    title: l.manifest.title,
    description: l.manifest.description,
    source: l.source,
    order: l.order,
    required: l.manifest.required === true,
    enabled: settings.layersEnabled.includes(l.manifest.name),
    status: "loaded",
    tools: registered(l).map((t) => t.name),
    toolsOutsideCeiling: l.outsideCeiling,
    sections: (l.extension.sections ?? []).map((s) => s.key),
    env: envInfo(l.manifest),
    ui: l.manifest.ui ?? EMPTY_UI,
    ...metaInfo(l.manifest),
  });

  const failedInfo = (f: FailedLayer): LayerInfo => ({
    name: f.folder,
    kind: f.manifest?.kind === "provider" ? "provider" : "harness",
    title: typeof f.manifest?.title === "string" ? f.manifest.title : f.folder,
    description: typeof f.manifest?.description === "string" ? f.manifest.description : "",
    source: "project",
    order: f.order,
    required: false,
    enabled: false,
    status: "failed",
    error: f.error,
    tools: [],
    toolsOutsideCeiling: [],
    sections: [],
    env: f.manifest && Array.isArray(f.manifest.env) ? envInfo(f.manifest) : [],
    ui: f.manifest?.ui ?? EMPTY_UI,
    ...(f.manifest ? metaInfo(f.manifest) : {}),
  });

  return {
    async reload(): Promise<ReloadResult> {
      const before = new Map(loaded.map((l) => [l.manifest.name, l.revision]));
      const next = await rebuild();
      ({ loaded, failed, toolMap, ceiling } = next);
      index();
      const after = new Map(loaded.map((l) => [l.manifest.name, l.revision]));
      return {
        added: [...after.keys()].filter((n) => !before.has(n)),
        removed: [...before.keys()].filter((n) => !after.has(n)),
        changed: [...after.keys()].filter((n) => before.has(n) && before.get(n) !== after.get(n)),
        failed: failed.map((f) => f.folder),
      };
    },
    sectionTitle: (key) => loaded.find((l) => l.sectionTitles?.[key] !== undefined)?.sectionTitles?.[key],
    layers: () => loaded,
    manifests: () => loaded.map((l) => l.manifest),
    extensions: () => loaded.map((l) => l.extension),
    defaultSelection: () => loaded.filter((l) => l.manifest.enabledByDefault).map((l) => l.extension),
    providers: () => loaded.flatMap((l) => (l.provider ? [l.provider] : [])),
    handlers: (name) => byName.get(name)?.handlers,
    toolLayer: (name) => toolMap.get(name),
    infos: (settings) =>
      [...loaded.map((l) => loadedInfo(l, settings)), ...failed.map(failedInfo)].sort((a, b) => a.order - b.order),
    toolInfos: (settings, offered) =>
      loaded.flatMap((l) => registered(l).map((t) => toolInfo(t, l.manifest.name, settings, offered))),
    ceiling: () => ceiling,
    extension: (name) => byName.get(name)?.extension,
    selection: (settings) => {
      const on = new Set(settings.layersEnabled);
      const add: Extension[] = [];
      const remove: Extension[] = [];
      for (const l of loaded) {
        const name = l.manifest.name;
        if (on.has(name) && !l.manifest.enabledByDefault) add.push(l.extension);
        if (!on.has(name) && l.manifest.enabledByDefault && l.manifest.required !== true) remove.push(l.extension);
      }
      return { add, remove };
    },
    toolObjects: (names) => names.flatMap((n) => {
      const t = toolByName.get(n);
      return t ? [t] : [];
    }),
  };
}

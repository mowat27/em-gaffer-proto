/**
 * The permissions ceiling (DESIGN 8 "Ceiling", D7, D8, T27). `tsf/permissions.json` holds `allow` and `deny` lists of
 * `layer.tool` patterns; it is read once at startup by this deterministic code and never written by the app. The
 * verdicts are computed once over the registry's tool map into a frozen set of allowed tool names; there is no setter.
 *
 * Pattern syntax: `<layerGlob>.<toolGlob>`; `*` alone means `*.*`; a pattern without a dot means `<layer>.*`. `*`
 * matches any run of characters, `?` one character, everything else is literal and case-sensitive. Deny wins over
 * allow; `--tools` patterns are ANDed on top, so they can only narrow.
 *
 * The guard (`ceilingGuard`) is installed by the required `factory_harness` layer. `beforeTool` blocks a resolved call
 * outside the ceiling (a tool registered past the filter, the `testing.skipCeilingFilter` seam). A call to a tool that
 * is not registered never reaches `beforeTool`: pi-durable 1.5.0 settles it `tool_unavailable` and runs only `afterTool`
 * (probed on 1.5.0 with a faux call to an unregistered tool: `afterTool` ran with the `tool_unavailable` result,
 * `beforeTool` did not run). So `afterTool` rewrites that result to `blocked` naming the ceiling when the tool map knows
 * the name as denied. Unknown names and tools the user disabled keep `tool_unavailable`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hook, ToolTask, type HookRegistration, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { CeilingInfo } from "../shared/types.ts";
import type { CeilingView } from "./layer-context.ts";

export interface CeilingFile {
  allow: string[];
  deny: string[];
}

/** What `readCeiling` returns: the file's lists (or the allow-all default), its source and the `--tools` patterns. */
export interface CeilingRead {
  readonly file: CeilingFile;
  readonly source: "file" | "default";
  readonly cli: readonly string[] | null;
  /** The path that was read (or would have been). */
  readonly path: string;
  /** sha256 of the file's bytes, hex; null when the file is missing (DESIGN 14, spec 2.5 detection). */
  readonly sha256: string | null;
}

const DEFAULT_FILE: CeilingFile = { allow: ["*"], deny: [] };

function stringList(value: unknown, key: string, file: string): string[] {
  if (!Array.isArray(value) || value.some((p) => typeof p !== "string" || p.trim() === "")) {
    throw new Error(`${file}: "${key}" must be an array of non-empty pattern strings`);
  }
  return (value as string[]).map((p) => p.trim());
}

/**
 * Read `tsf/permissions.json`. A missing file allows everything (`source: "default"`). Malformed JSON or a wrong shape
 * throws, so startup fails closed. `deny` may be omitted (none); `allow` may not.
 */
export function readCeiling(file: string, cliPatterns: readonly string[] | null): CeilingRead {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { file: { allow: [...DEFAULT_FILE.allow], deny: [] }, source: "default", cli: cliList(cliPatterns), path: file, sha256: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`${file} must be a JSON object { "allow": [...], "deny": [...] }`);
  }
  const record = json as Record<string, unknown>;
  if (!("allow" in record)) throw new Error(`${file}: "allow" is missing`);
  const allow = stringList(record.allow, "allow", file);
  const deny = "deny" in record ? stringList(record.deny, "deny", file) : [];
  return {
    file: { allow, deny },
    source: "file",
    cli: cliList(cliPatterns),
    path: file,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

function cliList(patterns: readonly string[] | null): readonly string[] | null {
  if (patterns === null) return null;
  return Object.freeze(patterns.map((p) => p.trim()).filter((p) => p !== ""));
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (const ch of glob) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Compile one `layer.tool` pattern into a matcher over (layer, tool). */
export function compilePattern(p: string): (layer: string, tool: string) => boolean {
  const pattern = p.trim();
  const full = pattern === "*" ? "*.*" : pattern.includes(".") ? pattern : `${pattern}.*`;
  const dot = full.indexOf(".");
  const layerRe = globToRegExp(full.slice(0, dot));
  const toolRe = globToRegExp(full.slice(dot + 1));
  return (layer, tool) => layerRe.test(layer) && toolRe.test(tool);
}

type Matcher = (layer: string, tool: string) => boolean;

/** The frozen ceiling: verdicts computed once over the tool map. */
export class Ceiling implements CeilingView {
  readonly #toolMap: ReadonlyMap<string, string>;
  readonly #allowed: ReadonlySet<string>;
  readonly #verdict: Matcher;
  readonly #info: CeilingInfo;
  /** sha256 of permissions.json as read at startup; null when the file was missing. */
  readonly sha256: string | null;

  constructor(read: CeilingRead, toolMap: ReadonlyMap<string, string>) {
    const allow = read.file.allow.map(compilePattern);
    const deny = read.file.deny.map(compilePattern);
    const cli = read.cli?.map(compilePattern) ?? null;
    this.#verdict = (layer, tool) =>
      allow.some((m) => m(layer, tool)) &&
      !deny.some((m) => m(layer, tool)) &&
      (cli === null || cli.some((m) => m(layer, tool)));
    this.sha256 = read.sha256;
    this.#toolMap = new Map(toolMap);
    const allowed = new Set<string>();
    const allowedQualified: string[] = [];
    const deniedQualified: string[] = [];
    for (const [tool, layer] of this.#toolMap) {
      if (this.#verdict(layer, tool)) {
        allowed.add(tool);
        allowedQualified.push(`${layer}.${tool}`);
      } else {
        deniedQualified.push(`${layer}.${tool}`);
      }
    }
    this.#allowed = allowed;
    this.#info = Object.freeze({
      source: read.source,
      file: read.path,
      allow: Object.freeze([...read.file.allow]),
      deny: Object.freeze([...read.file.deny]),
      cliPatterns: read.cli === null ? null : Object.freeze([...read.cli]),
      allowed: Object.freeze(allowedQualified),
      denied: Object.freeze(deniedQualified),
    });
    Object.freeze(this);
  }

  /** The verdict for `layer.tool` (a pure function of the patterns). */
  allows(layer: string, tool: string): boolean {
    return this.#verdict(layer, tool);
  }

  /** The tool map knows the name and its verdict is allow. */
  allowsName(tool: string): boolean {
    return this.#allowed.has(tool);
  }

  layerOf(tool: string): string | undefined {
    return this.#toolMap.get(tool);
  }

  /** The tool map knows the name and its verdict is deny. */
  isDenied(tool: string): boolean {
    return this.#toolMap.has(tool) && !this.#allowed.has(tool);
  }

  info(): CeilingInfo {
    return this.#info;
  }
}

export function buildCeiling(read: CeilingRead, toolMap: ReadonlyMap<string, string>): Ceiling {
  return new Ceiling(read, toolMap);
}

/** The block reason, without pi-durable's "Tool call blocked: " prefix. */
export function outsideCeiling(ceiling: CeilingView, tool: string): string {
  return `outside the permissions ceiling: ${ceiling.layerOf(tool) ?? "unknown"}.${tool}`;
}

/** The result `afterTool` gives an unregistered call to a denied tool (same shape as pi-durable's own `blocked`). */
export function blockedResult(ceiling: CeilingView, tool: string): ToolExecutionResult {
  const message = `Tool call blocked: ${outsideCeiling(ceiling, tool)}`;
  // `output` stays empty, as in the Harness's own error results: pi-durable renders the diagnostic into the model's
  // tool result text (`<harness>[error] ...</harness>`); a text output as well would repeat the message.
  return { output: [], isError: true, diagnostics: [{ severity: "error", code: "blocked", message }] };
}

/**
 * The ceiling guard hook. `ceiling` is read at call time (the layer context's getter), so the frozen ceiling is used
 * with no swap after the extensions exist. Nested calls (`call.parent`) pass through the same checks.
 */
export function ceilingGuard(ceiling: () => CeilingView): HookRegistration {
  return hook(ToolTask, {
    beforeTool: (call) => {
      const c = ceiling();
      return c.allowsName(call.name) ? undefined : { block: outsideCeiling(c, call.name) };
    },
    afterTool: (call, result) => {
      if (result.isError !== true) return undefined;
      if (result.diagnostics?.[0]?.code !== "tool_unavailable") return undefined;
      const c = ceiling();
      return c.isDenied(call.name) ? blockedResult(c, call.name) : undefined;
    },
  });
}

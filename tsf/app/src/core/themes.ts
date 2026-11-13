/**
 * ThemeStore (DESIGN 9, Themes). PW themes are the source JSONs at `<pkg>/themes/*.json`; custom themes live in
 * `tsf.sqlite` (`themes`, migration 4) as a PW base plus seeds and tokens. Everything is resolved, checked and rendered
 * through `@pw/ui/theme` (resolveTheme, contrast, fixes, themeCss). The store caches the CSS of the active theme only;
 * the Service decides which theme is active (it follows the UI config) and calls `activate`.
 *
 * A PW theme's CSS is its built file `<pkg>/dist/themes/<name>.css` plus the style preset file (glass) when its style is
 * not flat. A custom theme's CSS is `themeCss(resolved, base)` plus the same preset. Custom values are checked so the CSS
 * is safe to inline in HTML: colours parse, no `<`, braces, semicolons, comments or `url(`.
 */
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { contrast, fixes as pwFixes, resolveTheme, SEEDS, themeCss } from "@pw/ui/theme";
import type { ThemesRepo } from "./db.ts";
import { ServiceError } from "./errors.ts";
import type { Logger } from "./log.ts";
import type { CustomTheme, ModeValues, ResolvedColours, ThemeCheck, ThemeInfo } from "../shared/types.ts";
import { TOKEN_CHOICES } from "../shared/theme-tokens.ts";

let pkgDir: string | undefined;

/** The @pw/ui package directory (the real path behind the `file:` link). */
function pwUiDir(): string {
  if (!pkgDir) pkgDir = dirname(createRequire(import.meta.url).resolve("@pw/ui/package.json"));
  return pkgDir;
}

/** Theme names: PW names are lowercase words joined by hyphens. */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A custom theme name must start with a letter (the pw-ui rule for theme names). */
const CUSTOM_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const STYLE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN_REF = /^\{[a-z0-9-]{1,64}\}$/;
const MAX_VALUE = 300;
const MAX_ENTRIES = 400;
/** The fallback when the stored theme no longer exists. */
export const FALLBACK_THEME = "precision-weave-neon";

type Resolved = ReturnType<typeof resolveTheme>;
type Source = { readonly [key: string]: unknown };

export interface ThemeDefinitionInput {
  readonly seeds?: { readonly [seed: string]: ModeValues<string> | string | null };
  readonly tokens?: { readonly [token: string]: ModeValues | string | number | null };
}

function safeValue(what: string, v: unknown): string | number {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ServiceError("invalid", `${what}: the number must be finite`);
    return v;
  }
  if (typeof v !== "string") throw new ServiceError("invalid", `${what}: a value is a string or a number`);
  if (v.trim() === "" || v.length > MAX_VALUE) throw new ServiceError("invalid", `${what}: a value is 1..${MAX_VALUE} characters`);
  if (TOKEN_REF.test(v)) return v;
  // eslint-disable-next-line no-control-regex
  if (/[<>{};\\\u0000-\u001f]|\/\*|\*\/|url\(|@import|expression\(/i.test(v)) {
    throw new ServiceError("invalid", `${what}: the value contains characters a theme value may not have`);
  }
  return v;
}

function modeValues(what: string, raw: unknown): ModeValues | string | number {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const out: { light?: string | number; dark?: string | number } = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k !== "light" && k !== "dark") throw new ServiceError("invalid", `${what}: use light and dark, not ${k}`);
      if (v === undefined || v === null) continue;
      out[k] = safeValue(`${what} (${k})`, v);
    }
    if (out.light === undefined && out.dark === undefined) throw new ServiceError("invalid", `${what}: give a light or a dark value`);
    return out;
  }
  return safeValue(what, raw);
}

/** Normalise one entry to per-mode form (a single value applies to both modes). */
function perMode(v: ModeValues | string | number): { light?: string | number; dark?: string | number } {
  if (typeof v === "object") return { ...v };
  return { light: v, dark: v };
}

/** Merge an input over stored seeds or tokens: `null` deletes an entry, a mode object merges per mode. */
function mergeEntries(
  what: string,
  stored: { readonly [k: string]: ModeValues | string | number },
  input: { readonly [k: string]: unknown } | undefined,
  nameOk: (k: string) => boolean,
): { [k: string]: ModeValues | string | number } {
  const out: { [k: string]: ModeValues | string | number } = { ...stored };
  if (input === undefined) return out;
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ServiceError("invalid", `${what} must be an object`);
  for (const [k, raw] of Object.entries(input)) {
    if (!nameOk(k)) throw new ServiceError("invalid", `${what}: unknown name ${JSON.stringify(k).slice(0, 80)}`);
    if (raw === null) {
      delete out[k];
      continue;
    }
    const next = modeValues(`${what} ${k}`, raw);
    const prev = stored[k];
    out[k] = typeof next === "object" && prev !== undefined ? { ...perMode(prev), ...next } : next;
  }
  if (Object.keys(out).length > MAX_ENTRIES) throw new ServiceError("invalid", `${what}: at most ${MAX_ENTRIES} entries`);
  return out;
}

function cleanTitle(title: string, fallback: string): string {
  const t = title.trim();
  if (t === "") return fallback;
  // eslint-disable-next-line no-control-regex
  if (t.length > 80 || /[<>{}\\\u0000-\u001f]|\*\//.test(t)) {
    throw new ServiceError("invalid", "title: at most 80 characters, without < > { } \\ or */");
  }
  return t;
}

export class ThemeStore {
  private readonly log: Logger;
  private readonly repo: ThemesRepo | undefined;
  private pw = new Map<string, { src: Source }>();
  private custom = new Map<string, CustomTheme>();
  private flat: Record<string, never> | undefined;
  private readonly styleJson = new Map<string, Record<string, never> | null>();
  private readonly styleCss = new Map<string, string>();
  private readonly resolved = new Map<string, Resolved>();
  private css = "";
  private active = "";

  constructor(opts: { log: Logger; repo?: ThemesRepo }) {
    this.log = opts.log;
    this.repo = opts.repo;
  }

  /** Read the PW sources, the base tokens and the stored custom themes. Call once before use. */
  async init(): Promise<void> {
    const dir = join(pwUiDir(), "themes");
    const pw = new Map<string, { src: Source }>();
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()) {
      const name = file.slice(0, -".json".length);
      if (!NAME.test(name)) continue;
      pw.set(name, { src: JSON.parse(await readFile(join(dir, file), "utf8")) as Source });
    }
    this.pw = pw;
    this.flat = (JSON.parse(await readFile(join(pwUiDir(), "dist", "tokens.json"), "utf8")) as { tokens: Record<string, never> }).tokens;
    for (const t of this.repo?.list() ?? []) this.custom.set(t.name, t);
    await this.prepare();
  }

  // --- reading -----------------------------------------------------------------------------------------------

  has(name: string): boolean {
    return this.pw.has(name) || this.custom.has(name);
  }

  names(): string[] {
    return [...this.pw.keys(), ...this.custom.keys()];
  }

  isCustom(name: string): boolean {
    return this.custom.has(name);
  }

  definition(name: string): CustomTheme | undefined {
    return this.custom.get(name);
  }

  /** PW themes first (file order), then custom themes (creation order). */
  list(): ThemeInfo[] {
    const out: ThemeInfo[] = [];
    for (const [name, { src }] of this.pw) {
      out.push({ name, title: typeof src.title === "string" ? src.title : name, kind: "pw", base: null, style: this.resolve(name).style ?? "flat", resolved: this.colours(name) });
    }
    for (const t of this.custom.values()) {
      out.push({ name: t.name, title: t.title, kind: "custom", base: t.base, style: this.resolve(t.name).style ?? "flat", definition: t, resolved: this.colours(t.name) });
    }
    return out;
  }

  /** The effective seed and token colours per mode (a seed's colour is the token of the same name). */
  private colours(name: string): ResolvedColours {
    const r = this.resolve(name);
    const pick = (keys: readonly string[]): { [k: string]: ModeValues<string> } => {
      const out: { [k: string]: ModeValues<string> } = {};
      for (const k of keys) {
        const light = r.values?.light?.[k];
        const dark = r.values?.dark?.[k];
        if (light === undefined && dark === undefined) continue;
        out[k] = { ...(light === undefined ? {} : { light: String(light) }), ...(dark === undefined ? {} : { dark: String(dark) }) };
      }
      return out;
    };
    return { seeds: pick(SEEDS), tokens: pick(TOKEN_CHOICES) };
  }

  info(name: string): ThemeInfo {
    const found = this.list().find((t) => t.name === name);
    if (!found) throw new ServiceError("not_found", `no such theme: ${name}`);
    return found;
  }

  private themeMap(extra?: CustomTheme): Map<string, { src: Source }> {
    const map = new Map(this.pw);
    for (const t of this.custom.values()) map.set(t.name, { src: { title: t.title, extends: t.base, seeds: t.seeds, tokens: t.tokens } });
    if (extra) map.set(extra.name, { src: { title: extra.title, extends: extra.base, seeds: extra.seeds, tokens: extra.tokens } });
    return map;
  }

  /** `bases(style)` as pw-ui's own themeBases() does it: the flat tokens, plus the preset's tokens for a preset. */
  private bases = (style: string): Record<string, never> | null => {
    if (style === "flat") return this.flat ?? null;
    if (!STYLE.test(style)) return null;
    const cached = this.styleJson.get(style);
    if (cached !== undefined) return cached;
    // Presets are loaded by `prepare()` (called from init) so this stays synchronous.
    return null;
  };

  /** Load every style preset the PW themes use (and `glass`), so `bases` is synchronous afterwards. */
  private async loadStyle(style: string): Promise<void> {
    if (style === "flat" || !STYLE.test(style) || this.styleJson.has(style)) return;
    try {
      const j = JSON.parse(await readFile(join(pwUiDir(), "dist", "styles", `${style}.json`), "utf8")) as { tokens: Record<string, never> };
      this.styleJson.set(style, { ...this.flat, ...j.tokens } as Record<string, never>);
    } catch {
      this.styleJson.set(style, null);
    }
    try {
      this.styleCss.set(style, await readFile(join(pwUiDir(), "dist", "styles", `${style}.css`), "utf8"));
    } catch (err) {
      this.log.warn("theme.style_missing", { style, error: err });
    }
  }

  /** Loads the presets named anywhere in the PW sources (and glass). */
  async prepare(): Promise<void> {
    const styles = new Set<string>(["glass"]);
    for (const { src } of this.pw.values()) if (typeof src.style === "string") styles.add(src.style);
    for (const s of styles) await this.loadStyle(s);
    this.resolved.clear();
  }

  private resolve(name: string, extra?: CustomTheme): Resolved {
    if (!extra) {
      const hit = this.resolved.get(name);
      if (hit) return hit;
    }
    const r = resolveTheme(name, this.themeMap(extra), this.bases as never);
    if (!extra) this.resolved.set(name, r);
    return r;
  }

  private baseOf(r: Resolved): Record<string, never> {
    return (this.bases(r.style) ?? this.flat ?? {}) as Record<string, never>;
  }

  // --- check, fixes, CSS ---------------------------------------------------------------------------------------

  check(name: string): ThemeCheck {
    if (!this.has(name)) throw new ServiceError("not_found", `no such theme: ${name}`);
    return this.checkOf(name, this.resolve(name));
  }

  private checkOf(name: string, r: Resolved): ThemeCheck {
    if (r.problems.length > 0) return { name, warnings: [], fixes: [], problems: [...r.problems] };
    const base = this.baseOf(r);
    return {
      name,
      warnings: contrast(r, base as never),
      fixes: pwFixes(r, base as never).map((f) => ({ mode: f.mode, token: f.token, from: String(f.from), to: String(f.to) })),
      problems: [],
    };
  }

  /** The full CSS of a theme: tokens + style preset. */
  async cssOf(name: string, extra?: CustomTheme): Promise<string> {
    if (!extra && !this.has(name)) throw new ServiceError("not_found", `no such theme: ${name}`);
    const r = this.resolve(name, extra);
    if (r.problems.length > 0) throw new ServiceError("invalid", r.problems[0]!);
    await this.loadStyle(r.style);
    let tokens: string | undefined;
    if (this.pw.has(name) && !extra) {
      try {
        tokens = await readFile(join(pwUiDir(), "dist", "themes", `${name}.css`), "utf8");
      } catch {
        tokens = undefined;
      }
    }
    tokens ??= themeCss(r as never, this.baseOf(r) as never);
    const preset = r.style !== "flat" ? this.styleCss.get(r.style) : undefined;
    return preset ? `${tokens}\n${preset}` : tokens;
  }

  // --- the active theme ------------------------------------------------------------------------------------------

  /** Render `name`, make it the active theme and cache its CSS. */
  async activate(name: string): Promise<string> {
    const css = await this.cssOf(name);
    this.setActive(name, css);
    return css;
  }

  /** Make `name` the active theme with CSS rendered earlier by `cssOf` (the Service renders before it commits). */
  setActive(name: string, css: string): void {
    this.css = css;
    this.active = name;
    this.log.info("theme.loaded", { theme: name, style: this.resolve(name).style, bytes: css.length });
  }

  /** The theme to fall back to when the active one is gone: Neon, else the first PW theme. */
  fallback(): string {
    return this.pw.has(FALLBACK_THEME) ? FALLBACK_THEME : [...this.pw.keys()][0] ?? FALLBACK_THEME;
  }

  /** The cached CSS of the active theme, "" before the first activate. */
  activeCss(): string {
    return this.css;
  }

  activeName(): string {
    return this.active;
  }

  // --- custom themes ---------------------------------------------------------------------------------------------

  /** Validate a candidate definition by resolving it; throws `invalid` with pw-ui's first problem. */
  private validated(t: CustomTheme): CustomTheme {
    const r = this.resolve(t.name, t);
    if (r.problems.length > 0) throw new ServiceError("invalid", r.problems[0]!);
    return t;
  }

  /**
   * Create a custom theme on a PW base. A repeat with the same content (a replayed tool call) returns the stored theme;
   * the same name with other content is `conflict`.
   */
  create(input: { name: string; title?: string; base: string } & ThemeDefinitionInput): { theme: CustomTheme; created: boolean } {
    const { name } = input;
    if (typeof name !== "string" || !CUSTOM_NAME.test(name)) {
      throw new ServiceError("invalid", "name: lowercase letters, digits and hyphens, starting with a letter, at most 64 characters");
    }
    if (this.pw.has(name)) throw new ServiceError("conflict", `${name} is a Precision Weave theme name`);
    if (typeof input.base !== "string" || !this.pw.has(input.base)) {
      throw new ServiceError("invalid", `base must be a Precision Weave theme (${[...this.pw.keys()].join(", ")})`);
    }
    const seeds = mergeEntries("seeds", {}, input.seeds, (k) => (SEEDS as string[]).includes(k)) as CustomTheme["seeds"];
    const tokens = mergeEntries("tokens", {}, input.tokens, (k) => TOKEN_NAME.test(k)) as CustomTheme["tokens"];
    const theme: CustomTheme = { name, title: cleanTitle(input.title ?? "", name), base: input.base, seeds, tokens };
    const existing = this.custom.get(name);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(theme)) return { theme: existing, created: false };
      throw new ServiceError("conflict", `a custom theme named ${name} exists; use set_theme_values to change it`);
    }
    this.validated(theme);
    if (this.repo && !this.repo.insert(theme)) throw new ServiceError("conflict", `a custom theme named ${name} exists`);
    this.custom.set(name, theme);
    this.resolved.clear();
    return { theme, created: true };
  }

  /** Merge seeds and tokens into a custom theme (`null` deletes an entry). */
  setValues(name: string, input: ThemeDefinitionInput & { title?: string }): CustomTheme {
    const cur = this.requireCustom(name);
    const theme: CustomTheme = {
      name,
      title: input.title !== undefined ? cleanTitle(input.title, cur.title) : cur.title,
      base: cur.base,
      seeds: mergeEntries("seeds", cur.seeds, input.seeds, (k) => (SEEDS as string[]).includes(k)) as CustomTheme["seeds"],
      tokens: mergeEntries("tokens", cur.tokens, input.tokens, (k) => TOKEN_NAME.test(k)) as CustomTheme["tokens"],
    };
    if (JSON.stringify(theme) === JSON.stringify(cur)) return cur;
    this.validated(theme);
    this.repo?.update(theme);
    this.custom.set(name, theme);
    this.resolved.clear();
    return theme;
  }

  /** Apply pw-ui's fixes for a custom theme as token overrides; returns the theme and the fixes applied. */
  fix(name: string): { theme: CustomTheme; applied: ThemeCheck["fixes"] } {
    const cur = this.requireCustom(name);
    const check = this.check(name);
    if (check.problems.length > 0) throw new ServiceError("invalid", check.problems[0]!);
    if (check.fixes.length === 0) return { theme: cur, applied: [] };
    const tokens: { [k: string]: ModeValues | string | number } = { ...cur.tokens };
    for (const f of check.fixes) {
      if (f.mode !== "light" && f.mode !== "dark") continue;
      const prev = tokens[f.token];
      tokens[f.token] = { ...(prev === undefined ? {} : perMode(prev)), [f.mode]: f.to };
    }
    const theme: CustomTheme = { ...cur, tokens: tokens as CustomTheme["tokens"] };
    this.validated(theme);
    this.repo?.update(theme);
    this.custom.set(name, theme);
    this.resolved.clear();
    return { theme, applied: check.fixes };
  }

  delete(name: string): void {
    this.requireCustom(name);
    this.repo?.delete(name);
    this.custom.delete(name);
    this.resolved.clear();
  }

  private requireCustom(name: string): CustomTheme {
    const t = this.custom.get(name);
    if (t) return t;
    if (this.pw.has(name)) throw new ServiceError("invalid", `${name} is a Precision Weave theme and is read-only; create a custom theme from it first`);
    throw new ServiceError("not_found", `no such theme: ${name}`);
  }
}

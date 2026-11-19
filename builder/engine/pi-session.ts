/**
 * Reading a pi session log (JSONL): the entries, their message type and tools, summary metrics, and the filter and
 * sort the Builder > Sessions view and the agent's session tools share. Pure: no Node or browser APIs.
 */

export type Kind = "session" | "meta" | "system" | "user" | "assistant" | "tool" | "tool-error" | "other";
export type Rec = Record<string, unknown>;

export const KIND_LABEL: Record<Kind, string> = {
  session: "session",
  meta: "config",
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool result",
  "tool-error": "tool error",
  other: "other",
};

export const KINDS = Object.keys(KIND_LABEL) as Kind[];

export interface Entry {
  /** 1-based line number in the file. */
  n: number;
  obj: Rec;
  ts: number;
  kind: Kind;
  /** Names of the tools this entry calls (assistant) or answers (tool result). */
  tools: string[];
}

export const rec = (v: unknown): Rec => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : {});
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export const parts = (message: Rec): Rec[] => (Array.isArray(message.content) ? message.content.map(rec) : []);
export const clip = (s: string, n = 600): string => (s.length > n ? `${s.slice(0, n)}…` : s);
export const textOf = (message: Rec): string =>
  parts(message)
    .filter((p) => p.type === "text")
    .map((p) => str(p.text))
    .join("\n");

export function kindOf(obj: Rec): Kind {
  const type = str(obj.type);
  if (type === "session") return "session";
  if (type === "model_change" || type === "thinking_level_change") return "meta";
  if (type !== "message") return "other";
  const message = rec(obj.message);
  const role = str(message.role);
  if (role === "system" || role === "user" || role === "assistant") return role;
  if (role === "toolResult") return message.isError === true ? "tool-error" : "tool";
  return "other";
}

export function toolsOf(obj: Rec, kind: Kind): string[] {
  const message = rec(obj.message);
  if (kind === "tool" || kind === "tool-error") return str(message.toolName) ? [str(message.toolName)] : [];
  if (kind !== "assistant") return [];
  return [...new Set(parts(message).filter((p) => p.type === "toolCall").map((p) => str(p.name)))];
}

export function parseSession(content: string): Entry[] {
  const entries: Entry[] = [];
  let last = 0;
  content.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let obj: Rec;
    try {
      obj = rec(JSON.parse(line));
    } catch {
      obj = { type: "unparsable", line };
    }
    const parsed = Date.parse(str(obj.timestamp));
    const ts = Number.isNaN(parsed) ? last : parsed;
    last = ts;
    const kind = kindOf(obj);
    entries.push({ n: i + 1, obj, ts, kind, tools: toolsOf(obj, kind) });
  });
  return entries;
}

export function argSummary(name: string, args: Rec): string {
  if (name === "bash") return str(args.command);
  const path = str(args.path) || str(args.file_path);
  if (path) return path;
  const json = JSON.stringify(args);
  return json === "{}" ? "" : json;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const fmtNum = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

export interface Metrics {
  entries: number;
  durationMs: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  input: number;
  output: number;
  cacheRead: number;
  /** Sum of each turn's `cost.total` as recorded in the log. */
  cost: number;
  model: string;
  topTools: [string, number][];
}

export function metricsOf(entries: Entry[]): Metrics {
  const m: Metrics = { entries: entries.length, durationMs: 0, turns: 0, toolCalls: 0, toolErrors: 0, input: 0, output: 0, cacheRead: 0, cost: 0, model: "", topTools: [] };
  const tools = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === "tool-error") m.toolErrors += 1;
    if (e.kind === "meta" && str(e.obj.modelId)) m.model = `${str(e.obj.provider)}/${str(e.obj.modelId)}`;
    if (e.kind !== "assistant") continue;
    m.turns += 1;
    const message = rec(e.obj.message);
    const usage = rec(message.usage);
    m.input += num(usage.input);
    m.output += num(usage.output);
    m.cacheRead += num(usage.cacheRead);
    m.cost += num(rec(usage.cost).total);
    for (const p of parts(message)) {
      if (p.type !== "toolCall") continue;
      m.toolCalls += 1;
      tools.set(str(p.name), (tools.get(str(p.name)) ?? 0) + 1);
    }
  }
  const stamps = entries.map((e) => e.ts).filter((t) => t > 0);
  m.durationMs = stamps.length ? Math.max(...stamps) - Math.min(...stamps) : 0;
  m.topTools = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return m;
}

export interface EntryFilter {
  /** Any of these message types; empty or absent = all. */
  kinds?: ReadonlySet<Kind> | readonly Kind[];
  /** Any of these tools; empty or absent = all. */
  tools?: ReadonlySet<string> | readonly string[];
  /** Case-insensitive text found anywhere in the raw entry. */
  text?: string;
  newestFirst?: boolean;
}

const has = <T>(set: ReadonlySet<T> | readonly T[] | undefined, v: T): boolean => (set === undefined ? true : Array.isArray(set) ? set.length === 0 || set.includes(v) : (set as ReadonlySet<T>).size === 0 || (set as ReadonlySet<T>).has(v));
const size = (set: ReadonlySet<unknown> | readonly unknown[] | undefined): number => (set === undefined ? 0 : Array.isArray(set) ? set.length : (set as ReadonlySet<unknown>).size);

/** The view's filter and sort: type AND tool AND text, ordered by timestamp (default newest first). */
export function filterEntries(entries: Entry[], f: EntryFilter = {}): Entry[] {
  const needle = (f.text ?? "").trim().toLowerCase();
  const toolFilter = size(f.tools) > 0;
  const rows = entries.filter(
    (e) => has(f.kinds, e.kind) && (!toolFilter || e.tools.some((t) => has(f.tools, t))) && (needle === "" || JSON.stringify(e.obj).toLowerCase().includes(needle)),
  );
  const newest = f.newestFirst ?? true;
  return rows.sort((a, b) => (newest ? b.ts - a.ts || b.n - a.n : a.ts - b.ts || a.n - b.n));
}

/** A plain-text rendering of one entry's content, for the agent. */
export function describeEntry(e: Entry, max = 240): string {
  const { obj } = e;
  const message = rec(obj.message);
  switch (e.kind) {
    case "session":
      return `session v${String(obj.version ?? "?")} in ${str(obj.cwd)}`;
    case "meta":
      return str(obj.type) === "model_change" ? `model ${str(obj.provider)}/${str(obj.modelId)}` : `thinking level ${str(obj.thinkingLevel)}`;
    case "system":
      return `system prompt sections: ${Object.keys(rec(message.sections)).join(", ") || "(none)"}`;
    case "user":
      return clip(textOf(message).replace(/\s+/g, " "), max);
    case "tool":
    case "tool-error":
      return `${str(message.toolName)}${num(message.durationMs) > 0 ? ` (${num(message.durationMs)}ms)` : ""}: ${clip(textOf(message).replace(/\s+/g, " "), max) || "(no output)"}`;
    case "assistant":
      return parts(message)
        .map((p) => {
          if (p.type === "thinking") return `[thinking] ${clip(str(p.thinking).replace(/\s+/g, " "), max)}`;
          if (p.type === "text") return clip(str(p.text).replace(/\s+/g, " "), max);
          if (p.type === "toolCall") return `call ${str(p.name)}: ${clip(argSummary(str(p.name), rec(p.arguments)).replace(/\s+/g, " "), max)}`;
          return "";
        })
        .filter(Boolean)
        .join(" | ");
    default:
      return str(obj.type);
  }
}

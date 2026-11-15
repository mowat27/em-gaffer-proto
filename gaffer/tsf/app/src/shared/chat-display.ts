/**
 * Display rules for the agent pane: finding entries, the one-line text of a tool step or queued message, and the model
 * line under an answer. Pure, so the rules are unit-tested without a DOM.
 */
import type { ChatItem, ChatUsage } from "./types.ts";

/** Everything an entry can be found by: its words, and for a tool call its name, arguments and result. */
export function itemText(item: ChatItem): string {
  switch (item.kind) {
    case "user":
    case "assistant":
    case "event":
      return item.text;
    case "cron":
      return `${item.name} ${item.text}`;
    case "tool":
      return `${item.name} ${JSON.stringify(item.args ?? null)} ${item.output ?? ""}`;
  }
}

/** Item id -> its searchable text in lower case. Built once per item list, not per keystroke. */
export type FindIndex = ReadonlyMap<string, string>;

export function buildFindIndex(items: readonly ChatItem[]): FindIndex {
  return new Map(items.map((item) => [item.id, itemText(item).toLowerCase()]));
}

/** The items whose text holds `query`, case-insensitively, in order. A blank query keeps everything. */
export function findItems(items: readonly ChatItem[], index: FindIndex, query: string): readonly ChatItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter((item) => (index.get(item.id) ?? itemText(item).toLowerCase()).includes(needle));
}

/** The count line under the find box. "Loaded" says the search covers only what the pane holds. */
export function findSummary(query: string, matched: number, total: number, hasEarlier: boolean): string {
  const q = query.trim();
  if (matched === 0) {
    return hasEarlier ? `No loaded entry holds "${q}". Load earlier messages to search further back.` : `No entry holds "${q}".`;
  }
  return `${matched} of ${total} ${hasEarlier ? "loaded " : ""}${total === 1 ? "entry" : "entries"} ${matched === 1 ? "matches" : "match"}.`;
}

/** `cd <dir> && npm test` -> `npm test`. Display only: the command that ran is unchanged. */
export function withoutCd(command: string): string {
  const match = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*&&\s*(\S[\s\S]*)$/.exec(command);
  return match?.[1] ?? command;
}

/** The first non-blank line, trimmed and cut to `max` characters with an ellipsis. */
export function firstLine(text: string, max: number): string {
  const line = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The one-line note of a tool step: its first short string argument, with a leading `cd … &&` dropped from a command. */
export function toolArgNote(args: unknown, max = 80): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "from", "command", "query", "name", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      const one = firstLine(key === "command" ? withoutCd(value) : value, max);
      if (one !== "") return one;
    }
  }
  return undefined;
}

/** What Copy puts on the clipboard for a step's arguments: the full command when there is one, so it can be rerun; else the JSON. */
export function copyableArgs(args: unknown): string {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const command = (args as Record<string, unknown>).command;
    if (typeof command === "string" && command.trim() !== "") return command;
  }
  return JSON.stringify(args ?? null, null, 2);
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} min ${Math.round((ms % 60_000) / 1_000)} s`;
}

/** Dollars: four decimals below a dollar, so a cheap turn does not read "$0.00"; two from a dollar up. */
export function money(usd: number): string {
  if (!(usd > 0)) return "$0.00";
  return `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)}`;
}

/**
 * The line under an answer: the model without its provider and the elapsed time ("claude-5 · 4.2 s"). The tooltip adds
 * the provider, the tokens and the cost when it is above zero. Null when there is nothing to say.
 */
export function answerMeta(item: { readonly model?: string; readonly durationMs?: number; readonly usage?: ChatUsage }): { text: string; title: string } | null {
  const short = item.model ? (item.model.split("/").at(-1) ?? item.model) : null;
  const elapsed = item.durationMs !== undefined ? formatDuration(item.durationMs) : null;
  const text = [short, elapsed].filter((p): p is string => p !== null && p !== "").join(" · ");
  if (text === "") return null;
  const slash = item.model?.indexOf("/") ?? -1;
  const detail: string[] = [];
  if (item.model) detail.push(slash > 0 ? `${item.model.slice(0, slash)}: ${item.model.slice(slash + 1)}` : item.model);
  if (item.usage) detail.push(`${item.usage.input.toLocaleString("en")} tokens in, ${item.usage.output.toLocaleString("en")} out`);
  if (item.usage && item.usage.costUsd > 0) detail.push(money(item.usage.costUsd));
  if (elapsed) detail.push(elapsed);
  return { text, title: detail.join(" · ") };
}

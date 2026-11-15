/**
 * What the agent is doing, derived from the live chat view. One derivation feeds the status chip, the collapsed rail,
 * the agent header's Stop and the browser tab, so they never disagree. Pure: unit-tested without a DOM.
 */
import type { ChatLive } from "./types.ts";

export type AgentState = "idle" | "working" | "retrying" | "compacting";
/** What a working agent is busy with. `thinking` is a stream with no text yet. */
export type AgentDoing = "waiting" | "thinking" | "writing" | "tools";

export interface AgentActivity {
  readonly state: AgentState;
  readonly doing: AgentDoing | null;
  readonly busy: boolean;
  /** A run is live or messages are queued: Stop has something to stop. */
  readonly canStop: boolean;
  /** The chip and tab words: "Idle", "Working · tools", "Retrying". */
  readonly short: string;
  /** One sentence for a tooltip and for the rail dot, which shows no words. */
  readonly detail: string;
}

const STATE_LABEL: Record<AgentState, string> = { idle: "Idle", working: "Working", retrying: "Retrying", compacting: "Compacting" };

const DOING_DETAIL: Record<AgentDoing, string> = {
  waiting: "The agent is waiting for the model",
  thinking: "The agent is thinking before it writes",
  writing: "The agent is writing the answer",
  tools: "The agent is running tools",
};

const IDLE: AgentActivity = { state: "idle", doing: null, busy: false, canStop: false, short: "Idle", detail: "The agent is idle" };

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function doingOf(live: ChatLive): AgentDoing | null {
  switch (live.phase) {
    case "waiting":
      return "waiting";
    case "streaming":
      return (live.streaming?.text ?? "").trim() === "" ? "thinking" : "writing";
    case "tools":
      return "tools";
    default:
      return null;
  }
}

function detailOf(live: ChatLive, state: AgentState, doing: AgentDoing | null): string {
  if (state === "retrying") return live.retry ? `The agent is retrying after a failure (${clip(live.retry.error, 80)})` : "The agent is retrying after a failure";
  if (state === "compacting") return "The agent is compacting the conversation";
  if (doing === null) return "The agent is working";
  if (doing === "tools" && live.tools.length > 0) {
    const names = live.tools.map((t) => t.name);
    return `${DOING_DETAIL.tools} (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""})`;
  }
  return DOING_DETAIL[doing];
}

export function agentActivity(live: ChatLive | null | undefined): AgentActivity {
  if (!live) return IDLE;
  const canStop = live.busy || live.inbox.length > 0;
  if (!live.busy) return canStop ? { ...IDLE, canStop } : IDLE;
  const state: AgentState = live.phase === "retrying" ? "retrying" : live.phase === "compacting" ? "compacting" : "working";
  const doing = state === "working" ? doingOf(live) : null;
  return {
    state,
    doing,
    busy: true,
    canStop,
    short: doing === null ? STATE_LABEL[state] : `${STATE_LABEL[state]} · ${doing}`,
    detail: detailOf(live, state, doing),
  };
}

/** What `index.html` ships, and the tab text when nothing else is known. */
export const APP_TITLE = "Tiny Software Factory";

/** "Notes/Plan.md" -> "Notes/Plan". */
export function pageLabel(path: string | null | undefined): string | null {
  if (!path) return null;
  const label = path.replace(/\.md$/i, "");
  return label === "" ? null : label;
}

/**
 * The browser tab: "Working · tools — Notes/Plan · my-factory" while the agent works, "Notes/Plan · my-factory" when it
 * does not. The agent's words lead because a browser cuts a tab title from the right.
 */
export function documentTitle(input: { readonly page: string | null; readonly factory: string | null; readonly agent: string | null }): string {
  const where = [input.page, input.factory].filter((p): p is string => p !== null && p !== "").join(" · ");
  const base = where === "" ? APP_TITLE : where;
  return input.agent ? `${input.agent} — ${base}` : base;
}

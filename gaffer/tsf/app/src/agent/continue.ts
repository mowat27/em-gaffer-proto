/**
 * Auto-continue (DESIGN 7, T3): when the newest run ended `interrupted` (the generation's retries ran out across
 * crashes) and the conversation is idle, submit one `continue` with requestId `continue:<runTaskId>`. pi-durable dedupes
 * by requestId, so a repeat is harmless; `ConversationBusy` is ignored. `restart_limit` is not continued (a crash loop).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationView } from "@earendil-works/pi-durable";
import type { Logger } from "../core/log.ts";
import type { ChatFeed } from "./feed.ts";

/** The task id of an interrupted run waiting to be continued, from a raw view. */
export function interruptedRun(value: ConversationView): number | undefined {
  const live = value.docs["pi.live"] as
    | { run?: unknown; runFailure?: { reason?: unknown; taskId?: unknown } }
    | undefined;
  if (!live || live.run !== undefined) return undefined;
  const failure = live.runFailure;
  if (!failure || failure.reason !== "interrupted" || typeof failure.taskId !== "number") return undefined;
  return failure.taskId;
}

export function startAutoContinue(feed: ChatFeed, main: Conversation, log: Logger): () => void {
  const done = new Set<number>();
  let stopped = false;

  const check = (value: ConversationView): void => {
    if (stopped) return;
    const taskId = interruptedRun(value);
    if (taskId === undefined || done.has(taskId)) return;
    done.add(taskId);
    const requestId = `continue:${taskId}`;
    log.info("agent.auto_continue", { requestId });
    void main.submit({ type: "continue", requestId }, BACKGROUND_CONTEXT).catch((err: unknown) => {
      const name = err instanceof Error ? err.name : "";
      if (name === "ConversationBusy") return;
      log.error("agent.auto_continue_failed", { requestId, error: err });
    });
  };

  const unsubscribe = feed.onCommit((c) => check(c.value));
  check(feed.current().value);
  return () => {
    stopped = true;
    unsubscribe();
  };
}

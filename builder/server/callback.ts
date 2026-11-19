/** The callback: one result per job, retried with backoff until the gaffer answers 204 or 410. */
import type { Emit } from "../runtime/types.ts";

export type ContractResult = { outcome: "done"; patch: string } | { outcome: "failed"; reason: string };

/** POST `body` to `url`; on anything but 204 or 410, retry `retries` more times (backoff 1, 2, 4 ... s, capped at 30). */
export async function postCallback(url: string, body: ContractResult, retries: number, emit: Emit): Promise<void> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 204) {
        emit("callback.ok", "result accepted by the gaffer (204)");
        return;
      }
      if (res.status === 410) {
        emit("callback.gone", "gaffer answered 410: result discarded");
        return;
      }
      emit("callback.retry", `callback answered HTTP ${res.status}, retrying`, { status: res.status, try: i + 1 });
    } catch (err) {
      emit("callback.retry", `callback failed: ${(err as Error).message}, retrying`, { try: i + 1 });
    }
    await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** i)));
  }
  emit("callback.abandoned", `callback to ${url} abandoned after ${retries + 1} tries`);
}

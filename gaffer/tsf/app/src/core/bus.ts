import type { AppBus, AppEvent } from "../shared/events.ts";
import type { Logger } from "./log.ts";

/** The in-process event bus. Listeners run synchronously in subscription order; a throwing listener is logged and skipped. */
export function createBus(log: Logger): AppBus {
  const listeners = new Set<(event: AppEvent) => void>();
  return {
    publish(event) {
      for (const fn of [...listeners]) {
        try {
          fn(event);
        } catch (err) {
          log.error("bus.listener_error", { type: event.type, error: err });
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

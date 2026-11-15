import { useSyncExternalStore } from "react";

let selected: string | null = null;
const listeners = new Set<() => void>();

export function selectPiAgentFile(path: string): void {
  selected = path;
  for (const listener of listeners) listener();
}

export function usePiAgentFile(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => selected,
    () => selected,
  );
}

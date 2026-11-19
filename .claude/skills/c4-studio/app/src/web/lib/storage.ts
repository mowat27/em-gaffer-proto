import { useCallback, useState } from 'react';

/** Per-viewer convenience state in localStorage. Every access is guarded: storage can be missing or throw. */
export function useStoredState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [value, set];
}

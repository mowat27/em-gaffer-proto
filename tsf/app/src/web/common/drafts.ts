/**
 * Client-only drafts that survive a refresh (DESIGN 11, "State"): text kept in `sessionStorage` under a key, such as
 * the composer (`tsf.draft.composer`) and the focus editor (`tsf.draft.page:<path>`). Every storage access is in
 * try/catch: a failure only loses the draft. Clear a draft after its save or send returned 2xx.
 */
import { useCallback, useState } from "react";

function read(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    if (value === "") sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Storage full or blocked: the draft lives only in memory.
  }
}

/**
 * `[value, setValue, clear]` for the draft under `key`. Switching to another key loads that key's draft.
 * An empty value removes the stored entry.
 */
export function useDraft(key: string): [string, (value: string) => void, () => void] {
  const [draft, setDraft] = useState(() => ({ key, value: read(key) }));
  let current = draft;
  if (draft.key !== key) {
    current = { key, value: read(key) };
    setDraft(current);
  }
  const setValue = useCallback(
    (value: string) => {
      write(key, value);
      setDraft({ key, value });
    },
    [key],
  );
  const clear = useCallback(() => {
    write(key, "");
    setDraft({ key, value: "" });
  }, [key]);
  return [current.value, setValue, clear];
}

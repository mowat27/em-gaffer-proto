/**
 * Data hooks for the factory screens: a layer query re-read on that layer's `layer.changed` (and on an optional
 * poll), and an action runner with busy and error state. Everything goes through the layer routes, the same path the
 * agent's tools and the settings panels use.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Json } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { onDelta } from "../state/store.ts";

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useLayerQuery<T = Json>(layer: string, name: string, input: Json = {}, pollMs = 0): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inputKey = JSON.stringify(input);
  const alive = useRef(true);
  const read = useCallback(() => {
    api.layers.query(layer, name, JSON.parse(inputKey) as Json).then(
      (r) => {
        if (!alive.current) return;
        setData(r as T);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!alive.current) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
  }, [layer, name, inputKey]);
  useEffect(() => {
    alive.current = true;
    read();
    const stop = onDelta((d) => {
      if ((d.type === "layer.changed" && d.layer === layer) || d.type === "layers.changed") read();
    });
    const timer = pollMs > 0 ? setInterval(read, pollMs) : null;
    return () => {
      alive.current = false;
      stop();
      if (timer) clearInterval(timer);
    };
  }, [layer, read, pollMs]);
  return { data, error, loading, refresh: read };
}

export interface ActionState {
  run: (name: string, input?: Json) => Promise<Json | null>;
  busy: string | null;
  error: string | null;
  clearError: () => void;
}

export function useLayerAction(layer: string): ActionState {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (name: string, input: Json = {}): Promise<Json | null> => {
      setBusy(name);
      setError(null);
      try {
        return await api.layers.action(layer, name, input);
      } catch (err) {
        setError(errorMessage(err));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [layer],
  );
  return { run, busy, error, clearError: () => setError(null) };
}

/** Save several settings through `set_setting`, one call per changed key. */
export async function saveSettings(layer: string, changes: Record<string, Json>): Promise<void> {
  for (const [key, value] of Object.entries(changes)) {
    await api.layers.action(layer, "set_setting", { key, value });
  }
}

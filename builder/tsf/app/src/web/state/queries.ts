/**
 * Small fetch hooks for lists the snapshot does not carry (models, prompts). Each refetches when its counter in the
 * store moves (`revs.models` on `models.changed`, `revs.prompts` on `prompts.changed`), so no panel needs a reload.
 */
import { useCallback, useEffect, useState } from "react";
import type { ModelInfo } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { readPrompts, type PromptsView } from "../settings/p5-types.ts";
import { useFactory } from "./store.ts";

export interface Fetched<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

function useFetched<T>(load: () => Promise<T>, rev: number): Fetched<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    load().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(errorMessage(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
    // `load` is a stable module function per hook; the counters decide when to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

const loadModels = (): Promise<ModelInfo[]> => api.models.list();
const loadPrompts = async (): Promise<PromptsView> => readPrompts(await api.prompts.list());

export function useModels(): Fetched<ModelInfo[]> {
  return useFetched(loadModels, useFactory((s) => s.revs.models));
}

export function usePrompts(): Fetched<PromptsView> {
  return useFetched(loadPrompts, useFactory((s) => s.revs.prompts));
}

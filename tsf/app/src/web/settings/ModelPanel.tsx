/**
 * Settings > Core 4 > Model (spec 8.5): provider and model picker over the enabled provider layers, plus the thinking
 * level. A choice applies at once (the server calls `conversation.configure`); the page follows `settings.changed` and
 * `chat.meta`, so what the picker shows is what the agent uses.
 */
import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Alert, Button, Field, Input, Select, useToast } from "@pw/ui/react";
import { THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { tokens } from "../navbar/widgets.tsx";
import { useModels } from "../state/queries.ts";
import { useFactory } from "../state/store.ts";

/** Most options a model select shows at once; the filter narrows a longer list. */
const SHOWN = 300;

export function ModelPanel() {
  const models = useModels();
  const current = useFactory((s) => s.chat?.meta.model ?? s.settings?.model ?? null);
  const thinking = useFactory((s) => s.settings?.thinkingLevel ?? s.chat?.meta.thinkingLevel ?? "low");
  const { toast } = useToast();
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const list = models.data ?? [];
  const providers = useMemo(() => [...new Set(list.map((m) => m.provider))], [list]);
  const provider = picked ?? current?.provider ?? providers[0] ?? "";
  const ofProvider = list.filter((m) => m.provider === provider);
  const needle = filter.trim().toLowerCase();
  const matching = (needle === "" ? ofProvider : ofProvider.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(needle))).slice().sort((a, b) => a.name.localeCompare(b.name));
  const shown = matching.slice(0, SHOWN);
  const active: ModelInfo | undefined = current ? list.find((m) => m.provider === current.provider && m.id === current.modelId) : undefined;
  // Keep the chosen model in the list even when the filter hides it.
  const options = active && !shown.includes(active) && active.provider === provider ? [active, ...shown] : shown;
  const levels: readonly ThinkingLevel[] = active?.thinkingLevels ?? THINKING_LEVELS;

  const fail = (title: string) => (err: unknown) => toast({ tone: "error", title, description: errorMessage(err) });
  const refresh = (): void => {
    setRefreshing(true);
    api.models
      .refresh()
      .catch(fail("The model list was not refreshed"))
      .finally(() => setRefreshing(false));
  };

  return (
    <div className="tsf-set-panel" data-testid="panel-model">
      <section className="tsf-set-group" data-cap="models.list" data-testid="model-picker">
        <h3 className="tsf-set-h">Model</h3>
        {models.error !== null && (
          <Alert tone="error" title="The model list did not load">
            {models.error}
          </Alert>
        )}
        <div className="tsf-set-grid">
          <Field label="Provider">
            {(c) => (
              <Select
                {...c}
                value={provider}
                data-cap="model.set"
                data-testid="model-provider"
                onChange={(e) => {
                  setPicked(e.target.value);
                  setFilter("");
                }}
              >
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Filter models" optional>
            {(c) => <Input {...c} type="search" value={filter} placeholder="Type part of a name" data-testid="model-filter" onChange={(e) => setFilter(e.target.value)} />}
          </Field>
        </div>
        <Field label="Model" help={matching.length > SHOWN ? `Showing ${SHOWN} of ${matching.length}; filter to narrow.` : `${matching.length} models`}>
          {(c) => (
            <Select
              {...c}
              value={current && current.provider === provider ? current.modelId : ""}
              data-cap="model.set"
              data-testid="model-select"
              onChange={(e) => {
                const id = e.target.value;
                if (id === "") return;
                api.models.set({ provider, modelId: id }).then(() => setPicked(null), fail("The model was not changed"));
              }}
            >
              {!(current && current.provider === provider) && <option value="">Choose a model</option>}
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name === m.id ? m.id : `${m.name} (${m.id})`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="tsf-set-row">
          <Button variant="secondary" size="sm" icon={RefreshCw} loading={refreshing} loadingLabel="Refreshing" data-cap="models.refresh" data-testid="models-refresh" onClick={refresh}>
            Refresh the model list
          </Button>
        </div>
        {active && (
          <p className="tsf-set-note" data-testid="model-facts">
            {tokens(active.contextWindow)} token window, up to {tokens(active.maxTokens)} out, {active.reasoning ? "reasoning" : "no reasoning"}, source {active.source}.
          </p>
        )}
      </section>

      <section className="tsf-set-group">
        <h3 className="tsf-set-h">Thinking level</h3>
        <Field label="Thinking" help={active && !active.reasoning ? "This model does not reason; the level has no effect." : undefined}>
          {(c) => (
            <Select
              {...c}
              value={thinking}
              data-cap="thinking.set"
              data-testid="thinking-select"
              onChange={(e) => api.models.setThinking(e.target.value as ThinkingLevel).catch(fail("The thinking level was not changed"))}
            >
              {levels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
              {!levels.includes(thinking) && <option value={thinking}>{thinking}</option>}
            </Select>
          )}
        </Field>
        <p className="tsf-set-note" data-testid="thinking-current" data-level={thinking}>
          Thinking is <strong>{thinking}</strong>.
        </p>
      </section>
    </div>
  );
}

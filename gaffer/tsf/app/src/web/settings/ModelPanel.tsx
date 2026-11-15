/**
 * Settings > Core 4 > Model (spec 8.5). Four parts:
 * - the model in use, with its facts and a star;
 * - the favourites in order (the first three are the 1, 2 and 3 keys of the model_controls layer), each movable and
 *   removable, a favourite that is no longer offered marked and not choosable;
 * - every model of the enabled providers, searchable (each word against name, id, provider and vendor), grouped by
 *   vendor and sorted by name, with a favourites-only filter and the refresh;
 * - the thinking level as stored and, when the model lacks it, the level the model actually gets.
 * Every choice applies at once through the Service; the page follows `settings.changed`, `models.changed` and
 * `chat.meta`, so what it shows is what the agent uses.
 */
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, RefreshCw, Star, X } from "lucide-react";
import { Alert, Badge, Button, EmptyState, Field, FilterChip, IconButton, SearchInput, Select, useToast } from "@pw/ui/react";
import { clampLevel, favouriteList, groupByVendor, matchesQuery, sameRef, shortName, vendorLabel } from "../../shared/model-choice.ts";
import { THINKING_LEVELS, type FavouriteModel, type ModelInfo, type ModelRef, type ThinkingLevel } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { tokens } from "../lib/usage.ts";
import { useModels } from "../state/queries.ts";
import { useFactory } from "../state/store.ts";

const NO_FAVOURITES: readonly ModelRef[] = [];

export function ModelPanel() {
  const models = useModels();
  const list = models.data ?? [];
  const current = useFactory((s) => s.chat?.meta.model ?? s.settings?.model ?? null);
  const favourites = useFactory((s) => s.settings?.favouriteModels ?? NO_FAVOURITES);
  const thinking = useFactory((s) => s.settings?.thinkingLevel ?? s.chat?.meta.thinkingLevel ?? "low");
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [onlyFavourites, setOnlyFavourites] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fail = (title: string) => (err: unknown) => toast({ tone: "error", title, description: errorMessage(err) });
  const active: ModelInfo | undefined = current ? list.find((m) => m.provider === current.provider && m.id === current.modelId) : undefined;
  const isFavourite = (ref: ModelRef): boolean => favourites.some((f) => sameRef(f, ref));
  const choose = (ref: ModelRef): void => {
    api.models.set(ref).catch(fail("The model was not changed"));
  };
  const setFavourite = (ref: ModelRef, favourite: boolean, position?: number): void => {
    api.models
      .setFavourite({ provider: ref.provider, modelId: ref.modelId, favourite, ...(position !== undefined ? { position } : {}) })
      .catch(fail(favourite ? "The favourite was not saved" : "The favourite was not removed"));
  };
  const refresh = (): void => {
    setRefreshing(true);
    api.models
      .refresh()
      .catch(fail("The model list was not refreshed"))
      .finally(() => setRefreshing(false));
  };

  return (
    <div className="tsf-set-panel" data-testid="panel-model">
      {models.error !== null && (
        <Alert tone="error" title="The model list did not load">
          {models.error}
        </Alert>
      )}
      <CurrentModel model={active} current={current} favourite={current !== null && isFavourite(current)} onStar={(on) => current && setFavourite(current, on)} />
      <Favourites rows={favouriteList(favourites, list, null)} current={current} onChoose={choose} onFavourite={setFavourite} />
      <AllModels
        models={list}
        loading={models.loading && models.data === null}
        current={current}
        isFavourite={isFavourite}
        query={query}
        onQuery={setQuery}
        onlyFavourites={onlyFavourites}
        onOnlyFavourites={setOnlyFavourites}
        refreshing={refreshing}
        onRefresh={refresh}
        onChoose={choose}
        onFavourite={setFavourite}
      />
      <Thinking model={active} level={thinking} onChange={(l) => api.models.setThinking(l).catch(fail("The thinking level was not changed"))} />
    </div>
  );
}

function CurrentModel({ model, current, favourite, onStar }: { model: ModelInfo | undefined; current: ModelRef | null; favourite: boolean; onStar: (on: boolean) => void }) {
  return (
    <section className="tsf-set-group">
      <h3 className="tsf-set-h">Model in use</h3>
      <div className="tsf-model-current" data-testid="model-current">
        <div className="tsf-model-current-text">
          <span className="tsf-model-current-name" data-testid="model-current-name">
            {model ? model.name : (current?.modelId ?? "No model")}
          </span>
          {current && (
            <span className="tsf-model-sub">
              {current.modelId} · {current.provider}
            </span>
          )}
          {model && (
            <span className="tsf-set-note" data-testid="model-facts">
              {tokens(model.contextWindow)} token window, up to {tokens(model.maxTokens)} out, {model.reasoning ? "reasoning" : "no reasoning"}, source {model.source}.
            </span>
          )}
        </div>
        {model && (
          <Button variant="secondary" size="sm" icon={Star} aria-pressed={favourite} data-cap="model.favourite" data-testid="model-current-star" onClick={() => onStar(!favourite)}>
            {favourite ? "Favourite" : "Add to favourites"}
          </Button>
        )}
      </div>
    </section>
  );
}

function Favourites({
  rows,
  current,
  onChoose,
  onFavourite,
}: {
  rows: readonly FavouriteModel[];
  current: ModelRef | null;
  onChoose: (ref: ModelRef) => void;
  onFavourite: (ref: ModelRef, favourite: boolean, position?: number) => void;
}) {
  return (
    <section className="tsf-set-group" data-cap="models.favourites" data-testid="model-favourites">
      <h3 className="tsf-set-h">Favourites</h3>
      <p className="tsf-set-note">The Model picker in the top bar lists these. Keys 1, 2 and 3 choose the first three.</p>
      {rows.length === 0 ? (
        <p className="tsf-set-note" data-testid="model-favourites-empty">
          No favourites yet. Star a model in the list below.
        </p>
      ) : (
        <ol className="tsf-model-favs">
          {rows.map((f, i) => {
            const ref = { provider: f.provider, modelId: f.modelId };
            const inUse = sameRef(ref, current);
            return (
              <li key={`${f.provider}/${f.modelId}`} className="tsf-model-fav" data-testid="model-favourite" data-model={f.modelId} data-current={inUse ? "true" : "false"}>
                <span className="tsf-model-key" aria-label={i < 3 ? `Key ${i + 1}` : undefined}>
                  {i < 3 ? i + 1 : ""}
                </span>
                <button
                  type="button"
                  className="tsf-model-pick"
                  disabled={!f.available}
                  aria-current={inUse ? "true" : undefined}
                  data-cap="model.set"
                  onClick={() => onChoose(ref)}
                >
                  <span className="tsf-model-name">{f.name}</span>
                  <span className="tsf-model-sub">
                    {f.modelId} · {f.provider}
                  </span>
                </button>
                {inUse && (
                  <Badge tone="brand" icon={Check}>
                    In use
                  </Badge>
                )}
                {!f.available && <Badge tone="warning">Not offered</Badge>}
                <IconButton icon={ArrowUp} label={`Move ${f.name} up`} variant="ghost" size="sm" disabled={i === 0} data-cap="model.favourite" onClick={() => onFavourite(ref, true, i)} />
                <IconButton
                  icon={ArrowDown}
                  label={`Move ${f.name} down`}
                  variant="ghost"
                  size="sm"
                  disabled={i === rows.length - 1}
                  data-cap="model.favourite"
                  onClick={() => onFavourite(ref, true, i + 2)}
                />
                <IconButton icon={X} label={`Remove ${f.name} from the favourites`} variant="ghost" size="sm" data-cap="model.favourite" onClick={() => onFavourite(ref, false)} />
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function AllModels(props: {
  models: readonly ModelInfo[];
  loading: boolean;
  current: ModelRef | null;
  isFavourite: (ref: ModelRef) => boolean;
  query: string;
  onQuery: (q: string) => void;
  onlyFavourites: boolean;
  onOnlyFavourites: (on: boolean) => void;
  refreshing: boolean;
  onRefresh: () => void;
  onChoose: (ref: ModelRef) => void;
  onFavourite: (ref: ModelRef, favourite: boolean) => void;
}) {
  const { models, current, isFavourite, query, onlyFavourites } = props;
  const matching = useMemo(
    () => models.filter((m) => matchesQuery(m, query) && (!onlyFavourites || isFavourite({ provider: m.provider, modelId: m.id }))),
    [models, query, onlyFavourites, isFavourite],
  );
  const groups = useMemo(() => groupByVendor(matching), [matching]);
  const vendors = useMemo(() => new Set(models.map(vendorLabel)).size, [models]);
  const filtered = query.trim() !== "" || onlyFavourites;
  const count = filtered ? `${matching.length} of ${models.length} models match` : `${models.length} models from ${vendors} vendors`;

  return (
    <section className="tsf-set-group" data-cap="models.list" data-testid="model-picker">
      <h3 className="tsf-set-h">All models</h3>
      <div className="tsf-model-tools">
        <SearchInput className="tsf-model-search" label="Search models" placeholder="Name, vendor, ID or provider" value={query} onChange={props.onQuery} autoFocus />
        <FilterChip icon={Star} pressed={onlyFavourites} onPressedChange={props.onOnlyFavourites}>
          Favourites only
        </FilterChip>
        <Button variant="secondary" size="sm" icon={RefreshCw} loading={props.refreshing} loadingLabel="Refreshing" data-cap="models.refresh" data-testid="models-refresh" onClick={props.onRefresh}>
          Refresh
        </Button>
      </div>
      <p className="tsf-set-note" data-testid="model-count" aria-live="polite">
        {props.loading ? "" : count}
      </p>
      {props.loading ? (
        <p className="tsf-set-note">Loading the models.</p>
      ) : groups.length === 0 ? (
        <EmptyState compact title={onlyFavourites && query.trim() === "" ? "No favourites yet" : "No model matches"}>
          {onlyFavourites && query.trim() === "" ? "Star a model to add it to the favourites." : "Try fewer words, or part of a name or ID."}
        </EmptyState>
      ) : (
        <div className="tsf-model-list" data-testid="model-list">
          {groups.map((g) => (
            <section key={g.key} className="tsf-model-group" aria-label={g.label} data-testid="model-group" data-vendor={g.key}>
              <h4 className="tsf-model-group-h">
                {g.label} <span className="tsf-model-group-n">{g.models.length}</span>
              </h4>
              {g.models.map((m) => {
                const ref = { provider: m.provider, modelId: m.id };
                const inUse = sameRef(ref, current);
                const fav = isFavourite(ref);
                return (
                  <div key={`${m.provider}/${m.id}`} className="tsf-model-row" data-testid="model-row" data-model={m.id} data-current={inUse ? "true" : "false"} data-favourite={fav ? "true" : "false"}>
                    <button type="button" className="tsf-model-pick" aria-current={inUse ? "true" : undefined} data-cap="model.set" onClick={() => props.onChoose(ref)}>
                      <span className="tsf-model-radio" aria-hidden="true" data-on={inUse ? "true" : "false"} />
                      <span className="tsf-model-text">
                        <span className="tsf-model-name">{shortName(m.name)}</span>
                        <span className="tsf-model-sub">
                          {m.id} · {m.provider}
                        </span>
                      </span>
                    </button>
                    <IconButton
                      icon={Star}
                      label={fav ? `Remove ${shortName(m.name)} from the favourites` : `Add ${shortName(m.name)} to the favourites`}
                      variant="ghost"
                      size="sm"
                      className="tsf-model-star"
                      aria-pressed={fav}
                      data-on={fav ? "true" : "false"}
                      data-cap="model.favourite"
                      onClick={() => props.onFavourite(ref, !fav)}
                    />
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function Thinking({ model, level, onChange }: { model: ModelInfo | undefined; level: ThinkingLevel; onChange: (level: ThinkingLevel) => void }) {
  const supported = model?.thinkingLevels ?? THINKING_LEVELS;
  const applied = clampLevel(supported, level);
  return (
    <section className="tsf-set-group">
      <h3 className="tsf-set-h">Thinking level</h3>
      <Field label="Thinking" help={model && !model.reasoning ? "This model does not reason; the level has no effect." : "Keys e and shift+e step through the levels this model supports."}>
        {(c) => (
          <Select {...c} value={level} data-cap="thinking.set" data-testid="thinking-select" onChange={(e) => onChange(e.target.value as ThinkingLevel)}>
            {THINKING_LEVELS.map((l) => (
              <option key={l} value={l}>
                {supported.includes(l) ? l : `${l} (not supported)`}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <p className="tsf-set-note" data-testid="thinking-current" data-level={level} data-applied={applied}>
        {applied === level ? (
          <>
            Thinking is <strong>{level}</strong>.
          </>
        ) : (
          <>
            You asked for <strong>{level}</strong>; this model does not support it, so it uses <strong>{applied}</strong>.
          </>
        )}
      </p>
    </section>
  );
}

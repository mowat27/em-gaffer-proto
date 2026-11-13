/**
 * tsf/data/tsf.sqlite: node:sqlite DatabaseSync, WAL, migrations from `meta.schema_version`, typed repositories
 * (DESIGN 3 step 4, 4.2).
 *
 * Migration N belongs to phase N and is added by the lot that owns this file in that phase: add one entry to
 * MIGRATIONS below (and, for a repository, a field on AppDb plus its construction in openAppDb). Each migration runs
 * once, in a transaction, and sets `meta.schema_version = N`.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelCacheStore } from "../agent/models.ts";
import type { CustomTheme, RunDetail, RunSummary, RunToolCall } from "../shared/types.ts";
import type { RunListInput } from "./service-api.ts";
import type { StoredSettings } from "./settings.ts";

/**
 * Stored settings, one JSON row per written key. Nothing is stored at first start (no defaults are written), so
 * `stored()` is `{}` on a new database; `core/settings.ts` merges it over the manifest-derived defaults.
 */
export interface SettingsRepo {
  /** Only the keys that were written, and only the keys of StoredSettings (see CONFIG_KEYS). */
  stored(): StoredSettings;
  /** Writes one key (`undefined` removes it) and calls every onChange listener. */
  set<K extends keyof StoredSettings>(k: K, v: StoredSettings[K]): void;
  /** Called after every set and setRaw. Returns the unsubscribe function. */
  onChange(fn: () => void): () => void;
  /** The raw JSON text of any key, including the non-config ones (`selection`). */
  getRaw(key: string): string | undefined;
  setRaw(key: string, json: string): void;
}

/** A `runs` row: the summary plus `first_entry` (pi.live.run.first), which matches an open run across restarts. */
export interface RunRow extends RunSummary {
  readonly firstEntry: number | null;
}

/**
 * The recorder's tables (DESIGN 4.2, migration 2): `runs` and `run_tools`. Only agent/recorder.ts writes; the Service
 * reads through the recorder.
 */
export interface RunsRepo {
  /** Upserts the run and every tool row in one transaction (args and output are capped at 20 000 chars). */
  save(run: RunRow, tools: readonly RunToolCall[]): void;
  /** Newest first (id descending). `limit` defaults to 20 and is clamped to 1..200; `before` = ids below it. */
  list(input: RunListInput): RunSummary[];
  get(id: number): RunDetail | undefined;
  /** The row with this id, with `first_entry`. */
  row(id: number): RunRow | undefined;
  /** Rows whose status is `running`, oldest first. */
  running(): RunRow[];
  /** Rows (any status) whose `first_entry` is `first`, oldest first. */
  byFirstEntry(first: number): RunRow[];
}

/** Custom themes (DESIGN 4.2, migration 4). Writes happen under the Service's `themes` mutex. */
export interface ThemesRepo {
  /** Oldest first. */
  list(): CustomTheme[];
  get(name: string): CustomTheme | undefined;
  /** INSERT ... ON CONFLICT DO NOTHING: false when the name exists (a replayed create finds its own row). */
  insert(theme: CustomTheme): boolean;
  /** Replaces title, seeds and tokens; false when the name does not exist. */
  update(theme: CustomTheme): boolean;
  delete(name: string): boolean;
}

export interface AppDb {
  db: DatabaseSync;
  settings: SettingsRepo;
  modelCache: ModelCacheStore;
  runs: RunsRepo;
  themes: ThemesRepo;
  /** Runs `sql` once in a transaction and records `meta.schema_version = version`; a no-op when already applied. */
  migrate(version: number, sql: string): void;
  close(): void;
}

/** The keys StoredSettings can hold: every Settings field except layersEnabled, plus layerToggles (DESIGN 4.2). */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "factoryName",
  "toolsDisabled",
  "model",
  "thinkingLevel",
  "compaction",
  "systemPrompt",
  "maxTurns",
  "layerToggles",
]);

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_cache (
  provider TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
`;

const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  "trigger" TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  model TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_source TEXT NOT NULL DEFAULT 'estimate',
  failure TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  first_entry INTEGER
);
CREATE INDEX IF NOT EXISTS runs_first_entry ON runs (first_entry);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status);
CREATE TABLE IF NOT EXISTS run_tools (
  call_id TEXT PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  diagnostic TEXT,
  args TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS run_tools_run ON run_tools (run_id);
`;

/** P3: the one UI config document (DESIGN 4.4); core/ui-config.ts reads and writes it. */
const MIGRATION_3 = `
CREATE TABLE IF NOT EXISTS ui_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  doc TEXT NOT NULL,
  updated_at INTEGER
);
`;

/** P4: custom themes (DESIGN 4.2). `seeds` and `tokens` are JSON texts. */
const MIGRATION_4 = `
CREATE TABLE IF NOT EXISTS themes (
  name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  base TEXT NOT NULL,
  seeds TEXT NOT NULL,
  tokens TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** P5: custom prompts (prompt layer 2) and runtime prompts (layer 4), DESIGN 4.2. Writes happen under the `prompts` mutex. */
const MIGRATION_5 = `
CREATE TABLE IF NOT EXISTS custom_prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_prompts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);
`;

/**
 * P6: cron entries and their per-slot run bookkeeping (DESIGN 4.2). `crons.next_run_at` is the slot the scheduler is
 * waiting for (ms epoch, null while disabled); `cron_runs` is keyed by `(cron_id, slot)`, so a slot is recorded once.
 */
const MIGRATION_6 = `
CREATE TABLE IF NOT EXISTS crons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  expr TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_slot INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cron_runs (
  cron_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  catch_up INTEGER NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL,
  submission_id INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (cron_id, slot)
);
`;

/** Migration N is phase N's. Later lots append here (P7 and P8 add none so far). */
const MIGRATIONS: readonly (readonly [version: number, sql: string])[] = [
  [1, MIGRATION_1],
  [2, MIGRATION_2],
  [3, MIGRATION_3],
  [4, MIGRATION_4],
  [5, MIGRATION_5],
  [6, MIGRATION_6],
];

function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const n = row ? Number.parseInt(row.value, 10) : 0;
  return Number.isInteger(n) ? n : 0;
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original error is the one to report.
    }
    throw err;
  }
}

function createSettingsRepo(db: DatabaseSync): SettingsRepo {
  const listeners = new Set<() => void>();
  const selectAll = db.prepare("SELECT key, value FROM settings");
  const selectOne = db.prepare("SELECT value FROM settings WHERE key = ?");
  const upsert = db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  const remove = db.prepare("DELETE FROM settings WHERE key = ?");

  const notify = (): void => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        // A broken listener must not stop the write or the other listeners.
      }
    }
  };

  return {
    stored(): StoredSettings {
      const out: Record<string, unknown> = {};
      for (const row of selectAll.all() as { key: string; value: string }[]) {
        if (!CONFIG_KEYS.has(row.key)) continue;
        try {
          out[row.key] = JSON.parse(row.value);
        } catch {
          // A row that is not JSON is ignored: the default applies.
        }
      }
      return out as StoredSettings;
    },
    set(k, v) {
      if (v === undefined) remove.run(k);
      else upsert.run(k, JSON.stringify(v), Date.now());
      notify();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getRaw(key) {
      const row = selectOne.get(key) as { value: string } | undefined;
      return row?.value;
    },
    setRaw(key, json) {
      upsert.run(key, json, Date.now());
      notify();
    },
  };
}

function createModelCacheStore(db: DatabaseSync): ModelCacheStore {
  const select = db.prepare("SELECT fetched_at, body FROM model_cache WHERE provider = ?");
  const upsert = db.prepare(
    "INSERT INTO model_cache (provider, fetched_at, body) VALUES (?, ?, ?) " +
      "ON CONFLICT(provider) DO UPDATE SET fetched_at = excluded.fetched_at, body = excluded.body",
  );
  return {
    get(provider) {
      const row = select.get(provider) as { fetched_at: number; body: string } | undefined;
      return row ? { fetchedAt: row.fetched_at, body: row.body } : undefined;
    },
    put(provider, body, fetchedAt) {
      upsert.run(provider, fetchedAt, body);
    },
  };
}

const TOOL_TEXT_CAP = 20_000;

interface RunSqlRow {
  id: number;
  trigger: RunSummary["trigger"];
  status: RunSummary["status"];
  started_at: number;
  finished_at: number | null;
  model: string | null;
  turns: number;
  tool_calls: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  cost_usd: number;
  cost_source: RunSummary["costSource"];
  failure: string | null;
  prompt: string;
  first_entry: number | null;
}

interface ToolSqlRow {
  call_id: string;
  name: string;
  status: RunToolCall["status"];
  duration_ms: number | null;
  diagnostic: string | null;
  args: string;
  output: string;
}

const RUN_COLUMNS =
  'id, "trigger" AS trigger, status, started_at, finished_at, model, turns, tool_calls, input, output, cache_read, ' +
  "cache_write, total_tokens, cost_usd, cost_source, failure, prompt, first_entry";

function runRow(r: RunSqlRow): RunRow {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.finished_at === null ? null : Math.max(0, r.finished_at - r.started_at),
    model: r.model,
    turns: r.turns,
    toolCalls: r.tool_calls,
    usage: {
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      totalTokens: r.total_tokens,
      costUsd: r.cost_usd,
    },
    costSource: r.cost_source,
    failure: r.failure,
    prompt: r.prompt,
    firstEntry: r.first_entry,
  };
}

function summaryOf(row: RunRow): RunSummary {
  const { firstEntry: _firstEntry, ...summary } = row;
  return summary;
}

function createRunsRepo(db: DatabaseSync): RunsRepo {
  const upsertRun = db.prepare(
    'INSERT INTO runs (id, "trigger", status, started_at, finished_at, model, turns, tool_calls, input, output, ' +
      "cache_read, cache_write, total_tokens, cost_usd, cost_source, failure, prompt, first_entry) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      'ON CONFLICT(id) DO UPDATE SET "trigger" = excluded."trigger", status = excluded.status, ' +
      "started_at = excluded.started_at, finished_at = excluded.finished_at, model = excluded.model, " +
      "turns = excluded.turns, tool_calls = excluded.tool_calls, input = excluded.input, output = excluded.output, " +
      "cache_read = excluded.cache_read, cache_write = excluded.cache_write, total_tokens = excluded.total_tokens, " +
      "cost_usd = excluded.cost_usd, cost_source = excluded.cost_source, failure = excluded.failure, " +
      "prompt = excluded.prompt, first_entry = excluded.first_entry",
  );
  const upsertTool = db.prepare(
    "INSERT INTO run_tools (call_id, run_id, name, status, duration_ms, diagnostic, args, output) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(call_id) DO UPDATE SET run_id = excluded.run_id, name = excluded.name, status = excluded.status, " +
      "duration_ms = excluded.duration_ms, diagnostic = excluded.diagnostic, args = excluded.args, output = excluded.output",
  );
  const selectOne = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`);
  const selectTools = db.prepare(
    "SELECT call_id, name, status, duration_ms, diagnostic, args, output FROM run_tools WHERE run_id = ? ORDER BY rowid",
  );
  const selectNewest = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY id DESC LIMIT ?`);
  const selectBefore = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id < ? ORDER BY id DESC LIMIT ?`);
  const selectRunning = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE status = 'running' ORDER BY id`);
  const selectFirst = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE first_entry = ? ORDER BY id`);
  const cap = (s: string): string => (s.length > TOOL_TEXT_CAP ? s.slice(0, TOOL_TEXT_CAP) : s);

  return {
    save(run, tools) {
      transaction(db, () => {
        upsertRun.run(
          run.id,
          run.trigger,
          run.status,
          run.startedAt,
          run.finishedAt,
          run.model,
          run.turns,
          run.toolCalls,
          run.usage.input,
          run.usage.output,
          run.usage.cacheRead,
          run.usage.cacheWrite,
          run.usage.totalTokens,
          run.usage.costUsd,
          run.costSource,
          run.failure,
          run.prompt,
          run.firstEntry,
        );
        for (const t of tools) {
          upsertTool.run(t.callId, run.id, t.name, t.status, t.durationMs, t.diagnostic, cap(t.args), cap(t.output));
        }
      });
    },
    list(input) {
      const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 20)));
      const rows = (
        input.before === undefined ? selectNewest.all(limit) : selectBefore.all(input.before, limit)
      ) as unknown as RunSqlRow[];
      return rows.map((r) => summaryOf(runRow(r)));
    },
    get(id) {
      const r = selectOne.get(id) as RunSqlRow | undefined;
      if (!r) return undefined;
      const tools = (selectTools.all(id) as unknown as ToolSqlRow[]).map(
        (t): RunToolCall => ({
          callId: t.call_id,
          name: t.name,
          status: t.status,
          durationMs: t.duration_ms,
          diagnostic: t.diagnostic,
          args: t.args,
          output: t.output,
        }),
      );
      return { ...summaryOf(runRow(r)), tools };
    },
    row(id) {
      const r = selectOne.get(id) as RunSqlRow | undefined;
      return r ? runRow(r) : undefined;
    },
    running() {
      return (selectRunning.all() as unknown as RunSqlRow[]).map(runRow);
    },
    byFirstEntry(first) {
      return (selectFirst.all(first) as unknown as RunSqlRow[]).map(runRow);
    },
  };
}

interface ThemeSqlRow {
  name: string;
  title: string;
  base: string;
  seeds: string;
  tokens: string;
}

function createThemesRepo(db: DatabaseSync): ThemesRepo {
  const parse = (r: ThemeSqlRow): CustomTheme => ({
    name: r.name,
    title: r.title,
    base: r.base,
    seeds: JSON.parse(r.seeds) as CustomTheme["seeds"],
    tokens: JSON.parse(r.tokens) as CustomTheme["tokens"],
  });
  const selectAll = db.prepare("SELECT name, title, base, seeds, tokens FROM themes ORDER BY created_at, name");
  const selectOne = db.prepare("SELECT name, title, base, seeds, tokens FROM themes WHERE name = ?");
  const insert = db.prepare(
    "INSERT INTO themes (name, title, base, seeds, tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(name) DO NOTHING",
  );
  const update = db.prepare("UPDATE themes SET title = ?, base = ?, seeds = ?, tokens = ?, updated_at = ? WHERE name = ?");
  const remove = db.prepare("DELETE FROM themes WHERE name = ?");
  return {
    list: () => (selectAll.all() as unknown as ThemeSqlRow[]).map(parse),
    get: (name) => {
      const r = selectOne.get(name) as ThemeSqlRow | undefined;
      return r ? parse(r) : undefined;
    },
    insert: (t) => {
      const now = Date.now();
      return Number(insert.run(t.name, t.title, t.base, JSON.stringify(t.seeds), JSON.stringify(t.tokens), now, now).changes) > 0;
    },
    update: (t) =>
      Number(update.run(t.title, t.base, JSON.stringify(t.seeds), JSON.stringify(t.tokens), Date.now(), t.name).changes) > 0,
    delete: (name) => Number(remove.run(name).changes) > 0,
  };
}

/** Open (creating if needed) the app database at `path` and bring it to the newest migration. */
export function openAppDb(path: string): AppDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  const migrate = (version: number, sql: string): void => {
    if (schemaVersion(db) >= version) return;
    transaction(db, () => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(version));
    });
  };

  try {
    for (const [version, sql] of MIGRATIONS) migrate(version, sql);
    return {
      db,
      settings: createSettingsRepo(db),
      modelCache: createModelCacheStore(db),
      runs: createRunsRepo(db),
      themes: createThemesRepo(db),
      migrate,
      close: () => {
        try {
          db.close();
        } catch {
          // Already closed.
        }
      },
    };
  } catch (err) {
    db.close();
    throw err;
  }
}

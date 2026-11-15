/**
 * The gaffer layer's state and work: settings, the gaffer home (clone, kit, config), the runner process, the events
 * file gaffer.ts appends to, the board API used to list and plan slices, and the Gaffer page. No pi-durable imports:
 * only node built-ins, so the layer loads from its cache copy.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, watchFile, unwatchFile } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { LayerContext } from "../../app/src/agent/layer-context.ts";
import type { Json } from "../../app/src/shared/types.ts";

export interface GafferSettings {
  name: string;
  boardId: string;
  orgId: string;
  baseUrl: string;
  repoUrl: string;
  /** Git branch the gaffer dispatches to and fast-forwards. */
  branch: string;
  builderHost: string;
  builderPort: number;
  callbackHost: string;
  callbackPort: number;
  handover: boolean;
  turnTimeoutMinutes: number;
  /** Extra `requires` entries, comma-separated ("stack:stub"); repo:<url> is always added. */
  requires: string;
  /** Shell command run in the clone after the patch is applied; empty = no gate. */
  gate: string;
  agentName: string;
}

export const DEFAULTS: GafferSettings = {
  name: "invoice-lite",
  boardId: "fe92ad7f-3eba-4a40-8528-d2f16d6081a3",
  orgId: "b44da9b9-2fae-47a2-ab4c-2ad0d3ea2978",
  baseUrl: "https://api.eventmodelers.ai",
  repoUrl: "git@github.com:mowat27/em-gaffer-proto.git",
  branch: "main",
  builderHost: "127.0.0.1",
  builderPort: 8788,
  callbackHost: "127.0.0.1",
  callbackPort: 8787,
  handover: false,
  turnTimeoutMinutes: 60,
  requires: "stack:stub",
  gate: "",
  agentName: "gaffer",
};

export const SETTING_KEYS = Object.keys(DEFAULTS) as (keyof GafferSettings)[];
export const PAGE = "Gaffer.md";
export const PLACEHOLDER = "set-in-agent-vault";

export interface GafferEvent {
  ts: string;
  source: string;
  kind: string;
  msg: string;
  jobId?: string;
  slice?: string;
  [k: string]: unknown;
}

export class GafferLayer {
  readonly dir: string;
  readonly settingsFile: string;
  readonly eventsFile: string;
  readonly runLog: string;
  readonly pidFile: string;
  readonly tokenFile: string;
  private settings: GafferSettings;
  private renderTimer: NodeJS.Timeout | null = null;
  private lastSize = -1;

  constructor(private readonly ctx: LayerContext) {
    this.dir = join(ctx.paths.dataDir, "layers", "gaffer");
    mkdirSync(this.dir, { recursive: true });
    this.settingsFile = join(this.dir, "settings.json");
    this.eventsFile = join(this.dir, "events.jsonl");
    this.runLog = join(this.dir, "run.log");
    this.pidFile = join(this.dir, "run.pid");
    this.tokenFile = join(this.dir, "board-token");
    this.settings = this.load();
  }

  // --- settings ------------------------------------------------------------------------------------------------

  private load(): GafferSettings {
    try {
      const raw = JSON.parse(readFileSync(this.settingsFile, "utf8")) as Partial<GafferSettings>;
      return { ...DEFAULTS, ...raw };
    } catch {
      return { ...DEFAULTS };
    }
  }

  getSettings(): GafferSettings {
    return { ...this.settings };
  }

  setSetting(key: string, value: unknown): GafferSettings {
    if (!SETTING_KEYS.includes(key as keyof GafferSettings)) throw new Error(`unknown setting "${key}" (one of ${SETTING_KEYS.join(", ")})`);
    const k = key as keyof GafferSettings;
    const current = this.settings[k];
    let v: unknown = value;
    if (typeof current === "number") {
      v = Number(value);
      if (!Number.isFinite(v as number)) throw new Error(`${key} must be a number`);
    } else if (typeof current === "boolean") {
      v = value === true || value === "true" || value === 1 || value === "1" || value === "on";
    } else {
      v = String(value ?? "").trim();
    }
    this.settings = { ...this.settings, [k]: v };
    writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    this.writeGafferJson();
    return this.getSettings();
  }

  builderUrl(): string {
    return `http://${this.settings.builderHost}:${this.settings.builderPort}`;
  }

  // --- the board token: environment first, else the token file. Never returned to a caller. ----------------------

  private token(): string {
    const env = (process.env.EVENTMODELERS_TOKEN ?? "").trim();
    if (env && env !== PLACEHOLDER) return env;
    try {
      const t = readFileSync(this.tokenFile, "utf8").trim();
      if (t && t !== PLACEHOLDER) return t;
    } catch {
      /* no file */
    }
    return "";
  }

  hasToken(): boolean {
    return this.token() !== "";
  }

  /** Store the board token (mode 600). Never echoed back. */
  setToken(token: string): void {
    const t = token.trim();
    if (!t) throw new Error("token is empty");
    if (t === PLACEHOLDER) throw new Error("that is the placeholder, not a token");
    writeFileSync(this.tokenFile, t, { mode: 0o600 });
    if (existsSync(join(this.repoDir(), ".eventmodelers"))) this.writeRunnerConfig();
    this.emit("token", "board token stored");
  }

  // --- the gaffer home ------------------------------------------------------------------------------------------

  home(): string {
    return join(this.dir, "gaffers", this.settings.name);
  }
  repoDir(): string {
    return join(this.home(), "repo");
  }
  kitSource(): string {
    return join(this.ctx.paths.projectRoot, "gaffer", "kit");
  }

  private run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
    const res = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status}): ${redact((res.stderr || res.stdout || "").trim().slice(-800))}`);
    return (res.stdout || "").trim();
  }

  private writeGafferJson(): void {
    const home = this.home();
    if (!existsSync(home)) return;
    const s = this.settings;
    const config = {
      name: s.name,
      repoUrl: s.repoUrl,
      branch: s.branch,
      builderUrl: this.builderUrl(),
      callbackHost: s.callbackHost,
      callbackPort: s.callbackPort,
      requires: s.requires
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      gate: s.gate,
      turnTimeoutMinutes: s.turnTimeoutMinutes,
      eventsFile: this.eventsFile,
      sliceDumpDir: join(this.ctx.paths.projectRoot, "examples"),
    };
    writeFileSync(join(home, "gaffer.json"), JSON.stringify(config, null, 2));
  }

  private writeRunnerConfig(): void {
    const token = this.token();
    if (!token) throw new Error("no board token: set EVENTMODELERS_TOKEN or write it to tsf/data/layers/gaffer/board-token");
    const s = this.settings;
    const dir = join(this.repoDir(), ".eventmodelers");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.json");
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      /* new */
    }
    const config = {
      ...existing,
      token,
      boardId: s.boardId,
      organizationId: s.orgId,
      baseUrl: s.baseUrl,
      agentTracing: false,
      handover: s.handover,
      agentName: s.agentName,
      turnTimeoutMinutes: s.turnTimeoutMinutes,
      localAi: { ...((existing.localAi as Record<string, unknown>) ?? {}), exec: "node .build-kit/gaffer.ts" },
    };
    writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  /** Create or refresh the gaffer home: clone, excludes, kit repo, `eventmodelers init --stack gaffer --git`, configs. */
  setup(): Json {
    const s = this.settings;
    const home = this.home();
    const repo = this.repoDir();
    const steps: string[] = [];
    mkdirSync(home, { recursive: true });

    if (!existsSync(join(repo, ".git"))) {
      rmSync(repo, { recursive: true, force: true });
      this.run("git", ["clone", "-q", s.repoUrl, repo], home);
      steps.push(`cloned ${s.repoUrl}`);
    } else {
      this.run("git", ["fetch", "-q", "origin"], repo);
      this.run("git", ["checkout", "-q", "-f", s.branch], repo);
      this.run("git", ["reset", "-q", "--hard", `origin/${s.branch}`], repo);
      steps.push(`clone refreshed to origin/${s.branch}`);
    }
    this.run("git", ["config", "user.name", "gaffer"], repo);
    this.run("git", ["config", "user.email", "gaffer@gaffer.local"], repo);

    const exclude = join(repo, ".git", "info", "exclude");
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    const lines = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    for (const l of [".build-kit/", ".eventmodelers/", ".claude/", ".mcp.json", ".env"]) {
      if (!lines.split("\n").includes(l)) appendFileSync(exclude, `${l}\n`);
    }
    steps.push("kit paths excluded from git");

    // The kit is a git repository of its own, built from gaffer/kit in this project.
    const kitRepo = join(home, "kit.git");
    rmSync(kitRepo, { recursive: true, force: true });
    const stage = join(home, "kit-stage");
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    this.run("cp", ["-R", `${this.kitSource()}/.`, stage], home);
    this.run("git", ["init", "-q", "-b", "main"], stage);
    this.run("git", ["-c", "user.name=gaffer", "-c", "user.email=gaffer@gaffer.local", "add", "-A"], stage);
    this.run("git", ["-c", "user.name=gaffer", "-c", "user.email=gaffer@gaffer.local", "commit", "-q", "-m", "gaffer kit"], stage);
    this.run("git", ["clone", "-q", "--bare", stage, kitRepo], home);
    rmSync(stage, { recursive: true, force: true });
    steps.push("kit repository built from gaffer/kit");

    // Credentials first, so `init` finds a complete config and asks nothing (--print never prompts).
    this.writeRunnerConfig();
    rmSync(join(repo, ".build-kit"), { recursive: true, force: true });
    const out = this.run("eventmodelers", ["--print", "init", "--stack", "gaffer", "--git", kitRepo], repo, { CI: "1" });
    steps.push(`eventmodelers init --stack gaffer --git: ${out.split("\n").filter((l) => /✓|installed|Installed/i.test(l)).length} ok lines`);
    if (!existsSync(join(repo, ".build-kit", "gaffer.ts"))) throw new Error(`init did not install .build-kit/gaffer.ts:\n${redact(out.slice(-1500))}`);
    if (!existsSync(join(repo, ".build-kit", "ralph-exec.js"))) throw new Error("init did not copy the shared runner (ralph-exec.js)");
    // The installer also drops a root CLAUDE.md router, .claude/ skills, .mcp.json, .gitignore and the kit's
    // templates/root placeholder into the clone. Only .build-kit and .eventmodelers belong to the gaffer: restore
    // every tracked file and remove the rest, so the clone's tree is clean at claim time and nothing can leak.
    this.run("git", ["checkout", "-q", "--", "."], repo);
    this.run("git", ["clean", "-fdqx", "-e", ".build-kit", "-e", ".eventmodelers"], repo);
    steps.push("clone tree cleaned (only .build-kit and .eventmodelers kept, both excluded)");
    this.writeRunnerConfig();
    this.writeGafferJson();
    steps.push("runner config and gaffer.json written");

    // The kit must never reach the target repository.
    const tracked = this.run("git", ["ls-files", ".build-kit", ".eventmodelers"], repo);
    if (tracked) throw new Error(`kit files are tracked in the clone: ${tracked}`);
    this.emit("setup", `gaffer home ready at ${home}`, { steps });
    return { home, repo, steps };
  }

  // --- the runner process ---------------------------------------------------------------------------------------

  pid(): number | null {
    try {
      const pid = Number(readFileSync(this.pidFile, "utf8").trim());
      if (!pid) return null;
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  }

  running(): boolean {
    return this.pid() !== null;
  }

  start(): Json {
    const pid = this.pid();
    if (pid) return { started: false, pid, reason: "already running" };
    if (!existsSync(join(this.repoDir(), ".build-kit", "gaffer.ts"))) throw new Error("the gaffer home is not set up: run gaffer_setup first");
    this.writeRunnerConfig();
    this.writeGafferJson();
    const fd = openSync(this.runLog, "a");
    const child = spawn("eventmodelers", ["run", "--exec", "node .build-kit/gaffer.ts"], {
      cwd: this.repoDir(),
      detached: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        GAFFER_CONFIG: join(this.home(), "gaffer.json"),
        EVENTMODELERS_TOKEN: this.token(),
        CI: "1",
      },
    });
    closeSync(fd);
    child.unref();
    writeFileSync(this.pidFile, String(child.pid));
    this.emit("start", `runner started (pid ${child.pid}) in ${this.repoDir()}`, { pid: child.pid });
    return { started: true, pid: child.pid };
  }

  stop(): Json {
    const pid = this.pid();
    if (!pid) return { stopped: false, reason: "not running" };
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
    const until = Date.now() + 5000;
    while (Date.now() < until && this.pid()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (this.pid()) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    rmSync(this.pidFile, { force: true });
    this.emit("stop", `runner stopped (pid ${pid})`, { pid });
    return { stopped: true, pid };
  }

  logTail(lines = 60): string {
    try {
      const text = readFileSync(this.runLog, "utf8");
      return redact(text.split("\n").slice(-lines).join("\n"));
    } catch {
      return "";
    }
  }

  // --- events -----------------------------------------------------------------------------------------------------

  emit(kind: string, msg: string, data: Record<string, unknown> = {}): void {
    appendFileSync(this.eventsFile, JSON.stringify({ ts: new Date().toISOString(), source: "layer", kind, msg, ...data }) + "\n");
  }

  events(limit = 50): GafferEvent[] {
    let text = "";
    try {
      text = readFileSync(this.eventsFile, "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n").filter(Boolean);
    const out: GafferEvent[] = [];
    for (const l of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(l) as GafferEvent);
      } catch {
        /* skip */
      }
    }
    return out.reverse();
  }

  clearEvents(): void {
    writeFileSync(this.eventsFile, "");
  }

  // --- board (read slices, set a slice to Planned) ----------------------------------------------------------------

  private async board(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = this.token();
    if (!token) throw new Error("no board token");
    const s = this.settings;
    const res = await fetch(`${s.baseUrl}/api/org/${s.orgId}/boards/${s.boardId}${path}`, {
      ...init,
      headers: { "x-token": token, "x-user-id": "gaffer-layer", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`board ${path} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async slices(): Promise<Json> {
    const data = (await this.board("/slicedata/slices")) as { slices?: Record<string, unknown>[] };
    const slices = (data.slices ?? []).map((x) => ({
      id: x.id,
      title: x.title,
      status: x.status ?? x.sliceStatus ?? null,
      type: x.type ?? x.sliceType ?? null,
      context: x.context ?? x.contextName ?? null,
    }));
    return slices as Json;
  }

  async setSliceStatus(idOrTitle: string, status: string): Promise<Json> {
    const slices = (await this.slices()) as { id: string; title: string; status: string | null }[];
    const slice = slices.find((x) => x.id === idOrTitle) ?? slices.find((x) => x.title?.toLowerCase() === idOrTitle.toLowerCase());
    if (!slice) throw new Error(`no slice "${idOrTitle}" on the board (${slices.map((x) => x.title).join(", ")})`);
    await this.board("/nodes/events", {
      method: "POST",
      body: JSON.stringify([
        {
          id: crypto.randomUUID(),
          eventType: "node:changed",
          nodeId: slice.id,
          boardId: this.settings.boardId,
          timestamp: Date.now(),
          changedAttributes: ["sliceStatus"],
          meta: { type: "SLICE_BORDER", sliceStatus: status },
        },
      ]),
    });
    this.emit("board", `slice "${slice.title}" set to ${status} (was ${slice.status ?? "unknown"})`, { sliceId: slice.id, status });
    return { id: slice.id, title: slice.title, from: slice.status, to: status };
  }

  // --- status and the page --------------------------------------------------------------------------------------

  /** The latest commit on main in the gaffer's clone (the merged, pushed state), or null when there is no clone. */
  head(): { sha: string; subject: string; author: string; date: string } | null {
    if (!existsSync(join(this.repoDir(), ".git"))) return null;
    try {
      const [sha, subject, author, date] = this.run("git", ["log", "-1", "--format=%h%x1f%s%x1f%an%x1f%cI", this.settings.branch], this.repoDir()).split("\x1f");
      return { sha, subject, author, date };
    } catch {
      return null;
    }
  }

  status(): Json {
    const pid = this.pid();
    const s = this.settings;
    const ready = existsSync(join(this.repoDir(), ".build-kit", "gaffer.ts"));
    const last = this.events(1)[0];
    return {
      running: pid !== null,
      pid,
      ready,
      head: this.head(),
      tokenPresent: this.hasToken(),
      tokenMasked: this.hasToken() ? "••••••••" : "",
      home: this.home(),
      builderUrl: this.builderUrl(),
      callback: `http://${s.callbackHost}:${s.callbackPort}/jobs/<jobId>`,
      board: { boardId: s.boardId, orgId: s.orgId, baseUrl: s.baseUrl },
      handover: s.handover,
      branch: s.branch,
      summary: `Gaffer ${pid ? "running" : ready ? "stopped" : "not set up"}${last ? ` · ${last.kind}` : ""}`,
      lastEvent: last ?? null,
    };
  }

  renderPage(): string {
    const st = this.status() as Record<string, unknown>;
    const s = this.settings;
    const events = this.events(60);
    const rows = events.map((e) => `| ${e.ts.replace("T", " ").slice(0, 19)} | ${e.source} | \`${e.kind}\` | ${e.slice ? `${e.slice}: ` : ""}${md(e.msg)} |`);
    return [
      "# Gaffer",
      "",
      `**${st.running ? `Running (pid ${st.pid})` : st.ready ? "Stopped" : "Not set up"}** · board token ${st.tokenPresent ? "present" : "missing"}`,
      "",
      "| Setting | Value |",
      "|---|---|",
      `| Board | \`${s.boardId}\` (org \`${s.orgId}\`) at ${s.baseUrl} |`,
      `| Target repository | \`${s.repoUrl}\` (${s.branch}) |`,
      `| Builder | ${this.builderUrl()} |`,
      `| Callback | http://${s.callbackHost}:${s.callbackPort}/jobs/<jobId> |`,
      `| Handover | ${s.handover ? "on (slices end Waiting)" : "off (slices end Done)"} |`,
      `| Turn timeout | ${s.turnTimeoutMinutes} min |`,
      `| Requires | repo:<target>, ${s.requires || "(none)"} |`,
      `| Gate | ${s.gate ? `\`${s.gate}\`` : "none (stub)"} |`,
      `| Home | \`${this.home()}\` |`,
      "",
      "Controls: Settings (S) > Advanced > Gaffer, or ask the agent (gaffer_setup, gaffer_start, gaffer_stop, gaffer_plan_slice ...).",
      "",
      `## Events (newest first, ${events.length} shown)`,
      "",
      "| Time | Source | Kind | Message |",
      "|---|---|---|---|",
      ...(rows.length ? rows : ["| | | | no events yet |"]),
      "",
    ].join("\n");
  }

  async writePage(): Promise<void> {
    const content = this.renderPage();
    const svc = this.ctx.service();
    try {
      await svc.updatePage({ path: PAGE, content }, { by: "system" });
    } catch (err) {
      if ((err as { code?: string }).code === "not_found") await svc.createPage({ path: PAGE, content }, { by: "system" });
      else throw err;
    }
  }

  scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      // The Gaffer screen in the web app renders this state; the Markdown page is no longer written (writePage stays
      // for anyone who wants a page copy).
      this.ctx.bus.publish({ type: "layer.changed", layer: "gaffer", by: "system" });
    }, 400);
  }

  /** Poll the events file (and the pid) so the page and the widgets follow gaffer.ts without a connection to it. */
  watch(): () => void {
    if (!existsSync(this.eventsFile)) writeFileSync(this.eventsFile, "");
    const check = () => {
      let size = -1;
      try {
        size = statSync(this.eventsFile).size;
      } catch {
        size = -1;
      }
      if (size !== this.lastSize) {
        this.lastSize = size;
        this.scheduleRender();
      }
    };
    watchFile(this.eventsFile, { interval: 1000 }, check);
    const pidTimer = setInterval(() => {
      const running = this.running();
      if (running !== this.lastRunning) {
        this.lastRunning = running;
        if (!running && existsSync(this.pidFile)) {
          rmSync(this.pidFile, { force: true });
          this.emit("exit", "runner process is gone");
        }
        this.scheduleRender();
      }
    }, 2000);
    check();
    return () => {
      unwatchFile(this.eventsFile, check);
      clearInterval(pidTimer);
    };
  }
  private lastRunning = false;
}

function md(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Mask anything that looks like a token or a proxy URL. */
export function redact(s: string): string {
  return s
    .replace(/token=[^\s&]+/gi, "token=***")
    .replace(/(x-token["']?\s*[:=]\s*["']?)[^\s"',]+/gi, "$1***")
    .replace(/https?:\/\/[^\s@/]+@[^\s]+/g, "http://***@***");
}

export function text(v: unknown, max = 4000): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}

export function projectRel(ctx: LayerContext, p: string): string {
  const root = resolve(ctx.paths.projectRoot);
  return p.startsWith(root) ? p.slice(root.length + 1) : p;
}

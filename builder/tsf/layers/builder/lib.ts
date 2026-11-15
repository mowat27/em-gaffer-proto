/**
 * The builder layer's state and work: settings (the build server's config, including the pi invocation), the server
 * process, the events file the server appends to, and the Builder page. Node built-ins only.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, watchFile, unwatchFile } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { LayerContext } from "../../app/src/agent/layer-context.ts";
import type { Json } from "../../app/src/shared/types.ts";

/** Flat settings (one control each); `pi_*` keys become the server's `pi` object. */
export interface BuilderSettings {
  host: string;
  port: number;
  workspaceDir: string;
  /** The app inside the target repository, relative to its root ("." = the root). */
  appDir: string;
  capabilities: string;
  jobTimeoutMinutes: number;
  callbackRetries: number;
  pi_command: string;
  pi_agentDir: string;
  pi_provider: string;
  pi_model: string;
  pi_thinking: string;
  pi_args: string;
  pi_timeoutMinutes: number;
}

export const DEFAULTS: BuilderSettings = {
  host: "127.0.0.1",
  port: 8788,
  workspaceDir: "jobs",
  appDir: ".",
  capabilities: "stack:stub",
  jobTimeoutMinutes: 20,
  callbackRetries: 8,
  pi_command: "~/.pi/agent/bin/pi",
  pi_agentDir: "pi-agent",
  pi_provider: "openrouter",
  pi_model: "anthropic/claude-sonnet-5.5",
  pi_thinking: "low",
  // Context files, prompt templates, extensions and skills stay on: they are what AGENTS.md, prompts/build.md
  // and anything dropped into the agent dir's extensions/skills folders depend on.
  pi_args: "--no-session --no-mcp --no-themes",
  pi_timeoutMinutes: 10,
};

export const SETTING_KEYS = Object.keys(DEFAULTS) as (keyof BuilderSettings)[];
export const PAGE = "Builder.md";

export interface BuilderEvent {
  ts: string;
  source: string;
  kind: string;
  msg: string;
  jobId?: string;
  slice?: string;
  [k: string]: unknown;
}

export class BuilderLayer {
  readonly dir: string;
  readonly settingsFile: string;
  readonly configFile: string;
  readonly eventsFile: string;
  readonly runLog: string;
  readonly pidFile: string;
  private settings: BuilderSettings;
  private renderTimer: NodeJS.Timeout | null = null;
  private lastSize = -1;
  private lastRunning = false;

  constructor(private readonly ctx: LayerContext) {
    this.dir = join(ctx.paths.dataDir, "layers", "builder");
    mkdirSync(this.dir, { recursive: true });
    this.settingsFile = join(this.dir, "settings.json");
    this.configFile = join(this.dir, "config.json");
    this.eventsFile = join(this.dir, "events.jsonl");
    this.runLog = join(this.dir, "server.log");
    this.pidFile = join(this.dir, "server.pid");
    this.settings = this.load();
    this.writeConfig();
  }

  private load(): BuilderSettings {
    try {
      return { ...DEFAULTS, ...(JSON.parse(readFileSync(this.settingsFile, "utf8")) as Partial<BuilderSettings>) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  getSettings(): BuilderSettings {
    return { ...this.settings };
  }

  setSetting(key: string, value: unknown): BuilderSettings {
    if (!SETTING_KEYS.includes(key as keyof BuilderSettings)) throw new Error(`unknown setting "${key}" (one of ${SETTING_KEYS.join(", ")})`);
    const k = key as keyof BuilderSettings;
    const current = this.settings[k];
    let v: unknown = value;
    if (typeof current === "number") {
      v = Number(value);
      if (!Number.isFinite(v as number)) throw new Error(`${key} must be a number`);
    } else {
      v = String(value ?? "").trim();
    }
    this.settings = { ...this.settings, [k]: v };
    writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    this.writeConfig();
    return this.getSettings();
  }

  serverDir(): string {
    return this.ctx.paths.projectRoot;
  }

  url(): string {
    return `http://${this.settings.host}:${this.settings.port}`;
  }

  /** The server reads this at start (host, port) and again at every job (everything else, pi included). */
  writeConfig(): void {
    const s = this.settings;
    const config = {
      host: s.host,
      port: s.port,
      workspaceDir: resolve(this.ctx.paths.projectRoot, s.workspaceDir),
      appDir: s.appDir || ".",
      capabilities: s.capabilities
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      jobTimeoutMinutes: s.jobTimeoutMinutes,
      callbackRetries: s.callbackRetries,
      eventsFile: this.eventsFile,
      pi: {
        command: s.pi_command,
        agentDir: s.pi_agentDir,
        provider: s.pi_provider,
        model: s.pi_model,
        thinking: s.pi_thinking,
        args: s.pi_args,
        timeoutMinutes: s.pi_timeoutMinutes,
      },
    };
    writeFileSync(this.configFile, JSON.stringify(config, null, 2));
  }

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
    const script = join(this.serverDir(), "server.ts");
    if (!existsSync(script)) throw new Error(`${script} is missing`);
    this.writeConfig();
    const fd = openSync(this.runLog, "a");
    const child = spawn(process.execPath, [script], {
      cwd: this.ctx.paths.projectRoot,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, BUILDER_CONFIG: this.configFile },
    });
    closeSync(fd);
    child.unref();
    writeFileSync(this.pidFile, String(child.pid));
    this.emit("start", `build server started (pid ${child.pid}) on ${this.url()}`, { pid: child.pid });
    return { started: true, pid: child.pid, url: this.url() };
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
    this.emit("stop", `build server stopped (pid ${pid})`, { pid });
    return { stopped: true, pid };
  }

  async health(): Promise<Json> {
    try {
      const res = await fetch(`${this.url()}/status`, { signal: AbortSignal.timeout(3000) });
      return (await res.json()) as Json;
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  logTail(lines = 60): string {
    try {
      return readFileSync(this.runLog, "utf8").split("\n").slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  jobLog(jobId: string, lines = 200): string {
    const file = join(resolve(this.ctx.paths.projectRoot, this.settings.workspaceDir), "logs", `${jobId}.log`);
    try {
      return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
    } catch {
      return `no log for job ${jobId}`;
    }
  }

  emit(kind: string, msg: string, data: Record<string, unknown> = {}): void {
    appendFileSync(this.eventsFile, JSON.stringify({ ts: new Date().toISOString(), source: "layer", kind, msg, ...data }) + "\n");
  }

  events(limit = 50): BuilderEvent[] {
    let text = "";
    try {
      text = readFileSync(this.eventsFile, "utf8");
    } catch {
      return [];
    }
    const out: BuilderEvent[] = [];
    for (const l of text.split("\n").filter(Boolean).slice(-limit)) {
      try {
        out.push(JSON.parse(l) as BuilderEvent);
      } catch {
        /* skip */
      }
    }
    return out.reverse();
  }

  clearEvents(): void {
    writeFileSync(this.eventsFile, "");
  }

  status(): Json {
    const pid = this.pid();
    const s = this.settings;
    const last = this.events(1)[0];
    return {
      running: pid !== null,
      pid,
      url: this.url(),
      capabilities: s.capabilities,
      pi: { command: s.pi_command, agentDir: s.pi_agentDir, provider: s.pi_provider, model: s.pi_model, thinking: s.pi_thinking, args: s.pi_args },
      workspaceDir: resolve(this.ctx.paths.projectRoot, s.workspaceDir),
      summary: `Builder ${pid ? "running" : "stopped"}${last ? ` · ${last.kind}` : ""}`,
      lastEvent: last ?? null,
    };
  }

  renderPage(): string {
    const st = this.status() as Record<string, unknown>;
    const s = this.settings;
    const events = this.events(60);
    const rows = events.map((e) => `| ${e.ts.replace("T", " ").slice(0, 19)} | ${e.source} | \`${e.kind}\` | ${e.slice ? `${e.slice}: ` : ""}${md(e.msg)} |`);
    return [
      "# Builder",
      "",
      `**${st.running ? `Running (pid ${st.pid}) on ${this.url()}` : "Stopped"}**`,
      "",
      "| Setting | Value |",
      "|---|---|",
      `| Listen | ${this.url()} (POST /slices, GET /status) |`,
      `| Capabilities | repo:<any reachable>, ${s.capabilities || "(none)"} |`,
      `| Workspaces | \`${s.workspaceDir}/<jobId>\` (the newest few are kept after a job; logs in \`${s.workspaceDir}/logs\`) |`,
      `| App directory | \`${s.appDir || "."}\` in the target repository |`,
      `| Job timeout | ${s.jobTimeoutMinutes} min |`,
      "",
      "## pi agent (next build)",
      "",
      "| Setting | Value |",
      "|---|---|",
      `| Command | \`${s.pi_command}\` |`,
      `| Agent dir | ${s.pi_agentDir ? `\`${s.pi_agentDir}\` (settings.json, AGENTS.md, prompts/, extensions/, skills/)` : "pi default (~/.pi/agent)"} |`,
      `| Provider / model | ${s.pi_provider} / ${s.pi_model} |`,
      `| Thinking | ${s.pi_thinking || "(pi default)"} |`,
      `| Flags | \`${s.pi_args}\` |`,
      `| Timeout | ${s.pi_timeoutMinutes} min |`,
      "",
      "Standing instructions (`pi-agent/AGENTS.md`) and the per-job prompt (`pi-agent/prompts/build.md`) are Pi files, read before every job; edit them directly, not a setting. `pi-agent/extensions/` and `skills/` are plain Pi folders: drop files in and they load.",
      "",
      "Controls: Settings (S) > Advanced > Builder, or ask the agent (builder_start, builder_stop, builder_set_setting ...). Changes apply to the next job.",
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
      // The Builder screen in the web app renders this state; the Markdown page is no longer written.
      this.ctx.bus.publish({ type: "layer.changed", layer: "builder", by: "system" });
    }, 400);
  }

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
          this.emit("exit", "build server process is gone");
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
}

function md(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function text(v: unknown, max = 4000): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}

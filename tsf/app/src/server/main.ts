/**
 * The startup sequence (DESIGN 3). `createFactory` runs steps 1 to 12 (no listen, no signals, no `start()`), and
 * `runServer` steps 13 to 15 plus signals and shutdown. Final in P1: later phases change `core/service.ts`, not this file.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { openFactoryAgent, type FactoryAgent, type OpenAgentOptions } from "../agent/harness.ts";
import { createBus } from "../core/bus.ts";
import { openAppDb } from "../core/db.ts";
import { loadEnv } from "../core/env.ts";
import { ServiceError } from "../core/errors.ts";
import { lockFile, readServerState, removeServerState, writeServerState } from "../core/lock.ts";
import { createLogger, type Logger } from "../core/log.ts";
import { ownAppDir, projectAppDir, projectPaths, resolveProjectRoot, type ProjectPaths } from "../core/paths.ts";
import { createService, type ServiceDeps } from "../core/service.ts";
import type { FactoryService } from "../core/service-api.ts";
import { createApp, type WebMode } from "./app.ts";
import { SseHub } from "./sse.ts";
import { attachPiTerminal } from "./pi-terminal.ts";
import { WebHost } from "./web-host.ts";

export interface RunServerOptions {
  projectRoot?: string;
  host?: string;
  port?: number;
  tools?: readonly string[] | null;
  dev?: boolean;
}

export interface Factory {
  paths: ProjectPaths;
  service: FactoryService;
  app: Hono;
  hub: SseHub;
  agent: FactoryAgent;
  /** `ServiceRuntime.start()`: runs after the URL line. */
  start(): Promise<void>;
  /** The DESIGN 3 shutdown order, minus the HTTP server (`runServer` closes that). Idempotent. */
  close(): Promise<void>;
}

export interface CreateFactoryOptions extends RunServerOptions {
  log?: Logger;
  /** false: serve no web app (tests). */
  web?: boolean;
  testing?: OpenAgentOptions["testing"];
  /** How the process restarts itself (`runServer` supplies it); absent: the `restart` capability answers `conflict`. */
  restart?: ServiceDeps["restart"];
  /** Replaces the `vite build` child (tests). */
  webBuild?: (outDir: string) => Promise<void>;
  /** Test seam: playwright loader for `screenshot`. */
  playwright?: ServiceDeps["playwright"];
  /** Test seam: milliseconds between the `restart` reply and the restart. */
  restartDelayMs?: number;
  /** Test seam: debounce of the web watcher in ms (default 500). */
  webDebounceMs?: number;
  /** The URL the Service reports; `runServer` supplies the listening address. Default: from TSF_HOST/TSF_PORT. */
  url?: () => string;
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

function parsePort(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error(`${name} must be an integer 0..65535, got "${raw}"`);
  return Number(raw);
}

function urlFor(host: string, port: number): string {
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

function resolveListen(opts: RunServerOptions): { host: string; port: number } {
  const host = opts.host ?? (process.env.TSF_HOST || "127.0.0.1");
  const port = opts.port ?? parsePort(process.env.TSF_PORT, "TSF_PORT") ?? 8000;
  return { host, port };
}

/** The web host when this process builds and serves the web app itself (not `--dev`, not `web: false`). */
function makeWebHost(opts: CreateFactoryOptions, paths: ProjectPaths, log: Logger, publish: WebHostPublish): WebHost | undefined {
  if (opts.web === false) return undefined;
  const vite = process.env.TSF_VITE_URL;
  if (opts.dev || (vite !== undefined && vite !== "")) return undefined;
  return new WebHost({
    appDir: paths.appDir,
    fallbackDir: join(paths.dataDir, "web"),
    log,
    publish,
    ...(opts.webBuild ? { build: opts.webBuild } : {}),
    ...(opts.webDebounceMs !== undefined ? { debounceMs: opts.webDebounceMs } : {}),
  });
}

type WebHostPublish = ConstructorParameters<typeof WebHost>[0]["publish"];

async function chooseWeb(opts: CreateFactoryOptions, paths: ProjectPaths, log: Logger, host: WebHost | undefined): Promise<WebMode> {
  if (opts.web === false) return { kind: "none", reason: "the web app is disabled" };
  const vite = process.env.TSF_VITE_URL;
  if (opts.dev || (vite !== undefined && vite !== "")) {
    return { kind: "proxy", url: vite || "http://127.0.0.1:5173" };
  }
  if (!host) return { kind: "none", reason: "the web app is disabled" };
  const built = await host.init();
  if ("skipped" in built) return { kind: "none", reason: "no web app yet (src/web/index.html is missing); the API is serving" };
  // A failed first build still serves: the page answers 503 until a rebuild (the watcher's or rebuild_web) succeeds.
  host.watch();
  return {
    kind: "static",
    root: host.root,
    hash: host.servedHash,
    reason: () => `the web build failed; see ${join(paths.logsDir, "tsf.log")}`,
  };
}

export async function createFactory(opts: CreateFactoryOptions = {}): Promise<Factory> {
  // 1. Paths.
  const paths = projectPaths(opts.projectRoot ?? resolveProjectRoot(process.cwd()));
  if (!existsSync(paths.tsfDir)) throw new Error(`no tsf/ in ${paths.projectRoot}: run /tsf install`);
  mkdirSync(paths.logsDir, { recursive: true });
  const log = opts.log ?? createLogger({ file: join(paths.logsDir, "tsf.log") });
  log.info("startup.paths", { projectRoot: paths.projectRoot });

  // 2. Env (never overrides a set, non-empty variable).
  loadEnv(paths.envFile);
  log.info("startup.env", { file: paths.envFile });

  const listen = resolveListen(opts);
  const url = opts.url ?? ((): string => urlFor(listen.host, listen.port));

  // 3. Lock.
  const unlock = lockFile(paths.lockFile);
  log.info("startup.lock", { file: paths.lockFile, pid: process.pid });

  let db: ReturnType<typeof openAppDb> | undefined;
  let agent: FactoryAgent | undefined;
  let runtime: Awaited<ReturnType<typeof createService>> | undefined;
  let unsubscribe: (() => void)[] = [];
  let hub: SseHub | undefined;
  let webHost: WebHost | undefined;
  try {
    // 4. App DB.
    db = openAppDb(paths.appDb);
    log.info("startup.db", { file: paths.appDb });
    const bus = createBus(log);
    webHost = makeWebHost(opts, paths, log, (e) => bus.publish(e));

    // 5-9. Ceiling, layers, models, harness, feed (inside openFactoryAgent); the Service getter is bound below.
    let bound: FactoryService | undefined;
    const serviceGetter = (): FactoryService => {
      if (!bound) throw new ServiceError("unavailable", "the factory is still starting");
      return bound;
    };
    agent = await openFactoryAgent({
      paths,
      log,
      bus,
      db,
      service: serviceGetter,
      tools: opts.tools ?? null,
      ...(opts.testing ? { testing: opts.testing } : {}),
    });
    log.info("startup.agent", {});

    // 10. Service.
    const bootId = Date.now();
    runtime = await createService({
      paths,
      db,
      bus,
      log,
      agent,
      bootId,
      startedAt: bootId,
      url,
      ...(webHost ? { web: webHost } : {}),
      ...(opts.restart ? { restart: opts.restart } : {}),
      ...(opts.restartDelayMs !== undefined ? { restartDelayMs: opts.restartDelayMs } : {}),
      ...(opts.playwright ? { playwright: opts.playwright } : {}),
    });
    bound = runtime.service;
    const service = runtime.service;
    log.info("startup.service", { bootId });

    // The SSE hub: chat deltas from the feed, app events from the bus.
    hub = new SseHub({ bootId, snapshot: () => service.snapshot(), log });
    const theHub = hub;
    unsubscribe = [agent.feed.onDelta((d) => theHub.publish(d)), bus.subscribe((e) => theHub.publish(e))];

    // 11. Resume: only now can a tool run, so a resumed page tool always finds the Service.
    agent.resume();
    log.info("startup.resume", {});

    // 12. Web.
    // Code and web both come from the app this process runs from (paths.appDir). A project copy that is not the
    // running app is reported, never loaded: its node_modules may not exist and its code may differ.
    const copy = projectAppDir(paths.projectRoot);
    if (copy !== undefined && sameDir(ownAppDir, copy) === false) {
      log.warn("startup.app_mismatch", { running: ownAppDir, project: copy, hint: "start through `just tsf start` (or reinstall the service) so the project's own launcher runs" });
    }
    const web = await chooseWeb(opts, paths, log, webHost);
    log.info("startup.web", { kind: web.kind });
    const app = createApp({ service, hub, log, web, hosts: [listen.host] });

    const ownedAgent = agent;
    const ownedRuntime = runtime;
    const ownedDb = db;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        for (const off of unsubscribe) off();
        webHost?.close();
        theHub.closeAll();
        await ownedRuntime.close().catch((err: unknown) => log.error("shutdown.service", { error: err }));
        await ownedAgent.close().catch((err: unknown) => log.error("shutdown.agent", { error: err }));
        ownedDb.close();
        unlock();
        log.info("shutdown.done", {});
      })();
      return closing;
    };

    return {
      paths,
      service,
      app,
      hub: theHub,
      agent: ownedAgent,
      start: () => ownedRuntime.start(),
      close,
    };
  } catch (err) {
    log.error("startup.failed", { error: err });
    webHost?.close();
    for (const off of unsubscribe) off();
    hub?.closeAll();
    await runtime?.close().catch(() => undefined);
    await agent?.close().catch(() => undefined);
    db?.close();
    unlock();
    throw err;
  }
}

export async function runServer(
  opts: RunServerOptions = {},
): Promise<{ url: string; port: number; factory: Factory; close(): Promise<void> }> {
  const root = projectPaths(opts.projectRoot ?? resolveProjectRoot(process.cwd()));
  if (!existsSync(root.tsfDir)) throw new Error(`no tsf/ in ${root.projectRoot}: run /tsf install`);
  mkdirSync(root.logsDir, { recursive: true });
  const log = createLogger({ file: join(root.logsDir, "tsf.log") });
  let url = "";
  // The restart hook exists before the listener does; `beginRestart` is assigned below, once there is something to close.
  // Under a supervisor (systemd sets INVOCATION_ID; the unit also sets TSF_SUPERVISED) the process exits 3 and
  // Restart=on-failure brings it back; otherwise it releases everything and starts a detached replacement.
  const supervised = Boolean(process.env.INVOCATION_ID) || Boolean(process.env.TSF_SUPERVISED);
  let beginRestart: (reason?: string) => void = () => undefined;
  const factory = await createFactory({
    ...opts,
    projectRoot: root.projectRoot,
    log,
    url: () => url,
    restart: { mode: supervised ? "systemd" : "respawn", begin: (reason) => beginRestart(reason) },
  });
  const { host, port: wantedPort } = resolveListen(opts);

  // 13. HTTP.
  let server!: Server;
  let port: number;
  try {
    port = await new Promise<number>((resolveListening, reject) => {
      server = serve({ fetch: factory.app.fetch, hostname: host, port: wantedPort }, (info) => resolveListening(info.port)) as Server;
      server.once("error", reject);
    });
  } catch (err) {
    await factory.close();
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code === "EADDRINUSE" ? `port ${wantedPort} on ${host} is already in use` : `could not listen: ${String(err)}`);
  }
  const closePiTerminal = attachPiTerminal(server);
  url = urlFor(host, port);
  log.info("startup.listen", { host, port });

  // 14. State file, then the URL line.
  const status = factory.service.status();
  await writeServerState(factory.paths.serverState, {
    pid: process.pid,
    url,
    host,
    port,
    bootId: status.bootId,
    startedAt: status.startedAt,
  });
  process.stdout.write(`TSF running at ${url}\n`);

  // 15. Start.
  await factory.start();

  let closing: Promise<void> | undefined;
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const sig of signals) process.off(sig, onSignal);
      factory.hub.closeAll();
      closePiTerminal();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await factory.close();
      if (readServerState(factory.paths.serverState)?.pid === process.pid) removeServerState(factory.paths.serverState);
    })();
    return closing;
  };

  function shutdown(code: number): void {
    const force = setTimeout(() => process.exit(1), 5000);
    void close().then(
      () => process.exit(code),
      (err: unknown) => {
        log.error("shutdown.failed", { error: err });
        clearTimeout(force);
        process.exit(1);
      },
    );
  }
  /** DESIGN 3 "Restart": the same shutdown as a signal, then exit 3 (supervised) or a detached replacement and exit 0. */
  function restartNow(reason?: string): void {
    log.info("restart.begin", { reason, mode: supervised ? "systemd" : "respawn" });
    if (supervised) {
      shutdown(3);
      return;
    }
    const force = setTimeout(() => process.exit(1), 5000);
    void close().then(
      () => {
        try {
          // Same interpreter, arguments, working directory and environment; output appended to the log file.
          const fd = openSync(join(factory.paths.logsDir, "tsf.log"), "a");
          const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
            cwd: process.cwd(),
            env: process.env,
            detached: true,
            stdio: ["ignore", fd, fd],
          });
          child.unref();
          closeSync(fd);
          log.info("restart.respawned", { pid: child.pid });
          process.exit(0);
        } catch (err) {
          log.error("restart.failed", { error: err });
          process.exit(1);
        }
      },
      (err: unknown) => {
        log.error("restart.failed", { error: err });
        clearTimeout(force);
        process.exit(1);
      },
    );
  }
  beginRestart = restartNow;
  function onSignal(): void {
    log.info("shutdown.signal", {});
    shutdown(0);
  }
  for (const sig of signals) process.on(sig, onSignal);

  // A failed harness is final: exit 1 so a supervisor restarts the process.
  void factory.agent.harness.closed.then((end) => {
    if (end.kind === "failed") {
      log.error("harness.failed", { error: "error" in end ? end.error : undefined });
      shutdown(1);
    }
  });
  // A chat feed that gave up restarting its watch is final too: shut down gracefully, exit 1.
  factory.agent.feed.onFatal((err) => {
    log.error("feed.fatal", { error: err });
    shutdown(1);
  });

  return { url, port, factory, close };
}

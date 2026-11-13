/**
 * The served web build and its live rebuild (DESIGN 3 "Web build", "Liquid core"). `WebHost` owns the directory the
 * static handler serves. `init()` builds (or finds) the build for the current sources; `rebuild()` runs the build again
 * and, only on success, swaps the served directory; a failed rebuild keeps the previous good build serving and reports
 * vite's trimmed text. `watch()` rebuilds when `src/web` or `src/shared` change (fs.watch, recursive, debounced).
 * Bus events: `web.rebuilt {hash}` after a good rebuild, `web.build_failed {error}` after a failed one.
 */
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../core/log.ts";
import type { AppEvent } from "../shared/events.ts";
import type { RebuildWebResult, WebStatus } from "../shared/types.ts";
import { ensureWebBuilt, trimBuildText, type EnsureWebResult } from "./static.ts";

export interface WebHostOptions {
  appDir: string;
  /** Where to build when `<appDir>/dist` is not writable. */
  fallbackDir: string;
  log: Logger;
  publish: (event: AppEvent) => void;
  /** Replaces the `vite build` child (tests). */
  build?: (outDir: string) => Promise<void>;
  /** Quiet time after the last file event before a rebuild starts. Default 500. */
  debounceMs?: number;
}

export class WebHost {
  private rootDir: string | undefined;
  private hash: string | null = null;
  private building = false;
  private lastError: string | null = null;
  private running: Promise<RebuildWebResult> | undefined;
  private queued: Promise<RebuildWebResult> | undefined;
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly opts: WebHostOptions) {}

  /** The directory to serve, or undefined while no build exists. */
  root = (): string | undefined => this.rootDir;

  servedHash = (): string | null => this.hash;

  /** True once a build is being served. */
  serving(): boolean {
    return this.rootDir !== undefined;
  }

  status(): WebStatus {
    return { hash: this.hash, building: this.building, lastError: this.lastError };
  }

  private async ensure(): Promise<EnsureWebResult> {
    const { appDir, fallbackDir, log, build } = this.opts;
    return ensureWebBuilt({ appDir, fallbackDir, log, ...(build ? { build } : {}) });
  }

  /** The startup build (DESIGN 3 step 12). Blocks until the build exists, so the URL line means the UI works. */
  async init(): Promise<EnsureWebResult> {
    this.building = true;
    try {
      const r = await this.ensure();
      if ("root" in r) {
        this.rootDir = r.root;
        this.hash = r.hash;
        this.lastError = null;
      } else if ("error" in r) {
        this.lastError = trimBuildText(r.error);
      }
      return r;
    } finally {
      this.building = false;
    }
  }

  /** Build now. Calls made while a build runs share one follow-up build (the sources may have changed again). */
  rebuild(): Promise<RebuildWebResult> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
      return this.running;
    }
    if (!this.queued) {
      this.queued = this.running
        .catch(() => undefined)
        .then(() => {
          // Cleared as the follow-up starts, so an edit made while it runs queues another one.
          this.queued = undefined;
          return this.rebuild();
        });
    }
    return this.queued;
  }

  private async run(): Promise<RebuildWebResult> {
    const started = Date.now();
    this.building = true;
    try {
      const r = await this.ensure();
      const durationMs = Date.now() - started;
      if ("root" in r) {
        const changed = r.hash !== this.hash;
        const recovered = this.lastError !== null;
        this.rootDir = r.root;
        this.hash = r.hash;
        this.lastError = null;
        if (changed || recovered) this.opts.publish({ type: "web.rebuilt", hash: r.hash });
        return { ok: true, hash: r.hash, durationMs };
      }
      if ("skipped" in r) {
        return { ok: false, hash: this.hash, error: "there is no web source (src/web/index.html is missing)", durationMs };
      }
      const error = trimBuildText(r.error);
      this.lastError = error;
      this.opts.publish({ type: "web.build_failed", error });
      return { ok: false, hash: this.hash, error, durationMs };
    } finally {
      this.building = false;
    }
  }

  /** Watch `src/web` and `src/shared`; every change schedules one rebuild after `debounceMs` of quiet. */
  watch(): void {
    if (this.watchers.length > 0 || this.closed) return;
    const debounce = this.opts.debounceMs ?? 500;
    const onChange = (): void => {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.closed) return;
        this.rebuild().catch((err: unknown) => this.opts.log.error("web.rebuild_failed", { error: err }));
      }, debounce);
    };
    for (const dir of [join(this.opts.appDir, "src", "web"), join(this.opts.appDir, "src", "shared")]) {
      try {
        const w = fsWatch(dir, { recursive: true }, onChange);
        w.on("error", (err) => this.opts.log.warn("web.watch_error", { dir, error: err }));
        this.watchers.push(w);
      } catch (err) {
        this.opts.log.warn("web.watch_failed", { dir, error: err });
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}

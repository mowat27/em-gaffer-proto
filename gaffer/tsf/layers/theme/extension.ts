/**
 * theme layer: installs Ember (theme.ts) once the factory's Service is up. Every factory start and layer reload runs it.
 *   - Ember missing (a new VM, a fresh local factory): create it. Ember present: merge theme.ts's values over the stored
 *     ones, so git stays the source of the colours.
 *   - While the factory is still on its default theme (precision-weave-neon, system mode), make Ember the active theme
 *     in dark mode. A theme picked in Settings is left alone.
 */
import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext } from "../../app/src/agent/layer-context.ts";
import type { Origin } from "../../app/src/shared/types.ts";
import { MODE, THEME } from "./theme.ts";

const ORIGIN: Origin = { by: "system" };
/** The theme a factory starts on until one is picked. */
const DEFAULT_THEME = { name: "precision-weave-neon", mode: "system" };
/** The Service is bound after the layers load; wait for it this long at most. */
const WAIT_MS = 60_000;

async function install(ctx: LayerContext): Promise<void> {
  const svc = ctx.service();
  // Read before creating: createTheme also makes the new theme active, in the current mode.
  const before = { ...svc.getUiConfig().theme };
  if (svc.listThemes().some((t) => t.name === THEME.name)) {
    await svc.setThemeValues({ name: THEME.name, title: THEME.title, seeds: THEME.seeds, tokens: THEME.tokens }, ORIGIN);
    ctx.log.info("theme.updated", { theme: THEME.name });
  } else {
    await svc.createTheme(THEME, ORIGIN);
    ctx.log.info("theme.created", { theme: THEME.name });
  }
  if (before.name === DEFAULT_THEME.name && before.mode === DEFAULT_THEME.mode) {
    await svc.setTheme({ name: THEME.name, mode: MODE }, ORIGIN);
    ctx.log.info("theme.activated", { theme: THEME.name, mode: MODE });
  } else {
    const now = svc.getUiConfig().theme;
    if (now.name !== before.name || now.mode !== before.mode) await svc.setTheme(before, ORIGIN);
  }
}

function installWhenReady(ctx: LayerContext, started = Date.now()): void {
  let ready = true;
  try {
    ctx.service();
  } catch {
    ready = false;
  }
  if (!ready) {
    if (Date.now() - started < WAIT_MS) setTimeout(() => installWhenReady(ctx, started), 250);
    else ctx.log.warn("theme.no_service", { theme: THEME.name });
    return;
  }
  install(ctx).catch((err: unknown) => ctx.log.warn("theme.failed", { theme: THEME.name, error: (err as Error).message }));
}

export function createExtension(ctx: LayerContext): Extension {
  queueMicrotask(() => installWhenReady(ctx));
  return ctx.pi.defineExtension({ name: "theme", tools: [] }) as Extension;
}

/**
 * The UI config schema (DESIGN 4.4): closed pi-schema objects, compiled once, plus the semantic checks the schema cannot
 * express (unique placement ids, known widget types per navbar, known theme name, one action per key).
 *
 * Server-side only in P3 (core/ui-config.ts validates every merged document with it); it imports no node module.
 */
import { arr, bool, compile, int, map, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { BUILTIN_WIDGETS, type HotkeyAction, type NavbarId, type WidgetContribution } from "./types.ts";

/** Pane widths in pixels (the UI snaps to 4). */
export const PANE_MIN_WIDTH = 160;
export const PANE_MAX_WIDTH = 960;
export const NAVBAR_MAX_ITEMS = 24;

/** The built-in hotkey actions; each must keep a key (UiConfig.hotkeys is a Record over them). */
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = [
  "settings.open",
  "cron.open",
  "panes.left.toggle",
  "panes.right.toggle",
  "agent.focus",
  "agent.maximise",
];

const Pane = obj({ visible: bool(), width: int({ minimum: PANE_MIN_WIDTH, maximum: PANE_MAX_WIDTH }) });

const Placement = obj({
  id: str({ pattern: "^[a-z0-9_.-]{1,64}$" }),
  widget: str({ minLength: 1, maxLength: 129 }),
  slot: oneOf(["left", "center", "right"]),
  options: obj({ fullWidth: opt(bool()) }, { open: true }),
});

const Navbar = obj({ visible: bool(), items: arr(Placement, { maxItems: NAVBAR_MAX_ITEMS }) });

export const UiConfigSchema = obj({
  version: int({ minimum: 1 }),
  panes: obj({ left: Pane, right: Pane, agentMaximised: bool() }),
  navbars: obj({ global: Navbar, agent: Navbar }),
  theme: obj({ name: str({ minLength: 1, maxLength: 64 }), mode: oneOf(["light", "dark", "system"]) }),
  hotkeys: map(str({ minLength: 1, maxLength: 16 })),
  animations: obj({
    agentWorking: oneOf(["pulse", "glow", "spinner", "none"]),
    agentIdle: oneOf(["still", "breathe"]),
    reducedMotion: oneOf(["system", "on", "off"]),
  }),
});

export const uiConfigValidator = compile(UiConfigSchema);

/** What the semantic checks may know beyond the document itself. Absent lists skip that check. */
export interface UiConfigCheckContext {
  /** Layer widget contributions ("<layer>.<widget>"), with the navbars each may sit in. */
  readonly widgets?: readonly Pick<WidgetContribution, "id" | "navbars">[];
  /** Known theme names (PW and custom). */
  readonly themes?: readonly string[];
}

/** A hotkey action: a built-in or "<layer>.<action>". */
const ACTION_KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
/** One key ("s", "[", "/", "Escape", "F2") or "mod+<key>". */
const KEY_VALUE = /^(mod\+)?([^\s+]|\+|[A-Za-z][A-Za-z0-9]{1,11})$/;

/** Keys compare case-insensitively ("S" and "s" are one key). */
function normaliseKey(value: string): string {
  return value.toLowerCase();
}

/**
 * Schema errors first (each as "<path>: <message>", path "/" for the root), then semantic problems. An empty list
 * means the document is a valid UiConfig.
 */
export function checkUiConfig(doc: unknown, ctx: UiConfigCheckContext = {}): string[] {
  const errors = uiConfigValidator.errors(doc).map((e) => `${e.path === "" ? "/" : e.path}: ${e.message}`);
  if (errors.length > 0) return errors;
  const config = doc as {
    navbars: Record<NavbarId, { items: { id: string; widget: string }[] }>;
    theme: { name: string };
    hotkeys: Record<string, string>;
  };
  const problems: string[] = [];

  // Placements: ids unique across both navbars, widget types known for their navbar.
  const seen = new Map<string, string>();
  const layerWidgets = ctx.widgets ? new Map(ctx.widgets.map((w) => [w.id, w.navbars])) : undefined;
  for (const navbar of ["global", "agent"] as const) {
    config.navbars[navbar].items.forEach((item, i) => {
      const at = `/navbars/${navbar}/items/${i}`;
      const other = seen.get(item.id);
      if (other !== undefined) problems.push(`${at}/id: duplicate placement id ${item.id} (also at ${other})`);
      else seen.set(item.id, at);
      if ((BUILTIN_WIDGETS as readonly string[]).includes(item.widget)) return;
      if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(item.widget)) {
        problems.push(`${at}/widget: unknown widget ${item.widget}`);
        return;
      }
      if (layerWidgets === undefined) return;
      const navbars = layerWidgets.get(item.widget);
      if (navbars === undefined) problems.push(`${at}/widget: unknown widget ${item.widget}`);
      else if (!navbars.includes(navbar)) problems.push(`${at}/widget: ${item.widget} cannot be placed in the ${navbar} navbar`);
    });
  }

  // Theme name.
  if (ctx.themes && !ctx.themes.includes(config.theme.name)) problems.push(`/theme/name: unknown theme ${config.theme.name}`);

  // Hotkeys: built-in actions present, action names well formed, key values well formed, no key bound twice.
  for (const action of HOTKEY_ACTIONS) {
    if (!(action in config.hotkeys)) problems.push(`/hotkeys/${action}: the built-in action needs a key`);
  }
  const byKey = new Map<string, string>();
  for (const [action, key] of Object.entries(config.hotkeys)) {
    if (!ACTION_KEY.test(action)) problems.push(`/hotkeys/${action}: not a hotkey action (a built-in or <layer>.<action>)`);
    if (!KEY_VALUE.test(key)) problems.push(`/hotkeys/${action}: ${JSON.stringify(key)} is not one key or mod+key`);
    const norm = normaliseKey(key);
    const other = byKey.get(norm);
    if (other !== undefined) problems.push(`/hotkeys/${action}: duplicate hotkey ${key} (also ${other})`);
    else byKey.set(norm, action);
  }
  return problems;
}

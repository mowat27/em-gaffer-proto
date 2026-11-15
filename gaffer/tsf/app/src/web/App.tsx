/**
 * The app: the top bar over the three-pane workbench (DESIGN 11). Left: the page tree; centre: the focused page; right:
 * the agent pane with its header. App also mounts the hotkeys and the two modals that open on the `ui.open` event
 * (settings and cron).
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, useTheme, useToast } from "@pw/ui/react";
import { AgentHeader, AgentPane } from "./agent/AgentPane.tsx";
import { api, errorMessage } from "./api/client.ts";
import { CronModal } from "./cron/CronModal.tsx";
import { TopBar } from "./layout/TopBar.tsx";
import { Workbench } from "./layout/Workbench.tsx";
import { FactoryCenter } from "./factory/FactoryCenter.tsx";
import { FactoryNav } from "./factory/FactoryNav.tsx";
import { useHotkeys } from "./lib/hotkeys.ts";
import { documentTitle, pageLabel } from "../shared/agent-activity.ts";
import { useAgentState } from "./navbar/widgets.tsx";
import { PageTree } from "./pages/PageTree.tsx";
import { SettingsModal } from "./settings/SettingsModal.tsx";
import { acceptUiConfig, getFactoryState, onDelta, useFactory } from "./state/store.ts";

/** Drives pw-ui's ThemeProvider from the UI config's mode, so `useTheme()` agrees with `<html data-theme>`. */
function ModeSync() {
  const mode = useFactory((s) => (s.snapshot === null ? null : s.uiConfig.theme.mode));
  const { theme, setTheme } = useTheme();
  useEffect(() => {
    if (mode !== null && mode !== theme) setTheme(mode);
  }, [mode, theme, setTheme]);
  return null;
}

/**
 * The browser tab names the open page and the factory, and leads with the agent's words while it works, so a tab in the
 * background says whether the run finished (rules in shared/agent-activity.ts).
 */
function DocumentTitle() {
  const page = useFactory((s) => s.selection?.path ?? null);
  const factory = useFactory((s) => s.settings?.factoryName ?? s.status?.name ?? null);
  const agent = useAgentState();
  const words = agent.busy ? agent.short : null;
  useEffect(() => {
    document.title = documentTitle({ page: pageLabel(page), factory, agent: words });
  }, [page, factory, words]);
  return null;
}

/** The web build this page loaded (`<meta name="tsf-web-hash">`, set by the server); null under the dev proxy. */
export function loadedWebHash(): string | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLMetaElement>('meta[name="tsf-web-hash"]')?.content ?? null;
}

/** True when a build with `hash` is served and this page runs a different one. */
export function needsReload(loaded: string | null, served: string | null | undefined): boolean {
  return loaded !== null && typeof served === "string" && served !== "" && served !== loaded;
}

/**
 * Live web rebuild (DESIGN 3 "Web build"): reload when the server serves a different build than the one loaded (the
 * `web.rebuilt` event, or the snapshot after a restart), and show vite's error in a dismissible banner when a rebuild
 * failed (the previous good build keeps running).
 */
function WebBuildWatcher() {
  const served = useFactory((s) => s.status?.web?.hash ?? null);
  const error = useFactory((s) => s.webError);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(
    () =>
      onDelta((d) => {
        if (d.type === "web.rebuilt" && needsReload(loadedWebHash(), d.hash)) window.location.reload();
      }),
    [],
  );
  useEffect(() => {
    if (needsReload(loadedWebHash(), served)) window.location.reload();
  }, [served]);
  if (error === null || error === dismissed) return null;
  return (
    <div className="tsf-web-error" data-testid="web-build-error">
      <Alert tone="error" title="The web app did not rebuild" onDismiss={() => setDismissed(error)}>
        <pre className="tsf-web-error-text">{error}</pre>
        <p className="tsf-set-note">The previous build keeps running. Fix the source in tsf/app/src/web; the page rebuilds and reloads by itself.</p>
      </Alert>
    </div>
  );
}

interface Panel {
  readonly target: "settings" | "cron";
  readonly section?: string | undefined;
}

/**
 * Run a hotkey action. Opening a panel goes through the API, so every open page and the agent share one path. A layer
 * action that fails is reported (`fail`), so a key that did nothing says why ("No favourite model 2: ...").
 */
function runHotkey(action: string, fail: (title: string, err: unknown) => void): void {
  const state = getFactoryState();
  const panes = state.uiConfig.panes;
  const save = (patch: Parameters<typeof api.uiConfig.update>[0]): void => {
    api.uiConfig.update(patch).then(acceptUiConfig, () => undefined);
  };
  switch (action) {
    case "settings.open":
      api.ui.open("settings").catch(() => undefined);
      return;
    case "cron.open":
      api.ui.open("cron").catch(() => undefined);
      return;
    case "panes.left.toggle":
      save({ panes: { left: { visible: !panes.left.visible } } });
      return;
    case "panes.right.toggle":
      save(panes.right.visible || panes.agentMaximised ? { panes: { agentMaximised: false, right: { visible: false } } } : { panes: { right: { visible: true } } });
      return;
    case "agent.maximise":
      save(panes.agentMaximised ? { panes: { agentMaximised: false } } : { panes: { agentMaximised: true, right: { visible: true } } });
      return;
    case "agent.focus": {
      if (!panes.right.visible && !panes.agentMaximised) save({ panes: { right: { visible: true } } });
      // Wait a frame so a pane that was just shown has its composer.
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="composer"] textarea')?.focus());
      return;
    }
    default: {
      // A layer hotkey runs the layer's action, or opens one of its settings panels.
      const layer = action.split(".")[0] ?? "";
      const hotkey = state.layers.find((l) => l.name === layer && l.enabled)?.ui.hotkeys.find((h) => h.action === action);
      if (!hotkey) return;
      if (hotkey.run.kind === "panel") api.ui.open("settings", hotkey.run.panel).catch(() => undefined);
      else api.layers.action(layer, hotkey.run.action, hotkey.run.input ?? {}).catch((err: unknown) => fail(hotkey.title, err));
    }
  }
}

const hotkeyTable = (): Readonly<Record<string, string>> => getFactoryState().uiConfig.hotkeys;

export function App() {
  const [panel, setPanel] = useState<Panel | null>(null);
  const { toast } = useToast();
  const onHotkey = useCallback(
    (action: string) => runHotkey(action, (title, err) => toast({ tone: "error", title: `${title}: not done`, description: errorMessage(err) })),
    [toast],
  );
  useHotkeys(hotkeyTable, onHotkey);

  // `ui.open` arrives for every open page, whoever caused it (the button, the hotkey, the agent's open_panel tool).
  useEffect(
    () =>
      onDelta((d) => {
        if (d.type === "ui.open") setPanel({ target: d.target, section: d.section });
      }),
    [],
  );
  const close = useCallback(() => setPanel(null), []);

  return (
    <div className="tsf-app">
      <ModeSync />
      <DocumentTitle />
      <WebBuildWatcher />
      <TopBar />
      <Workbench
        left={
          <>
            <FactoryNav />
            <section className="tsf-files-tree" aria-label="Files">
              <h3>Files</h3>
              <PageTree />
            </section>
          </>
        }
        center={<FactoryCenter />}
        right={<AgentPane />}
        rightHeader={<AgentHeader />}
      />
      <SettingsModal open={panel?.target === "settings"} section={panel?.section} onClose={close} />
      <CronModal open={panel?.target === "cron"} onClose={close} />
    </div>
  );
}

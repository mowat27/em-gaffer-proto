/**
 * The top bar (DESIGN 11): the product brand, the global navbar from the UI config (widgets in three slots), then the
 * connection state (`data-testid="connection"`, `data-state="connecting|live|offline|restarting"`) and the Settings button. The
 * connection and Settings stay even when the navbar is hidden or empty, so the settings are always one click away.
 * Status is an icon and a word.
 */
import { CircleCheck, LoaderCircle, RotateCw, Settings, WifiOff } from "lucide-react";
import { Badge, Brand, IconButton, TopBar as PwTopBar } from "@pw/ui/react";
import { api } from "../api/client.ts";
import { Navbar } from "../navbar/Navbar.tsx";
import type { Connection } from "../state/store.ts";
import { useFactory } from "../state/store.ts";

const CONNECTION: Record<Connection, { word: string; tone: "success" | "neutral" | "error"; icon: typeof CircleCheck; title: string }> = {
  live: { word: "Live", tone: "success", icon: CircleCheck, title: "Connected: changes show as they happen" },
  connecting: { word: "Connecting", tone: "neutral", icon: LoaderCircle, title: "Connecting to the factory" },
  restarting: { word: "Restarting", tone: "neutral", icon: RotateCw, title: "The factory is restarting; this page reconnects by itself" },
  offline: { word: "Offline", tone: "error", icon: WifiOff, title: "The factory is not reachable; retrying" },
};

export function TopBar() {
  const connection = useFactory((s) => s.connection);
  const hotkey = useFactory((s) => s.uiConfig.hotkeys["settings.open"]);
  const c = CONNECTION[connection];
  return (
    <PwTopBar
      className="tsf-topbar"
      brand={<Brand href="/" name="Tiny Software Factory" />}
      nav={<Navbar id="global" className="tsf-navbar-global" />}
      actions={
        <>
          <Badge tone={c.tone} icon={c.icon} title={c.title} data-testid="connection" data-state={connection} role="status">
            {c.word}
          </Badge>
          <IconButton
            label={hotkey ? `Settings (${hotkey.toUpperCase()})` : "Settings"}
            icon={Settings}
            variant="ghost"
            data-cap="ui.open"
            data-testid="open-settings"
            onClick={() => {
              api.ui.open("settings").catch(() => {
                // The panel simply does not open.
              });
            }}
          />
        </>
      }
    />
  );
}

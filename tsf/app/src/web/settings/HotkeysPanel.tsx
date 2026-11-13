/**
 * Settings > Essentials > Hotkeys (spec 8.4): one row per hotkey action, a key field and a Set button. A key is one
 * character or "mod+key"; the server refuses a duplicate or an empty value and says why, which shows under the field.
 */
import { useState } from "react";
import { Button, Field, Input, StatusLine } from "@pw/ui/react";
import { api, errorMessage } from "../api/client.ts";
import { useFactory } from "../state/store.ts";

const TITLES: Record<string, string> = {
  "settings.open": "Open settings",
  "cron.open": "Open cron prompts",
  "panes.left.toggle": "Show or hide the pages pane",
  "panes.right.toggle": "Show or hide the agent pane",
  "agent.focus": "Focus the message box",
  "agent.maximise": "Expand or restore the agent",
};

function Row({ action, title, current }: { action: string; title: string; current: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const value = draft ?? current;
  const dirty = draft !== null && draft !== current;
  const save = (): void => {
    const key = value.trim();
    if (key === "") {
      setError("Enter a key, such as s or mod+k.");
      return;
    }
    api.hotkeys.set(action, key).then(
      () => {
        setDraft(null);
        setError(null);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      },
      (err: unknown) => setError(errorMessage(err)),
    );
  };
  return (
    <li className="tsf-set-hotkey" data-testid={`hotkey-${action}`}>
      <Field label={title} error={error ?? undefined} help={saved ? "Saved." : undefined}>
        {(f) => (
          <div className="tsf-set-hotkey-input">
            <Input
              {...f}
              value={value}
              inputSize="sm"
              maxLength={16}
              spellCheck={false}
              autoComplete="off"
              data-testid={`hotkey-input-${action}`}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(false);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
            />
            <Button variant="secondary" size="sm" disabled={!dirty} data-cap="hotkeys.set" data-testid={`hotkey-set-${action}`} onClick={save}>
              Set key
            </Button>
          </div>
        )}
      </Field>
    </li>
  );
}

export function HotkeysPanel() {
  const hotkeys = useFactory((s) => s.uiConfig.hotkeys);
  const layers = useFactory((s) => s.layers);
  const layerTitles = new Map(layers.filter((l) => l.enabled).flatMap((l) => l.ui.hotkeys.map((h) => [h.action, h.title] as const)));
  const actions = Object.keys(hotkeys);
  return (
    <div className="tsf-set-panel" data-testid="panel-hotkeys">
      <StatusLine>Hotkeys work anywhere on the page except while you are typing in a field.</StatusLine>
      <ul className="tsf-set-hotkeys" data-cap="hotkeys.list">
        {actions.map((a) => (
          <Row key={a} action={a} title={TITLES[a] ?? layerTitles.get(a) ?? a} current={hotkeys[a] ?? ""} />
        ))}
      </ul>
    </div>
  );
}

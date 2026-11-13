/**
 * Settings > Essentials > Theme (spec 8.3): the theme picker and colour mode, the contrast panel, a live preview, and
 * the editor for custom themes (seed and token colours per mode). No theme CSS is bundled: every change goes to the
 * server, which resolves the theme with pw-ui's `./theme` rules and answers with a `theme.applied` event that carries
 * the full CSS; `state/store.ts` swaps it into `<style id="tsf-theme">`. Edits apply as you type (after a short pause),
 * contrast failures are warnings and never block a change.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  Plus,
  RotateCcw,
  Trash2,
  Wand2,
} from "lucide-react";
import {
  AiTag,
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  Select,
  StatusLine,
  useToast,
} from "@pw/ui/react";
import { SEEDS, parseColor } from "@pw/ui/theme";
import { TOKEN_CHOICES } from "../../shared/theme-tokens.ts";
import type { ModeValues, ThemeCheck } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { useFactory } from "../state/store.ts";

const MODES = ["light", "dark"] as const;
type Mode = typeof MODES[number];

const NAME_RULE = /^[a-z][a-z0-9-]{0,62}$/;
const APPLY_DELAY_MS = 500;

function valuesOf(entry: unknown, mode: Mode): string {
  if (typeof entry === "string") return entry;
  if (typeof entry === "number") return String(entry);
  const v = (entry as ModeValues | undefined)?.[mode];
  return v === undefined ? "" : String(v);
}

/** "#RRGGBB" for the native picker from a hex, rgb() or hsl() string ("#000000" when it does not parse). */
export function toHex(value: string): string {
  const c = parseColor(value.trim());
  if (c === null) return "#000000";
  const h = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * A colour field: the swatch is painted in the shown colour and opens the native picker; the text input takes hex, rgb()
 * or hsl(). `overridden` marks a value the theme sets itself (badge and reset); otherwise the value is inherited.
 */
function ColourField({
  label,
  value,
  onChange,
  onReset,
  overridden,
  testId,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onReset?: () => void;
  overridden?: boolean;
  testId: string;
  disabled?: boolean;
}) {
  const bad = value.trim() !== "" && parseColor(value.trim()) === null;
  const paint = bad || value.trim() === "" ? undefined : { background: value };
  return (
    <Field
      label={label}
      error={bad ? "Use a hex, rgb() or hsl() colour." : undefined}
    >
      {(f) => (
        <div
          className="tsf-set-colour"
          data-overridden={overridden ? "true" : "false"}
        >
          <label
            className="tsf-set-swatch"
            style={paint}
            data-testid={`${testId}-swatch`}
          >
            <input
              type="color"
              className="tsf-set-picker"
              aria-label={`Pick ${label}`}
              value={toHex(value)}
              disabled={disabled}
              data-testid={`${testId}-picker`}
              onChange={(e) => onChange(e.target.value)}
            />
          </label>
          <Input
            {...f}
            value={value}
            inputSize="sm"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            placeholder="For example hsl(24 90% 55%)"
            data-testid={testId}
            onChange={(e) => onChange(e.target.value)}
          />
          {overridden && (
            <>
              <Badge tone="brand" data-testid={`${testId}-override`}>
                Override
              </Badge>
              {onReset && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={RotateCcw}
                  aria-label={`Reset ${label} to the inherited colour`}
                  data-testid={`${testId}-reset`}
                  onClick={onReset}
                >
                  Reset
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </Field>
  );
}

function Preview() {
  return (
    <div
      className="tsf-set-preview"
      data-testid="theme-preview"
      aria-label="Preview of the active theme"
    >
      <div className="tsf-set-preview-row">
        <Button variant="primary" size="sm">
          Primary
        </Button>
        <Button variant="secondary" size="sm">
          Secondary
        </Button>
        <Button variant="accent" size="sm">
          AI action
        </Button>
        <AiTag />
      </div>
      <div className="tsf-set-preview-row">
        <Badge tone="brand">Brand</Badge>
        <Badge tone="accent">Accent</Badge>
        <Badge tone="success" icon={CircleCheck}>
          Success
        </Badge>
        <Badge tone="warning" icon={CircleAlert}>
          Warning
        </Badge>
        <Badge tone="error" icon={CircleAlert}>
          Error
        </Badge>
      </div>
      <p className="tsf-set-preview-text">
        Body text on the surface, with <a href="#preview">a link</a> and{" "}
        <span className="tsf-set-preview-muted">secondary text</span>.
      </p>
    </div>
  );
}

function Contrast({
  name,
  custom,
  local,
  onCheck,
  onFix,
  busy,
}: {
  name: string;
  custom: boolean;
  local: ThemeCheck | null;
  onCheck: () => void;
  onFix: () => void;
  busy: boolean;
}) {
  const pushed = useFactory((s) => s.themeCheck);
  const check =
    pushed && pushed.name === name
      ? pushed
      : local && local.name === name
      ? local
      : null;
  const problems = check ? check.warnings.length + check.problems.length : 0;
  return (
    <section className="tsf-set-group" data-testid="theme-contrast">
      <h3 className="tsf-set-h">Contrast</h3>
      {check === null ? (
        <StatusLine>Not checked yet.</StatusLine>
      ) : problems === 0 ? (
        <StatusLine tone="success" icon={CircleCheck}>
          No contrast problems in light or dark.
        </StatusLine>
      ) : (
        <Alert
          tone="warning"
          title={`${problems} contrast ${
            problems === 1 ? "warning" : "warnings"
          }`}
          soft
        >
          Warnings do not block the theme. Fix them, or keep the colours as they
          are.
        </Alert>
      )}
      {check && (check.warnings.length > 0 || check.problems.length > 0) && (
        <ul className="tsf-set-warnings" data-testid="theme-warnings">
          {[...check.problems, ...check.warnings].map((w) => (
            <li key={w}>
              <code>{w}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="tsf-set-row">
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          data-cap="themes.check"
          data-testid="theme-check"
          onClick={onCheck}
        >
          Check contrast
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={Wand2}
          disabled={!custom || !check || check.fixes.length === 0}
          data-cap="themes.fix"
          data-testid="theme-fix"
          onClick={onFix}
        >
          Apply fixes
          {check && check.fixes.length > 0 ? ` (${check.fixes.length})` : ""}
        </Button>
      </div>
    </section>
  );
}

export function ThemeEditor() {
  const themes = useFactory((s) => s.themes);
  const theme = useFactory((s) => s.uiConfig.theme);
  const { toast } = useToast();
  const fail = (title: string) => (err: unknown) =>
    toast({ tone: "error", title, description: errorMessage(err) });

  const active = themes.find((t) => t.name === theme.name);
  const custom = active?.kind === "custom";

  // The seeds and tokens of a custom theme travel with the theme list (ThemeInfo.definition).
  const detail = active?.definition;

  const [localCheck, setLocalCheck] = useState<ThemeCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const runCheck = (): void => {
    setChecking(true);
    api.themes
      .check(theme.name)
      .then(setLocalCheck, fail("The check failed"))
      .finally(() => setChecking(false));
  };
  // Check the active theme when it changes, so the panel is never blank.
  useEffect(() => {
    if (theme.name === "") return;
    api.themes.check(theme.name).then(setLocalCheck, () => undefined);
  }, [theme.name]);

  // --- edits: drafts per seed or token and mode, sent after a pause ---------------------------------------------------
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "applying" | "applied">("idle");
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    setDrafts({});
    setStatus("idle");
    for (const t of Object.values(timers.current)) clearTimeout(t);
    timers.current = {};
  }, [theme.name]);

  const edit = (
    kind: "seeds" | "tokens",
    key: string,
    mode: Mode,
    value: string
  ): void => {
    const id = `${kind}.${key}.${mode}`;
    setDrafts((d) => ({ ...d, [id]: value }));
    clearTimeout(timers.current[id]);
    const v = value.trim();
    if (v === "" || parseColor(v) === null) return;
    timers.current[id] = setTimeout(() => {
      setStatus("applying");
      api.themes
        .values({ name: theme.name, [kind]: { [key]: { [mode]: v } } })
        .then(
          () => setStatus("applied"),
          (err: unknown) => {
            setStatus("idle");
            fail("The colour was not applied")(err);
          }
        );
    }, APPLY_DELAY_MS);
  };
  const own = (kind: "seeds" | "tokens", key: string, mode: Mode): string =>
    valuesOf(
      kind === "seeds" ? detail?.seeds?.[key] : detail?.tokens?.[key],
      mode
    );
  const overridden = (
    kind: "seeds" | "tokens",
    key: string,
    mode: Mode
  ): boolean => custom && own(kind, key, mode) !== "";
  /** A draft, else the effective colour the theme resolves to (the inherited value unless overridden). */
  const shown = (kind: "seeds" | "tokens", key: string, mode: Mode): string => {
    const id = `${kind}.${key}.${mode}`;
    if (id in drafts) return drafts[id] ?? "";
    const mine = own(kind, key, mode);
    if (mine !== "") return mine;
    return active?.resolved?.[kind]?.[key]?.[mode] ?? "";
  };
  const reset = (kind: "seeds" | "tokens", key: string): void => {
    for (const mode of MODES) {
      const id = `${kind}.${key}.${mode}`;
      clearTimeout(timers.current[id]);
      delete timers.current[id];
    }
    setDrafts((d) =>
      Object.fromEntries(
        Object.entries(d).filter(([id]) => !id.startsWith(`${kind}.${key}.`))
      )
    );
    setStatus("applying");
    api.themes.values({ name: theme.name, [kind]: { [key]: null } }).then(
      () => setStatus("applied"),
      (err: unknown) => {
        setStatus("idle");
        fail("The colour was not reset")(err);
      }
    );
  };

  const tokenKeys = useMemo(() => {
    const own = Object.keys(detail?.tokens ?? {});
    const drafted = Object.keys(drafts)
      .filter((k) => k.startsWith("tokens."))
      .map((k) => k.split(".")[1] ?? "");
    return [...new Set([...own, ...drafted])];
  }, [detail, drafts]);
  const [newToken, setNewToken] = useState<string>(TOKEN_CHOICES[0] ?? "");
  const [extra, setExtra] = useState<readonly string[]>([]);
  const visibleTokens = custom
    ? [...new Set([...tokenKeys, ...extra])]
    : [...TOKEN_CHOICES];

  // --- create ----------------------------------------------------------------------------------------------------------
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [base, setBase] = useState("");
  const baseName =
    base !== "" && themes.some((t) => t.name === base) ? base : theme.name;
  const nameError =
    name !== "" && !NAME_RULE.test(name)
      ? "Start with a letter, then use lowercase letters, digits and hyphens, for example warm-ai."
      : undefined;
  const [creating, setCreating] = useState(false);
  const create = (): void => {
    setCreating(true);
    api.themes
      .create({
        name,
        ...(title.trim() !== "" ? { title: title.trim() } : {}),
        base: baseName,
      })
      .then(() => api.themes.set(name))
      .then(() => {
        setName("");
        setTitle("");
      })
      .catch(fail("The theme was not created"))
      .finally(() => setCreating(false));
  };

  const [deleting, setDeleting] = useState(false);
  const pw = themes.filter((t) => t.kind === "pw");
  const mine = themes.filter((t) => t.kind === "custom");

  return (
    <div className="tsf-set-panel" data-testid="panel-theme">
      <section className="tsf-set-group">
        <h3 className="tsf-set-h">Theme</h3>
        <div className="tsf-set-grid" data-cap="themes.list">
          <Field label="Theme">
            {(f) => (
              <Select
                {...f}
                value={theme.name}
                data-cap="themes.set"
                data-testid="theme-select"
                onChange={(e) =>
                  api.themes
                    .set(e.target.value)
                    .catch(fail("The theme was not applied"))
                }
              >
                {!active && <option value={theme.name}>{theme.name}</option>}
                <optgroup label="Precision Weave">
                  {pw.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.title}
                    </option>
                  ))}
                </optgroup>
                {mine.length > 0 && (
                  <optgroup label="Custom">
                    {mine.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.title}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            )}
          </Field>
          <Field label="Colour mode">
            {(f) => (
              <Select
                {...f}
                value={theme.mode}
                data-cap="themes.set"
                data-testid="theme-mode"
                onChange={(e) =>
                  api.themes
                    .set(
                      theme.name,
                      e.target.value as "light" | "dark" | "system"
                    )
                    .catch(fail("The mode was not applied"))
                }
              >
                <option value="system">Follow the system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </Select>
            )}
          </Field>
        </div>
        <Preview />
      </section>

      <Contrast
        name={theme.name}
        custom={custom}
        local={localCheck}
        busy={checking}
        onCheck={runCheck}
        onFix={() =>
          api.themes
            .fix(theme.name)
            .then(runCheck, fail("The fixes were not applied"))
        }
      />

      <section className="tsf-set-group" data-testid="theme-edit">
        <h3 className="tsf-set-h">Colours</h3>
        {!custom && (
          <StatusLine>
            {active?.title ?? theme.name} is a built-in theme and cannot be
            edited. Its colours are shown below; create a custom theme from it,
            then change them here.
          </StatusLine>
        )}
        <>
          {custom && (
            <p
              className="tsf-set-note"
              role="status"
              data-testid="theme-edit-status"
            >
              {status === "applying"
                ? "Applying"
                : status === "applied"
                ? "Applied"
                : "Changes apply as you type."}
            </p>
          )}
          <h4 className="tsf-set-h2">Seeds</h4>
          <div className="tsf-set-colours">
            {SEEDS.map((seed) =>
              MODES.map((mode) => (
                <ColourField
                  key={`${seed}-${mode}`}
                  label={`${seed} (${mode})`}
                  value={shown("seeds", seed, mode)}
                  onChange={(v) => edit("seeds", seed, mode, v)}
                  onReset={() => reset("seeds", seed)}
                  overridden={overridden("seeds", seed, mode)}
                  disabled={!custom}
                  testId={`theme-seed-${seed}-${mode}`}
                />
              ))
            )}
          </div>
          <h4 className="tsf-set-h2">
            {custom ? "Token overrides" : "Tokens"}
          </h4>
          <div className="tsf-set-colours">
            {visibleTokens.map((token) =>
              MODES.map((mode) => (
                <ColourField
                  key={`${token}-${mode}`}
                  label={`${token} (${mode})`}
                  value={shown("tokens", token, mode)}
                  onChange={(v) => edit("tokens", token, mode, v)}
                  onReset={() => reset("tokens", token)}
                  overridden={overridden("tokens", token, mode)}
                  disabled={!custom}
                  testId={`theme-token-${token}-${mode}`}
                />
              ))
            )}
          </div>
          {custom && (
            <>
              <div className="tsf-set-row">
                <Field label="Add a token override">
                  {(f) => (
                    <Select
                      {...f}
                      value={newToken}
                      data-testid="theme-token-pick"
                      onChange={(e) => setNewToken(e.target.value)}
                    >
                      {TOKEN_CHOICES.filter(
                        (t) => !visibleTokens.includes(t)
                      ).map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Plus}
                  disabled={newToken === "" || visibleTokens.includes(newToken)}
                  data-cap="themes.values"
                  data-testid="theme-token-add"
                  onClick={() => setExtra((e) => [...e, newToken])}
                >
                  Add token
                </Button>
              </div>
              <div className="tsf-set-row">
                <Button
                  variant="danger"
                  size="sm"
                  icon={Trash2}
                  data-cap="themes.delete"
                  data-testid="theme-delete"
                  onClick={() => setDeleting(true)}
                >
                  Delete this theme
                </Button>
              </div>
              <ConfirmDialog
                open={deleting}
                onOpenChange={setDeleting}
                title={`Delete ${active?.title ?? theme.name}?`}
                confirmLabel="Delete theme"
                onConfirm={() => {
                  setDeleting(false);
                  api.themes
                    .remove(theme.name)
                    .catch(fail("The theme was not deleted"));
                }}
              >
                The factory goes back to Precision Weave Neon. This cannot be
                undone.
              </ConfirmDialog>
            </>
          )}
        </>
      </section>

      <section className="tsf-set-group" data-testid="theme-create">
        <h3 className="tsf-set-h">New custom theme</h3>
        <div className="tsf-set-grid">
          <Field
            label="Name"
            help="Starts with a letter; lowercase letters, digits and hyphens."
            error={nameError}
          >
            {(f) => (
              <Input
                {...f}
                value={name}
                inputSize="sm"
                autoComplete="off"
                spellCheck={false}
                data-testid="theme-create-name"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="Title" optional>
            {(f) => (
              <Input
                {...f}
                value={title}
                inputSize="sm"
                autoComplete="off"
                data-testid="theme-create-title"
                onChange={(e) => setTitle(e.target.value)}
              />
            )}
          </Field>
          <Field label="Start from">
            {(f) => (
              <Select
                {...f}
                value={baseName}
                data-testid="theme-create-base"
                onChange={(e) => setBase(e.target.value)}
              >
                {themes.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="tsf-set-row">
          <Button
            variant="primary"
            size="sm"
            loading={creating}
            disabled={name === "" || nameError !== undefined}
            data-cap="themes.create"
            data-testid="theme-create-submit"
            onClick={create}
          >
            Create theme
          </Button>
        </div>
      </section>
    </div>
  );
}

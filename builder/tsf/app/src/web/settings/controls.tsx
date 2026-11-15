/** Small controls the settings panels share: a switch row that carries a capability id, and a tab list. */
import { useId, type KeyboardEvent, type ReactNode } from "react";
import { Switch } from "@pw/ui/react";

/**
 * A setting that applies at once: label, switch and the word On or Off (pw-ui SwitchRow). The caller writes the literal
 * data-cap attribute with the capability id (and a `data-testid`) on the element; they are passed to the switch itself.
 */
export function Toggle({
  label,
  checked,
  onChange,
  disabled,
  ...rest
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  "data-cap": string;
  "data-testid"?: string;
}) {
  const id = useId();
  return (
    <div className="pw-switch-row">
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-labelledby={`${id}-label`} {...rest} />
      <span className="pw-switch-label" id={`${id}-label`}>
        {label}
      </span>
      <span className="pw-switch-state">{checked ? "On" : "Off"}</span>
    </div>
  );
}

export interface TabItem {
  readonly id: string;
  readonly label: string;
}

/** A tab list with roving arrow keys; the caller renders the panel. */
export function Tabs({
  items,
  value,
  onChange,
  label,
  className,
  testId,
}: {
  items: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  className?: string;
  testId?: string;
}) {
  const base = useId();
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = items.findIndex((t) => t.id === value);
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const target = items[(next + items.length) % items.length];
    if (!target) return;
    onChange(target.id);
    document.getElementById(`${base}-${target.id}`)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={className ? `tsf-tabs ${className}` : "tsf-tabs"} data-testid={testId} onKeyDown={onKey}>
      {items.map((t) => (
        <button
          key={t.id}
          id={`${base}-${t.id}`}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          className="tsf-tab"
          data-testid={`tab-${t.id}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

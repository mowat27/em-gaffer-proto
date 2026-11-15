/**
 * The one generic renderer of a layer's declarative `LayerControl` (DESIGN 8, "Layer handlers and UI"; types in
 * shared/types.ts). A project layer has no build step and cannot ship React, so its widgets and settings panels are
 * data and this file draws them with pw-ui. Queries are read on mount and again on every `layer.changed` for the same
 * layer; actions go to POST /api/layers/<layer>/action/<name>. This is the only file allowed a dynamic
 * `data-cap={control.capability}` (parity check 7).
 *
 * `inline` is the navbar form: a select's label sits beside it at the small control height, and a failed action is a
 * toast rather than a line under the control, so the bar never changes height.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Button, ConfirmDialog, Field, Input, Select, Switch, useToast } from "@pw/ui/react";
import { pickPath, shapeOptions, type OptionGroup } from "../../shared/select-options.ts";
import type { Json, LayerControl as Control } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { onDelta } from "../state/store.ts";

const pick = pickPath;

function show(value: Json | undefined): string {
  if (value === undefined || value === null) return "None";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** The query result for a control, re-read on this layer's changes, and for `core:` queries on settings, models and layer changes. */
function useQuery(layer: string, query: string | undefined): { value: Json | undefined; error: string | null } {
  const [value, setValue] = useState<Json | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(() => {
    if (query === undefined) return;
    api.layers.query(layer, query).then(
      (r) => {
        setValue(r);
        setError(null);
      },
      (err: unknown) => setError(errorMessage(err)),
    );
  }, [layer, query]);
  useEffect(() => {
    read();
    return onDelta((d) => {
      if (d.type === "layer.changed" && d.layer === layer) read();
      else if (d.type === "layers.changed") read();
      else if (query?.startsWith("core:") && (d.type === "settings.changed" || d.type === "models.changed")) read();
    });
  }, [layer, query, read]);
  return { value, error };
}

export function LayerControl({ layer, control, inline = false }: { layer: string; control: Control; inline?: boolean }) {
  const { toast } = useToast();
  const selectId = useId();
  const query = control.kind === "button" ? undefined : control.query;
  const field = control.kind === "button" ? undefined : control.kind === "value" ? control.field : control.field;
  const { value: raw, error: queryError } = useQuery(layer, query);
  const current = pick(raw, field);
  const optionsQuery = control.kind === "select" ? control.optionsQuery : undefined;
  const { value: optionsRaw } = useQuery(layer, optionsQuery?.query);
  const groups = useMemo<OptionGroup[]>(
    () => (optionsQuery ? shapeOptions(optionsRaw, optionsQuery) : [{ label: null, options: (control.kind === "select" ? (control.options ?? []) : []).map((o) => ({ value: o, label: o })) }]),
    [optionsRaw, optionsQuery, control],
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = actionError ?? queryError;

  const run = (action: string, input: Json): void => {
    setBusy(true);
    setActionError(null);
    api.layers
      .action(layer, action, input)
      .catch((err: unknown) => {
        if (inline) toast({ tone: "error", title: `${control.label} did not apply`, description: errorMessage(err) });
        else setActionError(errorMessage(err));
      })
      .finally(() => setBusy(false));
  };

  const errorLine = error ? (
    <p className="tsf-layer-error" role="alert">
      {error}
    </p>
  ) : null;

  switch (control.kind) {
    case "value":
      return (
        <div className="tsf-layer-control" data-cap={control.capability} data-layer={layer}>
          <span className="tsf-layer-label">{control.label}</span>
          <span className="tsf-layer-value">{show(current)}</span>
          {errorLine}
        </div>
      );
    case "button":
      return (
        <div className="tsf-layer-control" data-layer={layer} data-inline={inline ? "true" : undefined}>
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            data-cap={control.capability}
            onClick={() => (control.confirm ? setConfirm(true) : run(control.action, control.input ?? {}))}
          >
            {control.label}
          </Button>
          {control.confirm && (
            <ConfirmDialog
              open={confirm}
              onOpenChange={setConfirm}
              title={control.label}
              confirmLabel={control.label}
              onConfirm={() => {
                setConfirm(false);
                run(control.action, control.input ?? {});
              }}
            >
              {control.confirm}
            </ConfirmDialog>
          )}
          {errorLine}
        </div>
      );
    case "toggle":
      return (
        <div className="tsf-layer-control" data-layer={layer}>
          <Field label={control.label}>
            {(p) => (
              <Switch
                {...p}
                checked={current === true}
                disabled={busy}
                data-cap={control.capability}
                onCheckedChange={(v) => run(control.action, { value: v })}
              />
            )}
          </Field>
          {errorLine}
        </div>
      );
    case "select": {
      const value = typeof current === "string" ? current : "";
      // A value the options do not list (a stale list, a model chosen elsewhere) still shows, never a blank select.
      const known = groups.some((g) => g.options.some((o) => o.value === value));
      const select = (props: { id?: string; "aria-describedby"?: string }) => (
        <Select
          {...props}
          value={value}
          disabled={busy}
          className={inline ? "pw-input-sm" : undefined}
          wrapClassName={inline ? "tsf-layer-select" : undefined}
          data-cap={control.capability}
          onChange={(e) => run(control.action, { value: e.target.value })}
        >
          {value === "" && <option value="">Choose</option>}
          {value !== "" && !known && <option value={value}>{value}</option>}
          {groups.map((g) => {
            const options = g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ));
            return g.label === null ? options : (
              <optgroup key={`group:${g.label}`} label={g.label}>
                {options}
              </optgroup>
            );
          })}
        </Select>
      );
      if (inline) {
        return (
          <div className="tsf-layer-control" data-layer={layer} data-inline="true" title={queryError ?? undefined}>
            <label className="tsf-layer-label" htmlFor={selectId}>
              {control.label}
            </label>
            {select({ id: selectId })}
          </div>
        );
      }
      return (
        <div className="tsf-layer-control" data-layer={layer}>
          <Field label={control.label}>{(p) => select(p)}</Field>
          {errorLine}
        </div>
      );
    }
    case "text":
    case "number": {
      const shown = draft ?? (current === undefined || current === null ? "" : String(current));
      const save = (): void => {
        if (draft === null) return;
        const value: Json = control.kind === "number" ? Number(draft) : draft;
        if (control.kind === "number" && !Number.isFinite(value)) {
          setActionError("Enter a number.");
          return;
        }
        run(control.action, { value });
        setDraft(null);
      };
      return (
        <div className="tsf-layer-control" data-layer={layer}>
          <Field label={control.label}>
            {(p) => (
              <div className="tsf-layer-input">
                <Input
                  {...p}
                  type={control.kind === "number" ? "number" : "text"}
                  value={shown}
                  inputSize="sm"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                  }}
                />
                <Button variant="secondary" size="sm" disabled={draft === null} loading={busy} data-cap={control.capability} onClick={save}>
                  Save
                </Button>
              </div>
            )}
          </Field>
          {errorLine}
        </div>
      );
    }
  }
}

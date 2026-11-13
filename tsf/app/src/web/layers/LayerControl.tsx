/**
 * The one generic renderer of a layer's declarative `LayerControl` (DESIGN 8, "Layer handlers and UI"; types in
 * shared/types.ts). A project layer has no build step and cannot ship React, so its widgets and settings panels are
 * data and this file draws them with pw-ui. Queries are read on mount and again on every `layer.changed` for the same
 * layer; actions go to POST /api/layers/<layer>/action/<name>. This is the only file allowed a dynamic
 * `data-cap={control.capability}` (parity check 7).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ConfirmDialog, Field, Input, Select, Switch } from "@pw/ui/react";
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

export function LayerControl({ layer, control }: { layer: string; control: Control }) {
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
      .catch((err: unknown) => setActionError(errorMessage(err)))
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
        <div className="tsf-layer-control" data-layer={layer}>
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
    case "select":
      return (
        <div className="tsf-layer-control" data-layer={layer}>
          <Field label={control.label}>
            {(p) => (
              <Select
                {...p}
                value={typeof current === "string" ? current : ""}
                disabled={busy}
                data-cap={control.capability}
                onChange={(e) => run(control.action, { value: e.target.value })}
              >
                {typeof current !== "string" && <option value="">Choose</option>}
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
            )}
          </Field>
          {errorLine}
        </div>
      );
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

/**
 * Settings > Essentials > Layout and widgets > Custom widget types (P9, DESIGN 11): the widget types project layers
 * define, a Remove button for each, and a compact form that defines one (widgets.define). The widget is one declarative
 * LayerControl (shared/types.ts), so the form builds the same JSON the agent's define_widget tool takes. The layer list
 * and the widget catalog follow `layers.changed`; a placed widget of a removed type leaves the navbar with the type.
 */
import { useState } from "react";
import { Button, ConfirmDialog, Field, Input, Select, StatusLine, Textarea } from "@pw/ui/react";
import type { DefaultPlacement, Json, LayerControl, LayerInfo, NavbarId, NavbarSlot, SelectOptionsQuery, WidgetContribution } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { useFactory } from "../state/store.ts";

type Kind = LayerControl["kind"];
const KINDS: readonly Kind[] = ["value", "button", "toggle", "text", "number", "select"];

interface Form {
  layer: string;
  suffix: string;
  title: string;
  description: string;
  global: boolean;
  agent: boolean;
  kind: Kind;
  label: string;
  query: string;
  field: string;
  action: string;
  actionInput: string;
  options: string;
  oqQuery: string;
  oqField: string;
  oqValue: string;
  oqLabel: string;
  /** "", "value" or "label". */
  oqSort: string;
  /** "", "prefix:<separator>" or "field:<name>". */
  oqGroup: string;
  oqNumeric: boolean;
  /** "" (no default placement), "global" or "agent". */
  placeNavbar: string;
  placeSlot: NavbarSlot;
  capability: string;
}

const EMPTY: Form = {
  layer: "",
  suffix: "",
  title: "",
  description: "",
  global: true,
  agent: true,
  kind: "value",
  label: "",
  query: "",
  field: "",
  action: "",
  actionInput: "",
  options: "",
  oqQuery: "",
  oqField: "",
  oqValue: "",
  oqLabel: "",
  oqSort: "",
  oqGroup: "",
  oqNumeric: false,
  placeNavbar: "",
  placeSlot: "right",
  capability: "",
};

/** The verified model picker (template/examples/model-picker.layer.json), built from core capabilities only. */
const MODEL_PICKER: Omit<Form, "layer"> = {
  suffix: "model_picker",
  title: "Model picker",
  description: "Choose the model the agent uses.",
  global: true,
  agent: true,
  kind: "select",
  label: "Model",
  query: "core:settings.get",
  field: "model.modelId",
  action: "core:model.set",
  actionInput: '{ "modelId": "$value" }',
  options: "",
  oqQuery: "core:models.list",
  oqField: "",
  oqValue: "id",
  oqLabel: "name",
  oqSort: "label",
  oqGroup: "prefix:/",
  oqNumeric: true,
  // No default placement here: the form's own placement is the Layout panel's "Add widget".
  placeNavbar: "",
  placeSlot: "right",
  capability: "model.set",
};

/** The widget the form describes, or the sentence that says what is missing. */
export function buildWidget(f: Form): WidgetContribution | string {
  const suffix = f.suffix.trim();
  if (f.layer === "") return "Choose a layer.";
  if (suffix === "" || f.title.trim() === "") return "Enter an id suffix and a title.";
  const navbars: NavbarId[] = [...(f.global ? (["global"] as const) : []), ...(f.agent ? (["agent"] as const) : [])];
  if (navbars.length === 0) return "Choose at least one navbar.";
  if (f.label.trim() === "" || f.capability.trim() === "") return "Enter a control label and a capability.";
  const label = f.label.trim();
  const capability = f.capability.trim();
  const opt = (k: string, v: string): Record<string, string> => (v.trim() === "" ? {} : { [k]: v.trim() });
  let actionInput: Json | undefined;
  if (f.actionInput.trim() !== "") {
    try {
      actionInput = JSON.parse(f.actionInput) as Json;
    } catch {
      return "Action input is not valid JSON.";
    }
  }
  let control: LayerControl;
  if (f.kind === "value") {
    if (f.query.trim() === "") return "Enter a query.";
    control = { kind: "value", label, query: f.query.trim(), ...opt("field", f.field), capability };
  } else if (f.kind === "button") {
    if (f.action.trim() === "") return "Enter an action.";
    control = { kind: "button", label, action: f.action.trim(), capability };
  } else {
    if (f.query.trim() === "" || f.field.trim() === "" || f.action.trim() === "") return "Enter a query, a field and an action.";
    const base = { label, query: f.query.trim(), field: f.field.trim(), action: f.action.trim(), ...(actionInput !== undefined ? { actionInput } : {}), capability };
    if (f.kind === "select") {
      const options = f.options.split(",").map((o) => o.trim()).filter((o) => o !== "");
      if (f.oqQuery.trim() !== "") {
        const group = f.oqGroup.trim();
        const m = /^(prefix|field):(.+)$/.exec(group);
        if (group !== "" && !m) return 'Group by must read prefix:<separator> (for example prefix:/) or field:<name>.';
        const groupBy = m ? (m[1] === "prefix" ? { prefix: m[2]! } : { field: m[2]! }) : undefined;
        const optionsQuery: SelectOptionsQuery = {
          query: f.oqQuery.trim(),
          ...opt("field", f.oqField),
          ...opt("valueField", f.oqValue),
          ...opt("labelField", f.oqLabel),
          ...(f.oqSort === "value" || f.oqSort === "label" ? { sortBy: f.oqSort } : {}),
          ...(groupBy ? { groupBy } : {}),
          ...(f.oqNumeric ? { numeric: true } : {}),
        };
        control = { kind: "select", ...base, optionsQuery };
      } else if (options.length > 0) control = { kind: "select", ...base, options };
      else return "Enter options or an options query.";
    } else control = { kind: f.kind, ...base };
  }
  const defaultPlacements: DefaultPlacement[] = [];
  if (f.placeNavbar !== "") {
    if (!navbars.includes(f.placeNavbar as NavbarId)) return "The default placement navbar must be one of the chosen navbars.";
    defaultPlacements.push({ navbar: f.placeNavbar as NavbarId, slot: f.placeSlot });
  }
  return {
    id: `${f.layer}.${suffix}`,
    title: f.title.trim(),
    description: f.description.trim(),
    navbars,
    defaultOptions: {},
    control,
    ...(defaultPlacements.length > 0 ? { defaultPlacements } : {}),
  };
}

function DefineForm({ layers }: { layers: readonly LayerInfo[] }) {
  const [f, setF] = useState<Form>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]): void => setF((p) => ({ ...p, [k]: v }));
  const layer = layers.some((l) => l.name === f.layer) ? f.layer : (layers[0]?.name ?? "");
  const text = (k: keyof Form, label: string, testId: string, help?: string) => (
    <Field label={label} help={help}>
      {(p) => <Input {...p} value={String(f[k])} inputSize="sm" spellCheck={false} autoComplete="off" data-testid={testId} onChange={(e) => set(k, e.target.value as never)} />}
    </Field>
  );
  const submit = (): void => {
    setError(null);
    setNote(null);
    const w = buildWidget({ ...f, layer });
    if (typeof w === "string") {
      setError(w);
      return;
    }
    api.widgetTypes.define(layer, w).then(
      (r) => setNote(r.info.status === "failed" ? `Saved, but the layer failed to load: ${r.info.error ?? "unknown error"}` : `${r.created ? "Defined" : "Replaced"} ${r.widget.id}.`),
      (e: unknown) => setError(errorMessage(e)),
    );
  };
  return (
    <section className="tsf-set-group" data-testid="widget-define">
      <h3 className="tsf-set-h">Define widget</h3>
      {layers.length === 0 ? (
        <StatusLine tone="warning">Create a layer in Advanced, then define widgets in it.</StatusLine>
      ) : (
        <>
          <div className="tsf-set-row">
            <Button
              variant="ghost"
              size="sm"
              data-testid="widget-define-example"
              onClick={() => setF({ ...MODEL_PICKER, layer })}
            >
              Use model picker example
            </Button>
          </div>
          <div className="tsf-set-add">
            <Field label="Layer">
              {(p) => (
                <Select {...p} value={layer} data-testid="widget-define-layer" onChange={(e) => set("layer", e.target.value)}>
                  {layers.map((l) => (
                    <option key={l.name} value={l.name}>
                      {l.title} ({l.name})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {text("suffix", "Id suffix", "widget-define-suffix", `Full id: ${layer}.${f.suffix || "..."}`)}
            {text("title", "Title", "widget-define-title")}
            {text("description", "Description", "widget-define-description")}
          </div>
          <div className="tsf-set-add">
            <label className="tsf-set-note">
              <input type="checkbox" checked={f.global} data-testid="widget-define-global" onChange={(e) => set("global", e.target.checked)} /> Global navbar
            </label>
            <label className="tsf-set-note">
              <input type="checkbox" checked={f.agent} data-testid="widget-define-agent" onChange={(e) => set("agent", e.target.checked)} /> Agent navbar
            </label>
            <Field label="Control kind">
              {(p) => (
                <Select {...p} value={f.kind} data-testid="widget-define-kind" onChange={(e) => set("kind", e.target.value as Kind)}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {text("label", "Label", "widget-define-label")}
            {text("capability", "Capability", "widget-define-capability", "A core capability id such as model.set.")}
          </div>
          <div className="tsf-set-add">
            <Field label="Default placement" help="Placed once when the layer loads.">
              {(p) => (
                <Select {...p} value={f.placeNavbar} data-testid="widget-define-place-navbar" onChange={(e) => set("placeNavbar", e.target.value)}>
                  <option value="">None</option>
                  <option value="global">Global navbar</option>
                  <option value="agent">Agent navbar</option>
                </Select>
              )}
            </Field>
            {f.placeNavbar !== "" && (
              <Field label="Slot">
                {(p) => (
                  <Select {...p} value={f.placeSlot} data-testid="widget-define-place-slot" onChange={(e) => set("placeSlot", e.target.value as NavbarSlot)}>
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                  </Select>
                )}
              </Field>
            )}
          </div>
          <div className="tsf-set-add">
            {f.kind !== "button" && text("query", "Query", "widget-define-query", "core:settings.get or a layer handler.")}
            {f.kind !== "button" && text("field", "Field", "widget-define-field", "Dotted path, such as model.modelId.")}
            {f.kind !== "value" && text("action", "Action", "widget-define-action", "core:model.set or a layer handler.")}
          </div>
          {f.kind !== "value" && f.kind !== "button" && (
            <Field label="Action input (JSON, optional)" help={'"$value" is replaced by the chosen value.'}>
              {(p) => <Textarea {...p} value={f.actionInput} rows={2} spellCheck={false} data-testid="widget-define-actioninput" onChange={(e) => set("actionInput", e.target.value)} />}
            </Field>
          )}
          {f.kind === "select" && (
            <div className="tsf-set-add">
              {text("options", "Options (comma separated)", "widget-define-options")}
              {text("oqQuery", "Options query", "widget-define-oq-query", "core:models.list")}
              {text("oqField", "Options field", "widget-define-oq-field")}
              {text("oqValue", "Value field", "widget-define-oq-value")}
              {text("oqLabel", "Label field", "widget-define-oq-label")}
              <Field label="Sort by">
                {(p) => (
                  <Select {...p} value={f.oqSort} data-testid="widget-define-oq-sort" onChange={(e) => set("oqSort", e.target.value)}>
                    <option value="">Source order</option>
                    <option value="value">Value</option>
                    <option value="label">Label</option>
                  </Select>
                )}
              </Field>
              {text("oqGroup", "Group by", "widget-define-oq-group", "prefix:/ or field:provider")}
              <label className="tsf-set-note">
                <input type="checkbox" checked={f.oqNumeric} data-testid="widget-define-oq-numeric" onChange={(e) => set("oqNumeric", e.target.checked)} /> Numeric sort
              </label>
            </div>
          )}
          <div className="tsf-set-row">
            <Button variant="primary" size="sm" data-cap="widgets.define" data-testid="widget-define-submit" onClick={submit}>
              Define widget
            </Button>
          </div>
          {note !== null && (
            <div data-testid="widget-define-note">
              <StatusLine>{note}</StatusLine>
            </div>
          )}
          {error !== null && <p className="tsf-set-note" role="alert" data-testid="widget-define-error">{error}</p>}
        </>
      )}
    </section>
  );
}

export function WidgetTypes() {
  const layers = useFactory((s) => s.layers);
  const project = layers.filter((l) => l.source === "project");
  const types = project.flatMap((l) => l.ui.widgets.map((w) => ({ layer: l.name, widget: w })));
  const [removing, setRemoving] = useState<{ layer: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = (): void => {
    if (removing === null) return;
    const { layer, id } = removing;
    setRemoving(null);
    api.widgetTypes.undefine(layer, id).catch((e: unknown) => setError(errorMessage(e)));
  };
  return (
    <>
      <section className="tsf-set-group" data-testid="widget-types">
        <h3 className="tsf-set-h">Custom widget types</h3>
        {types.length === 0 ? (
          <p className="tsf-set-note">No project layer defines a widget type.</p>
        ) : (
          <ul className="tsf-set-widgets">
            {types.map(({ layer, widget }) => (
              <li key={widget.id} className="tsf-set-widget" data-testid={`widget-type-${widget.id}`}>
                <div className="tsf-set-widget-name">
                  <span>{widget.title}</span>
                  <code>{widget.id}</code>
                </div>
                <Button variant="danger" size="sm" data-cap="widgets.undefine" data-testid={`widget-type-remove-${widget.id}`} onClick={() => setRemoving({ layer, id: widget.id })}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error !== null && <p className="tsf-set-note" role="alert">{error}</p>}
        <ConfirmDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)} title="Remove widget type" confirmLabel="Remove" onConfirm={remove}>
          Remove {removing?.id}? Every placement of it leaves the navbars.
        </ConfirmDialog>
      </section>
      <DefineForm layers={project} />
    </>
  );
}

/**
 * Settings > Core 4 > Prompts (spec 8.5): the four prompt layers, each viewable and editable here and by the agent.
 * 1 the system prompt (default from factory_harness, or an override), 2 custom prompts (named, on or off), 3 extension
 * sections (read-only text, on or off per section) and 4 runtime prompts (appended at any time, removable). The lists
 * come from GET /api/prompts and are refetched on every `prompts.changed` event, so a change by the agent shows at once.
 */
import { useEffect, useState } from "react";
import { Eye, Plus, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Field, IconButton, Input, Textarea, useToast } from "@pw/ui/react";
import { api, errorMessage } from "../api/client.ts";
import { usePrompts } from "../state/queries.ts";
import { Toggle } from "./controls.tsx";
import { readPromptText, type CustomPromptView, type SectionPromptView } from "./p5-types.ts";

function useFail() {
  const { toast } = useToast();
  return (title: string) => (err: unknown) => toast({ tone: "error", title, description: errorMessage(err) });
}

function SystemLayer({ text, override }: { text: string; override: boolean }) {
  const fail = useFail();
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const dirty = draft !== text;
  return (
    <section className="tsf-set-group" data-testid="prompt-system">
      <h3 className="tsf-set-h">
        1. System prompt <Badge tone={override ? "warning" : "neutral"}>{override ? "Override" : "Default"}</Badge>
      </h3>
      <p className="tsf-set-note">The factory's own instructions to the agent. The default ships with the skill; saving text here overrides it.</p>
      <Field label="System prompt">
        {(c) => <Textarea {...c} rows={8} value={draft} data-cap="prompts.system" data-testid="system-text" onChange={(e) => setDraft(e.target.value)} />}
      </Field>
      <div className="tsf-set-row">
        <Button variant="primary" size="sm" disabled={!dirty || draft.trim() === ""} data-cap="prompts.system" data-testid="system-save" onClick={() => api.prompts.setSystem(draft).catch(fail("The system prompt was not saved"))}>
          Save override
        </Button>
        <Button variant="secondary" size="sm" disabled={!override} data-cap="prompts.system" data-testid="system-reset" onClick={() => api.prompts.setSystem(null).catch(fail("The default was not restored"))}>
          Use the default
        </Button>
      </div>
    </section>
  );
}

function CustomRow({ prompt }: { prompt: CustomPromptView }) {
  const fail = useFail();
  const [name, setName] = useState(prompt.name);
  const [text, setText] = useState(prompt.text);
  useEffect(() => {
    setName(prompt.name);
    setText(prompt.text);
  }, [prompt.name, prompt.text]);
  const dirty = name !== prompt.name || text !== prompt.text;
  return (
    <li className="tsf-prompt" data-testid={`custom-${prompt.name}`} data-enabled={prompt.enabled ? "true" : "false"}>
      <div className="tsf-prompt-head">
        <Toggle
          label={<strong>{prompt.name}</strong>}
          checked={prompt.enabled}
          onChange={(v) => api.prompts.toggle(prompt.id, v).catch(fail("The prompt was not switched"))}
          data-cap="prompts.toggle"
          data-testid={`custom-toggle-${prompt.name}`}
        />
        <IconButton label={`Delete ${prompt.name}`} icon={Trash2} data-cap="prompts.custom_delete" data-testid={`custom-delete-${prompt.name}`} onClick={() => api.prompts.deleteCustom(prompt.id).catch(fail("The prompt was not deleted"))} />
      </div>
      <Field label="Name">{(c) => <Input {...c} value={name} data-testid={`custom-name-${prompt.name}`} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label="Text">{(c) => <Textarea {...c} rows={3} value={text} data-testid={`custom-text-${prompt.name}`} onChange={(e) => setText(e.target.value)} />}</Field>
      <div className="tsf-set-row">
        <Button
          variant="secondary"
          size="sm"
          disabled={!dirty || name.trim() === "" || text.trim() === ""}
          data-cap="prompts.custom_update"
          data-testid={`custom-save-${prompt.name}`}
          onClick={() => api.prompts.updateCustom({ id: prompt.id, ...(name !== prompt.name ? { name: name.trim() } : {}), ...(text !== prompt.text ? { text } : {}) }).catch(fail("The prompt was not saved"))}
        >
          Save
        </Button>
      </div>
    </li>
  );
}

function CustomLayer({ items }: { items: readonly CustomPromptView[] }) {
  const fail = useFail();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const create = (): void => {
    api.prompts.createCustom({ name: name.trim(), text }).then(() => {
      setName("");
      setText("");
    }, fail("The prompt was not created"));
  };
  return (
    <section className="tsf-set-group" data-testid="prompt-custom">
      <h3 className="tsf-set-h">2. Custom prompts</h3>
      <p className="tsf-set-note">Named instructions you switch on or off. Every enabled one joins the agent's next request.</p>
      {items.length === 0 ? <p className="tsf-set-note" data-testid="custom-empty">No custom prompts yet.</p> : <ul className="tsf-prompts">{items.map((p) => <CustomRow key={p.id} prompt={p} />)}</ul>}
      <div className="tsf-prompt tsf-prompt-new">
        <Field label="New prompt name">{(c) => <Input {...c} value={name} data-testid="custom-new-name" onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Text">{(c) => <Textarea {...c} rows={3} value={text} data-testid="custom-new-text" onChange={(e) => setText(e.target.value)} />}</Field>
        <div className="tsf-set-row">
          <Button variant="primary" size="sm" icon={Plus} disabled={name.trim() === "" || text.trim() === ""} data-cap="prompts.custom_create" data-testid="custom-new-submit" onClick={create}>
            Add custom prompt
          </Button>
        </div>
      </div>
    </section>
  );
}

function SectionRow({ section }: { section: SectionPromptView }) {
  const fail = useFail();
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const view = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (text === null) {
      if (section.text !== null) setText(section.text);
      else api.prompts.get(section.id).then((r) => setText(readPromptText(r)), fail("The section did not load"));
    }
  };
  return (
    <li className="tsf-prompt" data-testid={`section-${section.id}`} data-enabled={section.enabled ? "true" : "false"}>
      <div className="tsf-prompt-head">
        <Toggle
          label={<code>{section.key}</code>}
          checked={section.enabled}
          onChange={(v) => api.prompts.toggle(section.id, v).catch(fail("The section was not switched"))}
          data-cap="prompts.toggle"
          data-testid={`section-toggle-${section.id}`}
        />
        <IconButton label={open ? `Hide ${section.key}` : `View ${section.key}`} icon={Eye} data-cap="prompts.get" data-testid={`section-view-${section.id}`} onClick={view} />
      </div>
      {open && <pre className="tsf-code" data-testid={`section-text-${section.id}`}>{text ?? "Loading"}</pre>}
    </li>
  );
}

function SectionsLayer({ items }: { items: readonly SectionPromptView[] }) {
  // Bottom-up, like the panel: the last layer applied is at the top, factory_harness at the bottom.
  const layers = [...new Set(items.map((s) => s.layer))].reverse();
  const rows = (layer: string) => items.filter((s) => s.layer === layer).reverse();
  return (
    <section className="tsf-set-group" data-testid="prompt-sections">
      <h3 className="tsf-set-h">3. Extension prompts</h3>
      <p className="tsf-set-note">Sections each enabled layer adds. Their text is read-only; switch a section off to leave it out.</p>
      {items.length === 0 && <p className="tsf-set-note">No enabled layer adds a prompt section.</p>}
      {layers.map((layer) => (
        <div key={layer} className="tsf-set-group">
          <h4 className="tsf-set-h2">{layer}</h4>
          <ul className="tsf-prompts">{rows(layer).map((s) => <SectionRow key={s.id} section={s} />)}</ul>
        </div>
      ))}
    </section>
  );
}

function RuntimeLayer({ items }: { items: readonly { id: string; text: string }[] }) {
  const fail = useFail();
  const [text, setText] = useState("");
  return (
    <section className="tsf-set-group" data-testid="prompt-runtime">
      <h3 className="tsf-set-h">4. Runtime prompts</h3>
      <p className="tsf-set-note">Text appended now and sent with the next request. It stays until you remove it.</p>
      {items.length === 0 ? (
        <p className="tsf-set-note" data-testid="runtime-empty">No runtime prompts.</p>
      ) : (
        <ul className="tsf-prompts">
          {items.map((r) => (
            <li key={r.id} className="tsf-prompt tsf-prompt-runtime" data-testid="runtime-item">
              <p className="tsf-prompt-text">{r.text}</p>
              <IconButton label="Remove this runtime prompt" icon={Trash2} data-cap="prompts.runtime_remove" data-testid="runtime-remove" onClick={() => api.prompts.removeRuntime(r.id).catch(fail("The prompt was not removed"))} />
            </li>
          ))}
        </ul>
      )}
      <Field label="Append a runtime prompt">{(c) => <Textarea {...c} rows={3} value={text} data-testid="runtime-text" onChange={(e) => setText(e.target.value)} />}</Field>
      <div className="tsf-set-row">
        <Button variant="primary" size="sm" icon={Plus} disabled={text.trim() === ""} data-cap="prompts.runtime_append" data-testid="runtime-append" onClick={() => api.prompts.appendRuntime(text.trim()).then(() => setText(""), fail("The prompt was not appended"))}>
          Append
        </Button>
        <Button variant="secondary" size="sm" disabled={items.length === 0} data-cap="prompts.runtime_clear" data-testid="runtime-clear" onClick={() => api.prompts.clearRuntime().catch(fail("The prompts were not cleared"))}>
          Remove all
        </Button>
      </div>
    </section>
  );
}

export function PromptsPanel() {
  const prompts = usePrompts();
  const view = prompts.data;
  return (
    <div className="tsf-set-panel" data-testid="panel-prompts" data-cap="prompts.list">
      {prompts.error !== null && (
        <Alert tone="error" title="The prompts did not load">
          {prompts.error}
        </Alert>
      )}
      {view && (
        <>
          {/* Bottom-up: the request is built system, then custom, then extension sections, then runtime. */}
          <RuntimeLayer items={view.runtime} />
          <SectionsLayer items={view.sections} />
          <CustomLayer items={view.custom} />
          <SystemLayer text={view.system.text} override={view.system.override} />
        </>
      )}
    </div>
  );
}

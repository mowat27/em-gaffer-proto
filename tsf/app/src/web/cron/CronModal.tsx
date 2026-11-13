/**
 * The cron panel (spec 8.6, DESIGN 11): a list of scheduled prompts with name, expression, prompt, an enabled switch,
 * next run and last run; create, edit, delete with confirm and run now. It opens on the `ui.open` event (hotkey R, the
 * cron_status widget and the agent's `open_panel` tool all go through `api.ui.open`). The list is read from the
 * `cron.changed` slice of the factory state, so a change made by the agent or another page shows with no reload.
 */
import { useEffect, useId, useState, type FormEvent } from "react";
import { Alert, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, Switch, Textarea } from "@pw/ui/react";
import { api, errorMessage } from "../api/client.ts";
import { useFactory } from "../state/store.ts";
import type { CronEntry } from "../../shared/types.ts";
import "./cron.css";

const fmt = (ms: number | null): string => (ms === null ? "never" : new Date(ms).toLocaleString());

interface Draft {
  readonly id: string | null;
  readonly name: string;
  readonly expr: string;
  readonly prompt: string;
  readonly enabled: boolean;
}

const BLANK: Draft = { id: null, name: "", expr: "*/5 * * * *", prompt: "", enabled: true };

function CronForm({ initial, onClose }: { initial: Draft; onClose: () => void }) {
  const formId = useId();
  const [d, setD] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = initial.id !== null;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (d.name.trim() === "" || d.expr.trim() === "" || d.prompt.trim() === "") {
      setError("Name, schedule and prompt are all required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (initial.id !== null) await api.cron.update({ id: initial.id, name: d.name.trim(), expr: d.expr.trim(), prompt: d.prompt, enabled: d.enabled });
      else await api.cron.create({ name: d.name.trim(), expr: d.expr.trim(), prompt: d.prompt, enabled: d.enabled });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form id={formId} className="tsf-cron-form" data-testid="cron-form" onSubmit={(e) => void submit(e)}>
      <h3 className="tsf-cron-form-title">{editing ? "Edit cron prompt" : "New cron prompt"}</h3>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Name">
        {(f) => <Input {...f} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} autoFocus spellCheck={false} autoComplete="off" data-testid="cron-name" />}
      </Field>
      <Field label="Schedule" help="A cron expression with 5 or 6 fields, for example * * * * * for every minute.">
        {(f) => <Input {...f} value={d.expr} onChange={(e) => setD({ ...d, expr: e.target.value })} spellCheck={false} autoComplete="off" data-testid="cron-expr" />}
      </Field>
      <Field label="Prompt" help="Sent to the agent as a message each time the schedule fires.">
        {(f) => <Textarea {...f} value={d.prompt} rows={4} onChange={(e) => setD({ ...d, prompt: e.target.value })} data-testid="cron-prompt" />}
      </Field>
      <div className="tsf-cron-form-actions">
        <Button variant="ghost" onClick={onClose} disabled={busy} data-testid="cron-cancel">
          Cancel
        </Button>
        {editing ? (
          <Button variant="primary" type="submit" form={formId} loading={busy} data-cap="cron.update" data-testid="cron-save">
            Save changes
          </Button>
        ) : (
          <Button variant="primary" type="submit" form={formId} loading={busy} data-cap="cron.create" data-testid="cron-save">
            Create
          </Button>
        )}
      </div>
    </form>
  );
}

function Row({ entry, onEdit, onDelete }: { entry: CronEntry; onEdit: () => void; onDelete: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const fail = (err: unknown): void => setError(errorMessage(err));
  return (
    <li className="tsf-cron-row" data-testid="cron-row" data-name={entry.name} data-enabled={entry.enabled ? "true" : "false"}>
      <div className="tsf-cron-head">
        <Switch
          checked={entry.enabled}
          onCheckedChange={(enabled) => {
            setError(null);
            api.cron.update({ id: entry.id, enabled }).catch(fail);
          }}
          aria-label={`Enabled: ${entry.name}`}
          data-cap="cron.update"
          data-testid="cron-enabled"
        />
        <strong className="tsf-cron-title" data-testid="cron-row-name">
          {entry.name}
        </strong>
        <code className="tsf-cron-expr" data-testid="cron-row-expr">
          {entry.expr}
        </code>
        {entry.lastStatus && <Badge tone={entry.lastStatus === "failed" ? "error" : "neutral"}>{entry.lastStatus}</Badge>}
        <span className="tsf-cron-spacer" />
        <Button
          variant="secondary"
          size="sm"
          loading={running}
          data-cap="cron.run_now"
          data-testid="cron-run-now"
          onClick={() => {
            setError(null);
            setRunning(true);
            api.cron
              .runNow(entry.id)
              .catch(fail)
              .finally(() => setRunning(false));
          }}
        >
          Run now
        </Button>
        <Button variant="ghost" size="sm" data-cap="cron.update" data-testid="cron-edit" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" data-cap="cron.delete" data-testid="cron-delete" onClick={onDelete}>
          Delete
        </Button>
      </div>
      <p className="tsf-cron-prompt" data-testid="cron-row-prompt">
        {entry.prompt}
      </p>
      <p className="tsf-cron-times">
        <span>
          Next run: <span data-testid="cron-next">{entry.enabled ? fmt(entry.nextRunAt) : "paused"}</span>
        </span>
        <span>
          Last run: <span data-testid="cron-last">{fmt(entry.lastRunAt)}</span>
        </span>
      </p>
      {error && <Alert tone="error">{error}</Alert>}
    </li>
  );
}

export function CronModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cron = useFactory((s) => s.cron);
  const [form, setForm] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<CronEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A closed panel forgets its half-made form.
  useEffect(() => {
    if (!open) {
      setForm(null);
      setDeleting(null);
    }
  }, [open]);

  async function confirmDelete(entry: CronEntry): Promise<void> {
    setBusy(true);
    setDeleteError(null);
    try {
      await api.cron.remove(entry.id);
      setDeleting(null);
    } catch (err) {
      setDeleteError(errorMessage(err));
    }
    setBusy(false);
  }

  return (
    <>
      <Dialog open={open && deleting === null} onOpenChange={(o) => !o && onClose()} title="Cron prompts" description="Prompts the agent receives on a schedule." size="lg" className="tsf-cron-dialog" closeButton>
        <div data-testid="cron-modal">
          {form ? (
            <CronForm key={form.id ?? "new"} initial={form} onClose={() => setForm(null)} />
          ) : (
            <>
              <div className="tsf-cron-toolbar">
                <Button variant="primary" size="sm" data-cap="cron.create" data-testid="cron-new" onClick={() => setForm(BLANK)}>
                  New cron prompt
                </Button>
              </div>
              <div data-cap="cron.list" data-testid="cron-list">
                {cron.length === 0 ? (
                  <EmptyState title="No cron prompts" compact>
                    Add one to have the agent do something on a schedule.
                  </EmptyState>
                ) : (
                  <ul className="tsf-cron-rows">
                    {cron.map((c) => (
                      <Row
                        key={c.id}
                        entry={c}
                        onEdit={() => setForm({ id: c.id, name: c.name, expr: c.expr, prompt: c.prompt, enabled: c.enabled })}
                        onDelete={() => {
                          setDeleteError(null);
                          setDeleting(c);
                        }}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </Dialog>
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o && !busy) setDeleting(null);
          }}
          title={`Delete cron prompt "${deleting.name}"?`}
          description="It stops firing. Runs already in the chat stay."
          confirmLabel="Delete"
          danger
          onConfirm={() => void confirmDelete(deleting)}
          loading={busy}
        >
          {deleteError && <Alert tone="error">{deleteError}</Alert>}
        </ConfirmDialog>
      )}
    </>
  );
}

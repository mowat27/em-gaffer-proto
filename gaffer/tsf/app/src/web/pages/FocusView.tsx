/**
 * Centre pane: the selected page (DESIGN 11). Reads the snapshot's `focus`, so it follows whoever selected the page
 * and shows an agent's edit as it lands. Editing keeps its text and the version it started from in sessionStorage
 * (`useDraft`), so a reload loses nothing and a save after it still detects a conflict.
 */
import { useState } from "react";
import { FileText, Pencil, X } from "lucide-react";
import { Alert, Breadcrumbs, Button, EmptyState, IconButton, Textarea } from "@pw/ui/react";
import { api, errorMessage } from "../api/client.ts";
import { useDraft } from "../common/drafts.ts";
import { Markdown } from "../common/Markdown.tsx";
import { useFactory } from "../state/store.ts";
import type { Page } from "../../shared/types.ts";
import { hasPage, START_PAGE } from "./tree.ts";

function EmptyFocus() {
  const tree = useFactory((s) => s.pages);
  const [error, setError] = useState<string | null>(null);
  const canOpenStart = hasPage(tree, START_PAGE);

  return (
    <div className="tsf-focus-empty" data-testid="focus-empty">
      <EmptyState
        icon={FileText}
        title="No page open"
        actions={
          canOpenStart ? (
            <Button
              variant="primary"
              data-cap="pages.select"
              data-testid="open-start"
              onClick={() => {
                setError(null);
                api.pages.select(START_PAGE).catch((err: unknown) => setError(errorMessage(err)));
              }}
            >
              Open Start Here
            </Button>
          ) : undefined
        }
      >
        Pick a page on the left, or ask the agent to open one.
      </EmptyState>
      {error && (
        <Alert tone="error" soft onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
    </div>
  );
}

function crumbsOf(path: string): { label: string }[] {
  return path.split("/").map((seg, i, all) => ({ label: i === all.length - 1 ? seg.replace(/\.md$/, "") : seg }));
}

function PageBody({ page }: { page: Page }) {
  const [draft, setDraft, clearDraft] = useDraft(`tsf.draft.page:${page.path}`);
  // The version the draft was started from; a separate draft key so the plan's text key stays exactly as designed.
  const [base, setBase, clearBase] = useDraft(`tsf.draft.page.base:${page.path}`);
  const [editing, setEditing] = useState(base !== "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  // Not while saving: our own page.updated can arrive before the save's response does.
  const stale = editing && !saving && base !== "" && base !== page.version;

  function startEdit(): void {
    setError(null);
    setDraft(page.content);
    setBase(page.version);
    setEditing(true);
  }

  function leaveEdit(): void {
    clearDraft();
    clearBase();
    setError(null);
    setEditing(false);
  }

  async function save(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.pages.update({ path: page.path, content: draft, ...(base !== "" ? { baseVersion: base } : {}) });
      leaveEdit();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function close(): void {
    setClosing(true);
    api.pages
      .unselect()
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setClosing(false));
  }

  return (
    <>
      <div className="tsf-focus-head">
        <div className="tsf-focus-crumbs" data-testid="focus-crumbs">
          <Breadcrumbs items={crumbsOf(page.path)} label="Page location" />
        </div>
        <div className="tsf-focus-actions">
          {editing ? (
            <>
              <Button variant="ghost" size="sm" onClick={leaveEdit} disabled={saving} data-testid="page-cancel">
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={saving}
                disabled={draft === page.content}
                onClick={() => void save()}
                data-cap="pages.update"
                data-testid="page-save"
              >
                Save
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" icon={Pencil} onClick={startEdit} data-cap="pages.update" data-testid="page-edit">
              Edit
            </Button>
          )}
          <IconButton
            size="sm"
            label="Close page"
            icon={X}
            disabled={closing}
            onClick={close}
            data-cap="pages.unselect"
            data-testid="focus-close"
          />
        </div>
      </div>

      <div className="tsf-focus-body">
        {error && (
          <div className="tsf-focus-alert">
            <Alert tone="error" soft onDismiss={() => setError(null)}>
              {error}
            </Alert>
          </div>
        )}

        {editing ? (
          <>
            {stale && (
              <div className="tsf-focus-alert" data-testid="page-stale">
                <Alert
                  tone="warning"
                  title="This page changed while you were editing"
                  actions={
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setDraft(page.content);
                          setBase(page.version);
                        }}
                      >
                        Load the newer version
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setBase(page.version)}>
                        Keep my version
                      </Button>
                    </>
                  }
                >
                  Saving now would replace the newer version. Choose which text to keep.
                </Alert>
                <details className="tsf-focus-newer">
                  <summary>Newer version</summary>
                  <Markdown text={page.content} />
                </details>
              </div>
            )}
            <Textarea
              className="tsf-editor"
              aria-label={`Markdown of ${page.path}`}
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                  e.preventDefault();
                  if (draft !== page.content) void save();
                }
                // Escape leaves the editor only while there is nothing to lose, so the hotkeys work again.
                if (e.key === "Escape" && draft === page.content) {
                  e.preventDefault();
                  leaveEdit();
                }
              }}
              data-testid="page-editor"
            />
          </>
        ) : (
          <div data-testid="page-content" data-version={page.version}>
            <Markdown text={page.content} />
          </div>
        )}
      </div>
    </>
  );
}

export function FocusView() {
  const selection = useFactory((s) => s.selection);
  const focus = useFactory((s) => s.focus);
  const path = selection?.path ?? null;

  return (
    <div className="tsf-focus" data-testid="focus-view" data-cap="pages.read" data-path={path ?? undefined}>
      {path === null ? (
        <EmptyFocus />
      ) : focus && focus.path === path ? (
        <PageBody key={focus.path} page={focus} />
      ) : (
        <p className="tsf-focus-loading" role="status">
          Loading page
        </p>
      )}
    </div>
  );
}

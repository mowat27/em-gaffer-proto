/**
 * Dialogs of the page tree: create a page, create a folder, rename or move, delete with confirm (DESIGN 11, left pane).
 * Each one performs its API call itself and reports the result through `onDone`; the tree decides what to reveal and
 * select. Errors from the API stay inside the dialog so the person can fix the name and try again.
 */
import { useId, useState, type FormEvent } from "react";
import { Alert, Button, ConfirmDialog, Dialog, Field, Input } from "@pw/ui/react";
import { api, errorMessage } from "../api/client.ts";
import type { PagePath, TreeNode } from "../../shared/types.ts";
import { countPages, displayName } from "./tree.ts";

export type DialogState =
  | { readonly kind: "new-page"; readonly initial: string }
  | { readonly kind: "new-folder"; readonly initial: string }
  | { readonly kind: "move"; readonly node: TreeNode }
  | { readonly kind: "delete"; readonly node: TreeNode };

export type DialogResult =
  | { readonly kind: "page-created"; readonly path: PagePath }
  | { readonly kind: "folder-created"; readonly path: PagePath }
  | { readonly kind: "moved"; readonly from: PagePath; readonly to: PagePath }
  | { readonly kind: "deleted"; readonly path: PagePath };

interface PageDialogsProps {
  state: DialogState | null;
  onClose: () => void;
  onDone: (result: DialogResult) => void;
}

/** Trim, drop leading and trailing slashes and doubled slashes. */
function cleanPath(raw: string): string {
  return raw
    .trim()
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join("/");
}

interface NameDialogProps {
  title: string;
  description: string;
  label: string;
  help: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  /** Resolves when done; throws to show the message in the field. */
  onSubmit: (path: string) => Promise<void>;
  testId: string;
}

function NameDialog({ title, description, label, help, initial, submitLabel, onClose, onSubmit, testId }: NameDialogProps) {
  const formId = useId();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const path = cleanPath(value);
    if (path === "") {
      setError("Enter a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(path);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} data-testid={`${testId}-submit`}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} data-testid={testId}>
        <Field label={label} help={help} error={error ?? undefined}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} autoFocus spellCheck={false} autoComplete="off" data-testid={`${testId}-input`} />
        </Field>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ node, onClose, onDone }: { node: TreeNode; onClose: () => void; onDone: (r: DialogResult) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pages = countPages(node);
  const isFolder = node.kind === "folder";
  const name = displayName(node.path);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.pages.remove(node.path, isFolder && node.children.length > 0 ? true : undefined);
      onDone({ kind: "deleted", path: node.path });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const what = isFolder
    ? pages === 0
      ? "This deletes the empty folder."
      : `This deletes the folder and the ${pages} ${pages === 1 ? "page" : "pages"} in it.`
    : "This deletes the page from the project's tsf/pages folder.";

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`Delete ${isFolder ? "folder" : "page"} "${name}"?`}
      description={what}
      confirmLabel={isFolder ? "Delete folder" : "Delete page"}
      onConfirm={() => void confirm()}
      loading={busy}
    >
      {error && (
        <Alert tone="error" soft>
          {error}
        </Alert>
      )}
    </ConfirmDialog>
  );
}

export function PageDialogs({ state, onClose, onDone }: PageDialogsProps) {
  if (!state) return null;

  if (state.kind === "new-page") {
    return (
      <NameDialog
        key="new-page"
        testId="dialog-new-page"
        title="New page"
        description="The page is created and opened. Use / to put it in a folder."
        label="Page name"
        help="For example Notes/Ideas. The .md ending is added for you."
        initial={state.initial}
        submitLabel="Create page"
        onClose={onClose}
        onSubmit={async (path) => {
          const page = await api.pages.create(path.endsWith(".md") ? path : `${path}.md`);
          onDone({ kind: "page-created", path: page.path });
        }}
      />
    );
  }

  if (state.kind === "new-folder") {
    return (
      <NameDialog
        key="new-folder"
        testId="dialog-new-folder"
        title="New folder"
        description="Folders can be nested. Use / to create one inside another."
        label="Folder name"
        help="For example Languages/Python."
        initial={state.initial}
        submitLabel="Create folder"
        onClose={onClose}
        onSubmit={async (path) => {
          await api.pages.mkdir(path);
          onDone({ kind: "folder-created", path });
        }}
      />
    );
  }

  if (state.kind === "move") {
    const node = state.node;
    const isPage = node.kind === "page";
    return (
      <NameDialog
        key={`move:${node.path}`}
        testId="dialog-move"
        title={isPage ? "Rename or move page" : "Rename or move folder"}
        description={`Change the path of "${displayName(node.path)}". Folders in the new path are created when missing.`}
        label="New path"
        help={isPage ? "The .md ending is added for you." : "Pages inside the folder move with it."}
        initial={isPage ? node.path.replace(/\.md$/, "") : node.path}
        submitLabel={isPage ? "Move page" : "Move folder"}
        onClose={onClose}
        onSubmit={async (path) => {
          const to = isPage && !path.endsWith(".md") ? `${path}.md` : path;
          if (to === node.path) {
            onClose();
            return;
          }
          await api.pages.move(node.path, to);
          onDone({ kind: "moved", from: node.path, to });
        }}
      />
    );
  }

  return <DeleteDialog key={`delete:${state.node.path}`} node={state.node} onClose={onClose} onDone={onDone} />;
}

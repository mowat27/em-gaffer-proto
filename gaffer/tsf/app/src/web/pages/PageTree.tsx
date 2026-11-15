/**
 * Left pane: the page tree (DESIGN 11). Own markup (pw-ui has no tree): nested lists, folders that expand, page rows
 * that focus a page through api.pages.select. Which folders are collapsed is a per-browser convenience kept in
 * localStorage; every other piece of state comes from the snapshot, so a refresh rebuilds the tree. Upload (the
 * header button, or files dropped anywhere on the pane) saves any file into tsf/uploads.
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, FilePlus, FileText, Folder, FolderOpen, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { Alert, IconButton, LoadingState, useToast } from "@pw/ui/react";
import { api, errorMessage } from "../api/client.ts";
import { setView } from "../factory/viewStore.ts";
import { useFactory } from "../state/store.ts";
import type { FolderNode, PagePath, TreeNode } from "../../shared/types.ts";
import { DropZone, UploadButton, useUploader } from "../common/FileDrop.tsx";
import { PageDialogs, type DialogResult, type DialogState } from "./PageDialogs.tsx";
import { ancestorsOf, displayName, parentOf } from "./tree.ts";

const COLLAPSED_KEY = "tsf.tree.collapsed";

function loadCollapsed(): Set<PagePath> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: ReadonlySet<PagePath>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    /* the tree works without storage; the folders just open again after a reload */
  }
}

interface BranchProps {
  nodes: readonly TreeNode[];
  depth: number;
  selected: PagePath | null;
  collapsed: ReadonlySet<PagePath>;
  onToggle: (folder: FolderNode) => void;
  onSelect: (path: PagePath) => void;
  onMove: (node: TreeNode) => void;
  onDelete: (node: TreeNode) => void;
}

function Branch({ nodes, depth, selected, collapsed, onToggle, onSelect, onMove, onDelete }: BranchProps) {
  const indent = { "--tsf-depth": depth } as CSSProperties;
  return (
    <ul className="tsf-tree-list">
      {nodes.map((node) => {
        const name = displayName(node.path);
        const actions = (
          <div className="tsf-tree-actions">
            <IconButton
              size="sm"
              label={`Rename or move ${name}`}
              icon={Pencil}
              data-cap="pages.move"
              data-testid="tree-move"
              onClick={() => onMove(node)}
            />
            <IconButton size="sm" label={`Delete ${name}`} icon={Trash2} data-cap="pages.delete" data-testid="tree-delete" onClick={() => onDelete(node)} />
          </div>
        );

        if (node.kind === "folder") {
          const open = !collapsed.has(node.path);
          return (
            <li key={node.path} className="tsf-tree-item" data-kind="folder" data-path={node.path}>
              <div className="tsf-tree-row" style={indent}>
                <button type="button" className="tsf-tree-main" aria-expanded={open} onClick={() => onToggle(node)} data-testid="tree-folder">
                  {open ? <ChevronDown className="tsf-tree-chevron" aria-hidden="true" /> : <ChevronRight className="tsf-tree-chevron" aria-hidden="true" />}
                  {open ? <FolderOpen className="tsf-tree-icon" aria-hidden="true" /> : <Folder className="tsf-tree-icon" aria-hidden="true" />}
                  <span className="tsf-tree-name">{node.name}</span>
                </button>
                {actions}
              </div>
              {open && node.children.length > 0 && (
                <Branch
                  nodes={node.children}
                  depth={depth + 1}
                  selected={selected}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  onMove={onMove}
                  onDelete={onDelete}
                />
              )}
            </li>
          );
        }

        const isSelected = node.path === selected;
        return (
          <li key={node.path} className="tsf-tree-item" data-kind="page" data-path={node.path}>
            <div className="tsf-tree-row" style={indent} data-selected={isSelected}>
              <button
                type="button"
                className="tsf-tree-main"
                aria-current={isSelected ? "page" : undefined}
                title={node.title}
                data-cap="pages.select"
                data-testid="tree-page"
                onClick={() => onSelect(node.path)}
              >
                <span className="tsf-tree-chevron" aria-hidden="true" />
                <FileText className="tsf-tree-icon" aria-hidden="true" />
                <span className="tsf-tree-name">{node.name}</span>
              </button>
              {actions}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function PageTree() {
  const tree = useFactory((s) => s.pages);
  const selection = useFactory((s) => s.selection);
  const selected: PagePath | null = selection?.path ?? null;

  const [collapsed, setCollapsed] = useState<Set<PagePath>>(loadCollapsed);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The Pages pane's header slot (Workbench) that holds the new-page and new-folder buttons. */
  const [tools, setTools] = useState<HTMLElement | null>(null);
  useEffect(() => setTools(document.getElementById("tsf-left-tools")), []);
  /** The folder the toolbar's "new" buttons start in: the last folder opened, or the one holding the selected page. */
  const [context, setContext] = useState<PagePath>("");
  const { toast } = useToast();
  const { uploading, upload } = useUploader();
  const uploadFiles = useCallback(
    (files: File[]) => {
      void upload(files).then((saved) => {
        if (saved.length === 0) return;
        const title = saved.length === 1 ? `Uploaded ${saved[0]!.name}` : `Uploaded ${saved.length} files`;
        toast({ tone: "success", title, description: saved.length === 1 ? `Saved as ${saved[0]!.path}.` : "Saved in tsf/uploads." });
      });
    },
    [upload, toast],
  );

  const reveal = useCallback((path: PagePath) => {
    const above = ancestorsOf(path);
    setCollapsed((prev) => {
      if (!above.some((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      for (const p of above) next.delete(p);
      saveCollapsed(next);
      return next;
    });
  }, []);

  // A page selected by anyone (this tree, the agent, an API call) is always visible in the tree.
  useEffect(() => {
    if (selected === null) return;
    reveal(selected);
    setContext(parentOf(selected));
  }, [selected, reveal]);

  const toggle = useCallback((folder: FolderNode) => {
    setContext(folder.path);
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folder.path)) next.delete(folder.path);
      else next.add(folder.path);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const select = useCallback((path: PagePath) => {
    setError(null);
    setView("page");
    api.pages.select(path).catch((err: unknown) => setError(errorMessage(err)));
  }, []);

  const onDone = useCallback(
    (result: DialogResult) => {
      setDialog(null);
      setError(null);
      if (result.kind === "page-created") {
        reveal(result.path);
        select(result.path);
      } else if (result.kind === "folder-created") {
        reveal(`${result.path}/x`);
        setContext(result.path);
      } else if (result.kind === "moved") {
        reveal(result.to);
      }
    },
    [reveal, select],
  );

  const prefix = context === "" ? "" : `${context}/`;
  const children = tree?.children ?? [];

  return (
    <DropZone className="tsf-tree" testId="page-tree" data-cap="pages.list" onFiles={uploadFiles} disabled={uploading !== null} label="Drop files to upload them to tsf/uploads">
      {tools &&
        createPortal(
          <>
            <IconButton
              size="sm"
              label="New page"
              icon={FilePlus}
              data-cap="pages.create"
              data-testid="new-page"
              onClick={() => setDialog({ kind: "new-page", initial: prefix })}
            />
            <IconButton
              size="sm"
              label="New folder"
              icon={FolderPlus}
              data-cap="pages.create_folder"
              data-testid="new-folder"
              onClick={() => setDialog({ kind: "new-folder", initial: prefix })}
            />
            <UploadButton iconOnly label="Upload files to tsf/uploads" loading={uploading !== null} testId="upload-file" onFiles={uploadFiles} />
          </>,
          tools,
        )}

      {uploading !== null && (
        <div className="tsf-tree-alert" data-testid="upload-progress">
          <LoadingState text={uploading} />
        </div>
      )}
      {error && (
        <div className="tsf-tree-alert">
          <Alert tone="error" soft onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      <nav className="tsf-tree-scroll" aria-label="Pages">
        {children.length === 0 ? (
          <p className="tsf-tree-empty">No pages yet. Create one with the buttons above, or ask the agent.</p>
        ) : (
          <Branch
            nodes={children}
            depth={0}
            selected={selected}
            collapsed={collapsed}
            onToggle={toggle}
            onSelect={select}
            onMove={(node) => setDialog({ kind: "move", node })}
            onDelete={(node) => setDialog({ kind: "delete", node })}
          />
        )}
      </nav>

      <PageDialogs state={dialog} onClose={() => setDialog(null)} onDone={onDone} />
    </DropZone>
  );
}

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileCode, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { IconButton } from "@pw/ui/react";
import { api } from "../api/client.ts";
import { selectPiAgentFile, usePiAgentFile } from "../factory/piAgentStore.ts";
import { setView } from "../factory/viewStore.ts";

interface File {
  readonly path: string;
  readonly size: number;
}
interface Directory {
  readonly name: string;
  readonly dirs: Map<string, Directory>;
  readonly files: File[];
}

const COLLAPSED_KEY = "tsf.pi-agent-tree.collapsed";

function loadCollapsed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((path): path is string => typeof path === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(paths: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...paths]));
  } catch {
    /* The tree remains usable when browser storage is unavailable. */
  }
}

function directory(files: readonly File[]): Directory {
  const root: Directory = { name: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let here = root;
    for (const part of parts.slice(0, -1)) {
      let child = here.dirs.get(part);
      if (!child) {
        child = { name: part, dirs: new Map(), files: [] };
        here.dirs.set(part, child);
      }
      here = child;
    }
    here.files.push(file);
  }
  return root;
}

function FolderBranch({
  node,
  path,
  selected,
  collapsed,
  onToggle,
  onOpen,
}: {
  node: Directory;
  path: string;
  selected: string | null;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const open = !collapsed.has(path);
  return (
    <li className="tsf-tree-item" data-kind="folder">
      <button type="button" className="tsf-tree-main tsf-pi-tree-folder" aria-expanded={open} onClick={() => onToggle(path)}> 
        {open ? <ChevronDown className="tsf-tree-chevron" /> : <ChevronRight className="tsf-tree-chevron" />}
        {open ? <FolderOpen className="tsf-tree-icon" /> : <Folder className="tsf-tree-icon" />}
        <span className="tsf-tree-name">{node.name}</span>
      </button>
      {open && <Branch node={node} prefix={path} selected={selected} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />}
    </li>
  );
}

function Branch({
  node,
  prefix,
  selected,
  collapsed,
  onToggle,
  onOpen,
}: {
  node: Directory;
  prefix: string;
  selected: string | null;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <ul className="tsf-tree-list">
      {[...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((dir) => {
        const path = prefix === "" ? dir.name : `${prefix}/${dir.name}`;
        return <FolderBranch key={path} node={dir} path={path} selected={selected} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />;
      })}
      {[...node.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => (
        <li key={file.path} className="tsf-tree-item" data-kind="page">
          <button type="button" className="tsf-tree-main tsf-pi-tree-file" aria-current={selected === file.path ? "page" : undefined} title={file.path} onClick={() => onOpen(file.path)}>
            <span className="tsf-tree-chevron" />
            <FileCode className="tsf-tree-icon" />
            <span className="tsf-tree-name">{file.path.split("/").at(-1)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A left-pane tree over the builder's definitions (builder/agentics, read only), alongside the normal Pages tree. */
export function PiAgentTree() {
  const [files, setFiles] = useState<File[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const selected = usePiAgentFile();
  const refresh = (): void => { void api.builderAgent.files().then((result) => setFiles(result.files), () => setFiles([])); };
  useEffect(() => { refresh(); }, []);
  const toggle = (path: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveCollapsed(next);
      return next;
    });
  };
  const open = (path: string): void => {
    selectPiAgentFile(path);
    setView("pi-agent");
  };
  return (
    <section className="tsf-pi-tree" aria-label="Agentics files">
      <div className="tsf-pi-tree-head">
        <h3>Agentics</h3>
        <IconButton size="sm" label="Refresh agentics files" icon={RefreshCw} onClick={() => { void refresh(); }} />
      </div>
      <Branch node={directory(files)} prefix="" selected={selected} collapsed={collapsed} onToggle={toggle} onOpen={open} />
    </section>
  );
}

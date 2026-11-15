/**
 * Settings > Advanced > Layers authoring (P9, DESIGN 11): reload layers, create a project layer, and per layer a file
 * editor (list, open, save, new file, delete file) and delete layer. Built-in layers list their files read-only. Every
 * write goes through the Service, which validates and reloads; the layer list, tools and prompt sections follow the
 * `layers.changed`, `tools.changed` and `prompts.changed` events, so nothing here refetches them. Also the read-only
 * Settings block (settings.get). Import layer (a local path or https URL, or a file uploaded into tsf/uploads from the
 * form's Upload file button or a drop on the form) sits beside New layer; a project layer row has
 * Export, which writes the archive to tsf/data/exports and offers it as a download.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, ConfirmDialog, Field, Input, StatusLine, Switch, Textarea, useToast } from "@pw/ui/react";
import type { ExportLayerResult, LayerFileList, LayerInfo, Settings } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { DropZone, UploadButton, useUploader } from "../common/FileDrop.tsx";
import { onDelta } from "../state/store.ts";

export function LayerToolbar() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [source, setSource] = useState("");
  const [importName, setImportName] = useState("");
  const [replace, setReplace] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const { uploading, upload } = useUploader();
  // An uploaded archive fills the path; Import stays the user's step, so the name and Replace can still be set.
  const uploadArchive = (files: File[]): void => {
    setImportError(null);
    setImportNote(null);
    void upload(files.slice(0, 1)).then(([saved]) => {
      if (!saved) return;
      setSource(saved.path);
      setImportNote(`Uploaded to ${saved.path}. Choose Import to install it.`);
    });
  };

  const doImport = (): void => {
    setImportError(null);
    setImportNote(null);
    api.layers
      .import({ source: source.trim(), ...(importName.trim() !== "" ? { name: importName.trim() } : {}), ...(replace ? { replace: true } : {}) })
      .then(
        (r) => {
          setImportNote(r.layer.status === "failed" ? `Imported ${r.name}, but it failed to load: ${r.layer.error ?? "unknown error"}` : `Imported ${r.name} ${r.version}.`);
          setSource("");
          setImportName("");
        },
        (e: unknown) => setImportError(errorMessage(e)),
      );
  };

  const reload = (): void => {
    setBusy(true);
    api.layers.reload().then(
      (list) => {
        setBusy(false);
        const failed = list.filter((l) => l.status === "failed");
        toast({ tone: failed.length > 0 ? "error" : "success", title: failed.length > 0 ? `${failed.length} layer(s) failed to load` : "Layers reloaded" });
      },
      (e: unknown) => {
        setBusy(false);
        toast({ tone: "error", title: "The layers were not reloaded", description: errorMessage(e) });
      },
    );
  };
  const create = (): void => {
    setError(null);
    api.layers.create({ name: name.trim(), title: title.trim(), description: description.trim() }).then(
      () => {
        setOpen(false);
        setName("");
        setTitle("");
        setDescription("");
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  };
  return (
    <div className="tsf-set-group" data-testid="layer-toolbar">
      <div className="tsf-set-row">
        <Button variant="secondary" size="sm" loading={busy} data-cap="layers.reload" data-testid="layers-reload" onClick={reload}>
          Reload layers
        </Button>
        <Button variant="secondary" size="sm" aria-expanded={open} data-testid="layer-new" onClick={() => setOpen(!open)}>
          New layer
        </Button>
        <Button variant="secondary" size="sm" aria-expanded={importOpen} data-testid="layer-import" onClick={() => setImportOpen(!importOpen)}>
          Import layer
        </Button>
      </div>
      {importOpen && (
        <DropZone className="tsf-set-group" testId="layer-import-form" onFiles={uploadArchive} disabled={uploading !== null} label="Drop a layer archive to upload it">
          <div className="tsf-set-add">
            <Field label="Path or URL" help="A .tgz or layer folder on this machine, or an https URL to a .tgz. Or upload a .tgz.">
              {(f) => (
                <div className="tsf-import-source">
                  <Input {...f} value={source} inputSize="sm" spellCheck={false} autoComplete="off" data-testid="layer-import-source" onChange={(e) => setSource(e.target.value)} />
                  <UploadButton label="Upload file" multiple={false} accept=".tgz,.gz,application/gzip" loading={uploading !== null} testId="layer-import-upload" onFiles={uploadArchive} />
                </div>
              )}
            </Field>
            <Field label="Name" help="Optional: install under another name.">
              {(f) => <Input {...f} value={importName} inputSize="sm" spellCheck={false} autoComplete="off" data-testid="layer-import-name" onChange={(e) => setImportName(e.target.value)} />}
            </Field>
            <Field label="Replace an existing layer">
              {(f) => <Switch {...f} checked={replace} data-testid="layer-import-replace" onCheckedChange={setReplace} />}
            </Field>
            <Button variant="primary" size="sm" disabled={source.trim() === ""} data-cap="layers.import" data-testid="layer-import-submit" onClick={doImport}>
              Import
            </Button>
          </div>
          {importNote !== null && (
            <div data-testid="layer-import-note">
              <StatusLine>{importNote}</StatusLine>
            </div>
          )}
          {importError !== null && <p className="tsf-set-note" role="alert" data-testid="layer-import-error">{importError}</p>}
        </DropZone>
      )}
      {open && (
        <div className="tsf-set-group" data-testid="layer-new-form">
          <div className="tsf-set-add">
            <Field label="Name" help="Lower case letters, digits and underscores.">
              {(f) => <Input {...f} value={name} inputSize="sm" spellCheck={false} autoComplete="off" data-testid="layer-new-name" onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label="Title">
              {(f) => <Input {...f} value={title} inputSize="sm" autoComplete="off" data-testid="layer-new-title" onChange={(e) => setTitle(e.target.value)} />}
            </Field>
            <Field label="Description">
              {(f) => <Input {...f} value={description} inputSize="sm" autoComplete="off" data-testid="layer-new-description" onChange={(e) => setDescription(e.target.value)} />}
            </Field>
            <Button variant="primary" size="sm" disabled={name.trim() === "" || title.trim() === ""} data-cap="layers.create" data-testid="layer-new-submit" onClick={create}>
              Create layer
            </Button>
          </div>
          {error !== null && <p className="tsf-set-note" role="alert" data-testid="layer-new-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

function FileEditor({ layer }: { layer: LayerInfo }) {
  const [list, setList] = useState<LayerFileList | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [newPath, setNewPath] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.layers.files(layer.name).then(setList, (e: unknown) => setError(errorMessage(e)));
  }, [layer.name]);
  useEffect(() => {
    refresh();
    return onDelta((d) => {
      if (d.type === "layers.changed") refresh();
    });
  }, [refresh]);

  const editable = list?.editable === true;
  const dirty = path !== null && text !== saved;

  const openFile = (p: string): void => {
    setError(null);
    setNote(null);
    api.layers.readFile(layer.name, p).then(
      (r) => {
        setPath(p);
        setText(r.content);
        setSaved(r.content);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  };
  const write = (p: string, content: string): void => {
    setError(null);
    setNote(null);
    api.layers.writeFile(layer.name, p, content).then(
      (r) => {
        setPath(p);
        setText(content);
        setSaved(content);
        setNewPath("");
        setNote(r.layer.status === "failed" ? `Saved, but the layer failed to load: ${r.layer.error ?? "unknown error"}` : `Saved ${p}.`);
        refresh();
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  };
  const remove = (): void => {
    if (path === null) return;
    setConfirmDelete(false);
    api.layers.deleteFile(layer.name, path).then(
      () => {
        setPath(null);
        setText("");
        setSaved("");
        refresh();
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  };

  return (
    <div className="tsf-layer-files" data-testid={`author-files-${layer.name}`}>
      {list === null ? (
        <p className="tsf-set-note">Loading</p>
      ) : (
        <ul className="tsf-chips">
          {list.files.map((f) => (
            <li key={f.path}>
              <Button variant="ghost" size="sm" aria-pressed={path === f.path} data-cap="layers.read_file" data-testid={`author-file-${layer.name}-${f.path}`} onClick={() => openFile(f.path)}>
                {f.path}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {list !== null && !editable && <p className="tsf-set-note">A built-in layer is read-only.</p>}
      {path !== null && (
        <div className="tsf-set-group" data-testid={`author-editor-${layer.name}`}>
          <Field label={path}>
            {(f) => (
              <Textarea {...f} value={text} rows={10} spellCheck={false} readOnly={!editable} data-testid={`author-editor-text-${layer.name}`} onChange={(e) => setText(e.target.value)} />
            )}
          </Field>
          <div className="tsf-set-row">
            <Button variant="primary" size="sm" disabled={!editable || !dirty} data-cap="layers.write_file" data-testid={`author-file-save-${layer.name}`} onClick={() => write(path, text)}>
              Save
            </Button>
            {editable && (
              <Button variant="danger" size="sm" data-cap="layers.delete_file" data-testid={`author-file-delete-${layer.name}`} onClick={() => setConfirmDelete(true)}>
                Delete file
              </Button>
            )}
          </div>
          <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete file" confirmLabel="Delete file" onConfirm={remove}>
            Delete {path} from {layer.name}? This cannot be undone.
          </ConfirmDialog>
        </div>
      )}
      {editable && (
        <div className="tsf-set-add">
          <Field label="New file" help="A path inside the layer, such as prompts/house_style.md.">
            {(f) => <Input {...f} value={newPath} inputSize="sm" spellCheck={false} autoComplete="off" data-testid={`author-newfile-path-${layer.name}`} onChange={(e) => setNewPath(e.target.value)} />}
          </Field>
          <Button variant="secondary" size="sm" disabled={newPath.trim() === ""} data-cap="layers.write_file" data-testid={`author-newfile-create-${layer.name}`} onClick={() => write(newPath.trim(), "")}>
            Create file
          </Button>
        </div>
      )}
      {note !== null && (
        <div data-testid={`author-files-note-${layer.name}`}>
          <StatusLine>{note}</StatusLine>
        </div>
      )}
      {error !== null && <p className="tsf-set-note" role="alert" data-testid={`author-files-error-${layer.name}`}>{error}</p>}
    </div>
  );
}

/** Files disclosure and Delete layer for one layer row. */
export function LayerAuthoringRow({ layer }: { layer: LayerInfo }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [exported, setExported] = useState<ExportLayerResult | null>(null);
  const exportIt = (): void => {
    setExported(null);
    api.layers.export(layer.name).then(setExported, (e: unknown) => toast({ tone: "error", title: `${layer.title} was not exported`, description: errorMessage(e) }));
  };
  const del = (): void => {
    setConfirm(false);
    api.layers.delete(layer.name).catch((e: unknown) => toast({ tone: "error", title: `${layer.title} was not deleted`, description: errorMessage(e) }));
  };
  return (
    <div className="tsf-layer-author">
      <div className="tsf-set-row">
        <Button variant="ghost" size="sm" aria-expanded={open} data-cap="layers.files" data-testid={`author-files-toggle-${layer.name}`} onClick={() => setOpen(!open)}>
          {open ? "Hide files" : "Files"}
        </Button>
        {layer.source === "project" && (
          <Button variant="secondary" size="sm" data-cap="layers.export" data-testid={`author-export-${layer.name}`} onClick={exportIt}>
            Export
          </Button>
        )}
        {layer.source === "project" && (
          <Button variant="danger" size="sm" data-cap="layers.delete" data-testid={`author-delete-${layer.name}`} onClick={() => setConfirm(true)}>
            Delete layer
          </Button>
        )}
      </div>
      {exported !== null && (
        <p className="tsf-set-note" data-testid={`author-exported-${layer.name}`}>
          Exported {exported.files.length} files ({exported.size} bytes) to <code>{exported.path}</code>.{" "}
          <a href={api.layers.exportFileUrl(exported.file)} download={exported.file} data-testid={`author-export-download-${layer.name}`}>
            Download {exported.file}
          </a>
        </p>
      )}
      {layer.source === "project" && (
        <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete layer" confirmLabel="Delete layer" onConfirm={del}>
          Delete the layer {layer.name} and all its files? Its widgets leave the navbars and its prompt sections go. This cannot be undone.
        </ConfirmDialog>
      )}
      {open && <FileEditor layer={layer} />}
    </div>
  );
}

/** Read-only view of the settings document (factory name, turn limit, model). */
export function SettingsBlock() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const read = (): void => {
      api.settings.get().then(
        (s) => {
          setSettings(s);
          setError(null);
        },
        (e: unknown) => setError(errorMessage(e)),
      );
    };
    read();
    return onDelta((d) => {
      if (d.type === "settings.changed") read();
    });
  }, []);
  return (
    <section className="tsf-set-group" data-cap="settings.get" data-testid="settings-block">
      <h4 className="tsf-set-h2">Settings</h4>
      {settings === null ? (
        <p className="tsf-set-note">{error ?? "Loading"}</p>
      ) : (
        <div className="tsf-set-note" data-testid="settings-values">
          <div>
            Factory name: <code data-testid="settings-factory-name">{settings.factoryName}</code>
          </div>
          <div>
            Max turns: <code data-testid="settings-max-turns">{settings.maxTurns === null ? "no limit" : String(settings.maxTurns)}</code>
          </div>
          <div>
            Model: <code data-testid="settings-model">{settings.model ? `${settings.model.provider}/${settings.model.modelId}` : "default"}</code>
          </div>
        </div>
      )}
    </section>
  );
}

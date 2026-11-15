import { useEffect, useState } from "react";
import { FileCode, Save } from "lucide-react";
import { Alert, Button, EmptyState } from "@pw/ui/react";
import { CodeEditor } from "../common/CodeEditor.tsx";
import { api, errorMessage } from "../api/client.ts";
import { usePiAgentFile } from "./piAgentStore.ts";

/** Editor for a file selected in the Pi agent tree in the left pane. */
export function PiAgentView() {
  const path = usePiAgentFile();
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    api.builderAgent.read(path).then(
      (file) => {
        setContent(file.content);
        setSaved(file.content);
      },
      (err: unknown) => setError(errorMessage(err)),
    ).finally(() => setLoading(false));
  }, [path]);

  const save = (): void => {
    if (!path || saving || content === saved) return;
    setSaving(true);
    setError(null);
    api.builderAgent.write(path, content).then(
      (file) => {
        setContent(file.content);
        setSaved(file.content);
      },
      (err: unknown) => setError(errorMessage(err)),
    ).finally(() => setSaving(false));
  };

  if (!path) {
    return <div className="tsf-focus-empty"><EmptyState icon={FileCode} title="No Pi agent file open">Choose a file under Pi agent in the left pane.</EmptyState></div>;
  }

  return (
    <div className="tsf-focus" data-testid="pi-agent-file" data-path={path}>
      <div className="tsf-focus-head">
        <div className="tsf-focus-crumbs"><span className="tsf-fx-mono">builder/pi-agent/{path}</span></div>
        <div className="tsf-focus-actions">
          <Button size="sm" variant="primary" icon={Save} loading={saving} disabled={content === saved || loading} onClick={save}>Save</Button>
        </div>
      </div>
      <div className="tsf-focus-body">
        {error && <Alert tone="error" soft onDismiss={() => setError(null)}>{error}</Alert>}
        {loading ? <p className="tsf-focus-loading">Loading file</p> : <CodeEditor path={path} value={content} onChange={setContent} onSave={save} />}
      </div>
    </div>
  );
}

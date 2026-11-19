import { useEffect, useState } from "react";
import { FileCode } from "lucide-react";
import { Alert, EmptyState } from "@pw/ui/react";
import { api, errorMessage } from "../api/client.ts";
import { usePiAgentFile } from "./piAgentStore.ts";

/**
 * A file of the builder's definitions (builder/agentics), selected in the agent tree in the left pane. Read only:
 * definitions change through the builder's definitions tools, which validate and version each change.
 */
export function PiAgentView() {
  const path = usePiAgentFile();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    api.builderAgent
      .read(path)
      .then(
        (file) => setContent(file.content),
        (err: unknown) => setError(errorMessage(err)),
      )
      .finally(() => setLoading(false));
  }, [path]);

  if (!path) {
    return (
      <div className="tsf-focus-empty">
        <EmptyState icon={FileCode} title="No definition open">
          Choose a file under Agentics in the left pane.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="tsf-focus" data-testid="pi-agent-file" data-path={path}>
      <div className="tsf-focus-head">
        <div className="tsf-focus-crumbs">
          <span className="tsf-fx-mono">builder/agentics/{path}</span>
        </div>
      </div>
      <div className="tsf-focus-body">
        {error && (
          <Alert tone="error" soft onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        <p className="tsf-fx-muted">Read only. Change definitions with the builder's definitions tools (agent_update, skill_update, ...), which validate and version every change.</p>
        {loading ? <p className="tsf-focus-loading">Loading file</p> : <pre className="tsf-fx-pre">{content}</pre>}
      </div>
    </div>
  );
}

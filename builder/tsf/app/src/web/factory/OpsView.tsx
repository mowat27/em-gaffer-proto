/**
 * Builder > Ops: the operator's notifications, newest first. Agents send them with notify_operator (the ops agent ends
 * every investigation with one); they are recorded in control/notifications.jsonl and read through the builder layer
 * (`builder tool notifications_list`), together with any a builder's tsf notify sink posted to this TSF. A new one
 * arrives as a feed event, which re-reads the list.
 */
import { RefreshCw } from "lucide-react";
import { Alert, Button, Card } from "@pw/ui/react";
import { StatusChip, ago } from "./common.tsx";
import { useLayerQuery } from "./useLayer.ts";

interface Notification {
  id: string;
  ts: string;
  severity: string;
  summary: string;
  runId?: string;
  jobId?: string;
  link?: string;
  from?: string;
}

const chip = (severity: string) => (severity === "error" ? "error" : severity === "warn" ? "warn" : "ok") as "error" | "warn" | "ok";

export function OpsView() {
  const list = useLayerQuery<{ count: number; error: string | null; notifications: Notification[] }>("builder", "notifications", { limit: 100 });
  const items = list.data?.notifications ?? [];
  return (
    <div className="tsf-ss" data-testid="ops-view">
      {(list.error || list.data?.error) && (
        <Alert tone="error" soft>
          {list.error ?? list.data?.error}
        </Alert>
      )}
      <Card
        title="Notifications"
        description="What agents told the operator (notify_operator), newest first: the ops agent ends every investigation with one, naming its branch and evidence."
        actions={
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={list.loading} onClick={list.refresh}>
            Refresh
          </Button>
        }
      >
        {items.length === 0 ? (
          <p className="tsf-fx-muted">No notifications yet.</p>
        ) : (
          <table className="tsf-fx-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Severity</th>
                <th>Summary</th>
                <th>Run</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {items.map((n) => (
                <tr key={n.id}>
                  <td title={n.ts} style={{ whiteSpace: "nowrap" }}>
                    {ago(n.ts)}
                  </td>
                  <td>
                    <StatusChip state={chip(n.severity)} label={n.severity} />
                  </td>
                  <td>
                    {n.summary}
                    {n.link && (
                      <div className="tsf-fx-mono">
                        {/^https?:\/\//.test(n.link) ? (
                          <a href={n.link} target="_blank" rel="noreferrer">
                            {n.link}
                          </a>
                        ) : (
                          n.link
                        )}
                      </div>
                    )}
                  </td>
                  <td className="tsf-fx-mono">{n.runId ?? ""}</td>
                  <td>{n.from ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

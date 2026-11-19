import { useEffect, useState } from 'react';
import { Ban } from 'lucide-react';
import { ActivityLog, ActivityStep, AiPanel, Alert, Button, Card, ConfirmDialog, DataTable, EmptyState, KeyValue, useToast, type ActivityStatus, type Column } from '@pw/ui/react';
import type { Job, JobEvent, JobStatus } from '../../shared/types.ts';
import { api, errorMessage } from '../api/client.ts';
import { JobStatusBadge, LinkButton, Markdown } from '../lib/ui.tsx';
import { formatTime } from '../state/modelIndex.ts';
import { useStudio } from '../state/studio.tsx';

const TYPE_LABEL = { create: 'Create from prompt', reverse: 'Reverse engineer', update: 'Update', ask: 'Ask' } as const;
const STATUS_MAP: Record<JobStatus, ActivityStatus> = { queued: 'waiting', running: 'running', succeeded: 'done', failed: 'failed', cancelled: 'stopped' };

function elapsed(job: Job, now: number): string {
  if (!job.startedAt) return '';
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : now;
  const sec = Math.max(0, Math.round((end - new Date(job.startedAt).getTime()) / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${sec} s`;
}

const clock = (iso: string) => (iso.length >= 19 ? iso.slice(11, 19) : '–');

function EventStep({ ev, running }: { ev: JobEvent; running: boolean }) {
  const status: ActivityStatus = running ? 'running' : 'done';
  const firstLine = ev.text.split('\n')[0] ?? '';
  const long = ev.text.length > 140 || ev.text.includes('\n');
  switch (ev.kind) {
    case 'tool': {
      const [tool, ...rest] = ev.text.split(' ');
      return <ActivityStep status={status} name={rest.join(' ') || tool} tool={rest.length ? tool : undefined} time={clock(ev.ts)} />;
    }
    case 'result':
      return <ActivityStep status="done" name="Result" note={firstLine.slice(0, 140)} time={clock(ev.ts)} detail={long ? <pre className="c4-pre c4-pre-sm">{ev.text}</pre> : undefined} detailLabel="Full result" />;
    case 'stderr':
      return <ActivityStep status="skipped" name="Standard error" note={firstLine.slice(0, 140)} time={clock(ev.ts)} detail={long ? <pre className="c4-pre c4-pre-sm">{ev.text}</pre> : undefined} detailLabel="Full output" />;
    case 'system':
      return <ActivityStep status="done" name={firstLine.slice(0, 140)} tool="system" time={clock(ev.ts)} />;
    default:
      return <ActivityStep status={status} name={firstLine.slice(0, 140)} time={clock(ev.ts)} detail={long ? <pre className="c4-pre c4-pre-sm c4-wrap">{ev.text}</pre> : undefined} detailLabel="Full text" />;
  }
}

export function JobsPage() {
  const s = useStudio();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const selected = s.jobs.find((j) => j.id === s.url.job) ?? s.jobs[0] ?? null;
  const running = selected?.status === 'running';

  // The list endpoint trims events; fetch the full job when one is opened.
  const selectedId = selected?.id;
  useEffect(() => {
    if (!selectedId) return;
    api.job(selectedId).then(s.upsertJob).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const columns: Column<Job>[] = [
    { key: 'type', header: 'Type', render: (j) => TYPE_LABEL[j.type] ?? j.type, sortValue: (j) => j.type },
    { key: 'model', header: 'Model and branch', render: (j) => `${j.model}${j.branch ? ` / ${j.branch}` : ''}` },
    { key: 'status', header: 'Status', render: (j) => <JobStatusBadge status={j.status} />, sortValue: (j) => j.status },
    { key: 'startedAt', header: 'Started', render: (j) => formatTime(j.startedAt ?? j.createdAt), sortValue: (j) => j.startedAt ?? j.createdAt },
  ];

  const cancel = async () => {
    if (!selected) return;
    setCancelling(true);
    try {
      await api.cancelJob(selected.id);
      setConfirm(false);
    } catch (e) {
      toast({ tone: 'error', title: 'Could not cancel the job', description: errorMessage(e) });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="c4-page c4-jobs">
      <h2 className="c4-page-title">Jobs</h2>
      <p className="c4-muted">Headless Claude runs that create, reverse engineer, update or answer questions about a model.</p>
      <DataTable
        caption="Jobs, newest first"
        columns={columns}
        rows={s.jobs}
        rowId={(j) => j.id}
        rowLabel={(j) => `${TYPE_LABEL[j.type]} job for ${j.model}`}
        onRowClick={(j) => s.navigate({ job: j.id })}
        selectedIds={selected ? new Set([selected.id]) : new Set()}
        empty={<EmptyState compact title="No jobs yet">Start one from New model, or ask the chat to make a large change.</EmptyState>}
        hover
        compact
      />
      {selected && (
        <Card
          title={`${TYPE_LABEL[selected.type] ?? selected.type}: ${selected.model}`}
          description={<JobStatusBadge status={selected.status} />}
          actions={
            (selected.status === 'running' || selected.status === 'queued') && (
              <Button variant="danger" size="sm" icon={Ban} onClick={() => setConfirm(true)}>
                Cancel job
              </Button>
            )
          }
        >
          <KeyValue
            items={[
              { key: 'Prompt', value: selected.prompt },
              ...(selected.codePath ? [{ key: 'Code path', value: <code>{selected.codePath}</code> }] : []),
              { key: 'Branch', value: <LinkButton onClick={() => s.navigate({ model: selected.model, branch: selected.branch, page: 'diagram', view: undefined, element: undefined, rel: undefined })}>{selected.model} / {selected.branch ?? 'default'}</LinkButton> },
              { key: 'Started', value: formatTime(selected.startedAt ?? selected.createdAt) },
            ]}
          />
          {selected.error && <Alert tone="error" title="The job failed">{selected.error}</Alert>}
          <ActivityLog status={STATUS_MAP[selected.status]} title={`Agent activity (${selected.events.length} events)`} elapsed={elapsed(selected, now)}>
            {selected.events.length === 0 ? (
              <ActivityStep status={selected.status === 'queued' ? 'waiting' : 'running'} name="Waiting for the first event" />
            ) : (
              selected.events.map((ev, i) => <EventStep key={`${ev.ts}${i}`} ev={ev} running={running && i === selected.events.length - 1} />)
            )}
          </ActivityLog>
          {selected.result && (
            <AiPanel note="Written by Claude. Review the model before relying on it.">
              <Markdown>{selected.result}</Markdown>
            </AiPanel>
          )}
        </Card>
      )}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Cancel this job?" confirmLabel="Cancel job" cancelLabel="Keep running" onConfirm={() => void cancel()} loading={cancelling}>
        Claude is stopped where it is. Changes it already wrote to the branch stay in place and appear in History.
      </ConfirmDialog>
    </div>
  );
}

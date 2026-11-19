import { useEffect, useState } from 'react';
import { ActivityLog, ActivityStep, Alert, Card, DataTable, EmptyState, Field, KeyValue, Kpi, KpiGrid, LoadingState, Select, type ActivityStatus, type Column } from '@pw/ui/react';
import type { AgentCost, AgentRun, AgentRunSummary, AgentStep, AgentUsage, ChatSummary, JobStatus } from '../../shared/types.ts';
import { api, errorMessage } from '../api/client.ts';
import { JobStatusBadge, Markdown } from '../lib/ui.tsx';
import { formatTime } from '../state/modelIndex.ts';
import { useStudio } from '../state/studio.tsx';

const RUN_STATUS: Record<AgentRun['status'], JobStatus> = { running: 'running', succeeded: 'succeeded', failed: 'failed', aborted: 'cancelled' };
const STEP_STATUS: Record<AgentRun['status'], ActivityStatus> = { running: 'running', succeeded: 'done', failed: 'failed', aborted: 'stopped' };

/** Chat filter value for runs recorded before chats were kept separately. */
const NO_CHAT = '-';

const num = (n: number | undefined) => (n === undefined ? '–' : n.toLocaleString('en-GB'));

function tokens(u: AgentUsage): string {
  if (u.inputTokens === undefined && u.outputTokens === undefined) return '–';
  return `${num(u.inputTokens)} in / ${num(u.outputTokens)} out`;
}

function usd(c: AgentCost): string {
  if (c.usd === null) return 'Unknown';
  const v = c.usd < 0.01 ? c.usd.toFixed(4) : c.usd.toFixed(2);
  return `$${v}${c.source === 'estimated' ? ' (est.)' : ''}`;
}

function seconds(ms: number | undefined): string {
  if (ms === undefined) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`;
}

function json(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2) ?? '';
  } catch {
    return String(v);
  }
}

function brief(input: unknown): string {
  const text = json(input).replace(/\s+/g, ' ');
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function Pre({ value }: { value: unknown }) {
  return <pre className="c4-pre c4-pre-sm c4-wrap">{json(value)}</pre>;
}

function StepLog({ step, runStatus }: { step: AgentStep; runStatus: AgentRun['status'] }) {
  const failed = step.toolCalls.some((t) => t.error);
  const title = [`Step ${step.index + 1}`, step.modelId, step.finishReason, step.usage ? tokens(step.usage) : undefined].filter(Boolean).join(' · ');
  return (
    <ActivityLog status={failed ? 'failed' : step.finishReason === 'incomplete' ? STEP_STATUS[runStatus] : 'done'} title={title}>
      {step.reasoning && <ActivityStep status="done" name="Reasoning" detail={<pre className="c4-pre c4-pre-sm c4-wrap">{step.reasoning}</pre>} detailLabel="Reasoning" />}
      {step.toolCalls.map((t) => (
        <ActivityStep
          key={t.id}
          status={t.error ? 'failed' : t.output === undefined && !t.durationMs ? STEP_STATUS[runStatus] : 'done'}
          name={brief(t.input) || t.name}
          tool={t.name}
          note={t.error ?? undefined}
          time={t.durationMs !== undefined ? seconds(t.durationMs) : undefined}
          detail={
            <div className="c4-agent-io">
              <strong>Input</strong>
              <Pre value={t.input} />
              <strong>{t.error ? 'Error' : 'Output'}</strong>
              <Pre value={t.error ?? t.output ?? '(no output recorded)'} />
            </div>
          }
          detailLabel="Input and output"
        />
      ))}
      {step.text && <ActivityStep status="done" name="Text" note={step.text.split('\n')[0]?.slice(0, 140)} detail={<Markdown>{step.text}</Markdown>} detailLabel="Full text" />}
      {(!!step.warnings?.length || step.providerMetadata !== undefined) && (
        <ActivityStep status="done" name="Provider data" detail={<Pre value={{ responseId: step.responseId, warnings: step.warnings, providerMetadata: step.providerMetadata }} />} detailLabel="Raw data" />
      )}
    </ActivityLog>
  );
}

function RunDetail({ run, chat }: { run: AgentRun; chat: string }) {
  const u = run.usage;
  return (
    <Card title={`Run at ${formatTime(run.startedAt)}`} description={<JobStatusBadge status={RUN_STATUS[run.status]} />}>
      <KeyValue
        items={[
          { key: 'Prompt', value: <span className="c4-wrap">{run.prompt}</span> },
          { key: 'Chat', value: <span className="c4-wrap">{chat}</span> },
          { key: 'Provider and model', value: <code>{`${run.provider} / ${run.modelId}`}</code> },
          { key: 'Started', value: `${formatTime(run.startedAt)} (${seconds(run.durationMs)})` },
          { key: 'Finish reason', value: run.finishReason ?? '–' },
          { key: 'Tokens', value: `${num(u.inputTokens)} input, ${num(u.outputTokens)} output, ${num(u.cacheReadTokens)} cache read, ${num(u.cacheWriteTokens)} cache write, ${num(u.reasoningTokens)} reasoning` },
          { key: 'Cost', value: `${usd(run.cost)}${run.cost.note ? `: ${run.cost.note}` : ''}` },
          ...(run.sessionId ? [{ key: 'Claude session', value: <code>{run.sessionId}</code> }] : []),
          { key: 'Run id', value: <code>{run.id}</code> },
        ]}
      />
      {run.error && <Alert tone={run.status === 'aborted' ? 'warning' : 'error'} title={run.status === 'aborted' ? 'Stopped' : 'The run failed'}>{run.error}</Alert>}
      {run.steps.length === 0 && <p className="c4-muted">No model steps were recorded.</p>}
      {run.steps.map((step) => (
        <StepLog key={step.index} step={step} runStatus={run.status} />
      ))}
      {run.meta && (
        <ActivityLog status="done" title="Run metadata">
          {Object.entries(run.meta).map(([k, v]) => (
            <ActivityStep key={k} status="done" name={k} detail={<Pre value={v} />} detailLabel="Value" />
          ))}
        </ActivityLog>
      )}
    </Card>
  );
}

export function AgentPage() {
  const s = useStudio();
  const model = s.model?.slug;
  const branch = s.branchName;
  const [runs, setRuns] = useState<AgentRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const latest = s.lastAgentRun?.id;
  const [chats, setChats] = useState<{ model: string; list: ChatSummary[] } | null>(null);
  const [chatFilter, setChatFilter] = useState({ model: '', id: '' });
  const filter = chatFilter.model === model ? chatFilter.id : '';

  useEffect(() => {
    if (!model) return;
    let live = true;
    api.chats(model).then(
      (list) => live && setChats({ model, list }),
      () => live && setChats({ model, list: [] }),
    );
    return () => {
      live = false;
    };
  }, [model, latest]);

  useEffect(() => {
    if (!model || !branch) return;
    let live = true;
    api
      .agentRuns(model, branch)
      .then((r) => {
        if (!live) return;
        setRuns(r);
        setError(null);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [model, branch, latest]);

  const shown = runs?.filter((r) => !filter || (filter === NO_CHAT ? !r.chatId : r.chatId === filter)) ?? null;
  const selectedId = s.url.run ?? shown?.[0]?.id;
  useEffect(() => {
    if (!model || !branch || !selectedId) {
      setRun(null);
      return;
    }
    let live = true;
    api
      .agentRun(model, branch, selectedId)
      .then((r) => {
        if (!live) return;
        setRun(r);
        setRunError(null);
      })
      .catch((e) => live && setRunError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [model, branch, selectedId]);

  if (!model || !branch) return <EmptyState title="No model selected">Create or choose a model in the top bar.</EmptyState>;

  // Chats belong to the model, so a chat can have runs on several branches; this page shows this branch's.
  const chatList = chats?.model === model ? chats.list : [];
  const titles = new Map(chatList.map((c) => [c.id, c.title]));
  const chatName = (id: string | undefined) => (!id ? 'Not recorded: the run is from before chats were kept separately' : (titles.get(id) ?? 'Unknown chat'));
  const inRuns = new Set((runs ?? []).map((r) => r.chatId ?? NO_CHAT));
  const chatOptions = [...chatList.filter((c) => inRuns.has(c.id)).map((c) => ({ id: c.id, label: c.title })), ...(inRuns.has(NO_CHAT) ? [{ id: NO_CHAT, label: 'From before chats were kept separately' }] : [])];

  const totals = (shown ?? []).reduce(
    (t, r) => ({
      cost: t.cost + (r.cost.usd ?? 0),
      unknown: t.unknown + (r.cost.usd === null ? 1 : 0),
      tools: t.tools + r.toolCalls,
      tokens: t.tokens + (r.usage.totalTokens ?? (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0)),
    }),
    { cost: 0, unknown: 0, tools: 0, tokens: 0 },
  );

  const columns: Column<AgentRunSummary>[] = [
    { key: 'startedAt', header: 'Started', render: (r) => formatTime(r.startedAt) },
    { key: 'prompt', header: 'Prompt', wrap: true, width: '32ch', render: (r) => r.prompt.split('\n')[0]?.slice(0, 160) },
    { key: 'modelId', header: 'Model', render: (r) => <code>{r.modelId}</code>, sortValue: (r) => `${r.provider}/${r.modelId}` },
    { key: 'status', header: 'Status', render: (r) => <JobStatusBadge status={RUN_STATUS[r.status]} /> },
    { key: 'toolCalls', header: 'Tool calls', numeric: true },
    { key: 'tokens', header: 'Tokens', render: (r) => tokens(r.usage), sortValue: (r) => r.usage.totalTokens ?? 0 },
    { key: 'cost', header: 'Cost', numeric: true, render: (r) => usd(r.cost), sortValue: (r) => r.cost.usd ?? -1 },
    { key: 'durationMs', header: 'Duration', numeric: true, render: (r) => seconds(r.durationMs) },
  ];

  return (
    <div className="c4-page c4-agent">
      <h2 className="c4-page-title">Agent history</h2>
      <p className="c4-muted">Every chat answer on {branch}: the model calls, each tool call with its input and output, tokens and cost.</p>
      {error && <Alert tone="error" title="Could not load the agent history">{error}</Alert>}
      {!runs && !error && <LoadingState text="Loading agent history" />}
      {runs && runs.length > 0 && (
        <div className="c4-agent-filter">
          <Field label="Chat">
            <Select
              value={filter}
              onChange={(e) => {
                setChatFilter({ model, id: e.target.value });
                if (s.url.run) s.navigate({ run: undefined }, { replace: true });
              }}
            >
              <option value="">All chats</option>
              {chatOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {shown && shown.length > 0 && (
        <KpiGrid>
          <Kpi label="Runs" value={num(shown.length)} />
          <Kpi label="Tool calls" value={num(totals.tools)} />
          <Kpi label="Tokens" value={num(totals.tokens)} />
          <Kpi label="Cost" value={usd({ usd: totals.cost, source: 'provider' })} unit={totals.unknown ? `${totals.unknown} unpriced` : undefined} />
        </KpiGrid>
      )}
      {shown && (
        <DataTable
          caption={`Agent runs on ${branch}, newest first`}
          columns={columns}
          rows={shown}
          rowId={(r) => r.id}
          rowLabel={(r) => `agent run ${formatTime(r.startedAt)}`}
          onRowClick={(r) => s.navigate({ run: r.id })}
          selectedIds={selectedId ? new Set([selectedId]) : new Set()}
          empty={<EmptyState compact title="No agent runs yet">Ask the chat something; each answer is recorded here.</EmptyState>}
          hover
          compact
        />
      )}
      {runError && <Alert tone="error" title="Could not load the run">{runError}</Alert>}
      {run && run.id === selectedId && <RunDetail run={run} chat={chatName(run.chatId)} />}
    </div>
  );
}

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge, cx } from '@pw/ui/react';
import { CircleCheck, CircleDashed, CircleX, Clock, FileQuestion, Loader, OctagonX, Ban, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, Archive, Replace } from 'lucide-react';
import type { AdrStatus, JobStatus, ValidationResult, VersionSource } from '../../shared/types.ts';

/** A button that reads as an in-page link. */
export function LinkButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cx('c4-link', className)} {...rest} />;
}

// Tables scroll inside their own box so a wide table never widens the chat or the page.
const MD_COMPONENTS: Components = {
  table: ({ children }) => (
    <div className="c4-md-table">
      <table className="pw-table">{children}</table>
    </div>
  ),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

/** Markdown with GitHub extensions (tables, task lists, strikethrough, autolinks). */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="c4-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function AdrStatusBadge({ status }: { status: AdrStatus }) {
  const map = {
    proposed: { tone: 'info', icon: FileQuestion, label: 'Proposed' },
    accepted: { tone: 'success', icon: CircleCheck, label: 'Accepted' },
    rejected: { tone: 'error', icon: CircleX, label: 'Rejected' },
    deprecated: { tone: 'warning', icon: Archive, label: 'Deprecated' },
    superseded: { tone: 'neutral', icon: Replace, label: 'Superseded' },
  } as const;
  const m = map[status] ?? map.proposed;
  return (
    <Badge tone={m.tone} icon={m.icon}>
      {m.label}
    </Badge>
  );
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const map = {
    queued: { tone: 'neutral', icon: Clock, label: 'Queued' },
    running: { tone: 'accent', icon: Loader, label: 'Running' },
    succeeded: { tone: 'success', icon: CircleCheck, label: 'Succeeded' },
    failed: { tone: 'error', icon: OctagonX, label: 'Failed' },
    cancelled: { tone: 'warning', icon: Ban, label: 'Cancelled' },
  } as const;
  const m = map[status];
  return (
    <Badge tone={m.tone} icon={m.icon}>
      {m.label}
    </Badge>
  );
}

export function SourceBadge({ source }: { source: VersionSource }) {
  const labels: Record<VersionSource, string> = { ui: 'UI', file: 'File', agent: 'Agent', cli: 'CLI', fork: 'Fork', rollback: 'Rollback', init: 'Initial' };
  return <Badge tone={source === 'agent' ? 'accent' : 'neutral'}>{labels[source]}</Badge>;
}

export function ValidationBadge({ result, validating }: { result: ValidationResult | null; validating?: boolean }) {
  if (validating) return <Badge tone="info" icon={Loader}>Validating</Badge>;
  if (!result) return <Badge tone="neutral" icon={CircleDashed}>Not validated</Badge>;
  switch (result.status) {
    case 'ok':
      return <Badge tone="success" icon={ShieldCheck}>Valid</Badge>;
    case 'parse-failed':
      return <Badge tone="error" icon={ShieldX}>Parse failed</Badge>;
    case 'inspections-failed':
      return <Badge tone="warning" icon={ShieldAlert}>Inspections failed</Badge>;
    default:
      return <Badge tone="neutral" icon={ShieldQuestion}>Validator unavailable</Badge>;
  }
}

export function Section2({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="c4-block">
      <div className="c4-block-head">
        <h3>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

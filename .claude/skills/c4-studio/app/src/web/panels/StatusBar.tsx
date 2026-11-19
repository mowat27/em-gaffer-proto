import { CircleDashed, Gauge, Hash, Loader, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, Timer } from 'lucide-react';
import { StatusLine } from '@pw/ui/react';
import { useRenderStats } from '../state/perf.ts';
import { useStudio } from '../state/studio.tsx';

export function StatusBar() {
  const { bs, validation, validating } = useStudio();
  const stats = useRenderStats();
  const v = validating
    ? { icon: Loader, text: 'validating', tone: undefined }
    : !validation
      ? { icon: CircleDashed, text: 'not validated', tone: undefined }
      : validation.status === 'ok'
        ? { icon: ShieldCheck, text: 'valid', tone: 'success' as const }
        : validation.status === 'parse-failed'
          ? { icon: ShieldX, text: 'parse failed', tone: 'error' as const }
          : validation.status === 'inspections-failed'
            ? { icon: ShieldAlert, text: 'inspections failed', tone: 'warning' as const }
            : { icon: ShieldQuestion, text: 'validator unavailable', tone: undefined };
  return (
    <footer className="c4-statusbar" role="status" aria-label="Status" data-testid="statusbar">
      <StatusLine icon={Timer}>
        <span data-testid="status-parse">parse {bs ? Math.round(bs.parseMs) : '–'} ms</span>
      </StatusLine>
      <StatusLine icon={Gauge}>
        <span data-testid="status-render">render {stats.revision ? stats.lastRenderMs : '–'} ms</span>
      </StatusLine>
      <StatusLine icon={Hash}>
        <span data-testid="status-revision">revision {bs?.revision ?? '–'}</span>
      </StatusLine>
      <StatusLine icon={v.icon} tone={v.tone}>
        <span data-testid="status-validation">{v.text}</span>
      </StatusLine>
      {bs?.busy && (
        <StatusLine icon={Loader} tone="warning">
          <span data-testid="status-busy">Busy: {bs.busy.label}</span>
        </StatusLine>
      )}
    </footer>
  );
}

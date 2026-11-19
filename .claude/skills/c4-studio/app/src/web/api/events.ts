import { useEffect, useRef } from 'react';
import type { ServerEvent } from '../../shared/types.ts';

/** Subscribes to GET /api/events. EventSource reconnects by itself; `onOpen` fires on every (re)connect so callers can resync. */
export function useServerEvents(onEvent: (e: ServerEvent) => void, onOpen?: () => void): void {
  const handler = useRef(onEvent);
  const opened = useRef(onOpen);
  handler.current = onEvent;
  opened.current = onOpen;
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (m) => {
      try {
        handler.current(JSON.parse(m.data) as ServerEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    es.onopen = () => opened.current?.();
    return () => es.close();
  }, []);
}

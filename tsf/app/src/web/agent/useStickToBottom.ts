import { useCallback, useEffect, useRef, type RefObject } from "react";

/** Follow new content only while the reader is within this many pixels of the end. */
export const STICK_THRESHOLD = 24;

export interface StickToBottom {
  /** Attach to an element that contains the pw-ui ChatLog (`role="log"`). The log is the scroller. */
  readonly wrapRef: RefObject<HTMLDivElement | null>;
  /** Jump to the end and follow again (after the person sends a message). */
  readonly scrollToBottom: () => void;
  /** The scroller, once mounted. */
  readonly scroller: () => HTMLElement | null;
}

/**
 * Stick-to-bottom for a chat log whose own `autoScroll` is off (pw-ui's effect has no dependency list and scrolls after
 * every render, which yanks the reader during SSE deltas). The log follows growth only while the person is within
 * `STICK_THRESHOLD` of the end; scrolling up releases it, scrolling back down re-engages it. A ResizeObserver on the
 * content and on the scroller catches growth that no render announces (streaming text, images, a pane resize).
 * `scroll-behavior` must be `auto` on the log (agent.css), or a smooth scroll would release the stick halfway.
 */
export function useStickToBottom(): StickToBottom {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const scrollerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const scroller = wrapRef.current?.querySelector<HTMLElement>('[role="log"]') ?? null;
    scrollerRef.current = scroller;
    if (!scroller) return;
    const follow = (): void => {
      if (stuck.current) scroller.scrollTop = scroller.scrollHeight;
    };
    // Release only when the reader moves up. A scroll event from our own `follow` can arrive after the next delta has
    // already grown the content, so "far from the end" alone does not mean the reader scrolled away.
    let lastTop = scroller.scrollTop;
    const onScroll = (): void => {
      const top = scroller.scrollTop;
      if (scroller.scrollHeight - top - scroller.clientHeight <= STICK_THRESHOLD) stuck.current = true;
      else if (top < lastTop - 1) stuck.current = false;
      lastTop = top;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(follow);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    follow();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer.disconnect();
      scrollerRef.current = null;
    };
  }, []);

  const scrollToBottom = useCallback((): void => {
    stuck.current = true;
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (el && stuck.current) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const scroller = useCallback((): HTMLElement | null => scrollerRef.current, []);

  return { wrapRef, scrollToBottom, scroller };
}

import { useCallback, useRef, useState } from "react";

/**
 * The height of an element as it changes: a callback ref for it and its border-box height
 * (`fallback` until it is measured). A bar laid over a scroller (2026-10-16) gives the scroller
 * room by it.
 */
export function useHeight<T extends HTMLElement>(fallback: number) {
  const [height, setHeight] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    setHeight(element.offsetHeight);
    observer.current = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.current.observe(element);
  }, []);
  return [ref, height] as const;
}

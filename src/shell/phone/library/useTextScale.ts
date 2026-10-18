import { type RefObject, useLayoutEffect, useState } from "react";

/** The meta line at the system's normal text size: 13 / 18. */
const META_SIZE = 13;
const META_LINE = 18;

/**
 * How much larger than designed the text is drawn (Android's font scale reaches the WebView as
 * a text zoom; doc/mobile-design.md, Dynamic Type): one meta line in `probe`, its font size over
 * 13 or its height over 18, whichever grew more. The list's fixed sizes grow with it, so 200 %
 * still fits two lines of title.
 */
export function useTextScale(probe: RefObject<HTMLElement | null>): number {
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = probe.current;
    if (!el) return;
    const measure = () => {
      const height = el.getBoundingClientRect().height;
      if (height <= 0) return;
      const next = Math.max(1, height / META_LINE, parseFloat(getComputedStyle(el).fontSize) / META_SIZE || 1);
      setScale((now) => (Math.abs(now - next) < 0.01 ? now : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [probe]);
  return scale;
}

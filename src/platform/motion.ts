/**
 * The system's «reduce motion» (Windows' animation effects off, macOS' Reduce motion): asked at the
 * moment a motion would start, so a change in the settings counts from the next one. Without
 * `matchMedia` (tests without a window) there is motion.
 */
export const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

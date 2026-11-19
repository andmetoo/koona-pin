// @vitest-environment jsdom
import { act, createElement, RefObject } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bookmark } from "../types";

const fake = vi.hoisted(() => ({ setReadingProgress: vi.fn(async () => ({})) }));
vi.mock("../services/api", () => ({ api: fake }));

import { useReadingProgress } from "./useReadingProgress";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A scroller jsdom can measure: 1,000 px of article in a 200 px window, scrolled to `top`. */
function scroller(top: number) {
  const element = document.createElement("div");
  element.appendChild(document.createElement("article"));
  let height = 1000;
  Object.defineProperty(element, "clientHeight", { get: () => 200 });
  Object.defineProperty(element, "scrollHeight", { get: () => height });
  element.scrollTop = top;
  Object.defineProperty(element, "scrollTop", { value: top, writable: true });
  return { element, grow: (to: number) => (height = to) };
}

const bookmark = (reading_progress: number) => ({ id: 1, reading_progress, reading_at: "2026-11-19" }) as unknown as Bookmark;

let root: Root;
let progress = 0;
function Probe({ b, scroller, ready }: { b: Bookmark; scroller: RefObject<HTMLElement | null>; ready: boolean }) {
  progress = useReadingProgress(b, scroller, ready);
  return null;
}
// One ref per scroller, as a reader keeps it, and one bookmark object until it changes.
const refs = new WeakMap<HTMLElement, RefObject<HTMLElement | null>>();
const render = (b: Bookmark, el: HTMLElement, ready: boolean) => {
  if (!refs.has(el)) refs.set(el, { current: el });
  return act(() => root.render(createElement(Probe, { b, scroller: refs.get(el)!, ready })));
};

beforeEach(() => {
  fake.setReadingProgress.mockClear();
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

describe("useReadingProgress, once ready", () => {
  it("counts a scroll to the end made before it was ready", () => {
    const { element } = scroller(800);
    render(bookmark(0), element, false);
    expect(progress).toBe(0);
    render(bookmark(0), element, true);
    expect(progress).toBe(1);
    expect(fake.setReadingProgress).toHaveBeenCalledWith(1, 1);
  });

  it("does not finish an article restored just short of its end", () => {
    // 0.999 of 800 px of room is 799.2: the end's rounding would make it 1.
    const { element } = scroller(799.2);
    render(bookmark(0.999), element, true);
    expect(progress).toBe(0.999);
    expect(fake.setReadingProgress).not.toHaveBeenCalled();
  });

  it("keeps a finished article finished when it opens at its top", () => {
    const { element } = scroller(0);
    render(bookmark(1), element, true);
    expect(progress).toBe(1);
  });

  it("counts only forward when the article changes size without a scroll", () => {
    let resized: () => void = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const { element, grow } = scroller(400);
    render(bookmark(0), element, true);
    expect(progress).toBe(0.5);
    grow(2000); // grows: 400 of 1,800, less than read; nothing changes
    act(() => resized());
    expect(progress).toBe(0.5);
    grow(600); // shrinks to its end under a scroll that stays put
    act(() => resized());
    expect(progress).toBe(1);
    vi.unstubAllGlobals();
  });
});

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
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

/** A ResizeObserver that reports when the test says so, and records what it watches. */
function stubResizeObserver() {
  const watched = new Set<Element>();
  let report: () => void = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        report = callback;
      }
      observe(element: Element) {
        watched.add(element);
      }
      disconnect() {
        watched.clear();
      }
    },
  );
  return { watched, report: () => act(() => report()) };
}

describe("useReadingProgress, once ready", () => {
  it("counts a scroll to the end made before it was ready", () => {
    const { element } = scroller(800);
    render(bookmark(0), element, false);
    expect(progress).toBe(0);
    render(bookmark(0), element, true);
    expect(progress).toBe(1);
    expect(fake.setReadingProgress).toHaveBeenCalledWith(1, 1);
  });

  it("counts that scroll even when the ResizeObserver never reports (a hidden article)", () => {
    stubResizeObserver();
    const { element } = scroller(800);
    render(bookmark(0), element, true);
    expect(progress).toBe(1);
  });

  it.each([799.2, 800])("does not finish an article restored just short of its end (scrollTop %d)", (top) => {
    // 0.999 of 800 px of room is 799.2, which a browser may round up to 800: the end's rounding
    // would make either 1.
    const { element } = scroller(top);
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
    const resize = stubResizeObserver();
    const { element, grow } = scroller(400);
    render(bookmark(0), element, true);
    resize.report(); // the first report, as an observer gives when it starts watching
    expect(progress).toBe(0.5);
    grow(2000); // grows: 400 of 1,800, less than read; nothing changes
    resize.report();
    expect(progress).toBe(0.5);
    grow(600); // shrinks to its end under a scroll that stays put
    resize.report();
    expect(progress).toBe(1);
  });

  it("watches the article that replaces the one it was watching", async () => {
    const resize = stubResizeObserver();
    const { element } = scroller(0);
    render(bookmark(0), element, true);
    const first = element.firstElementChild!;
    expect([...resize.watched]).toEqual([first]);
    const next = document.createElement("article");
    element.replaceChild(next, first); // the queue's next article
    await act(async () => {}); // MutationObserver reports in a microtask
    expect([...resize.watched]).toEqual([next]);
  });
});

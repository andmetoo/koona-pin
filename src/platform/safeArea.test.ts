import { afterEach, describe, expect, it, vi } from "vitest";
import { safeArea } from "./safeArea";

describe("a desktop's safe area", () => {
  it("is none, and the page is not touched for it", () => {
    // No window or document in this environment: any DOM access would throw.
    expect(safeArea()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe("a phone's safe area", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** A phone page just enough for the probe: counts the measurements, fires what invalidates. */
  function phone() {
    // A fresh module that reads the app's info at its start.
    vi.resetModules();
    const listeners: Record<string, () => void> = {};
    const viewport: Record<string, () => void> = {};
    let observed: (() => void) | undefined;
    const page = { measured: 0, bottom: "24px" };
    vi.stubGlobal("window", {
      __KOONA__: { platform: "android", capabilities: {} },
      addEventListener: (type: string, fn: () => void) => (listeners[type] = fn),
      visualViewport: { addEventListener: (type: string, fn: () => void) => (viewport[type] = fn) },
    });
    vi.stubGlobal("document", {
      documentElement: {},
      createElement: () => ({ style: {}, remove() {} }),
      body: { appendChild: () => {} },
    });
    vi.stubGlobal("getComputedStyle", () => {
      page.measured++;
      return { paddingTop: "30px", paddingRight: "0px", paddingBottom: page.bottom, paddingLeft: "0px" };
    });
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(fn: () => void) {
          observed = fn;
        }
        observe() {}
      },
    );
    return { page, resize: () => listeners.resize(), keyboard: () => viewport.resize(), bridge: () => observed!() };
  }

  it("is measured once and again only after something that can change it", async () => {
    const { page, resize, keyboard, bridge } = phone();
    const { isMobile } = await import("./platform");
    const { safeArea } = await import("./safeArea");
    expect(isMobile).toBe(true);
    expect(safeArea()).toEqual({ top: 30, right: 0, bottom: 24, left: 0 });
    expect(safeArea()).toEqual({ top: 30, right: 0, bottom: 24, left: 0 });
    expect(page.measured).toBe(1);

    // The bridge passes new insets (the keyboard opened).
    page.bottom = "300px";
    expect(safeArea().bottom).toBe(24);
    bridge();
    expect(safeArea().bottom).toBe(300);
    expect(page.measured).toBe(2);

    resize();
    safeArea();
    keyboard();
    safeArea();
    safeArea();
    expect(page.measured).toBe(4);
  });
});

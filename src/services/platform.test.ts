import { afterEach, describe, expect, it, vi } from "vitest";
import { goBack, isMobile, onBack, openPlace, platform, safeArea } from "./platform";

describe("platform", () => {
  it("is the desktop without the phone bridge", () => {
    expect(platform).toBe("desktop");
    expect(isMobile).toBe(false);
  });

  it("has no safe area on a desktop and does not touch the page for it", () => {
    // No window or document in this environment: any DOM access would throw.
    expect(safeArea()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("goes back one level, newest first, and says when there was nothing to close", () => {
    const closed: string[] = [];
    const offEditor = onBack(() => (closed.push("editor"), true));
    const offIdle = onBack(() => false);
    const offDialog = onBack(() => (closed.push("dialog"), true));
    expect(goBack()).toBe(true);
    expect(closed).toEqual(["dialog"]);
    offDialog();
    // A handler with nothing open passes Back on.
    expect(goBack()).toBe(true);
    expect(closed).toEqual(["dialog", "editor"]);
    offEditor();
    offIdle();
    expect(goBack()).toBe(false);
  });

  it("keeps a layer that registers again under what opened over it (a Fold unfolding with the editor open)", () => {
    const closed: string[] = [];
    // The editor opens, then a dialog over it.
    const editorPlace = openPlace();
    let offEditor = onBack(() => (closed.push("editor"), true), editorPlace);
    const offDialog = onBack(() => (closed.push("dialog"), true), openPlace());
    // The screen changes size: the editor moves between the side and a drawer and registers again.
    offEditor();
    offEditor = onBack(() => (closed.push("editor"), true), editorPlace);
    expect(goBack()).toBe(true);
    expect(closed).toEqual(["dialog"]);
    offDialog();
    expect(goBack()).toBe(true);
    expect(closed).toEqual(["dialog", "editor"]);
    offEditor();
  });
});

describe("a Back the phone gave up on", () => {
  it("closes nothing when it is not claimed, and nothing is asked with nothing open", () => {
    const closed: string[] = [];
    let asked = 0;
    expect(goBack(() => (asked++, true))).toBe(false);
    expect(asked).toBe(0);
    const off = onBack(() => (closed.push("dialog"), true));
    expect(goBack(() => false)).toBe(false);
    expect(closed).toEqual([]);
    expect(goBack(() => true)).toBe(true);
    expect(closed).toEqual(["dialog"]);
    off();
  });
});

describe("a phone's safe area", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** A phone page just enough for the probe: counts the measurements, fires what invalidates. */
  function phone() {
    // A fresh module that reads the bridge at its start.
    vi.resetModules();
    const listeners: Record<string, () => void> = {};
    const viewport: Record<string, () => void> = {};
    let observed: (() => void) | undefined;
    const page = { measured: 0, bottom: "24px" };
    vi.stubGlobal("window", {
      __KOONA_MOBILE__: { platform: "android", back: () => false, claim: () => true },
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
    const { safeArea, isMobile } = await import("./platform");
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

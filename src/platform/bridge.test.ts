import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilities, desktopCommands } from "./capabilities";
import { isMobile, platform } from "./platform";
import { safeArea } from "./safeArea";

describe("platform", () => {
  it("is a desktop that can do what a desktop does without the app's info (the demo, the tests)", () => {
    expect(platform).toBe("desktop");
    expect(isMobile).toBe(false);
    expect(capabilities).toMatchObject({ file_manager: true, tray: true, quit: true, browser_capture: true, mcp: true, updates: "self" });
    expect(desktopCommands).toBe(true);
  });

  describe("on a phone", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetModules();
    });

    it("is read from the app's info, with its capabilities and without the desktop's commands", async () => {
      vi.resetModules();
      const phone = { file_manager: false, tray: false, quit: false, updates: "store" };
      vi.stubGlobal("window", { __KOONA__: { platform: "ios", capabilities: phone } });
      const { platform, isMobile } = await import("./platform");
      const { capabilities, desktopCommands } = await import("./capabilities");
      expect([platform, isMobile]).toEqual(["ios", true]);
      expect(capabilities).toEqual(phone);
      expect(desktopCommands).toBe(false);
    });

    it("sells through Google Play in the Play build", async () => {
      vi.resetModules();
      vi.stubGlobal("window", { __KOONA__: { platform: "android", capabilities: { purchase: "play" } } });
      const { capabilities } = await import("./capabilities");
      expect(capabilities.purchase).toBe("play");
    });
  });
});

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

type Signals = { powerSave?: unknown; lowRam?: unknown; textScale?: unknown; reduceTransparency?: unknown };

async function loadSystem(answer?: () => Signals | undefined) {
  const events = new EventTarget();
  vi.stubGlobal("window", {
    __KOONA_MOBILE__: answer ? { system: answer } : {},
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
  vi.resetModules();
  const system = await import("./system");
  return { system, events };
}

describe("system signals", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("are calm without the bridge's answer", async () => {
    const { system } = await loadSystem();
    expect(system.systemSignals()).toEqual({ powerSave: false, lowRam: false, textScale: 1, reduceTransparency: false });
    expect(system.flatGlass(system.systemSignals())).toBe(false);
  });

  it("read the bridge before anything renders", async () => {
    const { system } = await loadSystem(() => ({ powerSave: true, lowRam: false, textScale: 1.3 }));
    expect(system.systemSignals()).toEqual({ powerSave: true, lowRam: false, textScale: 1.3, reduceTransparency: false });
    expect(system.flatGlass(system.systemSignals())).toBe(true);
  });

  it("draw the glass flat on a low-RAM device too", async () => {
    const { system } = await loadSystem(() => ({ powerSave: false, lowRam: true, textScale: 1 }));
    expect(system.flatGlass(system.systemSignals())).toBe(true);
  });

  it("draw the glass flat under iOS's Reduce Transparency, which WebKit's CSS does not see", async () => {
    const { system } = await loadSystem(() => ({ powerSave: false, lowRam: false, textScale: 1, reduceTransparency: true }));
    expect(system.systemSignals().reduceTransparency).toBe(true);
    expect(system.flatGlass(system.systemSignals())).toBe(true);
  });

  it("take nothing odd from the bridge, and survive one that throws", async () => {
    const odd = await loadSystem(() => ({ powerSave: "yes", lowRam: 1, textScale: -2, reduceTransparency: "on" }));
    expect(odd.system.systemSignals()).toEqual({ powerSave: false, lowRam: false, textScale: 1, reduceTransparency: false });
    const broken = await loadSystem(() => {
      throw new Error("gone");
    });
    expect(broken.system.systemSignals()).toEqual({ powerSave: false, lowRam: false, textScale: 1, reduceTransparency: false });
  });

  it("tell their listeners when the bridge says they changed, and only then (useSystemSignals' store)", async () => {
    let now: Signals = { powerSave: false, lowRam: false, textScale: 1 };
    const { system, events } = await loadSystem(() => now);
    const first = system.systemSignals();
    const heard = vi.fn();
    const stop = system.subscribeSystem(heard);
    const change = () => events.dispatchEvent(new Event("koona-system"));
    change();
    expect(heard).not.toHaveBeenCalled();
    expect(system.systemSignals()).toBe(first);
    now = { powerSave: true, lowRam: false, textScale: 2 };
    change();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(system.systemSignals()).toEqual({ powerSave: true, lowRam: false, textScale: 2, reduceTransparency: false });
    stop();
    now = { powerSave: false, lowRam: false, textScale: 2 };
    change();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

async function loadBar(answer?: () => unknown) {
  const events = new EventTarget();
  vi.stubGlobal("window", {
    __KOONA_MOBILE__: answer ? { bar: answer } : {},
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
  vi.resetModules();
  const bar = await import("./verticalBar");
  return { bar, events };
}

// iPhone Duo's displays in the Simulator (iOS 27.1): the outer one, and the inner one in landscape.
const OUTER = { edge: "right", column: [382, 0, 84, 678], status: [382, 0, 84, 174], division: null };
const INNER = { edge: "right", column: [867, 0, 84, 669], status: [867, 0, 84, 124], division: [455.5, 0, 40, 669] };

describe("the vertical bar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("is none without the bridge's answer: other iPhones, Android, a desktop", async () => {
    expect((await loadBar()).bar.verticalBar()).toBeNull();
    expect((await loadBar(() => null)).bar.verticalBar()).toBeNull();
  });

  it("reads the outer and the inner display as the plugin describes them", async () => {
    expect((await loadBar(() => OUTER)).bar.verticalBar()).toEqual(OUTER);
    expect((await loadBar(() => INNER)).bar.verticalBar()).toEqual(INNER);
  });

  it("takes nothing odd: no edge, no column, a bad rectangle, a bridge that throws", async () => {
    const { bar } = await loadBar();
    expect(bar.parseBar({ ...OUTER, edge: "top" })).toBeNull();
    expect(bar.parseBar({ ...OUTER, column: [382, 0, 0, 678] })).toBeNull();
    expect(bar.parseBar({ ...OUTER, column: "382" })).toBeNull();
    expect(bar.parseBar({ ...INNER, status: [1, 2], division: [1, 2, 3, Number.NaN] })).toEqual({ ...INNER, status: null, division: null });
    const broken = await loadBar(() => {
      throw new Error("gone");
    });
    expect(broken.bar.verticalBar()).toBeNull();
  });

  it("tells its listeners when the display changes (a fold), and only then", async () => {
    let now: unknown = OUTER;
    const { bar, events } = await loadBar(() => now);
    const first = bar.verticalBar();
    const heard = vi.fn();
    const stop = bar.subscribeBar(heard);
    const change = () => events.dispatchEvent(new Event("koona-bar"));
    change();
    expect(heard).not.toHaveBeenCalled();
    expect(bar.verticalBar()).toBe(first);
    now = INNER;
    change();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(bar.verticalBar()).toEqual(INNER);
    stop();
    now = null;
    change();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

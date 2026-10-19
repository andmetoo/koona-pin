import { afterEach, describe, expect, it, vi } from "vitest";

type Signals = { powerSave?: unknown; lowRam?: unknown; textScale?: unknown; reduceTransparency?: unknown };

/** A fresh module over a window whose bridge answers `answer` (or has no `system` at all). */
async function load(answer?: () => Signals | undefined) {
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
  });

  it("are calm without the bridge's answer", async () => {
    const { system } = await load();
    expect(system.systemSignals()).toEqual({ powerSave: false, lowRam: false, textScale: 1, reduceTransparency: false });
    expect(system.flatGlass(system.systemSignals())).toBe(false);
  });

  it("read the bridge before anything renders", async () => {
    const { system } = await load(() => ({ powerSave: true, lowRam: false, textScale: 1.3 }));
    expect(system.systemSignals()).toEqual({ powerSave: true, lowRam: false, textScale: 1.3, reduceTransparency: false });
    expect(system.flatGlass(system.systemSignals())).toBe(true);
  });

  it("draw the glass flat on a low-RAM device too", async () => {
    const { system } = await load(() => ({ powerSave: false, lowRam: true, textScale: 1 }));
    expect(system.flatGlass(system.systemSignals())).toBe(true);
  });

  it("draw the glass flat under iOS's Reduce Transparency, which WebKit's CSS does not see", async () => {
    const { system } = await load(() => ({ powerSave: false, lowRam: false, textScale: 1, reduceTransparency: true }));
    expect(system.systemSignals().reduceTransparency).toBe(true);
    expect(system.flatGlass(system.systemSignals())).toBe(true);
  });

  it("take nothing odd from the bridge, and survive one that throws", async () => {
    const odd = await load(() => ({ powerSave: "yes", lowRam: 1, textScale: -2, reduceTransparency: "on" }));
    expect(odd.system.systemSignals()).toEqual({ powerSave: false, lowRam: false, textScale: 1, reduceTransparency: false });
    const broken = await load(() => {
      throw new Error("gone");
    });
    expect(broken.system.systemSignals()).toEqual({ powerSave: false, lowRam: false, textScale: 1, reduceTransparency: false });
  });

  it("tell their listeners when the bridge says they changed, and only then (useSystemSignals' store)", async () => {
    let now: Signals = { powerSave: false, lowRam: false, textScale: 1 };
    const { system, events } = await load(() => now);
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

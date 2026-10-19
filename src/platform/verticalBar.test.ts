import { afterEach, describe, expect, it, vi } from "vitest";

/** A fresh module over a window whose bridge answers `answer` (or has no `bar` at all). */
async function load(answer?: () => unknown) {
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
  });

  it("is none without the bridge's answer: other iPhones, Android, a desktop", async () => {
    expect((await load()).bar.verticalBar()).toBeNull();
    expect((await load(() => null)).bar.verticalBar()).toBeNull();
  });

  it("reads the outer and the inner display as the plugin describes them", async () => {
    expect((await load(() => OUTER)).bar.verticalBar()).toEqual(OUTER);
    expect((await load(() => INNER)).bar.verticalBar()).toEqual(INNER);
  });

  it("takes nothing odd: no edge, no column, a bad rectangle, a bridge that throws", async () => {
    const { bar } = await load();
    expect(bar.parseBar({ ...OUTER, edge: "top" })).toBeNull();
    expect(bar.parseBar({ ...OUTER, column: [382, 0, 0, 678] })).toBeNull();
    expect(bar.parseBar({ ...OUTER, column: "382" })).toBeNull();
    expect(bar.parseBar({ ...INNER, status: [1, 2], division: [1, 2, 3, Number.NaN] })).toEqual({ ...INNER, status: null, division: null });
    const broken = await load(() => {
      throw new Error("gone");
    });
    expect(broken.bar.verticalBar()).toBeNull();
  });

  it("tells its listeners when the display changes (a fold), and only then", async () => {
    let now: unknown = OUTER;
    const { bar, events } = await load(() => now);
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

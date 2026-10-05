import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BADGES, GLYPHS, MARKS, STATES, TONES, drawIcon, frames, parseMark, parseMascot, rest } from "./feedback.js";

const brand = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../design/brand/pin-spirit-flat");
const svg = (file) => readFileSync(path.join(brand, file), "utf8");

/** A 2D context that records what is drawn; Path2D keeps its path. */
function recorder() {
  const calls = [];
  globalThis.Path2D = class {
    constructor(d) {
      this.d = d;
    }
  };
  const ctx = new Proxy(
    { calls },
    {
      get(target, name) {
        if (name in target) return target[name];
        if (name === "getImageData") return (x, y, w, h) => ({ width: w, height: h });
        return (...args) => calls.push([name, ...args.map((a) => a?.d ?? a)]);
      },
      set(target, name, value) {
        calls.push([`=${String(name)}`, value]);
        return true;
      },
    },
  );
  return { calls, canvas: () => ({ getContext: () => ctx }) };
}

describe("save feedback (NP-080)", () => {
  it("ends every state on its own mark, and only the last frame without animation", () => {
    for (const state of STATES) {
      const all = frames(state, true);
      expect(all.length, state).toBeGreaterThan(1);
      expect(all.at(-1)[0].badge).toBe(MARKS[state]);
      expect(all.at(-1)[1], "the last frame stays").toBeUndefined();
      expect(frames(state, false)).toEqual([all.at(-1)]);
      expect(rest(state)).toEqual({ badge: MARKS[state] });
      // About 0.6 s at most: the button answers, it does not perform.
      expect(all.reduce((sum, [, ms]) => sum + (ms ?? 0), 0)).toBeLessThanOrEqual(600);
    }
    expect(() => frames("nope", true)).toThrow();
  });

  it("has a badge, a glyph and page colours for each state", () => {
    expect(MARKS).toEqual({ saved: "ok", existing: "soft", queued: "wait", failed: "err" });
    expect(BADGES.wait.glyph).toBe("clock");
    expect(BADGES.soft.fill).toBe("#dcebe1");
    for (const state of STATES) {
      expect(GLYPHS[BADGES[MARKS[state]].glyph]).toBeTruthy();
      expect(TONES[state]).toHaveLength(2);
    }
  });

  it("reads the micro mark: silhouette, eyes and view box", () => {
    const mark = parseMark(svg("pin-spirit-micro.svg"));
    expect(mark.viewBox).toHaveLength(4);
    expect(mark.silhouette.startsWith("M")).toBe(true);
    expect(mark.eyes.match(/M/g)).toHaveLength(2);
  });

  it("reads the mascot as plain paths with fills and transforms", () => {
    const mascot = parseMascot(svg("pin-spirit.svg"));
    expect(mascot.viewBox).toBe("0 0 880 916");
    expect(mascot.paths.length).toBeGreaterThan(20);
    expect(mascot.paths.every((p) => p.d && p.fill)).toBe(true);
    expect(mascot.paths.some((p) => p.fill === "#699A74")).toBe(true);
  });

  it("draws the mark and cuts a gap for the state mark", () => {
    const mark = parseMark(svg("pin-spirit-micro.svg"));
    const plain = recorder();
    expect(drawIcon(plain.canvas, mark, 16, {})).toEqual({ width: 16, height: 16 });
    expect(plain.calls.some(([name, value]) => name === "=globalCompositeOperation" && value === "destination-out")).toBe(false);
    expect(plain.calls.some(([name, d]) => name === "fill" && d === mark.eyes)).toBe(true);

    const waiting = recorder();
    drawIcon(waiting.canvas, mark, 32, { badge: "wait", opacity: 0.5 });
    const names = waiting.calls.map(([name, value]) => (name.startsWith("=") ? `${name}:${value}` : name));
    expect(names).toContain("=globalAlpha:0.5");
    expect(names).toContain("=globalCompositeOperation:destination-out");
    expect(names).toContain("=fillStyle:#c8641f");
    expect(waiting.calls.filter(([name]) => name === "stroke").map(([, d]) => d)).toEqual(
      expect.arrayContaining(GLYPHS.clock.map(([, , d]) => d)),
    );

    const happy = recorder();
    drawIcon(happy.canvas, mark, 16, { happy: true });
    expect(happy.calls.some(([name, d]) => name === "fill" && d === mark.eyes)).toBe(false);
  });
});

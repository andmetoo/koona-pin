import { describe, expect, it } from "vitest";
import { levelPath, liquidPath, neckHalfWidth, sectorPath, settled, SPRINGS, springStep, wobble } from "./liquid";

describe("the reading progress's liquid", () => {
  it("springs settle on their target; the release spring swings past it once (the wobble)", () => {
    let s = { x: 0, v: 0 };
    let over = false;
    for (let i = 0; i < 120; i++) {
      s = springStep(s, 1, SPRINGS.back, 1 / 60);
      if (s.x > 1.001) over = true;
    }
    expect(over).toBe(true);
    expect(settled(s, 1)).toBe(true);
    // The finger's spring lags behind but gets there within half a second.
    let f = { x: 0, v: 0 };
    f = springStep(f, 80, SPRINGS.follow, 1 / 60);
    expect(f.x).toBeGreaterThan(0);
    expect(f.x).toBeLessThan(80);
    for (let i = 0; i < 30; i++) f = springStep(f, 80, SPRINGS.follow, 1 / 60);
    expect(Math.abs(f.x - 80)).toBeLessThan(2);
  });

  it("a pie's sector: nothing at 0, a half at 0.5, the whole disc at 1", () => {
    expect(sectorPath(0, 0, 10, 0)).toBe("");
    expect(sectorPath(0, 0, 10, 0.5)).toBe("M0 0L0 -10A10 10 0 0 1 0 10Z");
    expect(sectorPath(0, 0, 10, 1)).toContain("a10 10 0 1 0 20 0");
  });

  it("the neck thins as the pull nears the threshold and never vanishes", () => {
    expect(neckHalfWidth(10, 0, 80)).toBe(10);
    expect(neckHalfWidth(10, 40, 80)).toBeLessThan(neckHalfWidth(10, 20, 80));
    expect(neckHalfWidth(10, 500, 80)).toBeCloseTo(1.6);
    expect(liquidPath(6, 11, 0, 80)).toBe("");
    expect(liquidPath(6, 11, 60, 80)).toMatch(/^M-6 0A6 6 0 0 0 6 0C.*Z$/);
  });

  it("the drop's level fills from the bottom; the wobble dies out", () => {
    expect(levelPath(25, 0, 0)).toBe("");
    expect(levelPath(25, 0.5, 0)).toContain("M-26 0");
    expect(wobble(0)).toBe(1);
    expect(Math.abs(wobble(1) - 1)).toBeLessThan(0.01);
  });
});

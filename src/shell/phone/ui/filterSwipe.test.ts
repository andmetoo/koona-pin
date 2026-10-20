import { describe, expect, it } from "vitest";
import { atEdge, axisOf, landOn, liftVelocity, neighbour, offsetOf, pushSample, type Sample } from "./filterSwipe";

describe("the swipe between filters", () => {
  it("leaves the screen's side edges to the system's Back", () => {
    expect(atEdge(10, 393)).toBe(true);
    expect(atEdge(380, 393)).toBe(true);
    expect(atEdge(24, 393)).toBe(false);
    expect(atEdge(200, 393)).toBe(false);
  });

  it("is a swipe only when clearly sideways, and the list's scroll otherwise", () => {
    expect(axisOf(4, 3)).toBeNull();
    expect(axisOf(-30, 5)).toBe("x");
    expect(axisOf(5, 30)).toBe("y");
    // A diagonal is the scroll's.
    expect(axisOf(22, 20)).toBe("y");
  });

  it("goes to the next filter leftward and the previous rightward, never past the ends", () => {
    expect(neighbour(-50, 0, 4)).toBe(1);
    expect(neighbour(50, 2, 4)).toBe(1);
    expect(neighbour(50, 0, 4)).toBeNull();
    expect(neighbour(-50, 3, 4)).toBeNull();
    expect(neighbour(0, 1, 4)).toBeNull();
  });

  it("follows the finger, and gives only a little at the ends", () => {
    expect(offsetOf(-120, 0, 3)).toBe(-120);
    expect(offsetOf(120, 0, 3)).toBe(30);
    expect(offsetOf(-1000, 2, 3)).toBe(-64);
  });

  it("measures a flick over the drag's last 100 ms, and forgets it when the finger rests", () => {
    // A steady drag of 1 px per ms, sampled every 8 ms.
    const samples: Sample[] = [];
    for (let t = 0; t <= 200; t += 8) pushSample(samples, { x: -t, t });
    expect(samples.every((s) => 200 - s.t <= 100)).toBe(true);
    expect(liftVelocity(samples, 204)).toBeCloseTo(-1);
    // Rested 400 ms before lifting: no flick.
    expect(liftVelocity(samples, 600)).toBe(0);
    expect(landOn(-40, liftVelocity(samples, 600), 393, 0, 3)).toBe(0);
    // A slow drag whose last two events came 1 ms apart is still slow.
    const slow: Sample[] = [{ x: 0, t: 0 }, { x: -10, t: 50 }, { x: -20, t: 99 }, { x: -23, t: 100 }];
    expect(Math.abs(liftVelocity(slow, 100))).toBeLessThan(0.5);
    // Too short a span to say.
    expect(liftVelocity([{ x: 0, t: 0 }, { x: -5, t: 2 }], 2)).toBe(0);
  });

  it("lands on the neighbour past a third of the width or after a flick its way", () => {
    expect(landOn(-140, 0, 393, 0, 3)).toBe(1);
    expect(landOn(-100, 0, 393, 0, 3)).toBe(0);
    expect(landOn(-40, -0.8, 393, 0, 3)).toBe(1);
    // A flick back against the drag stays.
    expect(landOn(-140, 0.8, 393, 1, 3)).toBe(1);
    // Too short for a flick.
    expect(landOn(-12, -2, 393, 0, 3)).toBe(0);
    // Never wraps.
    expect(landOn(300, 1, 393, 0, 3)).toBe(0);
    expect(landOn(-300, -1, 393, 2, 3)).toBe(2);
  });
});

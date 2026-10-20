import { describe, expect, it } from "vitest";
import { atEdge, axisOf, landOn, neighbour, offsetOf } from "./filterSwipe";

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

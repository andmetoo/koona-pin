import { describe, expect, it } from "vitest";
import { clampView, FITTED, fitSize, maxScale, swipeCloses, viewOver, zoomAt } from "./pictureZoom";

const window = { width: 1200, height: 800 };
const centre = { x: 600, y: 400 };

describe("the viewer's geometry", () => {
  it("fits a picture into the room, never above its own pixels", () => {
    expect(fitSize({ width: 1600, height: 1000 }, { width: 1100, height: 600 })).toEqual({ width: 960, height: 600 });
    expect(fitSize({ width: 300, height: 200 }, { width: 1100, height: 600 })).toEqual({ width: 300, height: 200 });
    // The srcset promises a larger one: the fit makes room for it at once.
    expect(fitSize({ width: 300, height: 200 }, { width: 1100, height: 600 }, 1200)).toEqual({ width: 900, height: 600 });
    expect(fitSize({ width: 0, height: 0 }, window)).toEqual({ width: 0, height: 0 });
  });

  it("zooms to twice the pixels, between 4 × and 10 × the fit", () => {
    expect(maxScale({ width: 960, height: 600 }, 1600)).toBe(4);
    expect(maxScale({ width: 400, height: 250 }, 4000)).toBe(10);
    expect(maxScale({ width: 500, height: 300 }, 1500)).toBe(6);
  });

  it("keeps a zoomed picture over the window and a small one where it was laid out", () => {
    const fit = { width: 960, height: 600 };
    expect(clampView({ x: 300, y: -50, scale: 1 }, fit, window, 4)).toEqual(FITTED);
    // At 2 × it is 1920 × 1200: 360 px to pan either way across, 200 down or up.
    expect(clampView({ x: 1000, y: -1000, scale: 2 }, fit, window, 4)).toEqual({ x: 360, y: -200, scale: 2 });
    expect(clampView({ x: 0, y: 0, scale: 9 }, fit, window, 4).scale).toBe(4);
    expect(clampView({ x: 0, y: 0, scale: 0.5 }, fit, window, 4).scale).toBe(1);
    // A centre above the window's middle (the caption takes room below): the bounds follow it.
    expect(clampView({ x: 0, y: 1000, scale: 2 }, fit, window, 4, { x: 600, y: 360 }).y).toBe(240);
  });

  it("zooms at a point and keeps that point under the pointer", () => {
    const fit = { width: 960, height: 600 };
    const at = { x: 200, y: 100 };
    const view = zoomAt(FITTED, 2, at, fit, window, 4, centre);
    // The picture's point under `at` before: (at - 0) / 1; after: (at - view) / 2. The same.
    expect((at.x - view.x) / view.scale).toBeCloseTo(at.x, 5);
    expect((at.y - view.y) / view.scale).toBeCloseTo(at.y, 5);
    expect(zoomAt(view, 1, at, fit, window, 4, centre)).toEqual(FITTED);
  });

  it("covers the article's picture for the lift, a cropped one too", () => {
    const fit = { width: 960, height: 600 };
    expect(viewOver({ left: 300, top: 500, width: 480, height: 300 }, fit, centre)).toEqual({ x: -60, y: 250, scale: 0.5 });
    // A wide crop of a taller picture (object-fit: cover): the picture covers the box.
    expect(viewOver({ left: 0, top: 0, width: 480, height: 200 }, fit, centre).scale).toBe(0.5);
    expect(viewOver({ left: 0, top: 0, width: 300, height: 300 }, fit, centre).scale).toBe(0.5);
  });

  it("closes on a long or a quick swipe", () => {
    expect(swipeCloses(150, 0.1, 800)).toBe(true);
    expect(swipeCloses(-150, 0.1, 800)).toBe(true);
    expect(swipeCloses(40, 0.9, 800)).toBe(true);
    expect(swipeCloses(60, 0.2, 800)).toBe(false);
  });
});

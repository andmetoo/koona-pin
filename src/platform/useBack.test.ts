// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// A phone: useBack registers only there.
vi.mock("./platform", () => ({ isMobile: true }));

import { goBack, onBack } from "./back";
import { useBack } from "./useBack";

let root: Root | null = null;
const Layer = ({ close }: { close: () => void | boolean }) => {
  useBack(close);
  return null;
};
const mount = (close: () => void | boolean) => {
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Layer, { close })));
};

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe("useBack", () => {
  it("a second quick Back, before the closed layer is gone, closes the layer below", () => {
    const below = vi.fn(() => true);
    const offBelow = onBack(below);
    const close = vi.fn();
    mount(close);
    expect(goBack()).toBe(true);
    expect(goBack()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(below).toHaveBeenCalledTimes(1);
    offBelow();
  });

  it("a layer that cannot close keeps Back: nothing under it closes", () => {
    const below = vi.fn(() => true);
    const offBelow = onBack(below);
    const close = vi.fn(() => false);
    mount(close);
    expect(goBack()).toBe(true);
    expect(goBack()).toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
    expect(below).not.toHaveBeenCalled();
    offBelow();
  });
});

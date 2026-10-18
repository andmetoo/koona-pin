// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Picture } from "./usePicture";

// Inside Tauri unless a test says otherwise; `convertFileSrc` as Tauri builds it on macOS and Linux.
const env = vi.hoisted(() => ({ tauri: true }));
vi.mock("../services/api", () => ({ isTauri: () => env.tauri }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${encodeURIComponent(path)}`,
}));

import { usePicture } from "./usePicture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = { id: number; url: string | null; webFirst?: boolean };
let root: Root;
let picture: Picture;
function Probe({ id, url, webFirst }: Props) {
  picture = usePicture("bookmark-image", id, url, { webFirst });
  return null;
}
const render = (props: Props) => act(() => root.render(createElement(Probe, props)));
const fail = () => act(() => picture.onError());
const setOnline = (online: boolean) => vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);

const A = "https://x.org/a.png";
const B = "https://x.org/b.png";

beforeEach(() => {
  env.tauri = true;
  setOnline(true);
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});

describe("usePicture", () => {
  it("tries the local copy, then the source address once, then gives up", () => {
    render({ id: 3, url: A });
    expect(picture.src).toMatch(/^kpimg:\/\/localhost\/b%2F3%2Fimage\?v=[0-9a-f]{8}$/);
    expect(picture.failed).toBe(false);
    fail();
    expect(picture.src).toBe(A);
    fail();
    expect(picture.src).toBeNull();
    expect(picture.failed).toBe(true);
  });

  it("goes straight to the fallback offline", () => {
    setOnline(false);
    render({ id: 3, url: A });
    expect(picture.src).toMatch(/^kpimg:/);
    fail();
    expect(picture.src).toBeNull();
    expect(picture.failed).toBe(true);
  });

  it("starts again for a new source address", () => {
    render({ id: 3, url: A });
    fail();
    fail();
    expect(picture.failed).toBe(true);
    render({ id: 3, url: B });
    expect(picture.src).toMatch(/^kpimg:/);
    expect(picture.failed).toBe(false);
    // The failed address stays failed while it is the one shown.
    render({ id: 3, url: B });
    fail();
    expect(picture.src).toBe(B);
  });

  it("has nothing to show without a source address", () => {
    render({ id: 3, url: null });
    expect(picture.src).toBeNull();
    expect(picture.failed).toBe(false);
  });

  it("loads the web first when asked, the copy after it", () => {
    render({ id: 3, url: A, webFirst: true });
    expect(picture.src).toBe(A);
    fail();
    expect(picture.src).toMatch(/^kpimg:/);
    fail();
    expect(picture.failed).toBe(true);
  });

  it("loads the copy first when asked for the web while offline", () => {
    setOnline(false);
    render({ id: 3, url: A, webFirst: true });
    expect(picture.src).toMatch(/^kpimg:/);
    fail();
    expect(picture.failed).toBe(true);
  });

  it("outside Tauri tries the source address alone, as before the cache", () => {
    env.tauri = false;
    render({ id: 3, url: A });
    expect(picture.src).toBe(A);
    fail();
    expect(picture.src).toBeNull();
    expect(picture.failed).toBe(true);
  });
});

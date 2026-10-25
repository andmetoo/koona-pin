import { beforeEach, describe, expect, it, vi } from "vitest";

// Inside Tauri or in the browser demo, by hand; `convertFileSrc` as Tauri builds it on macOS and Linux.
const env = vi.hoisted(() => ({ tauri: true }));
vi.mock("./api", () => ({ isTauri: () => env.tauri }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${encodeURIComponent(path)}`,
}));

import { hash8, pictureSrc } from "./pictures";

describe("hash8", () => {
  it("is FNV-1a 32 over UTF-8, as 8 hex digits", () => {
    // The reference values of FNV-1a 32.
    expect(hash8("")).toBe("811c9dc5");
    expect(hash8("a")).toBe("e40c292c");
    expect(hash8("foobar")).toBe("bf9cf968");
    // Beyond ASCII the bytes are UTF-8: "é" is C3 A9.
    expect(hash8("é")).toBe("1e9de8c1");
  });

  it("is stable and changes with the address", () => {
    expect(hash8("https://x.org/a.png")).toBe(hash8("https://x.org/a.png"));
    expect(hash8("https://x.org/a.png")).not.toBe(hash8("https://x.org/b.png"));
  });
});

describe("pictureSrc", () => {
  beforeEach(() => {
    env.tauri = true;
  });

  it("asks the kpimg scheme by kind and id, the path encoded as one segment", () => {
    const src = "https://x.org/a.png";
    const v = hash8(src);
    expect(pictureSrc("bookmark-image", 12, src)).toBe(`kpimg://localhost/b%2F12%2Fimage?v=${v}`);
    expect(pictureSrc("bookmark-icon", 12, src)).toBe(`kpimg://localhost/b%2F12%2Ficon?v=${v}`);
    expect(pictureSrc("post-thumb", 7, src)).toBe(`kpimg://localhost/p%2F7%2Fthumb?v=${v}`);
    expect(pictureSrc("feed-icon", "a b/c", src)).toBe(`kpimg://localhost/f%2Fa%20b%2Fc%2Ficon?v=${v}`);
  });

  it("changes its version with the source address", () => {
    expect(pictureSrc("bookmark-image", 1, "https://x.org/a.png")).not.toBe(pictureSrc("bookmark-image", 1, "https://x.org/b.png"));
  });

  it("has no picture without a source address", () => {
    expect(pictureSrc("bookmark-image", 1, null)).toBeNull();
    expect(pictureSrc("bookmark-icon", 1, undefined)).toBeNull();
    expect(pictureSrc("post-thumb", 1, "")).toBeNull();
  });

  it("keeps the feed filter: https (plain http upgraded) and inline pictures only", () => {
    expect(pictureSrc("post-thumb", 1, "http://x.org/a.jpg")).toMatch(/^kpimg:/);
    expect(pictureSrc("feed-icon", "u", "javascript:alert(1)")).toBeNull();
    // A bookmark's picture is not filtered: the backend decides.
    expect(pictureSrc("bookmark-image", 1, "http://x.org/a.jpg")).toMatch(/^kpimg:/);
  });

  it("leaves the source address where there is no copy to ask for", () => {
    const inline = "data:image/png;base64,AAAA";
    expect(pictureSrc("post-thumb", 1, inline)).toBe(inline);
    expect(pictureSrc("bookmark-image", 1, inline)).toBe(inline);
    // A link not saved yet.
    expect(pictureSrc("bookmark-image", -1, "https://x.org/a.png")).toBe("https://x.org/a.png");
    expect(pictureSrc("feed-icon", "", "https://x.org/a.png")).toBe("https://x.org/a.png");
  });

  it("passes the source address through outside Tauri", () => {
    env.tauri = false;
    expect(pictureSrc("bookmark-image", 12, "https://x.org/a.png")).toBe("https://x.org/a.png");
    expect(pictureSrc("post-thumb", 7, "http://x.org/a.jpg")).toBe("https://x.org/a.jpg");
    expect(pictureSrc("bookmark-icon", 12, null)).toBeNull();
  });
});

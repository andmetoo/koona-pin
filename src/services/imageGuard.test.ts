// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Pictures the WebView loads itself pass the native, DNS-aware check first; the answers are per host.
const api = vi.hoisted(() => ({ checkPublicResource: vi.fn() }));
vi.mock("./api", () => ({ api }));
const { guardArticleHtml, publicImage } = await import("./imageGuard");

// The answers last the session: every test asks about hosts of its own.
const refused = new Set(["intranet.example", "router.example"]);
beforeEach(() => {
  api.checkPublicResource.mockReset();
  api.checkPublicResource.mockImplementation(async (url: string) => !refused.has(new URL(url).hostname));
});

describe("publicImage", () => {
  it("passes data pictures and refuses other schemes without asking", async () => {
    expect(await publicImage("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(await publicImage("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E")).toBe(true);
    for (const raw of ["data:text/html,<b>x</b>", "file:///C:/x.png", "javascript:alert(1)", "blob:https://a.example/1", "/relative.png", "", null]) {
      expect(await publicImage(raw)).toBe(false);
    }
    expect(api.checkPublicResource).not.toHaveBeenCalled();
  });

  it("asks once per host, also while the first answer is on its way", async () => {
    const answers = await Promise.all(["https://cdn-a.example/1.png", "https://cdn-a.example/2.png", "http://cdn-a.example/3.png"].map(publicImage));
    expect(answers).toEqual([true, true, true]);
    expect(await publicImage("https://cdn-a.example/4.png")).toBe(true);
    expect(api.checkPublicResource).toHaveBeenCalledTimes(1);
    expect(await publicImage("https://intranet.example/a.png")).toBe(false);
    expect(await publicImage("https://intranet.example/b.png")).toBe(false);
    expect(api.checkPublicResource).toHaveBeenCalledTimes(2);
  });

  it("does not remember «no answer»: offline or a failed call is asked again", async () => {
    api.checkPublicResource.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("ipc"));
    expect(await publicImage("https://late.example/a.png")).toBe(false);
    expect(await publicImage("https://late.example/a.png")).toBe(false);
    expect(await publicImage("https://late.example/a.png")).toBe(true);
    expect(api.checkPublicResource).toHaveBeenCalledTimes(3);
  });
});

describe("guardArticleHtml", () => {
  it("keeps the srcset candidates that pass and falls back to one when src is refused", async () => {
    const html = await guardArticleHtml(
      `<p>Text</p><img src="https://router.example/a.png" srcset="https://pics-b.example/a-1x.png 1x, https://router.example/a-2x.png 2x, https://pics-b.example/a-3x.png 3x">`,
    );
    const img = new DOMParser().parseFromString(html, "text/html").querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://pics-b.example/a-3x.png");
    expect(img.getAttribute("srcset")).toBe("https://pics-b.example/a-1x.png 1x, https://pics-b.example/a-3x.png 3x");
    expect(html).toContain("<p>Text</p>");
  });

  it("takes a refused picture's figure with it, but not a figure that keeps another picture", async () => {
    const html = await guardArticleHtml(
      `<figure id="alone"><img src="https://router.example/x.png"><figcaption>Caption</figcaption></figure>` +
        `<figure id="pair"><img src="https://router.example/y.png"><img src="https://pics-c.example/y.png"></figure>`,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.getElementById("alone")).toBeNull();
    expect(html).not.toContain("Caption");
    expect(Array.from(doc.querySelectorAll("#pair img"), (img) => img.getAttribute("src"))).toEqual(["https://pics-c.example/y.png"]);
    expect(html).not.toContain("router.example");
  });
});

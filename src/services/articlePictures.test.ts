// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { addLeadPicture, parseSrcset, pictureAddress, preparePictures, restorePictures, watchPictures } from "./articlePictures";
import { articleOfPost } from "./feedsView";
import { extractArticle } from "./reader";

const BASE = "https://blog.example.org/2026/post";
const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");
/** Both steps, as reading mode and a feed post run them. */
const prepared = (html: string) => {
  const page = doc(html);
  restorePictures(page);
  preparePictures(page, BASE);
  return page.body;
};
const srcs = (body: Element) => Array.from(body.querySelectorAll("img")).map((img) => img.getAttribute("src"));

describe("picture addresses", () => {
  it("resolves, upgrades plain http and refuses other schemes", () => {
    expect(pictureAddress("/a.jpg", BASE)).toBe("https://blog.example.org/a.jpg");
    expect(pictureAddress("//cdn.example.org/a.jpg", BASE)).toBe("https://cdn.example.org/a.jpg");
    expect(pictureAddress("http://old.example/a.jpg")).toBe("https://old.example/a.jpg");
    expect(pictureAddress("javascript:alert(1)", BASE)).toBeNull();
    expect(pictureAddress("data:image/png;base64,AAAA", BASE)).toBeNull();
    expect(pictureAddress("/a.jpg")).toBeNull();
  });

  it("reads a srcset as the standard does", () => {
    expect(parseSrcset("a.jpg 1x,b.jpg 2x")).toEqual([
      { url: "a.jpg", descriptor: "1x" },
      { url: "b.jpg", descriptor: "2x" },
    ]);
    // Cloudinary and Substack keep commas inside the address.
    expect(parseSrcset("https://c.example/w_400,h_300/x.jpg 400w, https://c.example/w_800,h_600/x.jpg 800w").map((c) => c.url)).toEqual([
      "https://c.example/w_400,h_300/x.jpg",
      "https://c.example/w_800,h_600/x.jpg",
    ]);
    expect(parseSrcset("only.jpg")).toEqual([{ url: "only.jpg", descriptor: "" }]);
  });
});

describe("pictures a script would have shown", () => {
  it("takes the lazy loader's address over its placeholder", () => {
    const body = prepared(`
      <img src="https://blog.example.org/wp-content/plugins/lazy/placeholder.gif" data-lazy-src="/real/one.jpg">
      <img src="data:image/gif;base64,R0lGOD" data-src="/real/two.jpg" data-srcset="/real/two.jpg 1x, /real/two@2x.jpg 2x">
      <img data-orig-file="/real/three.jpg">
      <img src="/kept.jpg" data-lazy="true">`);
    expect(srcs(body)).toEqual([
      "https://blog.example.org/real/one.jpg",
      "https://blog.example.org/real/two.jpg",
      "https://blog.example.org/real/three.jpg",
      "https://blog.example.org/kept.jpg",
    ]);
    expect(body.querySelectorAll("img")[1].getAttribute("srcset")).toBe("https://blog.example.org/real/two.jpg 1x, https://blog.example.org/real/two@2x.jpg 2x");
  });

  it("puts a <noscript> copy in its placeholder's place, and leaves one alone", () => {
    const body = prepared(`
      <p><img class="lazyload" src="/blank.gif"><noscript><img src="/real.jpg" alt="Real"></noscript></p>
      <p><img src="/shown.jpg"><noscript><img src="/other.jpg"></noscript></p>`);
    expect(body.querySelectorAll("p")[0].querySelector("img")?.getAttribute("src")).toBe("https://blog.example.org/real.jpg");
    expect(body.querySelectorAll("p")[0].querySelector("noscript")).toBeNull();
    expect(body.querySelectorAll("p")[1].querySelector(":scope > img")?.getAttribute("src")).toBe("https://blog.example.org/shown.jpg");
  });

  it("gives a <picture>'s <img> the address only its <source> names", () => {
    const body = prepared(`
      <figure><picture>
        <source media="(max-width: 600px)" srcset="/small.webp">
        <source srcset="/medium.webp 800w, /large.webp 1600w" type="image/webp">
        <img alt="Chart">
      </picture><figcaption>Chart</figcaption></figure>`);
    const img = body.querySelector("figure > img");
    expect(img?.getAttribute("src")).toBe("https://blog.example.org/large.webp");
    expect(img?.getAttribute("srcset")).toBe("https://blog.example.org/medium.webp 800w, https://blog.example.org/large.webp 1600w");
    expect(body.querySelector("picture, source")).toBeNull();
  });

  it("turns an emoji picture back into its letter", () => {
    const body = prepared(`<p>Done <img class="wp-smiley emoji" src="https://s.w.org/images/core/emoji/15.0.3/72x72/1f389.png" alt="🎉"> today</p>`);
    expect(body.querySelector("img")).toBeNull();
    expect(body.textContent?.replace(/\s+/g, " ").trim()).toBe("Done 🎉 today");
  });

  it("drops a 1 × 1 counter, and the figure a dropped picture leaves empty", () => {
    const body = prepared(`
      <p>Text <img src="/pixel.gif" width="1" height="1"></p>
      <figure><img src="javascript:x()"><figcaption>Gone</figcaption></figure>
      <img src="/kept.jpg" width="600" height="300">`);
    expect(srcs(body)).toEqual(["https://blog.example.org/kept.jpg"]);
    expect(body.querySelector("figure")).toBeNull();
  });
});

describe("the lead picture", () => {
  const lead = (html: string, image: string) => {
    const page = doc(html);
    addLeadPicture(page, image, BASE, "");
    return srcs(page.body);
  };

  it("goes over a text that has none of its own", () => {
    expect(lead("<p>Words first.</p>", "https://cdn.example.org/2026/10/marscloud-1152x648.jpg")).toEqual(["https://cdn.example.org/2026/10/marscloud-1152x648.jpg"]);
  });

  it("is not added twice, whatever the size, format or image service", () => {
    expect(lead('<p>Text</p><img src="https://cdn.example.org/marscloud-640x349.jpg">', "https://cdn.example.org/marscloud-1536x864.jpg")).toHaveLength(1);
    expect(lead('<p>Text</p><img src="/gallery/intro-1792594756.webp">', "https://www.example.org/gallery/l-intro-1792594756.jpg")).toHaveLength(1);
    expect(lead('<p>Text</p><img src="/_image?href=https%3A%2F%2Fblog.example.org%2Ffile%2F01M5.png&w=800">', "https://blog.example.org/file/01M5.png")).toHaveLength(1);
  });

  it("is not added over a picture, nor as a logo or a share card", () => {
    expect(lead('<figure><img src="/other.jpg"></figure><p>Text</p>', "https://cdn.example.org/lead.jpg")).toEqual(["/other.jpg"]);
    expect(lead("<p>Text</p>", "https://www.example.org/images/logo--red.png")).toEqual([]);
    expect(lead("<p>Text</p>", "https://habr.com/share/publication/1099122/5af77cc7/")).toEqual([]);
  });
});

describe("both readers", () => {
  const words = "A paragraph long enough to be the article, about pictures that load lazily. ".repeat(12);

  it("reading mode shows a lazy picture over plain http", () => {
    const page = `<html><head><title>Lazy pictures</title></head><body><article><h1>Lazy pictures</h1><p>${words}</p>
      <figure><img src="/spacer.gif" data-src="http://cdn.example.org/photo.jpg" alt="Photo"><figcaption>Photo</figcaption></figure><p>${words}</p></article></body></html>`;
    const result = extractArticle(page, BASE);
    if (!result.ok) throw new Error(result.failure.reason);
    expect(srcs(doc(result.article.html).body)).toEqual(["https://cdn.example.org/photo.jpg"]);
  });

  it("a feed post keeps its srcset and lazy pictures", () => {
    const article = articleOfPost(
      { id: 1, url: BASE, title: "Post", author: null, published_at: null, full: true, language: null, html: `<p>Hi</p><img src="/blank.gif" data-lazy-src="/a.jpg" srcset="/a.jpg 1x, /a@2x.jpg 2x">` },
      null,
    );
    const img = doc(article.html).body.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://blog.example.org/a.jpg");
    expect(img?.getAttribute("srcset")).toBe("https://blog.example.org/a.jpg 1x, https://blog.example.org/a@2x.jpg 2x");
  });
});

describe("pictures on screen", () => {
  const size = (img: HTMLImageElement, width: number, height: number) => {
    Object.defineProperty(img, "naturalWidth", { value: width });
    Object.defineProperty(img, "naturalHeight", { value: height });
  };

  it("hides a failed picture with its figure, a pixel, and keeps a small one in the line", () => {
    document.body.innerHTML = `<div id="body"><figure><img id="broken" src="https://a.example/x.jpg"><figcaption>x</figcaption></figure>
      <p>Badge <img id="badge" src="https://a.example/b.svg"> and <img id="pixel" src="https://a.example/p.gif"></p><img id="photo" src="https://a.example/photo.jpg"></div>`;
    const body = document.getElementById("body")!;
    const stop = watchPictures(body);
    const img = (id: string) => document.getElementById(id) as HTMLImageElement;
    img("broken").dispatchEvent(new Event("error"));
    size(img("badge"), 80, 20);
    size(img("pixel"), 1, 1);
    size(img("photo"), 1200, 800);
    for (const id of ["badge", "pixel", "photo"]) img(id).dispatchEvent(new Event("load"));
    expect(body.querySelector("figure")?.hidden).toBe(true);
    expect(img("pixel").hidden).toBe(true);
    expect(img("badge").hasAttribute("data-inline")).toBe(true);
    expect(img("photo").hidden).toBe(false);
    expect(img("photo").hasAttribute("data-inline")).toBe(false);
    stop();
    document.body.innerHTML = `<div id="body"><img id="icon" src="https://a.example/i.png"></div>`;
    const again = watchPictures(document.getElementById("body")!);
    size(img("icon"), 24, 24);
    img("icon").dispatchEvent(new Event("load"));
    expect(img("icon").hasAttribute("data-inline")).toBe(true);
    again();
  });
});

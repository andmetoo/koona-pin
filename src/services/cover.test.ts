import { describe, expect, it } from "vitest";
import { coverOf, hash, monogram, PALETTE, pendingFor, PENDING_MS, siteName } from "./cover";

describe("covers of bookmarks without a picture (NP-087)", () => {
  it("are the same for the same address, on every start", () => {
    expect(hash("iana.org")).toBe(hash("iana.org"));
    const a = coverOf("github.com", "https://github.com/andmetoo/koonapin/issues");
    expect(coverOf("github.com", "https://github.com/andmetoo/koonapin/issues")).toEqual(a);
    // The FNV-1a reference value: a change of the hash would recolour every library.
    expect(hash("a")).toBe(0xe40c292c);
  });

  it("take their colour from the site and their pattern from the page", () => {
    const one = coverOf("github.com", "https://github.com/one");
    const two = coverOf("GitHub.com", "https://github.com/two");
    expect([two.from, two.to]).toEqual([one.from, one.to]);
    const pages = Array.from({ length: 40 }, (_, i) => coverOf("github.com", `https://github.com/${i}`));
    expect(new Set(pages.map((c) => c.pattern)).size).toBe(4);
    expect(new Set(pages.map((c) => JSON.stringify(c))).size).toBe(40);
  });

  it("spread sites evenly over the palette", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 1400; i++) {
      const { from } = coverOf(`site-${i}.example`, `https://site-${i}.example/`);
      counts.set(from, (counts.get(from) ?? 0) + 1);
    }
    expect(counts.size).toBe(PALETTE.length);
    // 100 each on average: no colour is twice as common as another.
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(65);
      expect(n).toBeLessThan(135);
    }
  });

  it("draw only inside numbers: no NaN or Infinity reaches the SVG", () => {
    for (let i = 0; i < 200; i++) {
      const c = coverOf(`site${i}.example`, `https://site${i}.example/page/${i}`);
      expect(c.path).not.toMatch(/NaN|Infinity/);
      for (const circle of c.circles) for (const n of circle) expect(Number.isFinite(n)).toBe(true);
      expect(c.angle).toBeGreaterThanOrEqual(110);
      expect(c.angle).toBeLessThanOrEqual(170);
    }
  });

  it("name a site by the letter of its name", () => {
    expect(monogram("mail.google.com")).toBe("G");
    expect(monogram("www.iana.org")).toBe("I");
    expect(monogram("bbc.co.uk")).toBe("B");
    expect(monogram("localhost")).toBe("L");
    expect(monogram("яндекс.рф")).toBe("Я");
    expect(monogram("192.168.1.1", "Router")).toBe("R");
    expect(monogram("[::1]", "")).toBe("#");
  });

  it("shimmer only while a fresh capture waits for its metadata", () => {
    const now = Date.parse("2026-10-06T12:00:00.000Z");
    const fresh = { image_url: null, favicon_url: null, created_at: "2026-10-06T11:59:58.000Z", source: "chrome", revision: 1 };
    expect(pendingFor(fresh, now)).toBe(PENDING_MS - 2000);
    expect(pendingFor({ ...fresh, favicon_url: "https://x/icon.png" }, now)).toBe(0);
    expect(pendingFor({ ...fresh, source: "import" }, now)).toBe(0);
    expect(pendingFor({ ...fresh, revision: 2 }, now), "the metadata came, with nothing").toBe(0);
    expect(pendingFor({ ...fresh, created_at: "2026-10-06T11:59:00.000Z" }, now)).toBe(0);
    expect(pendingFor({ ...fresh, created_at: "2026-10-06T12:05:00.000Z" }, now), "a clock ahead does not shimmer forever").toBe(0);
  });

  it("names a poster cover by the site's own name, else by the label of its domain", () => {
    expect(siteName({ domain: "kottke.org" })).toBe("kottke");
    expect(siteName({ domain: "bbc.co.uk" })).toBe("bbc");
    expect(siteName({ domain: "www.theverge.com" })).toBe("theverge");
    expect(siteName({ domain: "mail.google.com" })).toBe("google");
    expect(siteName({ domain: "localhost" })).toBe("localhost");
    expect(siteName({ domain: "kottke.org", site_name: "Kottke.org" })).toBe("Kottke.org");
    expect(siteName({ domain: "kottke.org", site_name: "  " })).toBe("kottke");
    expect(siteName({ domain: "kottke.org", site_name: null })).toBe("kottke");
    expect(siteName({ domain: "192.168.1.1", title: " Router " })).toBe("Router");
    expect(siteName({ domain: "192.168.1.1" })).toBe("192.168.1.1");
  });
});

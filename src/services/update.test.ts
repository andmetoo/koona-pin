import { describe, expect, it } from "vitest";
import { megabytes, notesUrl, offer, percent } from "./update";

describe("the app update (sheet 42)", () => {
  it("shows the row only while a new version is in play", () => {
    expect(offer(null)).toBeNull();
    expect(offer({ state: "unknown" })).toBeNull();
    expect(offer({ state: "checking" })).toBeNull();
    expect(offer({ state: "up_to_date", checked_at: "2026-10-08T12:00:00Z" })).toBeNull();
    expect(offer({ state: "check_failed", checked_at: "2026-10-08T12:00:00Z" })).toBeNull();
    expect(offer({ state: "pacman" })).toBeNull();
    for (const status of [
      { state: "available", version: "0.3.0", notes: [] as string[], notes_url: "https://example.com" },
      { state: "downloading", version: "0.3.0", received: 1, total: 2 },
      { state: "installing", version: "0.3.0" },
      { state: "failed", version: "0.3.0", problem: "no_connection" },
    ] as const) {
      expect(offer(status)?.version).toBe("0.3.0");
    }
  });

  it("counts whole percent and none without a size", () => {
    expect(percent({ state: "downloading", version: "0.3.0", received: 4_100_000, total: 9_800_000 })).toBe(41);
    expect(percent({ state: "downloading", version: "0.3.0", received: 5, total: null })).toBeNull();
    expect(percent({ state: "downloading", version: "0.3.0", received: 12, total: 10 })).toBe(100);
    expect(percent({ state: "installing", version: "0.3.0" })).toBeNull();
  });

  it("writes sizes in megabytes of the language", () => {
    expect(megabytes(4_100_000, "en")).toBe("4.1 MB");
    expect(megabytes(9_800_000, "ru")).toMatch(/^9,8\sМБ$/);
  });

  it("opens the offered version in the site's changelog", () => {
    expect(notesUrl({ state: "available", version: "0.3.0", notes: ["Faster search."], notes_url: "https://koona.app/pin/changelog/#0.3.0" })).toBe(
      "https://koona.app/pin/changelog/#0.3.0",
    );
    expect(notesUrl({ state: "failed", version: "0.3.1", problem: "bad_signature" })).toBe("https://koona.app/pin/changelog/#0.3.1");
  });
});

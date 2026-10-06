import { describe, expect, it } from "vitest";
import { handle, MAX_BODY, notification, parse, senderAddress, TRAP, type Deps, type Row } from "./handler.ts";

const URL = "https://project.supabase.co/functions/v1/feedback";

function fakes(slots = 5) {
  const rows: Row[] = [];
  const notes: string[] = [];
  const hashes: string[] = [];
  let left = slots;
  const deps: Deps = {
    hash: async (address) => `h:${address}`,
    submit: async (hash, _perHour, row) => {
      hashes.push(hash);
      if (left-- <= 0) return false;
      rows.push(row);
      return true;
    },
    notify: async (text) => void notes.push(text),
  };
  return { deps, rows, notes, hashes };
}

const app = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "6.6.6.6", ...headers },
    body: JSON.stringify(body),
  });
const site = (fields: Record<string, string>, origin: string | null = "https://pin.netami.app") =>
  new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin === null ? {} : { origin }), "cf-connecting-ip": "198.51.100.2" },
    body: new URLSearchParams(fields).toString(),
  });
const fromApp = {
  kind: "bug",
  message: "  Only the first card moves.  ",
  email: null,
  report: "Netami Pin 0.1.0\nCapture: connected",
  app_version: "0.1.0",
  os: "Windows 11 24H2 (build 26300), x86_64",
  language: "en",
  source: "app",
};

describe("feedback function", () => {
  it("stores a message from the app with its version, OS and language, and notifies", async () => {
    const { deps, rows, notes, hashes } = fakes();
    const response = await handle(app(fromApp), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(rows).toEqual([
      {
        kind: "bug",
        message: "Only the first card moves.",
        email: null,
        app_version: "0.1.0",
        os: "Windows 11 24H2 (build 26300), x86_64",
        language: "en",
        report: "Netami Pin 0.1.0\nCapture: connected",
        source: "app",
      },
    ]);
    expect(hashes).toEqual(["h:203.0.113.7"]);
    expect(notes).toHaveLength(1);
  });

  it("keeps no report when the box was not ticked", async () => {
    const { deps, rows } = fakes();
    await handle(app({ ...fromApp, report: null }), deps);
    expect(rows[0].report).toBeNull();
  });

  it("refuses bad fields and says which", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "complaint" }, "kind"],
      [{ message: "   " }, "message"],
      [{ message: "x".repeat(5001) }, "message"],
      [{ email: "anna@example" }, "email"],
      [{ email: 42 }, "email"],
      [{ report: "x".repeat(10001) }, "report"],
      [{ os: "x".repeat(101) }, "os"],
    ];
    for (const [change, field] of cases) {
      const { deps, rows } = fakes();
      const response = await handle(app({ ...fromApp, ...change }), deps);
      expect(response.status, field).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid", field });
      expect(rows).toHaveLength(0);
    }
    expect((await handle(app({ ...fromApp, message: "x".repeat(5000) }), fakes().deps)).status).toBe(200);
    // Characters, as the app and Postgres count them: an emoji is one, not two UTF-16 units.
    expect((await handle(app({ ...fromApp, message: "🙂".repeat(5000) }), fakes().deps)).status).toBe(200);
    expect((await handle(app({ ...fromApp, message: "🙂".repeat(5001) }), fakes().deps)).status).toBe(400);
  });

  it("refuses broken bodies, other methods and other origins", async () => {
    const { deps } = fakes();
    const broken = new Request(URL, { method: "POST", headers: { "content-type": "application/json" }, body: "[1," });
    expect((await handle(broken, deps)).status).toBe(400);
    expect((await handle(app([1, 2]), deps)).status).toBe(400);
    expect((await handle(new Request(URL), deps)).status).toBe(405);
    const plain = new Request(URL, { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" });
    expect((await handle(plain, deps)).status).toBe(415);
    expect((await handle(app(fromApp, { origin: "https://evil.example" }), deps)).status).toBe(403);
    expect((await handle(app({ ...fromApp, message: "x".repeat(40_000) }), deps)).status).toBe(400);
    const huge = await handle(app({ ...fromApp, report: "x".repeat(MAX_BODY) }), deps);
    expect([huge.status, await huge.json()]).toEqual([400, { error: "invalid", field: "body" }]);
  });

  it("refuses a sender over the hourly limit with its own answer", async () => {
    const { deps, rows } = fakes(1);
    expect((await handle(app(fromApp), deps)).status).toBe(200);
    const second = await handle(app(fromApp), deps);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate_limited" });
    expect(rows).toHaveLength(1);
  });

  it("answers 500 when the database fails, and still 200 when only Telegram does", async () => {
    const failing = fakes();
    failing.deps.submit = async () => {
      throw new Error("down");
    };
    expect((await handle(app(fromApp), failing.deps)).status).toBe(500);
    const quiet = fakes();
    quiet.deps.notify = async () => {
      throw new Error("telegram down");
    };
    expect((await handle(app(fromApp), quiet.deps)).status).toBe(200);
    expect(quiet.rows).toHaveLength(1);
  });

  it("takes the site form, without report, version or OS, and sends the browser to a page of the site", async () => {
    const { deps, rows } = fakes();
    const response = await handle(
      site({ kind: "idea", message: "Dark mode for the site", email: "anna@example.com", lang: "ru", report: "x", os: "y" }),
      deps,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://pin.netami.app/ru/feedback/sent");
    expect(rows).toEqual([
      { kind: "idea", message: "Dark mode for the site", email: "anna@example.com", app_version: null, os: null, language: "ru", report: null, source: "site" },
    ]);
  });

  it("sends the site form to the limit and error pages in its language", async () => {
    const limited = fakes(0);
    const limit = await handle(site({ kind: "bug", message: "x", lang: "en" }), limited.deps);
    expect(limit.headers.get("location")).toBe("https://pin.netami.app/feedback/limit");
    const invalid = await handle(site({ kind: "bug", message: "", lang: "ru" }), fakes().deps);
    expect(invalid.status).toBe(303);
    expect(invalid.headers.get("location")).toBe("https://pin.netami.app/ru/feedback/long");
    const long = await handle(site({ kind: "bug", message: "x".repeat(5001), lang: "en" }), fakes().deps);
    expect(long.headers.get("location")).toBe("https://pin.netami.app/feedback/long");
    const badKind = await handle(site({ kind: "complaint", message: "x", lang: "en" }), fakes().deps);
    expect(badKind.headers.get("location")).toBe("https://pin.netami.app/feedback/error");
    // A foreign page posting the form, or one hiding its origin (`null`), lands on the error page
    // in the language of the form; nothing is stored.
    const foreign = await handle(site({ kind: "bug", message: "x", lang: "ru" }, "https://evil.example"), fakes().deps);
    expect([foreign.status, foreign.headers.get("location")]).toEqual([303, "https://pin.netami.app/ru/feedback/origin"]);
    const hidden = fakes();
    const nullOrigin = await handle(site({ kind: "bug", message: "x", lang: "en" }, "null"), hidden.deps);
    expect(nullOrigin.headers.get("location")).toBe("https://pin.netami.app/feedback/origin");
    expect(hidden.rows).toHaveLength(0);
    expect((await handle(app(fromApp, { origin: "null" }), fakes().deps)).status).toBe(403);
  });

  it("takes a long non-Latin message from the site: the cap counts encoded bytes generously", async () => {
    const { deps, rows } = fakes();
    const response = await handle(site({ kind: "idea", message: "漢".repeat(4999), lang: "en" }), deps);
    expect(response.headers.get("location")).toBe("https://pin.netami.app/feedback/sent");
    expect([...rows[0].message].length).toBe(4999);
  });

  it("tells a bot that filled the hidden field «sent» and keeps nothing", async () => {
    const { deps, rows, hashes } = fakes();
    const response = await handle(site({ kind: "bug", message: "buy now", [TRAP]: "https://spam.example", lang: "en" }), deps);
    expect(response.headers.get("location")).toBe("https://pin.netami.app/feedback/sent");
    expect(rows).toHaveLength(0);
    expect(hashes).toHaveLength(0);
  });
});

describe("feedback pieces", () => {
  it("the notification carries no text, no email address and no report", () => {
    const row = parse({ ...fromApp, email: "anna@example.com", message: "y".repeat(600) }, "app");
    if ("invalid" in row) throw new Error(row.invalid);
    const text = notification(row.row);
    expect(text).toContain("Bug · app · 0.1.0 · Windows 11 24H2 (build 26300), x86_64 · en");
    expect(text).not.toContain("yyy");
    expect(text).not.toContain("anna@example.com");
    expect(text).not.toContain("Capture: connected");
    expect(text).toContain("600 characters · email for a reply · report attached");
  });

  it("the sender is what Cloudflare set, never what the client could write", () => {
    const of = (headers: Record<string, string>) => senderAddress(new Headers(headers));
    expect(of({ "cf-connecting-ip": " 198.51.100.2 ", "x-forwarded-for": "6.6.6.6, 203.0.113.7", "x-real-ip": "7.7.7.7" })).toEqual({ address: "198.51.100.2", from: "cf-connecting-ip" });
    // Without it there is no address to trust: one shared key, named in the log.
    expect(of({ "x-forwarded-for": "6.6.6.6, 203.0.113.7", "x-real-ip": "7.7.7.7" })).toEqual({ address: "unknown", from: "none" });
    expect(of({})).toEqual({ address: "unknown", from: "none" });
  });
  it("the length counts characters, an emoji as one", () => {
    const row = parse({ ...fromApp, message: "🙂".repeat(600) }, "app");
    if ("invalid" in row) throw new Error(row.invalid);
    expect(notification(row.row)).toContain("600 characters");
  });
});

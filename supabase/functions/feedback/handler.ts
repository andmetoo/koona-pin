// The Edge Function `feedback` without Deno (NP-088, Р-9): checks a message
// from the app (JSON) or from the form on koona.app/pin (a plain HTML form),
// stores the row within the hourly limit and notifies the owner.
// `index.ts` wires the real database and Telegram; tests pass fakes.

// The form lives at koona.app/pin; browsers send only the origin, without the path (Р-47).
export const ORIGIN = "https://koona.app";
export const SITE = `${ORIGIN}/pin`;
export const MAX_MESSAGE = 5000;
export const MAX_REPORT = 10000;
export const PER_HOUR = 5;
// Bytes. A site form body is percent-encoded: 5000 emoji are 60 000 bytes, CJK 45 000.
export const MAX_BODY = 128 * 1024;
/** The hidden field of the site form; a name no autofill fills, unlike «website». */
export const TRAP = "hp_7q";

export type Kind = "bug" | "idea" | "question";
export type Row = {
  kind: Kind;
  message: string;
  email: string | null;
  app_version: string | null;
  os: string | null;
  language: string | null;
  report: string | null;
  source: "app" | "site";
};
export type Deps = {
  /** Salted hash of the sender's address. */
  hash: (address: string) => Promise<string>;
  /**
   * Stores the row if the sender has a place left in the hourly limit; false when
   * none is left. One transaction: a failed insert does not use up a place.
   */
  submit: (addressHash: string, perHour: number, row: Row) => Promise<boolean>;
  /** Best effort: a failed notification does not fail the request. */
  notify: (text: string) => Promise<void>;
};

type Failure = "invalid" | "rate_limited" | "server";
type Parsed = { row: Row; trap: boolean } | { invalid: string };

const kinds: Kind[] = ["bug", "idea", "question"];
// A practical check, not RFC 5322: something@something.tld without spaces.
const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function text(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // Characters as the app and Postgres count them, not UTF-16 units: an emoji is one.
  return [...trimmed].length <= max ? trimmed : undefined;
}

/** The fields of either form, checked; the name of the first bad field otherwise. */
export function parse(fields: Record<string, unknown>, source: "app" | "site"): Parsed {
  const kind = fields.kind;
  if (typeof kind !== "string" || !kinds.includes(kind as Kind)) return { invalid: "kind" };
  const message = text(fields.message, MAX_MESSAGE);
  if (!message) return { invalid: "message" };
  const email = text(fields.email, 254);
  if (email === undefined || (email !== null && !emailShape.test(email))) return { invalid: "email" };
  const language = text(source === "site" ? fields.lang : fields.language, 10);
  if (language === undefined) return { invalid: "language" };
  // The site has no report, version or OS: only the app knows them.
  const report = source === "app" ? text(fields.report, MAX_REPORT) : null;
  if (report === undefined) return { invalid: "report" };
  const app_version = source === "app" ? text(fields.app_version, 40) : null;
  if (app_version === undefined) return { invalid: "app_version" };
  const os = source === "app" ? text(fields.os, 100) : null;
  if (os === undefined) return { invalid: "os" };
  const trap = source === "site" && typeof fields[TRAP] === "string" && fields[TRAP] !== "";
  return { row: { kind: kind as Kind, message, email, app_version, os, language, report, source }, trap };
}

const kindName: Record<Kind, string> = { bug: "Bug", idea: "Idea", question: "Question" };

/**
 * What the owner reads in Telegram (Р-9): the type, the versions and the length —
 * not the text, the address or the report. Telegram keeps chats for ever; the text
 * stays only in the table, which forgets it after 12 months.
 */
export function notification(row: Row): string {
  const head = [kindName[row.kind], row.source, row.app_version, row.os, row.language].filter(Boolean).join(" · ");
  const extras = [`${[...row.message].length} characters`, row.email && "email for a reply", row.report && "report attached"].filter(Boolean).join(" · ");
  return `${head}\n${extras}`;
}

/**
 * The sender's address for the limit, and the header it came from (the name is
 * logged to check the deployment; the address never is). Only CF-Connecting-IP is
 * trusted: Cloudflare in front of Supabase sets it itself. X-Real-IP and every entry
 * of X-Forwarded-For can be written by the client or be a shared proxy hop, so
 * without CF-Connecting-IP all senders share one limit — loud in the log and caught
 * by the check in supabase/README.md, rather than a silent hole.
 */
export function senderAddress(headers: Headers): { address: string; from: string } {
  const address = headers.get("cf-connecting-ip")?.trim();
  return address ? { address, from: "cf-connecting-ip" } : { address: "unknown", from: "none" };
}
/** Languages of the site and their paths (NP-107, NP-090); the form sends its page's `lang`. */
const SITE_PATHS: Record<string, string> = {
  en: "", ru: "/ru", de: "/de", es: "/es", fr: "/fr", it: "/it", pl: "/pl", "pt-BR": "/pt-br", "sr-Latn": "/sr", tr: "/tr", uk: "/uk",
  "zh-CN": "/zh-cn", ja: "/ja", ko: "/ko",
};
/** Where the site form goes next: a static page of the site in its language, else English. */
export function sitePage(language: string | null, outcome: "sent" | "limit" | "long" | "origin" | "error"): string {
  // The field comes from the browser: only own keys, so «constructor» and the like stay English.
  return `${SITE}${language && Object.hasOwn(SITE_PATHS, language) ? SITE_PATHS[language] : ""}/feedback/${outcome}`;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function reply(source: "app" | "site", language: string | null, failure?: Failure, field?: string): Response {
  if (source === "site") {
    // A refused message (empty or over 5000 characters) and a hidden or foreign origin
    // have pages that say why; the rest is «error».
    const outcome = !failure
      ? "sent"
      : failure === "rate_limited"
        ? "limit"
        : field === "message"
          ? "long"
          : field === "origin"
            ? "origin"
            : "error";
    return new Response(null, { status: 303, headers: { location: sitePage(language, outcome) } });
  }
  if (!failure) return json(200, { ok: true });
  const status = failure === "invalid" ? 400 : failure === "rate_limited" ? 429 : 500;
  return json(status, field ? { error: failure, field } : { error: failure });
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method" });
  const type = request.headers.get("content-type") ?? "";
  const site = type.startsWith("application/x-www-form-urlencoded");
  if (!site && !type.startsWith("application/json")) return json(415, { error: "content_type" });
  const source = site ? "site" : "app";
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return reply(source, null, "invalid", "body");

  let fields: Record<string, unknown>;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_BODY) return reply(source, null, "invalid", "body");
    const body = new TextDecoder().decode(bytes);
    fields = site ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body);
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new Error("not an object");
  } catch {
    return reply(source, null, "invalid", "body");
  }
  const language = typeof fields.lang === "string" ? fields.lang : null;
  // A browser posting from anywhere but the site is not our form. The form page sets
  // its own referrer policy, so the site always names itself; `null` (a hidden
  // origin) is what any foreign page can produce, and is refused too.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== ORIGIN) {
    return site ? reply(source, language, "invalid", "origin") : json(403, { error: "origin" });
  }
  const parsed = parse(fields, source);
  if ("invalid" in parsed) return reply(source, language, "invalid", parsed.invalid);
  // A bot filled the hidden field: it is told «sent», nothing is kept.
  if (parsed.trap) return reply(source, parsed.row.language);

  try {
    const sender = senderAddress(request.headers);
    if (sender.from === "none") console.error(`feedback: ${source}, no CF-Connecting-IP — every sender shares one limit`);
    else console.log(`feedback: ${source}, address from ${sender.from}`);
    const address = await deps.hash(sender.address);
    if (!(await deps.submit(address, PER_HOUR, parsed.row))) return reply(source, parsed.row.language, "rate_limited");
  } catch (error) {
    console.error("feedback:", error instanceof Error ? error.message : error);
    return reply(source, parsed.row.language, "server");
  }
  try {
    await deps.notify(notification(parsed.row));
  } catch (error) {
    console.error("feedback notification:", error instanceof Error ? error.message : error);
  }
  return reply(source, parsed.row.language);
}

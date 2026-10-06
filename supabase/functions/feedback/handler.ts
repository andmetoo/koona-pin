// The Edge Function `feedback` without Deno (NP-088, Р-9): checks a message
// from the app (JSON) or from the form on pin.netami.app (a plain HTML form),
// takes a place in the hourly limit, stores the row and notifies the owner.
// `index.ts` wires the real database and Telegram; tests pass fakes.

export const SITE = "https://pin.netami.app";
export const MAX_MESSAGE = 5000;
export const MAX_REPORT = 10000;
export const PER_HOUR = 5;
const MAX_BODY = 32 * 1024;
/** The hidden field of the site form; a name no autofill fills, unlike «website». */
export const TRAP = "hp_7q";
const EXCERPT = 500;

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
  /** A place in the hourly limit, or false when none is left. */
  takeSlot: (addressHash: string, perHour: number) => Promise<boolean>;
  insert: (row: Row) => Promise<void>;
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

/** What the owner reads in Telegram: no address and no report (Р-9). */
export function notification(row: Row): string {
  const head = [kindName[row.kind], row.source, row.app_version, row.os, row.language].filter(Boolean).join(" · ");
  const chars = [...row.message];
  const excerpt = chars.length > EXCERPT ? `${chars.slice(0, EXCERPT).join("")}…` : row.message;
  const extras = [row.email && "Email left for a reply", row.report && "Report attached"].filter(Boolean).join(" · ");
  return `${head}\n\n${excerpt}${extras ? `\n\n${extras}` : ""}`;
}

/**
 * The sender's address for the limit. The client can put anything into
 * X-Forwarded-For; Cloudflare in front of Supabase sets CF-Connecting-IP itself,
 * and Supabase appends the real address as the last X-Forwarded-For entry.
 */
export function senderAddress(headers: Headers): string {
  return headers.get("cf-connecting-ip")?.trim() || headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

/** Where the site form goes next: a static page of the site in its language. */
export function sitePage(language: string | null, outcome: "sent" | "limit" | "error"): string {
  return `${SITE}${language === "ru" ? "/ru" : ""}/feedback/${outcome}`;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function reply(source: "app" | "site", language: string | null, failure?: Failure, field?: string): Response {
  if (source === "site") {
    const outcome = !failure ? "sent" : failure === "rate_limited" ? "limit" : "error";
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
  // A browser posting from anywhere but the site is not our form. `null` is the
  // site too when a referrer policy hides it (the form page asks browsers not to).
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== SITE && !(site && origin === "null")) {
    return site ? reply(source, null, "invalid", "origin") : json(403, { error: "origin" });
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return reply(source, null, "invalid", "body");

  let fields: Record<string, unknown>;
  try {
    const body = await request.text();
    if (body.length > MAX_BODY) return reply(source, null, "invalid", "body");
    fields = site ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body);
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new Error("not an object");
  } catch {
    return reply(source, null, "invalid", "body");
  }
  const language = typeof fields.lang === "string" ? fields.lang : null;
  const parsed = parse(fields, source);
  if ("invalid" in parsed) return reply(source, language, "invalid", parsed.invalid);
  // A bot filled the hidden field: it is told «sent», nothing is kept.
  if (parsed.trap) return reply(source, parsed.row.language);

  try {
    const address = await deps.hash(senderAddress(request.headers));
    if (!(await deps.takeSlot(address, PER_HOUR))) return reply(source, parsed.row.language, "rate_limited");
    await deps.insert(parsed.row);
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

// Deno entry of the Edge Function `feedback` (NP-088): the database through
// PostgREST with the service role key, notifications through the owner's
// Telegram bot. Secrets: FEEDBACK_IP_SALT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID;
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set by Supabase itself.
import { handle, type Row } from "./handler.ts";

// Supabase's runtime: work that may finish after the response.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const base = env("SUPABASE_URL");
const key = env("SUPABASE_SERVICE_ROLE_KEY");
const salt = env("FEEDBACK_IP_SALT");
// A legacy service role key is a JWT and goes as Bearer too; the new secret keys
// (`sb_secret_…`) are not JWTs and go only as `apikey`, the gateway refuses them as Bearer.
const headers: Record<string, string> = {
  apikey: key,
  "content-type": "application/json",
  ...(key.startsWith("eyJ") ? { authorization: `Bearer ${key}` } : {}),
};

async function rest(path: string, body: unknown): Promise<Response> {
  const response = await fetch(`${base}/rest/v1/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    // Only the status and PostgREST's code: its message and details can quote the row
    // («Failing row contains …»), with the person's text and email, into the log.
    const code = await response.json().then((body) => body?.code, () => undefined);
    throw new Error(`${path}: ${response.status}${code ? ` ${code}` : ""}`);
  }
  return response;
}

// Without them feedback is still stored, but nobody hears about it: said once per boot.
const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
const chat = Deno.env.get("TELEGRAM_CHAT_ID");
if (!token || !chat) console.warn("feedback: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set — no notifications");

async function telegram(text: string) {
  if (!token || !chat) return;
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    // The token is in the address, and the Edge Runtime quotes the address in a transport
    // error («error sending request for url (…)»): only the kind of failure goes to the log.
    throw new Error(`telegram: no response (${error instanceof Error ? error.name : typeof error})`);
  }
  if (!response.ok) throw new Error(`telegram: ${response.status}`);
}

const deps = {
  hash: async (address: string) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${address}`));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  },
  submit: async (addressHash: string, perHour: number, row: Row) =>
    (await rest("rpc/feedback_submit", { address_hash: addressHash, per_hour: perHour, entry: row }).then((r) => r.json())) === true,
  // The row is stored: the sender is answered at once and Telegram is told afterwards.
  notify: async (text: string) => {
    const sending = telegram(text).catch((error) => console.error("feedback notification:", error instanceof Error ? error.message : error));
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(sending);
    else await sending;
  },
};

Deno.serve((request) => handle(request, deps));

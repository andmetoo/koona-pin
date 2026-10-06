// Deno entry of the Edge Function `feedback` (NP-088): the database through
// PostgREST with the service role key, notifications through the owner's
// Telegram bot. Secrets: FEEDBACK_IP_SALT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID;
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set by Supabase itself.
import { handle, type Row } from "./handler.ts";

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const base = env("SUPABASE_URL");
const key = env("SUPABASE_SERVICE_ROLE_KEY");
const salt = env("FEEDBACK_IP_SALT");
const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };

async function rest(path: string, body: unknown, prefer?: string): Promise<Response> {
  const response = await fetch(`${base}/rest/v1/${path}`, {
    method: "POST",
    headers: prefer ? { ...headers, prefer } : headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}

const deps = {
  hash: async (address: string) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${address}`));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  },
  submit: async (addressHash: string, perHour: number, row: Row) =>
    (await rest("rpc/feedback_submit", { address_hash: addressHash, per_hour: perHour, entry: row }).then((r) => r.json())) === true,
  notify: async (text: string) => {
    const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const chat = Deno.env.get("TELEGRAM_CHAT_ID");
    if (!token || !chat) return;
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`telegram: ${response.status}`);
  },
};

Deno.serve((request) => handle(request, deps));

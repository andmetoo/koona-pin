import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The real `index.ts` under Node: Deno's env and server are stood in for, fetch is faked.
// Nothing leaves the machine; the token exists only here.
const TOKEN = "123456789:fake-token-of-this-test";
const env: Record<string, string> = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fake",
  FEEDBACK_IP_SALT: "salt",
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_CHAT_ID: "42",
};

let serve: (request: Request) => Promise<Response>;
let telegram: (url: string) => Promise<Response>;
const logged: unknown[][] = [];

beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: (name: string) => env[name] }, serve: (handler: typeof serve) => void (serve = handler) });
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    return url.startsWith(`${env.SUPABASE_URL}/rest/v1/`) ? Response.json(true) : telegram(url);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...args) => void logged.push(args));
  await import("./index.ts");
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const message = () =>
  new Request("https://project.supabase.co/functions/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify({ kind: "bug", message: "Only the first card moves." }),
  });

describe("feedback function in Deno", () => {
  it("logs a failed notification without the bot's token, which is in the request's address", async () => {
    const failures: [string, (url: string) => Promise<Response>, string][] = [
      // What Supabase's Edge Runtime throws when the connection fails: the address, token and all.
      [
        "transport",
        async (url) => {
          throw new TypeError(`error sending request for url (${url}): client error (Connect)`, { cause: new Error(url) });
        },
        "telegram: no response (TypeError)",
      ],
      [
        "timeout",
        async () => {
          throw new DOMException("Signal timed out.", "TimeoutError");
        },
        "telegram: no response (TimeoutError)",
      ],
      ["refusal", async () => new Response('{"ok":false}', { status: 401 }), "telegram: 401"],
    ];
    for (const [name, failure, expected] of failures) {
      telegram = failure;
      logged.length = 0;
      expect((await serve(message())).status, name).toBe(200);
      expect(logged, name).toEqual([["feedback notification:", expected]]);
    }
  });

  it("sends the notification to the chat", async () => {
    const sent: string[] = [];
    telegram = async (url) => {
      sent.push(url);
      return Response.json({ ok: true });
    };
    logged.length = 0;
    expect((await serve(message())).status).toBe(200);
    expect(sent).toEqual([`https://api.telegram.org/bot${TOKEN}/sendMessage`]);
    expect(logged).toEqual([]);
  });
});

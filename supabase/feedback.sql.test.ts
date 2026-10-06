// The feedback schema on a real Postgres (PGlite, NP-088): the migration as Supabase
// would run it, with Supabase's roles and its default grants to them, so the
// revokes are tested too. Retention (pg_cron) is a separate migration, not loaded here.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./migrations/20261006000000_feedback.sql", import.meta.url), "utf8");
// What a new Supabase project has before any migration: the API roles and their default grants.
const supabase = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const row = {
  kind: "bug",
  message: "Only the first card moves.",
  email: null,
  app_version: "0.1.0",
  os: "Windows 11",
  language: "en",
  report: "Netami Pin 0.1.0",
  source: "app",
};

let db: PGlite;
beforeEach(async () => {
  db = new PGlite();
  await db.exec(supabase);
  await db.exec(migration);
});
afterEach(() => db.close());

async function as<T>(role: string, work: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await work();
  } finally {
    await db.exec("reset role");
  }
}
const submit = (hash: string, entry: object, perHour = 5) =>
  as("service_role", async () => {
    const result = await db.query<{ ok: boolean }>("select public.feedback_submit($1, $2, $3::jsonb) as ok", [hash, perHour, JSON.stringify(entry)]);
    return result.rows[0].ok;
  });
const count = async (sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(`select count(*)::int as n ${sql}`, params)).rows[0].n;

describe("feedback schema", () => {
  it("stores a message and counts it against the sender", async () => {
    expect(await submit("a", row)).toBe(true);
    const stored = await db.query("select kind, message, email, app_version, os, language, report, source from public.feedback");
    expect(stored.rows).toEqual([row]);
    expect(await count("from public.feedback_hits where ip_hash = 'a'")).toBe(1);
  });

  it("refuses the sixth message of the hour from one sender, not from another", async () => {
    for (let i = 0; i < 5; i++) expect(await submit("a", row)).toBe(true);
    expect(await submit("a", row)).toBe(false);
    expect(await submit("b", row)).toBe(true);
    expect(await count("from public.feedback")).toBe(6);
    // An hour later the place is back.
    await db.exec("update public.feedback_hits set at = now() - interval '61 minutes' where ip_hash = 'a'");
    expect(await submit("a", row)).toBe(true);
  });

  it("a failed insert does not use up a place", async () => {
    await expect(submit("a", { ...row, kind: "complaint" })).rejects.toThrow(/check constraint/);
    await expect(submit("a", { ...row, message: "x".repeat(5001) })).rejects.toThrow(/check constraint/);
    expect(await count("from public.feedback_hits")).toBe(0);
    expect(await count("from public.feedback")).toBe(0);
    for (let i = 0; i < 5; i++) expect(await submit("a", row)).toBe(true);
  });

  it("counts characters as the app does: 5000 emoji fit", async () => {
    expect(await submit("a", { ...row, message: "🙂".repeat(5000) })).toBe(true);
  });

  for (const role of ["anon", "authenticated"]) {
    it(`${role} can neither read, write nor call the function`, async () => {
      expect(await submit("a", row)).toBe(true);
      await as(role, async () => {
        await expect(db.query("select * from public.feedback")).rejects.toThrow(/permission denied/);
        await expect(db.query("select * from public.feedback_hits")).rejects.toThrow(/permission denied/);
        await expect(db.query("insert into public.feedback (kind, message, source) values ('bug', 'x', 'app')")).rejects.toThrow(/permission denied/);
        await expect(db.query("select public.feedback_submit('z', 5, '{}'::jsonb)")).rejects.toThrow(/permission denied/);
      });
    });
  }
});

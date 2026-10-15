// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SupporterStatus } from "../types";
import {
  clearSupporterLook,
  contrast,
  FREE_PALETTES,
  fontLocked,
  ReaderChoice,
  readerStyle,
  registerSupporterLook,
  resolveReaderLook,
  saveReaderChoice,
  storedReaderChoice,
  supporterUnlocked,
  themeLocked,
} from "./readerLook";
import { supporterLook } from "../components/commercial/readerThemes";

const plan = (status: SupporterStatus["plan"]): SupporterStatus => ({
  available: true,
  sandbox: false,
  email: status ? "anna@example.com" : null,
  plan: status,
  check_failed: false,
  plan_unknown: false,
  awaiting_sign_in: false,
});
const active = plan({ status: "active", interval: "year", valid_until: "2027-10-15T00:00:00Z", renews_at: null, offline_until: "2026-11-14T00:00:00Z", also_renews: false });
const choice = (over: Partial<ReaderChoice> = {}): ReaderChoice => ({ theme: "auto", font: "serif", size: 18, column: "medium", ...over });

// The module registers itself when imported; each test states the build it means.
beforeEach(() => registerSupporterLook(supporterLook));
afterEach(() => localStorage.clear());

describe("the plan check (Р-64, point 6: the plan the app keeps, like the backup folder)", () => {
  test("a kept plan unlocks; none, or no status yet, does not", () => {
    expect(supporterUnlocked(active)).toBe(true);
    expect(supporterUnlocked(plan(null))).toBe(false);
    expect(supporterUnlocked(null)).toBe(false);
    expect(supporterUnlocked(undefined)).toBe(false);
  });
  test("Paper, Sepia and the extra fonts are locked without it, White, Dark, Serif and Sans never", () => {
    for (const unlocked of [false, true]) {
      expect(themeLocked("white", unlocked)).toBe(false);
      expect(themeLocked("dark", unlocked)).toBe(false);
      expect(fontLocked("serif", unlocked)).toBe(false);
      expect(fontLocked("sans", unlocked)).toBe(false);
      expect(themeLocked("paper", unlocked)).toBe(!unlocked);
      expect(themeLocked("sepia", unlocked)).toBe(!unlocked);
      expect(fontLocked("book", unlocked)).toBe(!unlocked);
      expect(fontLocked("legible", unlocked)).toBe(!unlocked);
    }
  });
});

describe("resolution of the look", () => {
  test("by default it follows the app's theme", () => {
    expect(resolveReaderLook(choice(), { appDark: false, unlocked: false }).theme).toBe("white");
    expect(resolveReaderLook(choice(), { appDark: true, unlocked: false }).theme).toBe("dark");
  });
  test("a free theme chosen holds against the app's", () => {
    expect(resolveReaderLook(choice({ theme: "white" }), { appDark: true, unlocked: false }).theme).toBe("white");
    expect(resolveReaderLook(choice({ theme: "dark" }), { appDark: false, unlocked: false }).theme).toBe("dark");
  });
  test("a locked choice shows the free one, and applies at once when the plan arrives", () => {
    const paper = choice({ theme: "paper", font: "book" });
    const free = resolveReaderLook(paper, { appDark: true, unlocked: false });
    expect([free.theme, free.font]).toEqual(["dark", "serif"]);
    const paid = resolveReaderLook(paper, { appDark: true, unlocked: true });
    expect([paid.theme, paid.font]).toEqual(["paper", "book"]);
    expect(paid.palette.read).toBe("#f4eee2");
    expect(paid.fontStack).toContain("Source Serif 4");
  });
  test("size, line and column", () => {
    const look = resolveReaderLook(choice({ size: 24, column: "wide" }), { appDark: false, unlocked: false });
    expect([look.size, look.lineHeight, look.width]).toEqual([24, 40, 760]);
    expect(resolveReaderLook(choice(), { appDark: false, unlocked: false }).lineHeight).toBe(30);
    const style = readerStyle(look) as Record<string, string>;
    expect([style["--reader-size"], style["--reader-line"], style["--reader-width"]]).toEqual(["24px", "40px", "760px"]);
  });
  test("the accent follows the page, not the app: White keeps the light green, Dark the mint", () => {
    const style = (theme: ReaderChoice["theme"]) => readerStyle(resolveReaderLook(choice({ theme }), { appDark: true, unlocked: true })) as Record<string, string>;
    expect(style("white")["--np-accent"]).toBe("#2f6b4f");
    expect(style("sepia")["--np-accent"]).toBe("#2f6b4f");
    expect(style("dark")["--np-accent"]).toBe("#8fd0ae");
  });
});

describe("kept per computer", () => {
  test("the choice survives a reload; nonsense falls back to the defaults", () => {
    saveReaderChoice(choice({ theme: "sepia", font: "sans", size: 20, column: "narrow" }));
    expect(storedReaderChoice()).toEqual({ theme: "sepia", font: "sans", size: 20, column: "narrow" });
    localStorage.setItem("koonapin.readerTheme", "neon");
    localStorage.setItem("koonapin.readerSize", "99");
    expect(storedReaderChoice()).toMatchObject({ theme: "auto", size: 18 });
  });
});

describe("a community build without the commercial module (Р-66)", () => {
  beforeEach(() => clearSupporterLook());
  test("Paper, Sepia and the extra fonts stay locked even with a plan; White and Dark work", () => {
    for (const unlocked of [false, true]) {
      expect(themeLocked("paper", unlocked)).toBe(true);
      expect(fontLocked("legible", unlocked)).toBe(true);
      const look = resolveReaderLook(choice({ theme: "sepia", font: "legible" }), { appDark: false, unlocked });
      expect([look.theme, look.font, look.palette]).toEqual(["white", "serif", FREE_PALETTES.white]);
    }
  });
  test("no community code imports the commercial reading themes but the one line in main.tsx", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "commercial") walk(path);
        } else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts")) files.push(path);
      }
    };
    walk("src");
    const importers = files.filter((f) => /import\s[^;]*["'][^"']*commercial\/readerThemes["']/.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => f.replace(/\\/g, "/"))).toEqual(["src/main.tsx"]);
  });
});

describe("contrast of body text (acceptance 3: at least 7:1 in every theme)", () => {
  const themes = { White: FREE_PALETTES.white, Dark: FREE_PALETTES.dark, Paper: supporterLook.themes.paper!, Sepia: supporterLook.themes.sepia! };
  const table = Object.entries(themes).map(([name, p]) => ({
    theme: name,
    page: p.read,
    ink: p.ink,
    text: p.text,
    body: Number(contrast(p.ink, p.read).toFixed(2)),
    ui: Number(contrast(p.text, p.read).toFixed(2)),
  }));
  test.each(table)("$theme: ink $ink on $page is $body:1, text $text is $ui:1", ({ body, ui }) => {
    expect(body).toBeGreaterThanOrEqual(7);
    expect(ui).toBeGreaterThanOrEqual(7);
  });
  test("the formula itself: black on white is 21:1, a colour on itself 1:1", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBe(1);
  });
  test("the table for the PR", () => {
    console.table(table);
  });
});

test("the free palettes are app.css's tokens, so the default (no choice) looks the same", () => {
  const css = readFileSync("src/styles/app.css", "utf8");
  const block = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
  const keys = ["read", "queue", "current", "card", "edge", "track", "border", "ink", "text", "muted", "dim", "panel", "well", "raised"] as const;
  for (const [selector, palette] of [[":root", FREE_PALETTES.white], ['[data-theme="dark"]', FREE_PALETTES.dark]] as const) {
    const scope = block(selector);
    for (const key of keys) {
      const token = key === "read" ? "--np-read" : `--np-read-${key}`;
      expect(scope, `${selector} ${token}`).toMatch(new RegExp(`\\s${token}: ${palette[key]};`));
    }
  }
});

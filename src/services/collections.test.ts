import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { childrenMoveUp, iconKind, isEmoji, typedEmoji } from "./collections";

describe("collection icons (2.19.0)", () => {
  it("takes real emoji, flags and families whole, and refuses letters", () => {
    for (const emoji of ["📚", "🇷🇸", "👍🏽", "👩‍💻", "❤️", "☕"]) expect(isEmoji(emoji), emoji).toBe(true);
    for (const text of ["Р", "Работа", "é", "a", "📚a", "‍📚", "1️⃣", "📚📚📚📚📚", ""]) expect(isEmoji(text), text).toBe(false);
  });

  it("reads a stored icon as one of the set, an emoji or the dot", () => {
    expect(iconKind("rocket")).toEqual({ kind: "lucide", name: "rocket" });
    expect(iconKind("📚")).toEqual({ kind: "emoji", text: "📚" });
    // A letter saved before the check, or an unknown name: the dot.
    expect(iconKind("Р")).toBeNull();
    expect(iconKind("rocketship")).toBeNull();
    expect(iconKind(null)).toBeNull();
  });

  it("takes the newest emoji typed into the field, wherever the caret was", () => {
    expect(typedEmoji("📚🎉", "📚")).toBe("🎉");
    expect(typedEmoji("🎉📚", "📚")).toBe("🎉");
    expect(typedEmoji("📚", "📚")).toBe("📚");
    expect(typedEmoji("🇷🇸", null)).toBe("🇷🇸");
    expect(typedEmoji("👩‍💻x", null)).toBe("👩‍💻");
    // A word in a Cyrillic layout is no emoji.
    expect(typedEmoji("Р", null)).toBeNull();
    expect(typedEmoji("Работа", null)).toBeNull();
  });
});

describe("childrenMoveUp (2.19.0)", () => {
  const t = ((key: string, options: Record<string, string>) => `${key} ${JSON.stringify(options)}`) as unknown as TFunction;

  it("says nothing without children, one sentence for one, another for several", () => {
    expect(childrenMoveUp(t, "en", [])).toBeUndefined();
    expect(childrenMoveUp(t, "en", ["Rust"])).toBe('confirm.deleteCollectionChild {"name":"Rust"}');
    expect(childrenMoveUp(t, "en", ["Rust", "Web", "Tools"])).toBe('confirm.deleteCollectionChildren {"names":"Rust, Web, and Tools"}');
    expect(childrenMoveUp(t, "ru", ["Rust", "Web"])).toBe('confirm.deleteCollectionChildren {"names":"Rust и Web"}');
  });
});

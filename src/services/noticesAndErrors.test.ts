import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
import { Bookmark, Collection } from "../types";
import { bulkFailure, bulkNotice, readingNotice } from "./bulk";
import { suggestedName } from "./collections";
import { dropAttribute, dropHint, parseDrop, sameDrop } from "./drag";
import { CommandError, describeError, reasonOf, toCommandError } from "./errors";
import { starterLinks } from "./starter";
import { undoNotice } from "./undo";

const ru = i18n.getFixedT("ru");

afterEach(async () => {
  if (i18n.language !== "en") await i18n.changeLanguage("en");
});

describe("bulk action words (frame 27)", () => {
  it("count the bookmarks in Russian plural forms", () => {
    expect(bulkNotice(ru, { action: "move", collection_id: 1 }, 4, "Работа")).toBe("4 закладки перемещены в «Работа»");
    expect(bulkNotice(ru, { action: "trash" }, 12)).toBe("12 закладок в Корзине");
    expect(bulkNotice(ru, { action: "tag", name: "crypto" }, 1)).toBe("Тег «crypto» добавлен к 1 закладке");
    expect(bulkNotice(ru, { action: "favorite", favorite: false }, 3)).toBe("3 закладки убраны из Избранного");
    expect(bulkNotice(ru, { action: "new_collection", name: "trezor.io" }, 5)).toBe("5 закладок перемещено в «trezor.io»");
  });
  it("say that nothing changed and why, speaking the reason in the sentence's language not the system's", () => {
    expect(i18n.language).toBe("en");
    const busy = { code: "database_busy", message: "database is locked" };
    expect(bulkFailure(ru, { action: "move", collection_id: 1 }, 4, busy, "Работа")).toBe(
      "Не удалось переместить 4 закладки в «Работа»: библиотека занята. Ничего не изменено.",
    );
    const taken = { code: "conflict", message: "UNIQUE constraint failed: collections.name" };
    expect(bulkFailure(ru, { action: "new_collection", name: "Работа" }, 4, taken)).toBe(
      "Не удалось создать коллекцию «Работа»: такое название уже есть. Ничего не изменено.",
    );
  });
  it("an undo of many counts instead of naming one", () => {
    const b = { title: "Один" } as Bookmark;
    expect(undoNotice(ru, { outcome: "undone", action: "trash", bookmarks: [b, b, b] }).text).toBe("Возвращены из Корзины 3 закладки");
    expect(undoNotice(ru, { outcome: "undone", action: "move", bookmarks: [b, b] }).text).toBe("Отменено для 2 закладок");
    expect(undoNotice(ru, { outcome: "undone", action: "move", bookmarks: [b] }).text).toBe("Отменено: «Один»");
  });
});

describe("finished (the phone's reader): its own words", () => {
  it("names the bookmark, counts many, says what an undo brought back", () => {
    const en = i18n.getFixedT("en");
    expect(readingNotice(en, { action: "finish" }, { title: "Local-first software", url: "https://inkandswitch.com" })).toBe("Finished · Local-first software");
    expect(bulkNotice(ru, { action: "finish" }, 3)).toBe("3 закладки отмечены дочитанными");
    const b = { title: "Один" } as Bookmark;
    expect(undoNotice(en, { outcome: "undone", action: "finished", bookmarks: [b] }).text).toBe("Back in Reading: “Один”");
  });
});

describe("the name a new collection from the selection offers", () => {
  const mark = (domain: string, tags: string[] = []) => ({ domain, tags });
  it("is the site most of them share", () => {
    expect(suggestedName([mark("trezor.io"), mark("trezor.io"), mark("ledger.com")])).toBe("trezor.io");
  });
  it("else a tag every one has, else nothing", () => {
    expect(suggestedName([mark("a.com", ["crypto", "x"]), mark("b.com", ["crypto"])])).toBe("crypto");
    expect(suggestedName([mark("a.com", ["x"]), mark("b.com", ["y"])])).toBeNull();
    expect(suggestedName([])).toBeNull();
  });
});

describe("drop targets of the sidebar (NP-030)", () => {
  const collections = [{ id: 3, name: "Разработка" }] as Collection[];

  it("go to an attribute and back, a tag with colons included", () => {
    for (const target of [{ kind: "collection", id: 3 }, { kind: "tag", name: "a:b" }, { kind: "trash" }, { kind: "new" }, { kind: "favorites" }, { kind: "reading" }, { kind: "bundle" }] as const)
      expect(parseDrop(dropAttribute(target))).toEqual(target);
    expect(parseDrop("collection:x")).toBeNull();
    expect(parseDrop("tag:")).toBeNull();
    expect(parseDrop(undefined)).toBeNull();
    expect(sameDrop({ kind: "tag", name: "x" }, { kind: "tag", name: "x" })).toBe(true);
    expect(sameDrop({ kind: "tag", name: "x" }, null)).toBe(false);
  });
  it("the hint under the stack says what the drop will do (frame 27)", () => {
    expect(dropHint(ru, { kind: "collection", id: 3 }, 3, collections)).toBe("Переместить 3 в «Разработка»");
    expect(dropHint(ru, { kind: "tag", name: "crypto" }, 3, collections)).toBe("Добавить тег «crypto» к 3");
    expect(dropHint(ru, { kind: "trash" }, 3, collections)).toBe("3 в Корзину");
    expect(dropHint(ru, { kind: "new" }, 3, collections)).toBe("Новая коллекция из 3");
    expect(dropHint(ru, { kind: "favorites" }, 3, collections)).toBe("3 в Избранное");
    expect(dropHint(ru, { kind: "reading" }, 3, collections)).toBe("3 в «Почитать»");
    expect(dropHint(ru, { kind: "bundle" }, 3, collections)).toBe("Добавить 3 закладки в набор");
    expect(dropHint(ru, null, 3, collections)).toBe("Бросьте на коллекцию, тег, Избранное, «Почитать» или Корзину");
  });
});

describe("command errors", () => {
  it("keeps the code, message and detail sent by Rust", () => {
    const error = toCommandError({ code: "not_found", message: "No such row", detail: "not_in_trash" });
    expect(error).toBeInstanceOf(CommandError);
    expect([error.code, error.detail, String(error)]).toEqual(["not_found", "not_in_trash", "No such row"]);
  });
  it("treats text from Tauri and plain errors as internal", () => {
    expect(toCommandError("state not managed").code).toBe("internal");
    const plain = toCommandError(new Error("Could not write the link"));
    expect([plain.code, String(plain)]).toEqual(["internal", "Could not write the link"]);
  });
  it("speaks the interface's language, never the app's English text alone (NP-085)", async () => {
    const empty = { code: "invalid_request", message: "Enter a collection name", detail: "empty_collection_name" };
    const conflict = { code: "conflict", message: "UNIQUE constraint failed: collections.name" };
    const full = { code: "disk_full", message: "database or disk is full" };
    const broken = { code: "internal", message: "The system cannot find the file." };
    await i18n.changeLanguage("en");
    expect(describeError(empty)).toBe("Enter a collection name.");
    expect(describeError(conflict)).toBe("That name is taken.");
    expect(describeError(full)).not.toContain("database or disk");
    expect(describeError(broken)).toBe("Something went wrong: The system cannot find the file");
    expect(reasonOf(empty)).toBe("the name is empty");
    await i18n.changeLanguage("ru");
    expect(describeError(empty)).toBe("Введите название коллекции.");
    expect(describeError(conflict)).toBe("Такое название уже есть.");
    expect(reasonOf(empty, i18n.getFixedT("ru"))).toBe("пустое название");
  });
  // English is enough: locales.test.ts keeps every other language's keys in step with it.
  it("has words for every detail and code", () => {
    const details = ["empty_tag", "empty_collection_name", "empty_title", "bookmark_gone", "not_in_trash", "invalid_url", "unsupported_url", "nothing_exported", "copy_gone", "library_opening", "empty_message", "message_too_long", "invalid_email", "no_connection", "service_failed", "too_many_messages", "proxy_failed", "no_connection_or_proxy", "no_connection_or_system_proxy", "fresh_sign_in", "review_account", "no_paid_time", "payments_not_stopped", "payment_pending", "deletion_unknown"];
    for (const key of [
      ...details.flatMap((d) => [`errors.detail.${d}`, `errors.reason.${d}`]),
      ...["not_found", "conflict", "invalid_request", "internal"].map((c) => `errors.code.${c}`),
      "errors.reason.invalid_request",
      "errors.reason.internal",
    ])
      expect(i18n.exists(key, { lng: "en", fallbackLng: [] }), key).toBe(true);
  });
});

describe("starter links (NP-117)", () => {
  it("are the koona.app pages in the order of the set: the front page, then each product", () => {
    const links = starterLinks(i18n.getFixedT("en"));
    expect(links.map((l) => l.url)).toEqual([
      "https://koona.app/",
      "https://koona.app/books/",
      "https://koona.app/pin/",
      "https://koona.app/lightcal/",
      "https://koona.app/notes/",
    ]);
    expect(links.map((l) => l.title)).toEqual(["Koona", "Koona Books", "Koona Pin", "Lightcal", "Ko Notes"]);
  });

  // English is enough: locales.test.ts keeps every other language's keys in step with it.
  it("have a title and a description", () => {
    for (const link of starterLinks(i18n.getFixedT("en"))) {
      expect(link.title, link.url).not.toMatch(/^starter\./);
      expect(link.description, link.url).not.toMatch(/^starter\./);
      expect(link.description.length).toBeGreaterThan(0);
    }
  });
});

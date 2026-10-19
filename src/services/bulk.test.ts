import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { bulkFailure, bulkNotice, readingNotice } from "./bulk";
import { suggestedName } from "./collections";
import { undoNotice } from "./undo";
import { Bookmark } from "../types";

const t = i18n.getFixedT("ru");

describe("bulk action words (frame 27)", () => {
  it("count the bookmarks in Russian plural forms", () => {
    expect(bulkNotice(t, { action: "move", collection_id: 1 }, 4, "Работа")).toBe("4 закладки перемещены в «Работа»");
    expect(bulkNotice(t, { action: "trash" }, 12)).toBe("12 закладок в корзине");
    expect(bulkNotice(t, { action: "tag", name: "crypto" }, 1)).toBe("Тег «crypto» добавлен к 1 закладке");
    expect(bulkNotice(t, { action: "favorite", favorite: false }, 3)).toBe("3 закладки убраны из избранного");
    expect(bulkNotice(t, { action: "new_collection", name: "trezor.io" }, 5)).toBe("5 закладок перемещено в «trezor.io»");
  });
  it("say that nothing changed and why", () => {
    const busy = { code: "database_busy", message: "database is locked" };
    expect(bulkFailure(t, { action: "move", collection_id: 1 }, 4, busy, "Работа")).toBe(
      "Не удалось переместить 4 закладки в «Работа»: библиотека занята. Ничего не изменено.",
    );
    const taken = { code: "conflict", message: "UNIQUE constraint failed: collections.name" };
    expect(bulkFailure(t, { action: "new_collection", name: "Работа" }, 4, taken)).toBe(
      "Не удалось создать коллекцию «Работа»: такое название уже есть. Ничего не изменено.",
    );
  });
  it("an undo of many counts instead of naming one", () => {
    const b = { title: "Один" } as Bookmark;
    expect(undoNotice(t, { outcome: "undone", action: "trash", bookmarks: [b, b, b] }).text).toBe("Возвращены из корзины 3 закладки");
    expect(undoNotice(t, { outcome: "undone", action: "move", bookmarks: [b, b] }).text).toBe("Отменено для 2 закладок");
    expect(undoNotice(t, { outcome: "undone", action: "move", bookmarks: [b] }).text).toBe("Отменено: «Один»");
  });
});

describe("finished (the phone's reader): its own words", () => {
  it("names the bookmark, counts many, says what an undo brought back", () => {
    const en = i18n.getFixedT("en");
    expect(readingNotice(en, { action: "finish" }, { title: "Local-first software", url: "https://inkandswitch.com" })).toBe("Finished · Local-first software");
    expect(bulkNotice(t, { action: "finish" }, 3)).toBe("3 закладки отмечены дочитанными");
    const b = { title: "Один" } as Bookmark;
    expect(undoNotice(en, { outcome: "undone", action: "finished", bookmarks: [b] }).text).toBe("Back in Reading: «Один»");
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

import { describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { CaptureStatus, Collection, LibraryCounts, SyncStatus } from "../types";
import { NOTICE_MS, noticeDuration, UNDO_MS } from "./notices";
import { inboxLine, notificationsOf, QUICK_INBOX } from "./notifications";
import { initialFilters, isNarrowed, noSection, sectionCount, sectionName } from "./sections";
import { newerSync } from "./syncOrder";
import { ASKED_MS, type Asked, settleAsked, toggleState } from "./toggle";

const t = i18n.getFixedT("en");

const makeCounts = (over: Partial<LibraryCounts> = {}): LibraryCounts => ({
  total: 10,
  favorites: 0,
  inbox: 0,
  inbox_newest: null,
  inbox_imported: 0,
  feed: 0,
  trash: 0,
  duplicates: 0,
  links: 0,
  reading: 0,
  reading_unread: 0,
  offline: 0,
  ...over,
});

describe("notices (frames 12, 20, 21, 29)", () => {
  it("a plain notice goes after 3 s, one with Undo or a long one after 8 s, an alert stays", () => {
    expect(noticeDuration({ text: "Saved", alert: false })).toBe(NOTICE_MS);
    expect(noticeDuration({ text: "Moved", alert: false, undo: () => {} })).toBe(UNDO_MS);
    expect(noticeDuration({ text: "Exported", alert: false, long: true })).toBe(UNDO_MS);
    expect(noticeDuration({ text: "Failed", alert: true, retry: () => {} })).toBeNull();
  });
});

describe("the notification centre (2026-10-16)", () => {
  const previews = { run: null, running: false, resultShown: false, handedOff: null, stop: vi.fn(), dismiss: vi.fn(), dismissHandedOff: vi.fn() };
  const on = () => ({
    browserDetails: vi.fn(),
    sortInbox: vi.fn(),
    hideInbox: vi.fn(),
    importOffer: vi.fn(),
    hideImportOffer: vi.fn(),
    openFeeds: vi.fn(),
    unfollow: vi.fn(),
    openLinks: vi.fn(),
  });
  const input = (over: Partial<Parameters<typeof notificationsOf>[0]> = {}) => ({
    capture: null,
    counts: makeCounts(),
    inboxHidden: false,
    inboxThumbs: [],
    importOffer: false,
    feeds: [],
    previews,
    ...over,
  });

  it("says where the inbox came from and whether it is quick to sort", () => {
    expect(inboxLine(makeCounts({ inbox: 4, inbox_imported: 4 }), t)).toBe(`${t("notifications.inboxFromImport")} ${t("notifications.inboxText")}`);
    expect(inboxLine(makeCounts({ inbox: 1 }), t)).toBe(t("notifications.inboxTextOne"));
    expect(inboxLine(makeCounts({ inbox: QUICK_INBOX + 1, inbox_imported: 2 }), t)).toBe(
      `${t("notifications.inboxImported", { count: 2 })} ${t("notifications.inboxMany")}`,
    );
  });

  it("nothing to say: no notifications", () => {
    expect(notificationsOf(input(), on(), t)).toEqual([]);
  });

  it("a failing browser, the inbox and the import offer, in that order, each with its action", () => {
    const handlers = on();
    const failing = { state: "failing", problem: "channel" } as CaptureStatus;
    const list = notificationsOf(input({ capture: failing, counts: makeCounts({ inbox: 2, inbox_newest: "2026-10-18T10:00:00Z" }), importOffer: true }), handlers, t);
    expect(list.map((n) => n.key)).toEqual(["capture:channel", "inbox:2026-10-18T10:00:00Z", "importOffer"]);
    list[1].action!.run();
    list[1].dismiss!.run();
    list[2].action!.run();
    expect([handlers.sortInbox, handlers.hideInbox, handlers.importOffer].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("a hidden inbox stays hidden", () => {
    expect(notificationsOf(input({ counts: makeCounts({ inbox: 2 }), inboxHidden: true }), on(), t)).toEqual([]);
  });
});

describe("sections (NP-072a)", () => {
  const counts = makeCounts({ total: 40, favorites: 5, inbox: 3, trash: 2, reading: 7, reading_unread: 4, offline: 1 });
  const design = { id: 4, name: "Design", count: 9 } as Collection;

  it("names the section and counts it, a collection by its own count", () => {
    const table = [
      [{}, "Bookmarks", 40],
      [{ onlyInbox: true }, "Inbox", 3],
      [{ onlyFavorites: true }, "Favorites", 5],
      [{ onlyReading: true }, "Reading", 7],
      [{ onlyOffline: true }, "Offline", 1],
      [{ onlyTrash: true }, "Trash", 2],
    ] as const;
    for (const [section, name, count] of table) {
      const filters = { ...initialFilters, ...section };
      expect([sectionName(filters, undefined, t), sectionCount(filters, counts, undefined)]).toEqual([name, count]);
    }
    const inDesign = { ...initialFilters, collectionId: 4 };
    expect([sectionName(inDesign, design, t), sectionCount(inDesign, counts, design)]).toEqual(["Design", 9]);
  });

  it("a search, a tag or a site narrows the section; spaces alone do not", () => {
    expect(isNarrowed(initialFilters)).toBe(false);
    expect(isNarrowed({ ...initialFilters, search: "   " })).toBe(false);
    expect(isNarrowed({ ...initialFilters, search: "pin" })).toBe(true);
    expect(isNarrowed({ ...initialFilters, tag: "design" })).toBe(true);
    expect(isNarrowed({ ...initialFilters, domain: "koona.app" })).toBe(true);
  });

  it("no section turns every section off", () => {
    expect(Object.values(noSection).every((value) => value === null || value === false)).toBe(true);
  });
});

describe("sync status order", () => {
  const status = (seq: number, enabled = true) => ({ seq, enabled }) as SyncStatus;

  it("keeps the newer status when an older answer comes late", () => {
    const event = status(5);
    expect(newerSync(null, event)).toBe(event);
    expect(newerSync(event, status(4, false))).toBe(event);
    const newer = status(6, false);
    expect(newerSync(event, newer)).toBe(newer);
  });

  it("takes the same status again", () => {
    const again = status(5, false);
    expect(newerSync(status(5), again)).toBe(again);
  });
});

describe("toggleState", () => {
  it("takes the library's copy when nothing was asked", () => {
    expect(toggleState(false, undefined, 0)).toBe(false);
    expect(toggleState(true, undefined, 0)).toBe(true);
  });

  it("takes a fresh ask the copy has not shown yet: a second tap undoes the first", () => {
    expect(toggleState(false, { on: true, at: 1000 }, 1500)).toBe(true);
    expect(toggleState(true, { on: false, at: 1000 }, 1500)).toBe(false);
  });

  it("takes the copy once the ask is old", () => {
    expect(toggleState(false, { on: true, at: 1000 }, 1000 + ASKED_MS)).toBe(false);
  });
});

describe("settleAsked", () => {
  const shownOf = (shown: Record<string, boolean>) => (key: string) => shown[key];

  it("drops an ask the copy shows: an Undo after it is the copy's to show", () => {
    const asked = new Map<string, Asked>([["reading:1", { on: true, at: 1000 }]]);
    settleAsked(asked, shownOf({ "reading:1": true }), 1500);
    expect(asked.size).toBe(0);
    // The Undo came in: the copy says not in Reading, and nothing outranks it.
    expect(toggleState(false, asked.get("reading:1"), 1600)).toBe(false);
  });

  it("keeps an ask the copy does not show yet, whatever else changed (a progress write)", () => {
    const asked = new Map<string, Asked>([["reading:1", { on: true, at: 1000 }]]);
    settleAsked(asked, shownOf({ "reading:1": false }), 1500);
    expect(asked.get("reading:1")).toEqual({ on: true, at: 1000 });
  });

  it("keeps the last of two quick asks until the copy shows it", () => {
    const asked = new Map<string, Asked>([["reading:1", { on: false, at: 1100 }]]);
    // The first ask (on) landed; the second (off) has not yet.
    settleAsked(asked, shownOf({ "reading:1": true }), 1500);
    expect(asked.get("reading:1")?.on).toBe(false);
  });

  it("drops old asks and those of bookmarks no longer loaded", () => {
    const asked = new Map<string, Asked>([
      ["reading:1", { on: true, at: 0 }],
      ["reading:2", { on: true, at: 2000 }],
    ]);
    settleAsked(asked, shownOf({ "reading:1": false }), ASKED_MS + 1);
    expect(asked.size).toBe(0);
  });
});

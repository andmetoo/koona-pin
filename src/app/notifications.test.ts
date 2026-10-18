import { describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { CaptureStatus, LibraryCounts } from "../types";
import { inboxLine, notificationsOf, QUICK_INBOX } from "./notifications";

const t = i18n.getFixedT("en");
const counts = (over: Partial<LibraryCounts> = {}): LibraryCounts => ({
  total: 10,
  favorites: 0,
  inbox: 0,
  inbox_newest: null,
  inbox_imported: 0,
  trash: 0,
  duplicates: 0,
  links: 0,
  reading: 0,
  reading_unread: 0,
  offline: 0,
  ...over,
});
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
  counts: counts(),
  inboxHidden: false,
  inboxThumbs: [],
  importOffer: false,
  feeds: [],
  previews,
  ...over,
});

describe("the notification centre (2026-10-16)", () => {
  it("says where the inbox came from and whether it is quick to sort", () => {
    expect(inboxLine(counts({ inbox: 4, inbox_imported: 4 }), t)).toBe(`${t("notifications.inboxFromImport")} ${t("notifications.inboxText")}`);
    expect(inboxLine(counts({ inbox: 1 }), t)).toBe(t("notifications.inboxTextOne"));
    expect(inboxLine(counts({ inbox: QUICK_INBOX + 1, inbox_imported: 2 }), t)).toBe(
      `${t("notifications.inboxImported", { count: 2 })} ${t("notifications.inboxMany")}`,
    );
  });

  it("nothing to say: no notifications", () => {
    expect(notificationsOf(input(), on(), t)).toEqual([]);
  });

  it("a failing browser, the inbox and the import offer, in that order, each with its action", () => {
    const handlers = on();
    const failing = { state: "failing", problem: "channel" } as CaptureStatus;
    const list = notificationsOf(input({ capture: failing, counts: counts({ inbox: 2, inbox_newest: "2026-10-18T10:00:00Z" }), importOffer: true }), handlers, t);
    expect(list.map((n) => n.key)).toEqual(["capture:channel", "inbox:2026-10-18T10:00:00Z", "importOffer"]);
    list[1].action!.run();
    list[1].dismiss!.run();
    list[2].action!.run();
    expect([handlers.sortInbox, handlers.hideInbox, handlers.importOffer].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("a hidden inbox stays hidden", () => {
    expect(notificationsOf(input({ counts: counts({ inbox: 2 }), inboxHidden: true }), on(), t)).toEqual([]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { goBack, onBack } from "../../../platform/back";
import { atRoot, back, detailOf, forPhone, initialStack, leave, paneOf, push, replaceTop, select, selectTab, topRoute } from "./stack";
import { enterTab } from "./usePhoneStack";

describe("the phone's stack", () => {
  it("starts on All bookmarks at its root", () => {
    const stack = initialStack();
    expect(stack).toEqual({ tab: "all", routes: [] });
    expect(topRoute(stack)).toBeNull();
    expect(atRoot(stack)).toBe(true);
  });

  it("pushes routes over a tab and pops them one by one, then says there is nothing to close", () => {
    let stack = push(initialStack("reading"), { name: "reader", bookmarkId: 7 });
    stack = push(stack, { name: "settings" });
    expect(topRoute(stack)).toEqual({ name: "settings" });
    stack = back(stack)!;
    expect(topRoute(stack)).toEqual({ name: "reader", bookmarkId: 7 });
    stack = back(stack)!;
    expect(stack).toEqual({ tab: "reading", routes: [] });
    expect(back(stack)).toBeNull();
  });

  it("replaces the top route, or pushes one at the root", () => {
    const reader = push(initialStack(), { name: "reader", bookmarkId: 1 });
    expect(replaceTop(reader, { name: "reader", bookmarkId: 2 }).routes).toEqual([{ name: "reader", bookmarkId: 2 }]);
    expect(replaceTop(initialStack(), { name: "search" }).routes).toEqual([{ name: "search" }]);
  });

  it("starts another tab at its root; the open tab goes back to its root", () => {
    const deep = push(initialStack("all"), { name: "search" });
    expect(selectTab(deep, "feeds")).toEqual({ tab: "feeds", routes: [] });
    expect(selectTab(deep, "all")).toEqual({ tab: "all", routes: [] });
    const root = initialStack("inbox");
    expect(selectTab(root, "inbox")).toBe(root);
  });
});

describe("a tab shows its section of the app", () => {
  const fakeApp = () => ({ navigate: vi.fn(), openFeeds: vi.fn(), feedPlace: { feed: "f1", item: null } });

  it("Inbox, Reading and All bookmarks are sections; Feeds opens on the feed last open", () => {
    const app = fakeApp();
    enterTab(app, "inbox");
    enterTab(app, "reading");
    enterTab(app, "all");
    enterTab(app, "feeds");
    expect(app.navigate.mock.calls).toEqual([[{ onlyInbox: true }], [{ onlyReading: true }], []]);
    expect(app.openFeeds.mock.calls).toEqual([["f1"]]);
  });
});

describe("system Back with the stack at the bottom", () => {
  it("closes a sheet first, then pops a route, then says false at the root", () => {
    let stack = push(initialStack(), { name: "reader", bookmarkId: 3 });
    const closed: string[] = [];
    // The stack's handler at place 0, as usePhoneStack registers it.
    const offStack = onBack(() => {
      const next = back(stack);
      if (!next) return false;
      stack = next;
      closed.push("route");
      return true;
    }, 0);
    // A sheet opened later takes a newer place.
    const offSheet = onBack(() => (closed.push("sheet"), true));
    expect(goBack()).toBe(true);
    expect(closed).toEqual(["sheet"]);
    offSheet();
    expect(goBack()).toBe(true);
    expect(closed).toEqual(["sheet", "route"]);
    expect(goBack()).toBe(false);
    offStack();
  });
});

describe("the Fold's two panes", () => {
  const bookmark = (id: number) => ({ name: "bookmark" as const, bookmarkId: id });
  const reader = (id: number) => ({ name: "reader" as const, bookmarkId: id });

  it("puts Search in the list pane and the rest in the detail pane", () => {
    expect(paneOf({ name: "search" })).toBe("list");
    for (const route of [bookmark(1), reader(1), { name: "post" as const, feedUid: null, itemId: 2 }, { name: "settings" as const }]) expect(paneOf(route)).toBe("detail");
  });

  it("selects a row into the detail pane, replacing what showed there, above the list", () => {
    let stack = select(initialStack(), bookmark(1));
    expect(stack.routes).toEqual([bookmark(1)]);
    stack = push(stack, reader(1));
    stack = select(stack, bookmark(2));
    expect(stack.routes).toEqual([bookmark(2)]);
    // The same row again changes nothing.
    expect(select(stack, bookmark(2))).toBe(stack);
    // Search over the selection: a result is selected above Search, the older one stays under it.
    stack = select(push(stack, { name: "search" }), bookmark(3));
    expect(stack.routes).toEqual([bookmark(2), { name: "search" }, bookmark(3)]);
    expect(detailOf(stack)).toEqual(bookmark(3));
    expect(detailOf(back(stack)!)).toEqual(bookmark(2));
    expect(detailOf(initialStack())).toBeNull();
  });

  it("Back clears the selection first, then says false at the tab's root", () => {
    const stack = select(initialStack("feeds"), { name: "post", feedUid: "f", itemId: 4 });
    expect(back(stack)).toEqual(initialStack("feeds"));
    expect(back(back(stack)!)).toBeNull();
  });

  it("Cancel leaves Search with the result chosen from it", () => {
    const stack = select(push(select(initialStack(), bookmark(1)), { name: "search" }), bookmark(2));
    expect(leave(stack, "search").routes).toEqual([bookmark(1)]);
    expect(leave(initialStack(), "search")).toEqual(initialStack());
  });

  it("folded, a bookmark's detail becomes its reader, once", () => {
    const plain = push(initialStack(), reader(1));
    expect(forPhone(plain)).toBe(plain);
    expect(forPhone(select(initialStack(), bookmark(1))).routes).toEqual([reader(1)]);
    expect(forPhone(push(select(initialStack(), bookmark(1)), reader(1))).routes).toEqual([reader(1)]);
    expect(forPhone({ tab: "all", routes: [bookmark(1), { name: "search" }, bookmark(2)] }).routes).toEqual([reader(1), { name: "search" }, reader(2)]);
  });
});

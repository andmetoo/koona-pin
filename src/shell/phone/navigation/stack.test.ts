import { describe, expect, it, vi } from "vitest";
import { goBack, onBack } from "../../../platform/back";
import { atRoot, back, initialStack, push, replaceTop, selectTab, topRoute } from "./stack";
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

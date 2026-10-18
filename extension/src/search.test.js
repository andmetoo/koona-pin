// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as FileUrl, fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The search page against a fake app: every answer waits until the test gives it.
const answers = [];
vi.mock("./native.js", () => ({
  talk: vi.fn(
    (message) =>
      new Promise((resolve) => {
        answers.push({ message, resolve });
      }),
  ),
}));

const tabs = { create: vi.fn(async () => {}), update: vi.fn(async () => {}) };
const counts = { all: 3, inbox: 1, favorites: 0, collections: [] };
const item = (id) => ({ id, url: `https://example.com/${id}`, title: id, domain: "example.com", created_at: "2026-10-01T00:00:00Z" });
const results = (...ids) => ({ ok: true, items: ids.map(item), counts, more: false });
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const enter = () => document.getElementById("query").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

beforeAll(async () => {
  globalThis.chrome = { tabs, runtime: {} };
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.close = vi.fn();
  Element.prototype.scrollIntoView = () => {};
  const html = readFileSync(fileURLToPath(new FileUrl("./search.html", import.meta.url)), "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
  await import("./search.js");
  // The first answer: the recent links.
  answers.shift().resolve(results("old"));
  await wait();
});

describe("search page", () => {
  beforeEach(() => tabs.create.mockClear());
  it("Enter waits for the answer to the query already sent, not the list before it", async () => {
    const query = document.getElementById("query");
    query.value = "new";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(150);
    expect(answers.map((a) => a.message.query)).toEqual(["new"]);
    enter();
    await wait();
    expect(tabs.create).not.toHaveBeenCalled();
    answers.shift().resolve(results("fresh"));
    await wait();
    expect(tabs.create).toHaveBeenCalledTimes(1);
    expect(tabs.create).toHaveBeenLastCalledWith({ url: "https://example.com/fresh" });
  });

  it("Enter right after a filter chip waits for that filter's answer", async () => {
    const inbox = [...document.querySelectorAll("#filters button")].find((chip) => chip.textContent.startsWith("searchInbox"));
    inbox.click();
    expect(answers.at(-1).message.filter).toEqual({ kind: "inbox" });
    enter();
    await wait();
    expect(tabs.create).not.toHaveBeenCalled();
    answers.shift().resolve(results("in-inbox"));
    await wait();
    expect(tabs.create).toHaveBeenCalledTimes(1);
    expect(tabs.create).toHaveBeenLastCalledWith({ url: "https://example.com/in-inbox" });
  });
});

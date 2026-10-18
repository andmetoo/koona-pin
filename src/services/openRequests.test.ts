import { describe, expect, it } from "vitest";
import { createOpenRequests, draggedFile, fileKindOf, refusedByName } from "./openRequests";

/** What a drag carries, as much as a DataTransfer shows of it. */
const drag = (init: { types: string[]; files?: File[]; items?: { kind: string; type: string }[] }) =>
  ({ types: init.types, files: init.files ?? [], items: init.items ?? [] }) as unknown as DataTransfer;

describe("files dropped on the window", () => {
  it("knows a list, OPML and bookmarks by the name", () => {
    expect(fileKindOf("rust-blogs.kpin")).toBe("kpin");
    expect(fileKindOf("Rust Blogs.KPIN ")).toBe("kpin");
    expect(fileKindOf("feeds.opml")).toBe("opml");
    expect(fileKindOf("feedly.opml")).toBe("opml");
    expect(fileKindOf("feed.xml")).toBeNull();
    expect(fileKindOf("bookmarks_10_18_26.html")).toBe("html");
    expect(fileKindOf("Bookmarks.HTM")).toBe("html");
    expect(fileKindOf("notes.txt")).toBeNull();
    expect(fileKindOf("kpin")).toBeNull();
    expect(fileKindOf("archive.kpin.zip")).toBeNull();
  });

  it("tells the drop zone what a drag carries before the drop", () => {
    // A link is not a file: the link variant stays as it was.
    expect(draggedFile(drag({ types: ["text/uri-list", "text/plain"] }))).toBeNull();
    expect(draggedFile(null)).toBeNull();
    // Real use: a drag from the system shows no file before the drop; the media type may say the
    // kind, or nothing does and the zone shows its hero.
    expect(draggedFile(drag({ types: ["Files"], items: [{ kind: "file", type: "application/vnd.koona.list+json" }] }))).toEqual({ name: null, kind: "kpin" });
    expect(draggedFile(drag({ types: ["Files"], items: [{ kind: "file", type: "text/html" }] }))).toEqual({ name: null, kind: "bookmarks" });
    expect(draggedFile(drag({ types: ["Files"], items: [{ kind: "file", type: "text/x-opml" }] }))).toEqual({ name: null, kind: "opml" });
    expect(draggedFile(drag({ types: ["Files"], items: [{ kind: "file", type: "" }] }))).toEqual({ name: null, kind: null });
    expect(draggedFile(drag({ types: ["Files"] }))).toEqual({ name: null, kind: null });
    // Progressive enhancement: the name, only where a webview shows it before the drop (a
    // DataTransfer made by a script).
    expect(draggedFile(drag({ types: ["Files"], files: [new File(["{}"], "rust-blogs.kpin")] }))).toEqual({ name: "rust-blogs.kpin", kind: "kpin" });
    expect(draggedFile(drag({ types: ["Files"], files: [new File(["x"], "notes.txt", { type: "text/plain" })] }))).toEqual({ name: "notes.txt", kind: null });
    expect(draggedFile(drag({ types: ["Files"], files: [new File(["x"], "Bookmarks.HTM")] }))).toEqual({ name: "Bookmarks.HTM", kind: "bookmarks" });
    expect(draggedFile(drag({ types: ["Files"], files: [new File(["{}"], "koona-pin-2026-10-18.json")] }))).toEqual({ name: "koona-pin-2026-10-18.json", kind: null });
  });
});

describe("the drop zone before the drop", () => {
  it("refuses by name only what cannot hide one of ours", () => {
    expect(refusedByName({ name: "report.pdf", kind: null })).toBe(true);
    expect(refusedByName({ name: "photo.JPG", kind: null })).toBe(true);
    // OPML is exported as .xml or .txt too; a name without an extension says nothing.
    expect(refusedByName({ name: "notes.txt", kind: null })).toBe(false);
    expect(refusedByName({ name: "subscriptions.xml", kind: null })).toBe(false);
    expect(refusedByName({ name: "bookmarks", kind: null })).toBe(false);
    expect(refusedByName({ name: "koona-pin-2026-10-18.json", kind: null })).toBe(false);
    expect(refusedByName({ name: null, kind: null })).toBe(false);
    expect(refusedByName({ name: "list.kpin", kind: "kpin" })).toBe(false);
  });
});

describe("the open requests", () => {
  it("keeps one list at a time and refuses the rest, busy or not, until it is done", () => {
    const queue = createOpenRequests();
    const seen: unknown[] = [];
    const stop = queue.subscribe((request) => seen.push(request));
    const first = { kind: "kpin-url", url: "https://example.org/a.kpin" } as const;
    expect(queue.push(first)).toBe(true);
    const firstId = queue.id();
    expect(queue.push({ kind: "kpin-path", path: "/tmp/b.kpin" })).toBe(false);
    queue.setBusy(true);
    expect(queue.push({ kind: "kpin", name: "c.kpin", text: "{}" })).toBe(false);
    expect([queue.current(), queue.id()]).toEqual([first, firstId]);
    queue.done();
    expect([queue.current(), queue.busy()]).toEqual([null, false]);
    queue.done();
    const second = { kind: "kpin", name: "rust-blogs.kpin", text: "{}" } as const;
    expect(queue.push(second)).toBe(true);
    expect(queue.id()).toBe(firstId + 1);
    stop();
    queue.done();
    expect(seen).toEqual([first, first, null, second]);
  });
});

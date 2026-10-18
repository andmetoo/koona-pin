import { describe, expect, it } from "vitest";
import { createOpenRequests, draggedFile, droppedRequest, fileKindOf, MAX_FILE } from "./openRequests";

/** What a drag carries, as much as a DataTransfer shows of it. */
const drag = (init: { types: string[]; files?: File[]; items?: { kind: string; type: string }[] }) =>
  ({ types: init.types, files: init.files ?? [], items: init.items ?? [] }) as unknown as DataTransfer;

describe("files dropped on the window", () => {
  it("knows a list, OPML and bookmarks by the name", () => {
    expect(fileKindOf("rust-blogs.kpin")).toBe("kpin");
    expect(fileKindOf("Rust Blogs.KPIN ")).toBe("kpin");
    expect(fileKindOf("feeds.opml")).toBe("opml");
    expect(fileKindOf("feedly.xml")).toBe("opml");
    expect(fileKindOf("bookmarks_10_18_26.html")).toBe("html");
    expect(fileKindOf("Bookmarks.HTM")).toBe("html");
    expect(fileKindOf("notes.txt")).toBeNull();
    expect(fileKindOf("kpin")).toBeNull();
    expect(fileKindOf("archive.kpin.zip")).toBeNull();
  });

  it("tells the veil what a drag carries before the drop", () => {
    // A link is not a file: the link veil stays as it was.
    expect(draggedFile(drag({ types: ["text/uri-list", "text/plain"] }))).toBeNull();
    expect(draggedFile(null)).toBeNull();
    // Where the name is shown (Chromium, a test's DataTransfer).
    expect(draggedFile(drag({ types: ["Files"], files: [new File(["{}"], "rust-blogs.kpin")] }))).toEqual({ name: "rust-blogs.kpin", kind: "kpin" });
    expect(draggedFile(drag({ types: ["Files"], files: [new File(["x"], "notes.txt", { type: "text/plain" })] }))).toEqual({ name: "notes.txt", kind: null });
    // WebKit hides the name until the drop; the media type may say the kind.
    expect(draggedFile(drag({ types: ["Files"], items: [{ kind: "file", type: "application/vnd.koona.list+json" }] }))).toEqual({ name: null, kind: "kpin" });
    expect(draggedFile(drag({ types: ["Files"], items: [{ kind: "file", type: "text/html" }] }))).toEqual({ name: null, kind: "html" });
    expect(draggedFile(drag({ types: ["Files"], items: [{ kind: "file", type: "text/x-opml" }] }))).toEqual({ name: null, kind: "opml" });
    expect(draggedFile(drag({ types: ["Files"], items: [{ kind: "file", type: "" }] }))).toEqual({ name: null, kind: null });
    expect(draggedFile(drag({ types: ["Files"] }))).toEqual({ name: null, kind: null });
  });

  it("reads the first dropped file into a request, or says why not", async () => {
    expect(await droppedRequest([new File(['{"format":"koona"}'], "rust-blogs.kpin")])).toEqual({
      kind: "kpin",
      name: "rust-blogs.kpin",
      text: '{"format":"koona"}',
    });
    expect(await droppedRequest([new File(["<opml/>"], "feeds.opml"), new File(["x"], "notes.txt")])).toEqual({ kind: "opml", name: "feeds.opml", text: "<opml/>" });
    expect(await droppedRequest([new File(["<DL>"], "bookmarks.html")])).toMatchObject({ kind: "html" });
    expect(await droppedRequest([new File(["x"], "notes.txt")])).toBe("unsupported");
    expect(await droppedRequest([new File([new Uint8Array(MAX_FILE + 1)], "huge.kpin")])).toBe("tooBig");
    expect(await droppedRequest([new File([new Uint8Array(MAX_FILE)], "just-fits.kpin")])).toMatchObject({ kind: "kpin" });
    expect(await droppedRequest([])).toBeNull();
    expect(await droppedRequest(null)).toBeNull();
  });
});

describe("the open requests", () => {
  it("keeps one at a time and drops the rest until it is done", () => {
    const queue = createOpenRequests();
    const seen: unknown[] = [];
    const stop = queue.subscribe((request) => seen.push(request));
    const first = { kind: "kpin-url", url: "https://example.org/a.kpin" } as const;
    expect(queue.push(first)).toBe(true);
    expect(queue.push({ kind: "kpin-path", path: "/tmp/b.kpin" })).toBe(false);
    expect(queue.push({ kind: "opml", name: "feeds.opml", text: "<opml/>" })).toBe(false);
    expect(queue.current()).toEqual(first);
    queue.done();
    expect(queue.current()).toBeNull();
    queue.done();
    const second = { kind: "html", name: "bookmarks.html", text: "<DL>" } as const;
    expect(queue.push(second)).toBe(true);
    stop();
    queue.done();
    expect(seen).toEqual([first, null, second]);
  });
});

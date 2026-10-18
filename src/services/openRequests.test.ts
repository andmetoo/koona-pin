import { describe, expect, it } from "vitest";
import { createOpenRequests, draggedFile, fileKindOf, MAX_FILE, readDropped } from "./openRequests";

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
    // Real use: a drag from the system shows no file before the drop; the media type may say the
    // kind, or nothing does and the veil says the generic line.
    expect(draggedFile(drag({ types: ["Files"], items: [{ kind: "file", type: "application/vnd.koona.list+json" }] }))).toEqual({ name: null, kind: "kpin" });
    expect(draggedFile(drag({ types: ["Files"], items: [{ kind: "file", type: "text/html" }] }))).toEqual({ name: null, kind: "html" });
    expect(draggedFile(drag({ types: ["Files"], items: [{ kind: "file", type: "text/x-opml" }] }))).toEqual({ name: null, kind: "opml" });
    expect(draggedFile(drag({ types: ["Files"], items: [{ kind: "file", type: "" }] }))).toEqual({ name: null, kind: null });
    expect(draggedFile(drag({ types: ["Files"] }))).toEqual({ name: null, kind: null });
    // Progressive enhancement: the name, only where a webview shows it before the drop (a
    // DataTransfer made by a script).
    expect(draggedFile(drag({ types: ["Files"], files: [new File(["{}"], "rust-blogs.kpin")] }))).toEqual({ name: "rust-blogs.kpin", kind: "kpin" });
    expect(draggedFile(drag({ types: ["Files"], files: [new File(["x"], "notes.txt", { type: "text/plain" })] }))).toEqual({ name: "notes.txt", kind: null });
  });

  it("reads the first dropped file, says whether more came, or says why not", async () => {
    expect(await readDropped([new File(['{"format":"koona"}'], "rust-blogs.kpin")])).toEqual({
      file: { kind: "kpin", name: "rust-blogs.kpin", text: '{"format":"koona"}' },
      more: false,
    });
    expect(await readDropped([new File(["<opml/>"], "feeds.opml"), new File(["x"], "notes.txt")])).toEqual({
      file: { kind: "opml", name: "feeds.opml", text: "<opml/>" },
      more: true,
    });
    expect(await readDropped([new File(["<DL>"], "bookmarks.html")])).toMatchObject({ file: { kind: "html" } });
    expect(await readDropped([new File(["x"], "notes.txt"), new File(["{}"], "list.kpin")])).toBe("unsupported");
    expect(await readDropped([new File([new Uint8Array(MAX_FILE + 1)], "huge.kpin")])).toBe("tooBig");
    expect(await readDropped([new File([new Uint8Array(MAX_FILE)], "just-fits.kpin")])).toMatchObject({ file: { kind: "kpin" } });
    expect(await readDropped([])).toBeNull();
    expect(await readDropped(null)).toBeNull();
  });
});

describe("the open requests", () => {
  it("keeps one list at a time: a new one replaces an idle one, a busy one refuses it", () => {
    const queue = createOpenRequests();
    const seen: unknown[] = [];
    const stop = queue.subscribe((request) => seen.push(request));
    const first = { kind: "kpin-url", url: "https://example.org/a.kpin" } as const;
    expect(queue.push(first)).toBe(true);
    const firstId = queue.id();
    const replacing = { kind: "kpin-path", path: "/tmp/b.kpin" } as const;
    expect(queue.push(replacing)).toBe(true);
    expect(queue.id()).toBe(firstId + 1);
    queue.setBusy(true);
    expect(queue.push({ kind: "kpin", name: "c.kpin", text: "{}" })).toBe(false);
    expect(queue.current()).toEqual(replacing);
    queue.done();
    expect([queue.current(), queue.busy()]).toEqual([null, false]);
    queue.done();
    const second = { kind: "kpin", name: "rust-blogs.kpin", text: "{}" } as const;
    expect(queue.push(second)).toBe(true);
    stop();
    queue.done();
    expect(seen).toEqual([first, replacing, replacing, null, second]);
  });
});

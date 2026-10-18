import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPS, HEAD, LARGEST, formatScanner, known, readDropped, readFile, sniff, sniffHead, topLevelFormat } from "./importFile";

const LIST = '{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"Rust","items":[]}';
const COPY = '{"format":"koona-pin","version":1,"bookmarks":[]}';
const OPML = '<?xml version="1.0"?>\n<!-- feeds --><opml version="2.0"><body><outline xmlUrl="https://example.org/a.xml"/></body></opml>';
const NETSCAPE = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type"><TITLE>Bookmarks</TITLE><DL><p><DT><A HREF="https://example.org">A</A></DL>';

/** A browser's export from tests/fixtures/bookmarks. */
const fixture = (name: string) => readFileSync(new URL(`../../tests/fixtures/bookmarks/${name}.html`, import.meta.url), "utf8");

/** Safari's export: its folders and links carry no ADD_DATE. */
const SAFARI = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
	<HTML>
	<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
	<Title>Bookmarks</Title>
	<H1>Bookmarks</H1>
	<DT><H3 FOLDED>Favorites</H3>
	<DL><p>
		<DT><A HREF="https://www.apple.com/">Apple</A>
	</DL><p>
</HTML>`;

/** A saved article whose glossary is a <dl>. */
const ARTICLE = `<!DOCTYPE html><html><head><title>Rust terms</title></head><body><article><h1>Terms</h1>
<dl><dt>Borrow</dt><dd>A reference. See <a href="https://doc.rust-lang.org/book/">the book</a>.</dd>
<dt><a href="https://example.org/lifetime">Lifetime</a></dt><dd>How long a reference lives.</dd></dl></article></body></html>`;

/** A file of `size` bytes whose text starts with `text`: its size is what a cap checks. */
const sized = (text: string, size: number, name: string) => new File([text, new Uint8Array(Math.max(0, size - text.length)).fill(32)], name);

describe("sniff", () => {
  it("knows a list and a full copy by their format, whatever their name", () => {
    expect(sniff(LIST)).toBe("kpin");
    expect(sniff(COPY)).toBe("backup");
    expect(sniff(`\n  ${LIST}`)).toBe("kpin");
  });

  it("looks past a BOM", () => {
    expect(sniff(`\uFEFF${LIST}`)).toBe("kpin");
    expect(sniff(`\uFEFF${OPML}`)).toBe("opml");
    expect(sniff(`\uFEFF${NETSCAPE}`)).toBe("bookmarks");
  });

  it("knows OPML by its root, a Netscape file by its DOCTYPE or a <dl>", () => {
    expect(sniff(OPML)).toBe("opml");
    expect(sniff("<OPML>")).toBe("opml");
    expect(sniff(NETSCAPE)).toBe("bookmarks");
    expect(sniff('<html><body><H1>Bookmarks</H1>\n<DL><p><DT><A HREF="https://example.org" ADD_DATE="1">A</A></DL></body></html>')).toBe("bookmarks");
    expect(sniff("<!doctype netscape-bookmark-file-1>")).toBe("bookmarks");
  });

  it("refuses other JSON, broken JSON, a PDF, plain text and a <dl> past 64 KB", () => {
    expect(sniff('{"format":"something-else"}')).toBeNull();
    expect(sniff("{}")).toBeNull();
    // Broken JSON past the head of an object of ours is Rust's to refuse: the list dialog says so.
    expect(sniff('{"format":"koona"')).toBe("kpin");
    expect(sniff('{"format"')).toBeNull();
    expect(sniff("[1, 2]")).toBeNull();
    expect(sniff("%PDF-1.7\n%âãÏÓ\n1 0 obj << /Type /Catalog >>")).toBeNull();
    expect(sniff("just some words")).toBeNull();
    expect(sniff("")).toBeNull();
    expect(sniff('<?xml version="1.0"?><rss version="2.0"/>')).toBeNull();
    expect(sniff(`<html>${" ".repeat(64 * 1024)}<dl></dl></html>`)).toBeNull();
    // <dlx> is not a <dl>.
    expect(sniff("<html><dlx>")).toBeNull();
  });
});

describe("bookmarks", () => {
  const noDoctype = (text: string) => text.replace(/<!DOCTYPE[^>]*>/i, "");

  it("knows real Chrome, Edge, Firefox and Safari exports, with their DOCTYPE or without it", () => {
    for (const text of [fixture("chrome"), fixture("edge"), fixture("firefox"), SAFARI]) {
      expect(sniff(text)).toBe("bookmarks");
      expect(sniff(noDoctype(text))).toBe("bookmarks");
    }
  });

  it("takes a <dl> only with a <DT><H3 folder or a <DT><A carrying HREF and ADD_DATE", () => {
    expect(sniff('<DL><p><DT><H3 ADD_DATE="1">Work</H3></DL>')).toBe("bookmarks");
    expect(sniff('<DL><p><DT><A ADD_DATE="1" HREF="https://example.org">A</A></DL>')).toBe("bookmarks");
    expect(sniff('<DL><p><DT><A HREF="https://example.org">A</A></DL>')).toBeNull();
    expect(sniff('<DT><A HREF="https://example.org" ADD_DATE="1">A</A>')).toBeNull();
  });

  it("refuses a saved article with a glossary <dl>", async () => {
    expect(sniff(ARTICLE)).toBeNull();
    expect(await readFile(new File([ARTICLE], "rust-terms.html"))).toEqual({ refused: "unsupported" });
  });
});

describe("topLevelFormat", () => {
  it("reads only the top-level key, past nested objects, arrays and strings that look like it", () => {
    expect(topLevelFormat('{"format":"koona-pin","version":1}')).toBe("koona-pin");
    expect(topLevelFormat('{ "version" : 1 , "format" : "koona" }')).toBe("koona");
    expect(topLevelFormat('{"meta":{"format":"koona"},"list":[{"format":"x"}],"format":"koona-pin"}')).toBe("koona-pin");
    expect(topLevelFormat('{"title":"\\"format\\":\\"koona\\"","format":"other"}')).toBe("other");
    expect(topLevelFormat('{"note":"a } and a ]","format":"koona"}')).toBe("koona");
    // An escaped key is still `format`.
    expect(topLevelFormat('{"form\\u0061t":"koona"}')).toBe("koona");
  });

  it("says none when the object has no string format, and nothing when the head does not tell", () => {
    expect(topLevelFormat('{"meta":{"format":"koona"}}')).toBeNull();
    expect(topLevelFormat('{"format":1}')).toBeNull();
    expect(topLevelFormat('{"format":null}')).toBeNull();
    expect(topLevelFormat("{}")).toBeNull();
    expect(topLevelFormat('{"format":"koo')).toBeUndefined();
    expect(topLevelFormat(`{"blob":"${"x".repeat(64 * 1024)}","format":"koona"}`)).toBeUndefined();
  });

  it("knows a big copy from its head without parsing the rest", () => {
    // Not valid JSON past the head: never parsed; Rust checks the whole copy.
    const big = `{"format":"koona-pin","version":1,"bookmarks":[${'{"url":"https://example.org"},'.repeat(200_000)}`;
    expect(big.length).toBeGreaterThan(CAPS.kpin);
    expect(sniff(big)).toBe("backup");
    // A format past the head: found by a scan of the whole text (caps are `known`'s).
    const late = (size: number) => `{"blob":"${"x".repeat(size)}","format":"koona"}`;
    expect(sniff(late(64 * 1024))).toBe("kpin");
    expect(sniff(late(CAPS.kpin))).toBe("kpin");
    expect(sniff(`{"blob":"${"x".repeat(HEAD)}","meta":{"format":"koona"}}`)).toBeNull();
    // From its head alone the late one is not known yet.
    expect(sniffHead(late(64 * 1024))).toBeUndefined();
  });
});

describe("readFile", () => {
  it("routes by content: a .kpin with a wrong name, a backup named .kpin, OPML named .xml and .txt", async () => {
    expect(await readFile(new File([LIST], "rust-blogs.json"))).toEqual({ kind: "kpin", name: "rust-blogs.json", text: LIST });
    expect(await readFile(new File([COPY], "library.kpin"))).toMatchObject({ kind: "backup" });
    expect(await readFile(new File([OPML], "subscriptions.xml"))).toMatchObject({ kind: "opml" });
    expect(await readFile(new File([OPML], "feeds.txt"))).toMatchObject({ kind: "opml" });
    expect(await readFile(new File([NETSCAPE], "bookmarks.html"))).toMatchObject({ kind: "bookmarks" });
    expect(await readFile(new File(["%PDF-1.7"], "report.pdf"))).toEqual({ refused: "unsupported" });
    expect(await readFile(new File(['{"a":1}'], "data.json"))).toEqual({ refused: "unsupported" });
  });

  it("checks the cap of each kind", async () => {
    expect(CAPS).toEqual({ kpin: 2 * 1024 * 1024, opml: 8 * 1024 * 1024, bookmarks: 64 * 1024 * 1024, backup: 256 * 1024 * 1024 });
    for (const [kind, text] of [["kpin", LIST], ["opml", OPML], ["bookmarks", NETSCAPE], ["backup", COPY]] as const) {
      // The file's size is what a cap checks; its text stands for it.
      expect(await known("f", CAPS[kind], text, () => Promise.resolve(text))).toMatchObject({ kind });
      expect(await known("f", CAPS[kind] + 1, text, () => Promise.resolve(text))).toEqual({ refused: "tooBig", cap: CAPS[kind] });
    }
    // Real files at the list's cap and one byte over.
    expect(await readFile(sized(LIST, CAPS.kpin, "just-fits.kpin"))).toMatchObject({ kind: "kpin" });
    expect(await readFile(sized(LIST, CAPS.kpin + 1, "huge.kpin"))).toEqual({ refused: "tooBig", cap: CAPS.kpin });
    expect(await readFile(sized(OPML, CAPS.kpin + 1, "feeds.opml"))).toMatchObject({ kind: "opml" });
  });

  it("reads the head first and the whole file only once its kind and cap allow it", async () => {
    /** A file that records what was read of it. */
    const watched = (text: string, size: number) => {
      const reads: string[] = [];
      const file = {
        name: "f",
        size,
        slice: (from: number, to: number) => ({ text: () => (reads.push(`head ${from}-${to}`), Promise.resolve(text.slice(from, to))) }),
        text: () => (reads.push("whole"), Promise.resolve(text)),
      } as unknown as File;
      return { file, reads };
    };
    // A list in its head: the head is the whole file, not read again.
    let w = watched(LIST, LIST.length);
    expect(await readFile(w.file)).toMatchObject({ kind: "kpin", text: LIST });
    expect(w.reads).toEqual([`head 0-${HEAD}`]);
    // A bigger one: head, then the whole.
    const long = `{"format":"koona","blob":"${"x".repeat(HEAD)}"}`;
    w = watched(long, long.length);
    expect(await readFile(w.file)).toMatchObject({ kind: "kpin", text: long });
    expect(w.reads).toEqual([`head 0-${HEAD}`, "whole"]);
    // A whole file that is no longer what its head was (changed in between): refused.
    w = watched(long, long.length);
    (w.file as unknown as { text: () => Promise<string> }).text = () => Promise.resolve(`{"format":"koona-pin"}${" ".repeat(HEAD)}`);
    expect(await readFile(w.file)).toEqual({ refused: "unsupported" });
    // A list over its cap, a PDF: the head only.
    w = watched(LIST, CAPS.kpin + 1);
    expect(await readFile(w.file)).toEqual({ refused: "tooBig", cap: CAPS.kpin });
    expect(w.reads).toEqual([`head 0-${HEAD}`]);
    w = watched("%PDF-1.7", 100 * 1024 * 1024);
    expect(await readFile(w.file)).toEqual({ refused: "unsupported" });
    expect(w.reads).toEqual([`head 0-${HEAD}`]);
    // A format past the head: scanned in pieces, read whole only once known and under its cap.
    const piece = 4 * 1024 * 1024;
    const late = `{"blob":"${"x".repeat(HEAD)}","format":"koona"}`;
    w = watched(late, late.length);
    expect(await readFile(w.file)).toMatchObject({ kind: "kpin", text: late });
    expect(w.reads).toEqual([`head 0-${HEAD}`, `head 0-${piece}`, "whole"]);
    w = watched(late, CAPS.kpin + 1);
    expect(await readFile(w.file)).toEqual({ refused: "tooBig", cap: CAPS.kpin });
    expect(w.reads).toEqual([`head 0-${HEAD}`, `head 0-${piece}`]);
    // Other JSON of 10 MB: scanned piece by piece to its end, never read whole.
    const other = `{"rows":[${"1,".repeat(5 * 1024 * 1024)}2]}`;
    w = watched(other, other.length);
    expect(await readFile(w.file)).toEqual({ refused: "unsupported" });
    expect(w.reads).toEqual([`head 0-${HEAD}`, `head 0-${piece}`, `head ${piece}-${2 * piece}`, `head ${2 * piece}-${3 * piece}`]);
  });

  it("keeps the scan's state across pieces", () => {
    const text = `{"a":"x\\"y","b":[{"format":"no"}],"form\\u0061t":"koona-pin"}`;
    for (let cut = 1; cut < text.length - 1; cut++) {
      const scan = formatScanner();
      expect(scan(text.slice(0, cut)), `cut at ${cut}`).toBeUndefined();
      expect(scan(text.slice(cut)), `cut at ${cut}`).toBe("koona-pin");
    }
  });

  it("the menu path, read once whole, scans that text and does not read it again", async () => {
    const late = `{"blob":"${"x".repeat(HEAD)}","format":"koona"}`;
    const caps: number[] = [];
    const whole = (cap: number) => (caps.push(cap), Promise.resolve(late));
    expect(await known("f", late.length, late.slice(0, HEAD), whole)).toMatchObject({ kind: "kpin", text: late });
    expect(caps).toEqual([CAPS.backup]);
  });

  it("knows a 3 MB backup whose format comes last, and refuses 3 MB of other JSON", async () => {
    const blob = (format: string) =>
      `{"bookmarks":[${'{"url":"https://example.org/a","title":"A"},'.repeat(75_000)}{"url":"https://example.org/z"}],"format":"${format}","version":1}`;
    const copy = blob("koona-pin");
    expect(copy.length).toBeGreaterThan(3 * 1024 * 1024);
    expect(sniffHead(copy)).toBeUndefined();
    expect(await readFile(new File([copy], "sorted.json"))).toMatchObject({ kind: "backup", text: copy });
    const other = blob("something-else");
    expect(await readFile(new File([other], "data.json"))).toEqual({ refused: "unsupported" });
    const none = `{"rows":[${"[1,2,3],".repeat(400_000)}[4]],"meta":{"format":"koona-pin"}}`;
    expect(none.length).toBeGreaterThan(3 * 1024 * 1024);
    expect(await readFile(new File([none], "rows.json"))).toEqual({ refused: "unsupported" });
  });

  it("takes a small head that does not tell as the whole file, not read again", async () => {
    const reads: string[] = [];
    const text = '{"format":"koo';
    expect(await known("f", text.length, text, (cap) => (reads.push(`whole ${cap}`), Promise.resolve(text)))).toEqual({ refused: "unsupported" });
    expect(reads).toEqual([]);
  });

  it("does not read a file over the largest cap", async () => {
    const huge = { name: "huge.json", size: LARGEST + 1, text: () => Promise.reject(new Error("read")) } as unknown as File;
    expect(await readFile(huge)).toEqual({ refused: "tooBig", cap: LARGEST });
  });
});

describe("readDropped", () => {
  it("takes the first of several files, and says others came", async () => {
    expect(await readDropped([new File([OPML], "feeds.opml"), new File(["x"], "notes.txt")])).toMatchObject({ kind: "opml", name: "feeds.opml", more: true });
    expect(await readDropped([new File([LIST], "a.kpin")])).toMatchObject({ kind: "kpin", more: false });
    expect(await readDropped([new File(["x"], "notes.txt"), new File([LIST], "a.kpin")])).toEqual({ refused: "unsupported" });
    expect(await readDropped([])).toBeNull();
    expect(await readDropped(null)).toBeNull();
  });
});

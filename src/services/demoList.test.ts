import { describe, expect, it } from "vitest";
import { demoLine, demoList, demoParagraph, demoTag } from "./demo";
import { caseName, caseText, cases, vectors } from "../../tests/kpin-conformance";

// The browser preview reads lists with a TypeScript stand-in for `lists/format.rs`. It answers
// every case of the format's conformance suite as the Rust reader does (`cases.json`, column
// `reader`), the generated ones at the limits included, and cleans text as the suite says, so
// the two cannot drift apart unseen while the UI tests run on the stand-in. What a reader reads
// out of a file (`list`) is the Rust reader's to meet; the stand-in only answers.
describe("the browser preview's list reader", () => {
  it.each(cases.map((c) => ({ ...c, label: caseName(c) })))("answers $label as the Rust reader does: $reader", (c) => {
    const read = demoList(caseText(c));
    expect("outcome" in read ? read.outcome : "ready").toBe(c.reader);
  });

  // serde_json refuses a value under a repeated key that JSON.parse drops, so the stand-in reads the
  // text, not the parsed value, for the rules the schema cannot see (reader rules 2026-11).
  it("refuses what serde_json refuses under a repeated key, and only that", () => {
    const list = (extra: string) => `{"format":"koona","app":"pin","kind":"list","version":"1.0","title":"T",${extra}"items":[{"type":"link","url":"https://example.com/"}]}`;
    const answer = (extra: string) => {
      const read = demoList(list(extra));
      return "outcome" in read ? read.outcome : "ready";
    };
    expect(answer(`"x":1e400,"x":1,`)).toBe("not_a_list");
    expect(answer(`"x":"\\ud800","x":1,`)).toBe("not_a_list");
    expect(answer(`"x":${"[".repeat(126)}${"]".repeat(126)},"x":1,`)).toBe("ready");
    expect(answer(`"x":${"[".repeat(127)}${"]".repeat(127)},"x":1,`)).toBe("not_a_list");
    expect(answer(`"x":"[[{{ \\" 1e999",`)).toBe("ready");
    expect(answer(`"x":[1.7976931348623157e308,-0,1e-400,"\\ud83d\\ude00"],`)).toBe("ready");
  });

  type Text ={ rule: "line" | "description" | "tag"; max: number; in: string; out: string | null };
  const clean = { line: demoLine, description: demoParagraph, tag: (raw: string) => demoTag(raw) };
  it.each(vectors<Text>("text.json"))("cleans the $rule $in as the suite says", (v) => {
    expect(clean[v.rule](v.in, v.max)).toBe(v.out);
  });
});

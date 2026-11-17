import { describe, expect, it } from "vitest";
import { demoLine, demoList, demoParagraph, demoTag } from "./demo";
import { caseName, caseText, cases, vectors } from "./kpinConformance";

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

  type Text = { rule: "line" | "description" | "tag"; max: number; in: string; out: string | null };
  const clean = { line: demoLine, description: demoParagraph, tag: (raw: string) => demoTag(raw) };
  it.each(vectors<Text>("text.json"))("cleans the $rule $in as the suite says", (v) => {
    expect(clean[v.rule](v.in, v.max)).toBe(v.out);
  });
});

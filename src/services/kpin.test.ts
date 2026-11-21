import { readdirSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { caseName, caseText, cases, kpinDir, kpinText, vectors } from "../../tests/kpin-conformance";
import { demoLine, demoList, demoParagraph, demoTag } from "./demo";

// The public schema of `.kpin` (`docs/kpin/schema-1.json`) against the format's conformance suite:
// `cases.json` says of every file whether the schema accepts it (`schema_valid`), and the Rust reader's
// test (`lists/format.rs`) holds what readers answer. Checked here with a JSON Schema 2020-12 validator,
// as the spec tells other tools to check their lists.
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(kpinText("schema-1.json")));

/** The JSON of a text; undefined, which no schema accepts, for a text that is not JSON (a file cut off). */
const json = (text: string): unknown => {
  try {
    // A byte order mark at the start is allowed and ignored (spec: The file).
    return JSON.parse(text.replace(/^\u{feff}/u, ""));
  } catch {
    return undefined;
  }
};

describe("the schema of .kpin", () => {
  it.each(cases.map((c) => ({ ...c, label: caseName(c) })))("answers $label as cases.json says: $schema_valid", (c) => {
    const valid = validate(json(caseText(c)));
    expect(valid, JSON.stringify(validate.errors)).toBe(c.schema_valid);
  });

  it("accepts every example of the spec", () => {
    for (const name of readdirSync(new URL("examples/", kpinDir))) {
      expect(validate(JSON.parse(kpinText(`examples/${name}`))), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("refuses a title made only of invisible characters of the BMP", () => {
    const list = (title: string) => ({ format: "koona", app: "pin", kind: "list", version: "1.0", title, items: [{ type: "link", url: "https://example.com/" }] });
    // The set a reader drops (spec: Text) that the schema can name: U+E0000 tag characters lie outside the BMP.
    // With the Unicode white space the pattern names itself rather than leave to \s.
    const invisible = String.fromCodePoint(0xad, 0x61c, 0x180e, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x206f, 0xfeff, 0xfff9, 0xfffb, 0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000);
    for (const c of invisible) expect(validate(list(` ${c} `)), `U+${c.codePointAt(0)!.toString(16)}`).toBe(false);
    expect(validate(list(`${invisible}a`))).toBe(true);
  });
});

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

  type Text = { rule: "line" | "description" | "tag"; max: number; in: string; out: string | null };
  const clean = { line: demoLine, description: demoParagraph, tag: (raw: string) => demoTag(raw) };
  it.each(vectors<Text>("text.json"))("cleans the $rule $in as the suite says", (v) => {
    expect(clean[v.rule](v.in, v.max)).toBe(v.out);
  });
});

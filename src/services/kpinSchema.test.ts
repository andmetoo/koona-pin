import { readdirSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { caseName, caseText, cases, kpinDir, kpinText } from "../../tests/kpin-conformance";

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
    return JSON.parse(text.replace(/^﻿/, ""));
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

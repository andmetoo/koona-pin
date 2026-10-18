import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { demoList } from "./demo";

// The browser preview reads lists with a TypeScript stand-in for `lists/format.rs`. It answers
// every fixture of the Rust reader as the Rust reader does (`cases.json`, column `reader`), so
// the two cannot drift apart unseen while the UI tests run on the stand-in.
const dir = new URL("../../src-tauri/tests/fixtures/kpin/", import.meta.url);
const cases: { file: string; reader: string }[] = JSON.parse(readFileSync(new URL("cases.json", dir), "utf8"));

describe("the browser preview's list reader", () => {
  it.each(cases)("answers $file as the Rust reader does: $reader", ({ file, reader }) => {
    const read = demoList(readFileSync(new URL(file, dir), "utf8"));
    expect("outcome" in read ? read.outcome : "ready").toBe(reader);
  });
});

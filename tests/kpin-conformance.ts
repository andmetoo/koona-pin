// For Vitest only, and outside src/ so that no app module can bring node:fs into the browser build:
// the public conformance suite of `.kpin` (`docs/kpin/conformance`, CC0, its README says how to read it),
// as `lists/conformance.rs` reads it for the Rust reader's tests.
import { readFileSync } from "node:fs";

/** The spec's folder: the schema, the examples and the suite are read from here. */
export const kpinDir = new URL("../docs/kpin/", import.meta.url);

/** A file of the spec's folder, by its path there (`schema-1.json`, `examples/minimal.kpin`). */
export const kpinText = (path: string) => readFileSync(new URL(path, kpinDir), "utf8");

/** A file of the suite, by its path in the suite. */
export const suiteText = (name: string) => kpinText(`conformance/${name}`);

export type Generate = { from: string; pad_to_bytes?: number; add_links?: number; add_sections?: number; remove?: string[]; set?: Record<string, unknown> };
export type Case = { file?: string; name?: string; generate?: Generate; schema_valid: boolean; reader: string; schema_cannot_see?: string };

export const cases: Case[] = JSON.parse(suiteText("cases.json")).cases;

/** The `vectors` of one of the suite's vector files. */
export const vectors = <T>(name: string): T[] => JSON.parse(suiteText(name)).vectors;

/** A case's name: its file, or the name of a generated one. */
export const caseName = (c: Case) => c.file ?? c.name ?? "?";

/** A case's file: as it is, or made from another by its `generate`. */
export function caseText(c: Case): string {
  if (c.file) return suiteText(c.file);
  const { from, pad_to_bytes, add_links = 0, add_sections = 0, remove = [], set = {} } = c.generate!;
  const base = suiteText(from);
  if (pad_to_bytes !== undefined) {
    // Spaces after the object: only the size changes. Every character added is one byte.
    return base + " ".repeat(Math.max(0, pad_to_bytes - new TextEncoder().encode(base).length));
  }
  const list = JSON.parse(base);
  for (const key of remove) delete list[key];
  Object.assign(list, set);
  for (let i = 0; i < add_links; i++) (list.items ??= []).push({ type: "link", url: `https://example.com/added/${i}` });
  for (let i = 0; i < add_sections; i++) (list.sections ??= []).push({ name: `Added ${i}`, items: [{ type: "link", url: `https://example.com/section/${i}` }] });
  return JSON.stringify(list, null, 2);
}

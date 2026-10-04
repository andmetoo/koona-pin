import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { dropAttribute, dropHint, parseDrop, sameDrop } from "./drag";
import { Collection } from "../types";

const t = i18n.getFixedT("ru");
const collections = [{ id: 3, name: "Разработка" }] as Collection[];

describe("drop targets of the sidebar (NP-030)", () => {
  it("go to an attribute and back, a tag with colons included", () => {
    for (const target of [{ kind: "collection", id: 3 }, { kind: "tag", name: "a:b" }, { kind: "trash" }, { kind: "new" }] as const)
      expect(parseDrop(dropAttribute(target))).toEqual(target);
    expect(parseDrop("collection:x")).toBeNull();
    expect(parseDrop("tag:")).toBeNull();
    expect(parseDrop(undefined)).toBeNull();
    expect(sameDrop({ kind: "tag", name: "x" }, { kind: "tag", name: "x" })).toBe(true);
    expect(sameDrop({ kind: "tag", name: "x" }, null)).toBe(false);
  });
  it("the hint under the stack says what the drop will do (frame 27)", () => {
    expect(dropHint(t, { kind: "collection", id: 3 }, 3, collections)).toBe("Переместить 3 в «Разработка»");
    expect(dropHint(t, { kind: "tag", name: "crypto" }, 3, collections)).toBe("Добавить тег «crypto» к 3");
    expect(dropHint(t, { kind: "trash" }, 3, collections)).toBe("3 в корзину");
    expect(dropHint(t, { kind: "new" }, 3, collections)).toBe("Новая коллекция из 3");
    expect(dropHint(t, null, 3, collections)).toBe("Бросьте на коллекцию, тег или корзину");
  });
});
